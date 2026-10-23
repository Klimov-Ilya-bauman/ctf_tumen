pub mod room;
use std::sync::atomic::{AtomicU64, Ordering};
use axum::{
    extract::{Query, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{HeaderMap, header},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use crate::{
    auth::extractor::AuthUser, error::AppError,
    game::{
        board::{Coord, Ship},
        state::Status,
    },
    state::AppState,
};
use room::{Conn, Room};
static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);
#[derive(Deserialize)]
pub struct WsQuery {
    game: u64,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    PlaceShips { ships: Vec<Ship> },
    Fire { x: u8, y: u8 },
    ChatSend { text: String },
}
fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let origin_host = origin.split_once("://").map(|(_, h)| h);
    matches!((origin_host, host), (Some(o), Some(h)) if o == h)
}
pub async fn ws_handler(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<WsQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, AppError> {
    if !origin_allowed(&headers) {
        return Err(AppError::Forbidden);
    }
    let room = room::get_or_load(&state, q.game).await?.ok_or(AppError::NotFound)?;
    Ok(upgrade.on_upgrade(move |socket| client_loop(socket, state, room, user.user_id)))
}
async fn client_loop(
    socket: WebSocket,
    state: AppState,
    room: std::sync::Arc<Room>,
    user_id: u64,
) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let conn_id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    {
        let mut inner = room.inner.lock().await;
        room::add_conn(
            &state,
            &room,
            &mut inner,
            Conn {
                id: conn_id,
                user_id,
                tx: tx.clone(),
            },
        );
    }
    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(text) = msg else {
            if matches!(msg, Message::Close(_)) {
                break;
            }
            continue;
        };
        let result = match serde_json::from_str::<ClientMsg>(&text) {
            Ok(ClientMsg::PlaceShips { ships }) => {
                room::place_ships(&state, &room, user_id, ships).await
            }
            Ok(ClientMsg::Fire { x, y }) => {
                room::fire(&state, &room, user_id, Coord { x, y }).await
            }
            Ok(ClientMsg::ChatSend { text }) => {
                room::send_chat(&state, &room, user_id, &text)
                    .await
                    .map(|_| ())
                    .map_err(|e| format!("cannot send chat message: {e:?}"))
            }
            Err(_) => Err("invalid message".to_string()),
        };
        if let Err(message) = result {
            let _ = tx
                .send(json!({ "type" : "error", "message" : message }).to_string());
        }
    }
    let mut inner = room.inner.lock().await;
    room::remove_conn(&mut inner, conn_id);
    if inner.conns.is_empty() && inner.game.status == Status::Finished {
        state.rooms.remove(&inner.game.id);
    }
    drop(inner);
    writer.abort();
}
