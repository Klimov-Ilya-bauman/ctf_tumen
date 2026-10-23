use axum::{
    Json, extract::{Path, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};
use crate::{
    auth::extractor::AuthUser,
    db::{
        chat_messages, games::{self, JoinOutcome},
        users,
    },
    error::AppError,
    game::{bot::random_fleet, state::{BOT_ID, Game, Mode, obfuscate_id}},
    state::AppState, ws::room::{self, ChatError},
};
#[derive(Deserialize)]
pub struct CreateGame {
    mode: Mode,
}
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateGame>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let id = games::create(&state.db, body.mode, user.user_id).await?;
    if body.mode == Mode::Bot {
        let ships = random_fleet(&mut rand::rng());
        games::save_board(&state.db, id, BOT_ID, &ships).await?;
    }
    Ok((StatusCode::CREATED, Json(json!({ "id" : id, "mode" : body.mode }))))
}
fn public_view(game: &Game) -> Value {
    json!(
        { "id" : game.id, "mode" : game.mode, "status" : game.status, "player1" :
        obfuscate_id(game.player1), "player2" : game.player2.map(obfuscate_id), "turn" :
        obfuscate_id(game.turn), "winner" : game.winner.map(obfuscate_id), }
    )
}
pub async fn get(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<u64>,
) -> Result<Json<Value>, AppError> {
    let game = games::load(&state.db, id).await?.ok_or(AppError::NotFound)?;
    let mut view = public_view(&game);
    let ids: Vec<u64> = [Some(game.player1), game.player2]
        .into_iter()
        .flatten()
        .collect();
    let names = users::usernames(&state.db, &ids).await?;
    view["player1_name"] = json!(names.get(& game.player1));
    view["player2_name"] = json!(game.player2.and_then(| p | names.get(& p)));
    if game.is_participant(user.user_id) {
        view["chat"] = json!(chat_messages::list(& state.db, id). await ?);
    }
    Ok(Json(view))
}
#[derive(Deserialize)]
pub struct ChatBody {
    text: String,
}
pub async fn chat(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<u64>,
    Json(body): Json<ChatBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let room = room::get_or_load(&state, id).await?.ok_or(AppError::NotFound)?;
    match room::send_chat(&state, &room, user.user_id, &body.text).await {
        Ok(message) => Ok((StatusCode::CREATED, Json(json!(message)))),
        Err(ChatError::NotParticipant) => Err(AppError::Forbidden),
        Err(ChatError::WrongStatus) => {
            Err(AppError::Conflict("chat is available while the game is in progress"))
        }
        Err(ChatError::Invalid(m)) => Err(AppError::BadRequest(m)),
        Err(ChatError::RateLimited) => Err(AppError::TooManyRequests),
        Err(ChatError::Internal) => Err(AppError::Internal),
    }
}
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, AppError> {
    let items: Vec<Value> = games::list_for_user(&state.db, user.user_id)
        .await?
        .into_iter()
        .map(|g| {
            json!(
                { "id" : g.id, "mode" : g.mode, "status" : g.status, "winner" : g
                .winner_id, "opponent_name" : g.opponent_name }
            )
        })
        .collect();
    Ok(Json(json!({ "games" : items })))
}
pub async fn join(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<u64>,
) -> Result<Json<Value>, AppError> {
    match games::join(&state.db, id, user.user_id).await? {
        JoinOutcome::Joined => {
            crate::ws::room::opponent_joined(&state, id, user.user_id).await;
            Ok(Json(json!({ "id" : id, "status" : "placing" })))
        }
        JoinOutcome::NotFound => Err(AppError::NotFound),
        JoinOutcome::OwnGame => Err(AppError::Conflict("cannot join your own game")),
        JoinOutcome::Unavailable => {
            Err(AppError::Conflict("game is not available for joining"))
        }
    }
}
