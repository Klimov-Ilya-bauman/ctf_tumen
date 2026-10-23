use axum::{Json, http::StatusCode, response::{IntoResponse, Response}};
use serde_json::json;
#[derive(Debug)]
pub enum AppError {
    BadRequest(&'static str),
    Unauthorized,
    Forbidden,
    NotFound,
    TooManyRequests,
    Conflict(&'static str),
    Internal,
}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found"),
            AppError::TooManyRequests => {
                (StatusCode::TOO_MANY_REQUESTS, "too many messages")
            }
            AppError::Conflict(m) => (StatusCode::CONFLICT, m),
            AppError::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
        };
        (status, Json(json!({ "error" : msg }))).into_response()
    }
}
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!("db error: {e}");
        AppError::Internal
    }
}
