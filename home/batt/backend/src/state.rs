use std::sync::Arc;
use dashmap::DashMap;
use jsonwebtoken::DecodingKey;
use sqlx::MySqlPool;
use crate::ws::room::Room;
#[derive(Clone)]
pub struct AppState {
    pub db: MySqlPool,
    pub rooms: Arc<DashMap<u64, Arc<Room>>>,
    pub session_key: Arc<DecodingKey>,
    pub reports_dir: Arc<String>,
}
