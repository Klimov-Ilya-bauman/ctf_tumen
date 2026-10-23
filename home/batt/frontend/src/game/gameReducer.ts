import { describeServerText } from '../api/errors'
import { isSpectatorView, type ChatMessage, type GameInfo, type GameOverReason, type GameView, type Move, type ServerMessage, type ShotResult, type SpectatorView, type UserId } from '../api/types'
import { idx } from './boardModel'

export interface LogEntry {
  n: number
  mine: boolean
  x: number
  y: number
  result: ShotResult
}

export interface Notice {
  kind: 'info' | 'error'
  text: string
  n: number
}

export interface GameState {

  view: GameView | SpectatorView | null

  pending: number | null

  submitting: boolean

  log: LogEntry[]

  fxEnemy: LogEntry[]
  fxOwn: LogEntry[]

  lastMine: ShotResult | null
  lastTheirs: ShotResult | null
  over: { winner: UserId | null; reason: GameOverReason | null } | null

  away: { since: number; grace: number } | null
  notice: Notice | null

  chat: ChatMessage[] | null

  finishedAt: number | null
}

export type GameAction =
  | { type: 'info'; info: GameInfo }
  | { type: 'server'; msg: ServerMessage; me: UserId }
  | { type: 'fire'; x: number; y: number }
  | { type: 'submit' }
  | { type: 'notice'; kind: Notice['kind']; text: string }
  | { type: 'clear-notice' }
  | { type: 'tick' }

export const POST_GAME_CHAT_GRACE_MS = 10_000

export const initialGameState: GameState = {
  view: null,
  pending: null,
  submitting: false,
  log: [],
  fxEnemy: [],
  fxOwn: [],
  lastMine: null,
  lastTheirs: null,
  over: null,
  away: null,
  notice: null,
  chat: null,
  finishedAt: null,
}

const LOG_LIMIT = 40

const FX_LIMIT = 6
let noticeSeq = 0
let logSeq = 0

function addChat(chat: ChatMessage[] | null, msgs: ChatMessage[]): ChatMessage[] {
  const out = chat ? [...chat] : []
  const seen = new Set(out.map((m) => m.id))
  for (const m of msgs) if (!seen.has(m.id)) out.push(m)
  return out.sort((a, b) => a.id - b.id)
}

function notice(kind: Notice['kind'], text: string): Notice {
  return { kind, text, n: ++noticeSeq }
}

function applyShot(s: GameState, m: Move & { turn: UserId }, me: UserId): GameState {
  if (!s.view) return s
  const move: Move = { user_id: m.user_id, x: m.x, y: m.y, result: m.result, sunk: m.sunk }

  if (isSpectatorView(s.view)) {
    const view: SpectatorView = { ...s.view, turn: m.turn, moves: [...s.view.moves, move] }
    const entry: LogEntry = { n: ++logSeq, mine: false, x: m.x, y: m.y, result: m.result }
    return { ...s, view, log: [entry, ...s.log].slice(0, LOG_LIMIT) }
  }

  const mine = m.user_id === me
  const view: GameView = {
    ...s.view,
    turn: m.turn,
    my_shots: mine ? [...s.view.my_shots, move] : s.view.my_shots,
    enemy_shots: mine ? s.view.enemy_shots : [...s.view.enemy_shots, move],
  }
  const entry: LogEntry = { n: ++logSeq, mine, x: m.x, y: m.y, result: m.result }
  return {
    ...s,
    view,
    pending: mine ? null : s.pending,
    lastMine: mine ? m.result : s.lastMine,
    lastTheirs: mine ? s.lastTheirs : m.result,
    log: [entry, ...s.log].slice(0, LOG_LIMIT),
    fxEnemy: mine ? [...s.fxEnemy, entry].slice(-FX_LIMIT) : s.fxEnemy,
    fxOwn: mine ? s.fxOwn : [...s.fxOwn, entry].slice(-FX_LIMIT),
  }
}

function applyServer(s: GameState, msg: ServerMessage, me: UserId): GameState {
  switch (msg.type) {
    case 'state': {
      const g = msg.game
      const finished = g.status === 'finished'

      const joined = s.view !== null && s.view.player2 === null && g.player2 !== null
      const joinedName = (g.player1 === me ? g.player2_name : g.player1_name) ?? 'Соперник'
      return {
        ...s,
        view: g,
        notice: joined ? notice('info', `${joinedName} вступает в партию — расставляйте корабли!`) : s.notice,
        pending: null,
        submitting: s.submitting && !isSpectatorView(g) && !g.placed && g.status === 'placing',
        over: finished ? (s.over ?? { winner: g.winner, reason: null }) : null,
        away: finished ? null : s.away,
        finishedAt: finished ? (s.finishedAt ?? Date.now()) : s.finishedAt,
      }
    }
    case 'shot_result':
      return applyShot(s, msg, me)
    case 'game_over':
      return {
        ...s,
        view: s.view && { ...s.view, status: 'finished', winner: msg.winner },
        pending: null,
        over: { winner: msg.winner, reason: msg.reason },
        away: null,
        finishedAt: s.finishedAt ?? Date.now(),
      }
    case 'opponent_joined':

      return s
    case 'opponent_disconnected':
      return s.view?.status === 'finished' ? s : { ...s, away: { since: Date.now(), grace: msg.grace_secs } }
    case 'opponent_reconnected':
      return s.away ? { ...s, away: null, notice: notice('info', 'Соперник вернулся.') } : s
    case 'chat_message':
      return { ...s, chat: addChat(s.chat, [msg.message]) }
    case 'error':
      return {
        ...s,
        pending: null,
        submitting: false,
        notice: notice('error', describeServerText(msg.message) ?? 'Сервер отклонил действие.'),
      }
    default:
      return s
  }
}

export function gameReducer(s: GameState, a: GameAction): GameState {
  switch (a.type) {
    case 'info':
      return a.info.chat ? { ...s, chat: addChat(s.chat, a.info.chat) } : s
    case 'server':
      return applyServer(s, a.msg, a.me)
    case 'fire':
      return { ...s, pending: idx(a.x, a.y), notice: null }
    case 'submit':
      return { ...s, submitting: true, notice: null }
    case 'notice':
      return { ...s, notice: notice(a.kind, a.text) }
    case 'clear-notice':
      return s.notice ? { ...s, notice: null } : s
    case 'tick':

      return { ...s }
  }
}
