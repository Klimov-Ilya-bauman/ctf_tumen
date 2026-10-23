use axum::{extract::FromRequestParts, http::{header::COOKIE, request::Parts}};
use crate::{auth::jwt, error::AppError, state::AppState};
pub struct AuthUser {
    pub user_id: u64,
}
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, AppError> {
        let header = parts
            .headers
            .get(COOKIE)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let token = jwt::cookie_value(header).ok_or(AppError::Unauthorized)?;
        let user_id = jwt::verify(token, &state.session_key)
            .ok_or(AppError::Unauthorized)?;
        Ok(AuthUser { user_id })
    }
}
