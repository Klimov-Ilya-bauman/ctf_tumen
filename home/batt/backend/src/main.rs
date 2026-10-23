mod api;
mod auth;
mod config;
mod db;
mod error;
mod game;
mod report;
mod state;
mod ws;
use std::sync::Arc;
use jsonwebtoken::DecodingKey;
use sqlx::mysql::MySqlPoolOptions;
use crate::{config::Config, state::AppState};
async fn fetch_session_public_key(base_url: &str) -> Vec<u8> {
    let url = format!("{base_url}/internal/session-key");
    for attempt in 1..=10 {
        match reqwest::get(&url).await {
            Ok(resp) if resp.status().is_success() => {
                match resp.bytes().await {
                    Ok(body) => return body.to_vec(),
                    Err(e) => {
                        tracing::warn!(
                            "attempt {attempt}: failed to read {url} body: {e}"
                        )
                    }
                }
            }
            Ok(resp) => {
                tracing::warn!("attempt {attempt}: {url} returned {}", resp.status())
            }
            Err(e) => tracing::warn!("attempt {attempt}: failed to reach {url}: {e}"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    panic!("could not fetch session public key from {url} after 10 attempts");
}
#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let config = Config::from_env();
    let db = MySqlPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .expect("failed to connect to MySQL");
    sqlx::migrate!("./migrations").run(&db).await.expect("failed to run migrations");
    let key_pem = fetch_session_public_key(&config.php_auth_internal_url).await;
    let session_key = DecodingKey::from_rsa_pem(&key_pem)
        .expect("php-auth /internal/session-key must return a valid RSA public key");
    std::fs::create_dir_all(&config.reports_dir)
        .unwrap_or_else(|e| panic!("failed to create {}: {e}", config.reports_dir));
    let app = api::router()
        .with_state(AppState {
            db,
            rooms: Default::default(),
            session_key: Arc::new(session_key),
            reports_dir: Arc::new(config.reports_dir.clone()),
        });
    let listener = tokio::net::TcpListener::bind(&config.listen_addr)
        .await
        .expect("failed to bind");
    tracing::info!("listening on {}", config.listen_addr);
    axum::serve(listener, app).await.expect("server error");
}
