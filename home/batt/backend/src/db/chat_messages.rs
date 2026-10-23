use sqlx::{MySqlPool, Row};
use crate::game::chat::ChatMessage;
fn from_row(r: sqlx::mysql::MySqlRow) -> ChatMessage {
    ChatMessage {
        id: r.get("id"),
        user_id: r.get("user_id"),
        text: r.get("text"),
        created_at: r.get("ts"),
    }
}
pub async fn insert(
    pool: &MySqlPool,
    game_id: u64,
    user_id: u64,
    text: &str,
) -> Result<ChatMessage, sqlx::Error> {
    let id = sqlx::query(
            "INSERT INTO chat_messages (game_id, user_id, text) VALUES (?, ?, ?)",
        )
        .bind(game_id)
        .bind(user_id)
        .bind(text)
        .execute(pool)
        .await?
        .last_insert_id();
    let row = sqlx::query(
            "SELECT id, user_id, text, CAST(UNIX_TIMESTAMP(created_at) AS UNSIGNED) AS ts FROM chat_messages WHERE id = ?",
        )
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(from_row(row))
}
pub async fn list(
    pool: &MySqlPool,
    game_id: u64,
) -> Result<Vec<ChatMessage>, sqlx::Error> {
    let rows = sqlx::query(
            "SELECT id, user_id, text, CAST(UNIX_TIMESTAMP(created_at) AS UNSIGNED) AS ts FROM \
         (SELECT * FROM chat_messages WHERE game_id = ? ORDER BY id DESC LIMIT 200) t ORDER BY id",
        )
        .bind(game_id)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(from_row).collect())
}
