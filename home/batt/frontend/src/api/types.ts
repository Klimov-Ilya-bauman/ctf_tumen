

export type UserId = number
export type GameId = number

export interface User {
  id: UserId
  username: string
}

export interface Credentials {
  username: string
  password: string
}

export const BOARD_SIZE = 10

export const FLEET: readonly number[] = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1]

export interface Ship {
  x: number
  y: number
  len: number
  horizontal: boolean
}

export type ShotResult = 'miss' | 'hit' | 'sunk'

export interface Move {
  user_id: UserId
  x: number
  y: number
  result: ShotResult
  sunk: Ship | null
}

export type GameMode = 'bot' | 'pvp'
export type GameStatus = 'waiting' | 'placing' | 'active' | 'finished'

export interface GameInfo {
  id: GameId
  mode: GameMode
  status: GameStatus
  player1: UserId
  player2: UserId | null
  turn: UserId
  winner: UserId | null

  player1_name: string | null
  player2_name: string | null
  chat?: ChatMessage[]
}

export interface GameView {
  id: GameId
  mode: GameMode
  status: GameStatus
  turn: UserId
  winner: UserId | null
  player1: UserId
  player2: UserId | null
  my_ships: Ship[]
  placed: boolean

  my_shots: Move[]

  enemy_shots: Move[]

  enemy_ships: Ship[]
  player1_name: string | null
  player2_name: string | null
}

export interface SpectatorView {
  id: GameId
  mode: GameMode
  status: GameStatus
  turn: UserId
  winner: UserId | null
  player1: UserId
  player2: UserId | null
  player1_ships: Ship[]
  player2_ships: Ship[]
  moves: Move[]
  player1_name: string | null
  player2_name: string | null
}

export function isSpectatorView(g: GameView | SpectatorView): g is SpectatorView {
  return 'player1_ships' in g
}

export interface GameSummary {
  id: GameId
  mode: GameMode
  status: GameStatus
  winner: UserId | null

  opponent_name: string | null
}

export interface CreatedGame {
  id: GameId
  mode: GameMode
}

export interface JoinedGame {
  id: GameId
  status: GameStatus
}

export const CHAT_MAX_CHARS = 500

export interface ChatMessage {
  id: number
  user_id: UserId
  text: string

  created_at: number
}

export type ClientMessage =
  | { type: 'place_ships'; ships: Ship[] }
  | { type: 'fire'; x: number; y: number }
  | { type: 'chat_send'; text: string }

export type GameOverReason = 'victory' | 'timeout' | 'disconnected'

export type ServerMessage =
  | { type: 'state'; game: GameView | SpectatorView }
  | ({ type: 'shot_result'; turn: UserId } & Move)
  | { type: 'game_over'; winner: UserId | null; reason: GameOverReason }
  | { type: 'opponent_joined'; user_id: UserId }
  | { type: 'opponent_disconnected'; grace_secs: number }
  | { type: 'opponent_reconnected' }
  | { type: 'chat_message'; message: ChatMessage }
  | { type: 'error'; message: string }
