pub mod auth;
pub mod fleet;
pub mod games;
pub mod health;
use axum::{Router, routing::{get, post}};
use crate::state::AppState;
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health::health))
        .route("/api/me", get(auth::me))
        .route("/api/fleet/random", post(fleet::random))
        .route("/api/games", post(games::create).get(games::list))
        .route("/api/games/{id}", get(games::get))
        .route("/api/games/{id}/join", post(games::join))
        .route("/api/games/{id}/chat", post(games::chat))
        .route("/ws", get(crate::ws::ws_handler))
}
