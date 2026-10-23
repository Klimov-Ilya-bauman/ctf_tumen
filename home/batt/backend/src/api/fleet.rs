use axum::Json;
use serde_json::{Value, json};
use crate::{auth::extractor::AuthUser, game::bot::random_fleet};
pub async fn random(_user: AuthUser) -> Json<Value> {
    Json(json!({ "ships" : random_fleet(& mut rand::rng()) }))
}
