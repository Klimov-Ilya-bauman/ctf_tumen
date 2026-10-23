use std::{collections::HashMap, sync::Arc, time::{Duration, Instant}};
use rand::RngExt;
use serde_json::json;
use tokio::sync::{Mutex, mpsc::UnboundedSender};
use crate::{
    db::{chat_messages, games, users},
    game::{
        chat::{ChatMessage, RateLimiter, TextError, clean_text},
        bot::Bot, board::{Coord, Ship},
        rules::ShotResult,
        state::{BOT_ID, Game, Mode, Move, MoveResult, Status, obfuscate_id},
    },
    state::AppState,
};
const TURN_TIMEOUT: Duration = Duration::from_secs(90);
const RECONNECT_GRACE: Duration = Duration::from_secs(60);
const POST_GAME_CHAT_GRACE: Duration = Duration::from_secs(10);
pub struct Conn {
    pub id: u64,
    pub user_id: u64,
    pub tx: UnboundedSender<String>,
}
pub struct RoomInner {
    pub game: Game,
    pub bot: Option<Bot>,
    pub conns: Vec<Conn>,
    pub bot_running: bool,
    pub watchdog_running: bool,
    pub turn_deadline: Instant,
    pub absent_since: HashMap<u64, Instant>,
    pub chat_limits: HashMap<u64, RateLimiter>,
    pub names: HashMap<u64, String>,
    pub finished_at: Option<Instant>,
}
fn mark_finished(inner: &mut RoomInner) {
    if inner.game.status == Status::Finished && inner.finished_at.is_none() {
        inner.finished_at = Some(Instant::now());
    }
}
pub struct Room {
    pub inner: Mutex<RoomInner>,
}
fn move_to_shot(mv: &Move) -> ShotResult {
    match (mv.result, &mv.sunk) {
        (MoveResult::Miss, _) => ShotResult::Miss,
        (MoveResult::Hit, _) => ShotResult::Hit,
        (MoveResult::Sunk, Some(ship)) => ShotResult::Sunk(ship.clone()),
        (MoveResult::Sunk, None) => ShotResult::Hit,
    }
}
fn aim_hint(game: &Game) -> Vec<Coord> {
    let Some(player) = game.opponent(BOT_ID) else {
        return Vec::new();
    };
    let scored = |user: u64| {
        game
            .moves()
            .iter()
            .filter(|m| m.user_id == user && m.result != MoveResult::Miss)
            .count()
    };
    if scored(player) <= scored(BOT_ID) {
        return Vec::new();
    }
    game.board_ships(player)
        .map(|ships| ships.iter().flat_map(|s| s.cells()).collect())
        .unwrap_or_default()
}
fn restore_bot(game: &Game) -> Bot {
    let mut bot = Bot::new();
    for mv in game.moves().iter().filter(|m| m.user_id == BOT_ID) {
        bot.report(Coord { x: mv.x, y: mv.y }, &move_to_shot(mv));
    }
    bot
}
pub async fn get_or_load(
    state: &AppState,
    id: u64,
) -> Result<Option<Arc<Room>>, sqlx::Error> {
    if let Some(room) = state.rooms.get(&id) {
        return Ok(Some(room.clone()));
    }
    let Some(game) = games::load(&state.db, id).await? else {
        return Ok(None);
    };
    let bot = (game.mode == Mode::Bot).then(|| restore_bot(&game));
    let ids: Vec<u64> = [Some(game.player1), game.player2]
        .into_iter()
        .flatten()
        .collect();
    let names = users::usernames(&state.db, &ids).await?;
    let now = Instant::now();
    let absent_since = if game.mode == Mode::Pvp {
        [Some(game.player1), game.player2]
            .into_iter()
            .flatten()
            .map(|p| (p, now))
            .collect()
    } else {
        HashMap::new()
    };
    let room = Arc::new(Room {
        inner: Mutex::new(RoomInner {
            game,
            bot,
            conns: Vec::new(),
            bot_running: false,
            watchdog_running: false,
            turn_deadline: now + TURN_TIMEOUT,
            absent_since,
            chat_limits: HashMap::new(),
            names,
            finished_at: None,
        }),
    });
    Ok(Some(state.rooms.entry(id).or_insert(room).clone()))
}
fn send_to(conn: &Conn, msg: &serde_json::Value) {
    let _ = conn.tx.send(msg.to_string());
}
fn state_for(inner: &RoomInner, user: u64) -> serde_json::Value {
    let mut view = if inner.game.is_participant(user) {
        json!(inner.game.view_for(user))
    } else {
        json!(inner.game.spectator_view())
    };
    view["player1_name"] = json!(inner.names.get(& inner.game.player1));
    view["player2_name"] = json!(
        inner.game.player2.and_then(| p | inner.names.get(& p))
    );
    view
}
pub fn send_state(inner: &RoomInner, conn: &Conn) {
    send_to(conn, &json!({ "type" : "state", "game" : state_for(inner, conn.user_id) }));
}
pub fn broadcast_state(inner: &RoomInner) {
    for conn in &inner.conns {
        send_state(inner, conn);
    }
}
fn broadcast_shot(inner: &RoomInner, mv: &Move) {
    let msg = json!(
        { "type" : "shot_result", "user_id" : obfuscate_id(mv.user_id), "x" : mv.x, "y" :
        mv.y, "result" : mv.result, "sunk" : mv.sunk, "turn" : obfuscate_id(inner.game
        .turn), }
    );
    for conn in &inner.conns {
        send_to(conn, &msg);
    }
    if inner.game.status == Status::Finished {
        let over = json!(
            { "type" : "game_over", "winner" : inner.game.winner.map(obfuscate_id),
            "reason" : "victory" }
        );
        for conn in &inner.conns {
            send_to(conn, &over);
        }
        broadcast_state(inner);
    }
}
pub async fn place_ships(
    state: &AppState,
    room: &Arc<Room>,
    user: u64,
    ships: Vec<Ship>,
) -> Result<(), String> {
    let mut inner = room.inner.lock().await;
    let ships_copy = ships.clone();
    inner
        .game
        .place_ships(user, ships)
        .map_err(|e| format!("cannot place ships: {e:?}"))?;
    let id = inner.game.id;
    if let Err(e) = games::save_board(&state.db, id, user, &ships_copy).await {
        tracing::error!("save_board failed: {e}");
        return Err("internal error".into());
    }
    if let Err(e) = games::save_state(&state.db, &inner.game).await {
        tracing::error!("save_state failed: {e}");
    }
    inner.turn_deadline = Instant::now() + TURN_TIMEOUT;
    broadcast_state(&inner);
    start_bot_if_needed(state, room, &mut inner);
    start_watchdog_if_needed(state, room, &mut inner);
    Ok(())
}
pub async fn fire(
    state: &AppState,
    room: &Arc<Room>,
    user: u64,
    c: Coord,
) -> Result<(), String> {
    let (game_id, mv) = {
        let mut inner = room.inner.lock().await;
        let mv = inner.game.fire(user, c).map_err(|e| format!("cannot fire: {e:?}"))?;
        (inner.game.id, mv)
    };
    if let Err(e) = games::insert_move(&state.db, game_id, &mv).await {
        tracing::error!("insert_move failed: {e}");
    }
    let mut inner = room.inner.lock().await;
    inner.game.commit_shot(user, &mv);
    inner.turn_deadline = Instant::now() + TURN_TIMEOUT;
    mark_finished(&mut inner);
    if let Err(e) = games::save_state(&state.db, &inner.game).await {
        tracing::error!("save_state failed: {e}");
    }
    broadcast_shot(&inner, &mv);
    if inner.game.status == Status::Finished {
        crate::report::schedule(
            state.db.clone(),
            state.reports_dir.clone(),
            inner.game.id,
        );
    }
    start_bot_if_needed(state, room, &mut inner);
    Ok(())
}
async fn persist_move(state: &AppState, game: &Game, mv: &Move) {
    if let Err(e) = games::insert_move(&state.db, game.id, mv).await {
        tracing::error!("insert_move failed: {e}");
    }
    if let Err(e) = games::save_state(&state.db, game).await {
        tracing::error!("save_state failed: {e}");
    }
}
pub fn start_bot_if_needed(state: &AppState, room: &Arc<Room>, inner: &mut RoomInner) {
    let bots_turn = inner.game.mode == Mode::Bot && inner.game.status == Status::Active
        && inner.game.turn == BOT_ID;
    if !bots_turn || inner.bot_running {
        return;
    }
    inner.bot_running = true;
    let (state, room) = (state.clone(), room.clone());
    tokio::spawn(async move { run_bot(state, room).await });
}
async fn run_bot(state: AppState, room: Arc<Room>) {
    loop {
        let delay = rand::rng().random_range(30..=70);
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        let mut inner = room.inner.lock().await;
        if inner.game.status != Status::Active || inner.game.turn != BOT_ID {
            inner.bot_running = false;
            return;
        }
        let hint = aim_hint(&inner.game);
        let Some(bot) = inner.bot.as_mut() else {
            inner.bot_running = false;
            return;
        };
        let c = bot.next_shot(&mut rand::rng(), &hint);
        let mv = match inner.game.fire(BOT_ID, c) {
            Ok(mv) => mv,
            Err(e) => {
                tracing::error!("bot move rejected: {e:?}");
                inner.bot_running = false;
                return;
            }
        };
        inner.game.commit_shot(BOT_ID, &mv);
        if let Some(bot) = inner.bot.as_mut() {
            bot.report(c, &move_to_shot(&mv));
        }
        inner.turn_deadline = Instant::now() + TURN_TIMEOUT;
        mark_finished(&mut inner);
        persist_move(&state, &inner.game, &mv).await;
        broadcast_shot(&inner, &mv);
        if inner.game.status == Status::Finished {
            crate::report::schedule(
                state.db.clone(),
                state.reports_dir.clone(),
                inner.game.id,
            );
        }
        if inner.game.status != Status::Active || inner.game.turn != BOT_ID {
            inner.bot_running = false;
            return;
        }
    }
}
pub async fn opponent_joined(state: &AppState, id: u64, user: u64) {
    let Some(room) = state.rooms.get(&id).map(|r| r.clone()) else {
        return;
    };
    let name = users::find_by_id(&state.db, user).await.ok().flatten().map(|(_, n)| n);
    let mut inner = room.inner.lock().await;
    if inner.game.join(user).is_err() {
        return;
    }
    if let Some(name) = name {
        inner.names.insert(user, name);
    }
    inner.absent_since.entry(user).or_insert_with(Instant::now);
    let msg = json!({ "type" : "opponent_joined", "user_id" : obfuscate_id(user) })
        .to_string();
    for conn in &inner.conns {
        let _ = conn.tx.send(msg.clone());
    }
    broadcast_state(&inner);
}
fn notify_others(inner: &RoomInner, user: u64, msg: serde_json::Value) {
    let text = msg.to_string();
    for conn in inner.conns.iter().filter(|c| c.user_id != user) {
        let _ = conn.tx.send(text.clone());
    }
}
pub fn add_conn(state: &AppState, room: &Arc<Room>, inner: &mut RoomInner, conn: Conn) {
    let user = conn.user_id;
    let first = !inner.conns.iter().any(|c| c.user_id == user);
    send_state(inner, &conn);
    inner.conns.push(conn);
    inner.absent_since.remove(&user);
    if first {
        notify_others(inner, user, json!({ "type" : "opponent_reconnected" }));
    }
    start_bot_if_needed(state, room, inner);
    start_watchdog_if_needed(state, room, inner);
}
pub fn remove_conn(inner: &mut RoomInner, conn_id: u64) {
    let Some(pos) = inner.conns.iter().position(|c| c.id == conn_id) else {
        return;
    };
    let user = inner.conns.remove(pos).user_id;
    if inner.conns.iter().any(|c| c.user_id == user) || inner.game.mode != Mode::Pvp {
        return;
    }
    inner.absent_since.insert(user, Instant::now());
    notify_others(
        inner,
        user,
        json!(
            { "type" : "opponent_disconnected", "grace_secs" : RECONNECT_GRACE.as_secs()
            }
        ),
    );
}
pub fn start_watchdog_if_needed(
    state: &AppState,
    room: &Arc<Room>,
    inner: &mut RoomInner,
) {
    if inner.game.status != Status::Active || inner.watchdog_running {
        return;
    }
    inner.watchdog_running = true;
    let (state, room) = (state.clone(), room.clone());
    tokio::spawn(async move { run_watchdog(state, room).await });
}
async fn run_watchdog(state: AppState, room: Arc<Room>) {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let mut inner = room.inner.lock().await;
        if inner.game.status != Status::Active {
            inner.watchdog_running = false;
            return;
        }
        let now = Instant::now();
        let players = [Some(inner.game.player1), inner.game.player2];
        let gone = players
            .into_iter()
            .flatten()
            .find(|p| {
                inner
                    .absent_since
                    .get(p)
                    .is_some_and(|t| now.duration_since(*t) >= RECONNECT_GRACE)
            });
        let verdict = if let Some(p) = gone {
            Some((p, "disconnected"))
        } else if now >= inner.turn_deadline {
            Some((inner.game.turn, "timeout"))
        } else {
            None
        };
        let Some((loser, reason)) = verdict else {
            continue;
        };
        if inner.game.forfeit(loser).is_ok() {
            mark_finished(&mut inner);
            if let Err(e) = games::save_state(&state.db, &inner.game).await {
                tracing::error!("save_state failed: {e}");
            }
            let over = json!(
                { "type" : "game_over", "winner" : inner.game.winner.map(obfuscate_id),
                "reason" : reason }
            )
                .to_string();
            for conn in &inner.conns {
                let _ = conn.tx.send(over.clone());
            }
            broadcast_state(&inner);
            crate::report::schedule(
                state.db.clone(),
                state.reports_dir.clone(),
                inner.game.id,
            );
        }
        inner.watchdog_running = false;
        return;
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum ChatError {
    NotParticipant,
    WrongStatus,
    Invalid(&'static str),
    RateLimited,
    Internal,
}
pub async fn send_chat(
    state: &AppState,
    room: &Arc<Room>,
    user: u64,
    text: &str,
) -> Result<ChatMessage, ChatError> {
    let mut inner = room.inner.lock().await;
    if !inner.game.is_participant(user) {
        return Err(ChatError::NotParticipant);
    }
    let just_finished = inner.game.status == Status::Finished
        && inner.finished_at.is_some_and(|t| t.elapsed() < POST_GAME_CHAT_GRACE);
    if !matches!(inner.game.status, Status::Placing | Status::Active) && !just_finished {
        return Err(ChatError::WrongStatus);
    }
    let text = clean_text(text)
        .map_err(|e| match e {
            TextError::Empty => ChatError::Invalid("message is empty"),
            TextError::TooLong => ChatError::Invalid("message is too long"),
        })?;
    if !inner.chat_limits.entry(user).or_default().allow(Instant::now()) {
        return Err(ChatError::RateLimited);
    }
    let message = chat_messages::insert(&state.db, inner.game.id, user, &text)
        .await
        .map_err(|e| {
            tracing::error!("chat insert failed: {e}");
            ChatError::Internal
        })?;
    let payload = json!({ "type" : "chat_message", "message" : message }).to_string();
    for conn in &inner.conns {
        let _ = conn.tx.send(payload.clone());
    }
    Ok(message)
}
