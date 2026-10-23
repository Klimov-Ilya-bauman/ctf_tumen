use std::env;
pub struct Config {
    pub database_url: String,
    pub listen_addr: String,
    pub php_auth_internal_url: String,
    pub reports_dir: String,
}
impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL").expect("DATABASE_URL must be set"),
            listen_addr: env::var("LISTEN_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:8000".into()),
            php_auth_internal_url: env::var("PHP_AUTH_INTERNAL_URL")
                .unwrap_or_else(|_| "http://php-auth:8080".into()),
            reports_dir: env::var("REPORTS_DIR")
                .unwrap_or_else(|_| "/data/reports".into()),
        }
    }
}
