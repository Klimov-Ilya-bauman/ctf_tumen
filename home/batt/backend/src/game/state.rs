use std::collections::HashMap;
use serde::Serialize;
use super::{
    board::{Coord, Ship},
    rules::{Board, FireError, FleetError, ShotResult},
};
pub const BOT_ID: u64 = 0;
const HASH_DOMAIN: u32 = 1_000_000;
const HASH_HALF: u32 = 1024;
const HASH_KEYS: [u32; 4] = [0x9E37, 0x85EB, 0xC2B2, 0x27D4];
fn hash_round(x: u32, k: u32) -> u32 {
    let mut x = x.wrapping_mul(0x45D9F3B).wrapping_add(k);
    x ^= x >> 15;
    x = x.wrapping_mul(0x2C1B3C6D);
    x ^= x >> 12;
    x % HASH_HALF
}
fn feistel(v: u32) -> u32 {
    let mut l = v >> 10;
    let mut r = v & 1023;
    for &k in HASH_KEYS.iter() {
        let next = l ^ hash_round(r, k);
        l = r;
        r = next;
    }
    (l << 10) | r
}
pub fn obfuscate_id(user_id: u64) -> u32 {
    let mut v = feistel(user_id as u32);
    while v >= HASH_DOMAIN {
        v = feistel(v);
    }
    v
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Bot,
    Pvp,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Waiting,
    Placing,
    Active,
    Finished,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MoveResult {
    Miss,
    Hit,
    Sunk,
}
impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Bot => "bot",
            Mode::Pvp => "pvp",
        }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "bot" => Some(Mode::Bot),
            "pvp" => Some(Mode::Pvp),
            _ => None,
        }
    }
}
impl<'de> serde::Deserialize<'de> for Mode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Mode::from_db(&s)
            .ok_or_else(|| serde::de::Error::custom("mode must be 'bot' or 'pvp'"))
    }
}
impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Waiting => "waiting",
            Status::Placing => "placing",
            Status::Active => "active",
            Status::Finished => "finished",
        }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "waiting" => Some(Status::Waiting),
            "placing" => Some(Status::Placing),
            "active" => Some(Status::Active),
            "finished" => Some(Status::Finished),
            _ => None,
        }
    }
}
impl MoveResult {
    pub fn as_str(self) -> &'static str {
        match self {
            MoveResult::Miss => "miss",
            MoveResult::Hit => "hit",
            MoveResult::Sunk => "sunk",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Move {
    pub user_id: u64,
    pub x: u8,
    pub y: u8,
    pub result: MoveResult,
    pub sunk: Option<Ship>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum GameError {
    NotParticipant,
    WrongStatus,
    AlreadyPlaced,
    NotYourTurn,
    BadFleet(FleetError),
    BadShot(FireError),
}
pub struct Game {
    pub id: u64,
    pub mode: Mode,
    pub status: Status,
    pub player1: u64,
    pub player2: Option<u64>,
    pub turn: u64,
    pub winner: Option<u64>,
    boards: HashMap<u64, Board>,
    moves: Vec<Move>,
}
#[derive(Serialize)]
pub struct MoveView {
    pub user_id: u32,
    pub x: u8,
    pub y: u8,
    pub result: MoveResult,
    pub sunk: Option<Ship>,
}
fn move_view(m: &Move) -> MoveView {
    MoveView {
        user_id: obfuscate_id(m.user_id),
        x: m.x,
        y: m.y,
        result: m.result,
        sunk: m.sunk.clone(),
    }
}
#[derive(Serialize)]
pub struct GameView {
    pub id: u64,
    pub mode: Mode,
    pub status: Status,
    pub turn: u32,
    pub winner: Option<u32>,
    pub player1: u32,
    pub player2: Option<u32>,
    pub my_ships: Vec<Ship>,
    pub placed: bool,
    pub my_shots: Vec<MoveView>,
    pub enemy_shots: Vec<MoveView>,
    pub enemy_ships: Vec<Ship>,
}
#[derive(Serialize)]
pub struct SpectatorView {
    pub id: u64,
    pub mode: Mode,
    pub status: Status,
    pub turn: u32,
    pub winner: Option<u32>,
    pub player1: u32,
    pub player2: Option<u32>,
    pub player1_ships: Vec<Ship>,
    pub player2_ships: Vec<Ship>,
    pub moves: Vec<MoveView>,
}
impl Game {
    pub fn is_participant(&self, user: u64) -> bool {
        user == self.player1 || self.player2 == Some(user)
    }
    pub fn opponent(&self, user: u64) -> Option<u64> {
        if user == self.player1 {
            self.player2
        } else if self.player2 == Some(user) {
            Some(self.player1)
        } else {
            None
        }
    }
    pub fn has_board(&self, user: u64) -> bool {
        self.boards.contains_key(&user)
    }
    pub fn board_ships(&self, user: u64) -> Option<&[Ship]> {
        self.boards.get(&user).map(|b| b.ships())
    }
    pub fn moves(&self) -> &[Move] {
        &self.moves
    }
    pub fn join(&mut self, user: u64) -> Result<(), GameError> {
        if self.mode != Mode::Pvp || self.status != Status::Waiting
            || self.player2.is_some()
        {
            return Err(GameError::WrongStatus);
        }
        if user == self.player1 {
            return Err(GameError::NotParticipant);
        }
        self.player2 = Some(user);
        self.status = Status::Placing;
        Ok(())
    }
    pub fn forfeit(&mut self, loser: u64) -> Result<(), GameError> {
        if self.status != Status::Active {
            return Err(GameError::WrongStatus);
        }
        let winner = self.opponent(loser).ok_or(GameError::NotParticipant)?;
        self.status = Status::Finished;
        self.winner = Some(winner);
        Ok(())
    }
    pub fn place_ships(&mut self, user: u64, ships: Vec<Ship>) -> Result<(), GameError> {
        if !self.is_participant(user) {
            return Err(GameError::NotParticipant);
        }
        if self.status != Status::Placing {
            return Err(GameError::WrongStatus);
        }
        if self.has_board(user) {
            return Err(GameError::AlreadyPlaced);
        }
        let board = Board::new(ships).map_err(GameError::BadFleet)?;
        self.boards.insert(user, board);
        if self
            .player2
            .is_some_and(|p2| self.has_board(self.player1) && self.has_board(p2))
        {
            self.status = Status::Active;
            self.turn = self.player1;
        }
        Ok(())
    }
    pub fn fire(&mut self, user: u64, c: Coord) -> Result<Move, GameError> {
        if !self.is_participant(user) {
            return Err(GameError::NotParticipant);
        }
        if self.status != Status::Active {
            return Err(GameError::WrongStatus);
        }
        if self.turn != user {
            return Err(GameError::NotYourTurn);
        }
        let enemy = self.opponent(user).ok_or(GameError::WrongStatus)?;
        self.shoot(user, enemy, c)
    }
    pub fn commit_shot(&mut self, user: u64, mv: &Move) {
        let Some(enemy) = self.opponent(user) else { return };
        let all_sunk = self.boards.get(&enemy).is_some_and(|b| b.all_sunk());
        if all_sunk {
            self.status = Status::Finished;
            self.winner = Some(user);
        } else if mv.result == MoveResult::Miss {
            self.turn = enemy;
        }
    }
    fn shoot(&mut self, user: u64, enemy: u64, c: Coord) -> Result<Move, GameError> {
        let board = self.boards.get_mut(&enemy).ok_or(GameError::WrongStatus)?;
        let (result, sunk) = match board.fire(c).map_err(GameError::BadShot)? {
            ShotResult::Miss => (MoveResult::Miss, None),
            ShotResult::Hit => (MoveResult::Hit, None),
            ShotResult::Sunk(ship) => (MoveResult::Sunk, Some(ship)),
        };
        let mv = Move {
            user_id: user,
            x: c.x,
            y: c.y,
            result,
            sunk,
        };
        self.moves.push(mv.clone());
        Ok(mv)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn restore(
        id: u64,
        mode: Mode,
        status: Status,
        player1: u64,
        player2: Option<u64>,
        turn: u64,
        winner: Option<u64>,
        boards: Vec<(u64, Vec<Ship>)>,
        moves: &[(u64, Coord)],
    ) -> Result<Self, GameError> {
        let player2 = if mode == Mode::Bot { Some(BOT_ID) } else { player2 };
        let mut game = Game {
            id,
            mode,
            status,
            player1,
            player2,
            turn,
            winner,
            boards: HashMap::new(),
            moves: Vec::new(),
        };
        for (user, ships) in boards {
            game.boards.insert(user, Board::new(ships).map_err(GameError::BadFleet)?);
        }
        for &(user, c) in moves {
            let enemy = game.opponent(user).ok_or(GameError::NotParticipant)?;
            game.shoot(user, enemy, c)?;
        }
        Ok(game)
    }
    pub fn spectator_view(&self) -> SpectatorView {
        SpectatorView {
            id: self.id,
            mode: self.mode,
            status: self.status,
            turn: obfuscate_id(self.turn),
            winner: self.winner.map(obfuscate_id),
            player1: obfuscate_id(self.player1),
            player2: self.player2.map(obfuscate_id),
            player1_ships: self
                .board_ships(self.player1)
                .map(|s| s.to_vec())
                .unwrap_or_default(),
            player2_ships: self
                .player2
                .and_then(|p2| self.board_ships(p2))
                .map(|s| s.to_vec())
                .unwrap_or_default(),
            moves: self.moves.iter().map(move_view).collect(),
        }
    }
    pub fn view_for(&self, user: u64) -> GameView {
        let enemy = self.opponent(user);
        GameView {
            id: self.id,
            mode: self.mode,
            status: self.status,
            turn: obfuscate_id(self.turn),
            winner: self.winner.map(obfuscate_id),
            player1: obfuscate_id(self.player1),
            player2: self.player2.map(obfuscate_id),
            my_ships: self
                .boards
                .get(&user)
                .map(|b| b.ships().to_vec())
                .unwrap_or_default(),
            placed: self.has_board(user),
            my_shots: self
                .moves
                .iter()
                .filter(|m| m.user_id == user)
                .map(move_view)
                .collect(),
            enemy_shots: self
                .moves
                .iter()
                .filter(|m| Some(m.user_id) == enemy)
                .map(move_view)
                .collect(),
            enemy_ships: match (self.status, enemy) {
                (Status::Finished, Some(e)) => {
                    self.board_ships(e).map(|s| s.to_vec()).unwrap_or_default()
                }
                _ => Vec::new(),
            },
        }
    }
}
