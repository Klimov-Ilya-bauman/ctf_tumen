use serde::Serialize;
use sqlx::{MySqlPool, Row};
use crate::game::{
    board::{Coord, Ship},
    state::{BOT_ID, Game, Mode, Move, Status, obfuscate_id},
};
pub async fn create(
    pool: &MySqlPool,
    mode: Mode,
    player1: u64,
) -> Result<u64, sqlx::Error> {
    let status = if mode == Mode::Bot { Status::Placing } else { Status::Waiting };
    let r = sqlx::query(
            "INSERT INTO games (mode, status, player1_id, turn_user_id) VALUES (?, ?, ?, ?)",
        )
        .bind(mode.as_str())
        .bind(status.as_str())
        .bind(player1)
        .bind(player1)
        .execute(pool)
        .await?;
    Ok(r.last_insert_id())
}
pub async fn save_state(pool: &MySqlPool, game: &Game) -> Result<(), sqlx::Error> {
    sqlx::query(
            "UPDATE games SET status = ?, turn_user_id = ?, winner_id = ?, \
         finished_at = IF(? = 'finished', COALESCE(finished_at, NOW()), NULL) WHERE id = ?",
        )
        .bind(game.status.as_str())
        .bind(game.turn)
        .bind(game.winner)
        .bind(game.status.as_str())
        .bind(game.id)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn save_board(
    pool: &MySqlPool,
    game_id: u64,
    user_id: u64,
    ships: &[Ship],
) -> Result<(), sqlx::Error> {
    let json = serde_json::to_string(ships).expect("ships serialize");
    sqlx::query("INSERT INTO boards (game_id, user_id, ships) VALUES (?, ?, ?)")
        .bind(game_id)
        .bind(user_id)
        .bind(json)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn insert_move(
    pool: &MySqlPool,
    game_id: u64,
    mv: &Move,
) -> Result<(), sqlx::Error> {
    sqlx::query(
            "INSERT INTO moves (game_id, user_id, x, y, result) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(game_id)
        .bind(mv.user_id)
        .bind(mv.x)
        .bind(mv.y)
        .bind(mv.result.as_str())
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn load(pool: &MySqlPool, id: u64) -> Result<Option<Game>, sqlx::Error> {
    let Some(row) = sqlx::query(
            "SELECT mode, status, player1_id, player2_id, turn_user_id, winner_id FROM games WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await? else {
        return Ok(None);
    };
    let mode = Mode::from_db(row.get::<String, _>("mode").as_str());
    let status = Status::from_db(row.get::<String, _>("status").as_str());
    let (Some(mode), Some(status)) = (mode, status) else {
        return Ok(None);
    };
    let mut boards = Vec::new();
    for r in sqlx::query(
            "SELECT user_id, CAST(ships AS CHAR) AS ships FROM boards WHERE game_id = ?",
        )
        .bind(id)
        .fetch_all(pool)
        .await?
    {
        let ships: Vec<Ship> = serde_json::from_str(&r.get::<String, _>("ships"))
            .map_err(|e| sqlx::Error::Decode(Box::new(e)))?;
        boards.push((r.get::<u64, _>("user_id"), ships));
    }
    let moves: Vec<(u64, Coord)> = sqlx::query(
            "SELECT user_id, x, y FROM moves WHERE game_id = ? ORDER BY id",
        )
        .bind(id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|r| (
            r.get("user_id"),
            Coord {
                x: r.get("x"),
                y: r.get("y"),
            },
        ))
        .collect();
    let game = Game::restore(
            id,
            mode,
            status,
            row.get("player1_id"),
            row.get("player2_id"),
            row.get("turn_user_id"),
            row.get("winner_id"),
            boards,
            &moves,
        )
        .map_err(|e| {
            tracing::error!("cannot restore game {id}: {e:?}");
            sqlx::Error::Decode("corrupt game data".into())
        })?;
    debug_assert!(game.mode != Mode::Bot || game.player2 == Some(BOT_ID));
    Ok(Some(game))
}
#[derive(Serialize)]
pub struct MoveRecord {
    pub user_id: u32,
    pub x: u8,
    pub y: u8,
    pub result: String,
    pub created_at: u64,
}
pub async fn list_moves(
    pool: &MySqlPool,
    game_id: u64,
) -> Result<Vec<MoveRecord>, sqlx::Error> {
    let rows = sqlx::query(
            "SELECT user_id, x, y, result, CAST(UNIX_TIMESTAMP(created_at) AS UNSIGNED) AS ts \
         FROM moves WHERE game_id = ? ORDER BY id",
        )
        .bind(game_id)
        .fetch_all(pool)
        .await?;
    Ok(
        rows
            .into_iter()
            .map(|r| MoveRecord {
                user_id: obfuscate_id(r.get("user_id")),
                x: r.get("x"),
                y: r.get("y"),
                result: r.get("result"),
                created_at: r.get("ts"),
            })
            .collect(),
    )
}
pub struct GameSummary {
    pub id: u64,
    pub mode: String,
    pub status: String,
    pub winner_id: Option<u64>,
    pub opponent_name: Option<String>,
}
pub async fn list_for_user(
    pool: &MySqlPool,
    user_id: u64,
) -> Result<Vec<GameSummary>, sqlx::Error> {
    let rows = sqlx::query(
            "SELECT g.id, g.mode, g.status, g.winner_id, u.username AS opponent_name FROM games g \
         LEFT JOIN users u ON u.id = IF(g.player1_id = ?, g.player2_id, g.player1_id) \
         WHERE g.player1_id = ? OR g.player2_id = ? ORDER BY g.id DESC LIMIT 100",
        )
        .bind(user_id)
        .bind(user_id)
        .bind(user_id)
        .fetch_all(pool)
        .await?;
    Ok(
        rows
            .into_iter()
            .map(|r| GameSummary {
                id: r.get("id"),
                mode: r.get("mode"),
                status: r.get("status"),
                winner_id: r.get("winner_id"),
                opponent_name: r.get("opponent_name"),
            })
            .collect(),
    )
}
#[derive(Debug, PartialEq, Eq)]
pub enum JoinOutcome {
    Joined,
    NotFound,
    OwnGame,
    Unavailable,
}
pub async fn join(
    pool: &MySqlPool,
    id: u64,
    user_id: u64,
) -> Result<JoinOutcome, sqlx::Error> {
    let r = sqlx::query(
            "UPDATE games SET player2_id = ?, status = 'placing' \
         WHERE id = ? AND mode = 'pvp' AND status = 'waiting' AND player2_id IS NULL AND player1_id <> ?",
        )
        .bind(user_id)
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await?;
    if r.rows_affected() == 1 {
        return Ok(JoinOutcome::Joined);
    }
    let row = sqlx::query("SELECT player1_id FROM games WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(
        match row {
            None => JoinOutcome::NotFound,
            Some(r) if r.get::<u64, _>("player1_id") == user_id => JoinOutcome::OwnGame,
            Some(_) => JoinOutcome::Unavailable,
        },
    )
}
