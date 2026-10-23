use std::{sync::Arc, time::Duration};
use serde_json::json;
use sqlx::MySqlPool;
use crate::{
    db::{chat_messages, games},
    game::state::obfuscate_id,
};
const DELAY: Duration = Duration::from_secs(1);
pub fn schedule(pool: MySqlPool, reports_dir: Arc<String>, game_id: u64) {
    tokio::spawn(async move {
        tokio::time::sleep(DELAY).await;
        if let Err(e) = generate(&pool, &reports_dir, game_id).await {
            tracing::error!("report generation failed for game {game_id}: {e}");
        }
    });
}
async fn generate(
    pool: &MySqlPool,
    reports_dir: &str,
    game_id: u64,
) -> Result<(), ReportError> {
    let game = games::load(pool, game_id).await?.ok_or(ReportError::NotFound)?;
    let moves = games::list_moves(pool, game_id).await?;
    let chat = chat_messages::list(pool, game_id).await?;
    let report = json!(
        { "game_id" : game.id, "mode" : game.mode, "status" : game.status, "winner_id" :
        game.winner.map(obfuscate_id), "player1_id" : obfuscate_id(game.player1),
        "player2_id" : game.player2.map(obfuscate_id), "moves" : moves, "chat" : chat, }
    );
    let dir = std::path::Path::new(reports_dir);
    tokio::fs::create_dir_all(dir).await.map_err(ReportError::Io)?;
    let final_path = dir.join(format!("{game_id}.json"));
    let tmp_path = dir.join(format!("{game_id}.json.tmp"));
    let body = serde_json::to_vec_pretty(&report).map_err(ReportError::Serialize)?;
    tokio::fs::write(&tmp_path, &body).await.map_err(ReportError::Io)?;
    tokio::fs::rename(&tmp_path, &final_path).await.map_err(ReportError::Io)?;
    Ok(())
}
#[derive(Debug)]
enum ReportError {
    NotFound,
    Db(sqlx::Error),
    Io(std::io::Error),
    Serialize(serde_json::Error),
}
impl From<sqlx::Error> for ReportError {
    fn from(e: sqlx::Error) -> Self {
        ReportError::Db(e)
    }
}
impl std::fmt::Display for ReportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReportError::NotFound => write!(f, "game not found"),
            ReportError::Db(e) => write!(f, "db error: {e}"),
            ReportError::Io(e) => write!(f, "io error: {e}"),
            ReportError::Serialize(e) => write!(f, "serialize error: {e}"),
        }
    }
}
