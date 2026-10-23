use std::{collections::VecDeque, time::{Duration, Instant}};
use serde::{Serialize, Serializer};
use super::state::obfuscate_id;
pub const MAX_TEXT_CHARS: usize = 500;
pub const RATE_LIMIT_COUNT: usize = 5;
pub const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(10);
fn serialize_hashed_id<S: Serializer>(id: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_u32(obfuscate_id(*id))
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub id: u64,
    #[serde(serialize_with = "serialize_hashed_id")]
    pub user_id: u64,
    pub text: String,
    pub created_at: u64,
}
#[derive(Debug, PartialEq, Eq)]
pub enum TextError {
    Empty,
    TooLong,
}
pub fn clean_text(raw: &str) -> Result<String, TextError> {
    let text: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .collect();
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(TextError::Empty);
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(TextError::TooLong);
    }
    Ok(text)
}
#[derive(Default)]
pub struct RateLimiter {
    sent: VecDeque<Instant>,
}
impl RateLimiter {
    pub fn allow(&mut self, now: Instant) -> bool {
        while self
            .sent
            .front()
            .is_some_and(|t| now.duration_since(*t) >= RATE_LIMIT_WINDOW)
        {
            self.sent.pop_front();
        }
        if self.sent.len() >= RATE_LIMIT_COUNT {
            return false;
        }
        self.sent.push_back(now);
        true
    }
}
