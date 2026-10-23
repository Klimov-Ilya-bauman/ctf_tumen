use axum::{Json, extract::State};
use serde_json::{Value, json};
use crate::{
    auth::extractor::AuthUser, db::users, error::AppError, game::state::obfuscate_id,
    state::AppState,
};
pub async fn me(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, AppError> {
    let (id, username) = users::find_by_id(&state.db, user.user_id)
        .await?
        .ok_or(AppError::Unauthorized)?;
    Ok(Json(json!({ "id" : obfuscate_id(id), "username" : username })))
}
