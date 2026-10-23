use axum::{Json, extract::State, http::StatusCode};
use serde_json::{Value, json};
use crate::state::AppState;
pub async fn health(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "status" : "ok" }))),
        Err(e) => {
            tracing::error!("health check: db error: {e}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status" : "db_unavailable" })),
            )
        }
    }
}
