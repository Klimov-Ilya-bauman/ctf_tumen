use std::collections::HashMap;
use sqlx::{MySqlPool, Row};
pub async fn find_by_id(
    pool: &MySqlPool,
    id: u64,
) -> Result<Option<(u64, String)>, sqlx::Error> {
    let row = sqlx::query("SELECT id, username FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| (r.get("id"), r.get("username"))))
}
pub async fn usernames(
    pool: &MySqlPool,
    ids: &[u64],
) -> Result<HashMap<u64, String>, sqlx::Error> {
    let mut out = HashMap::new();
    for &id in ids {
        if let Some((id, name)) = find_by_id(pool, id).await? {
            out.insert(id, name);
        }
    }
    Ok(out)
}
