use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
pub const COOKIE_NAME: &str = "session";
#[derive(Debug, Deserialize)]
pub struct Claims {
    pub sub: String,
}
pub fn cookie_value(header: &str) -> Option<&str> {
    header
        .split(';')
        .find_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            (name == COOKIE_NAME).then_some(value)
        })
}
pub fn verify(token: &str, key: &DecodingKey) -> Option<u64> {
    let validation = Validation::new(Algorithm::RS256);
    let data = decode::<Claims>(token, key, &validation).ok()?;
    data.claims.sub.parse().ok()
}
