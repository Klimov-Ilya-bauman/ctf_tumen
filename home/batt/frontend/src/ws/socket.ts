import type { ClientMessage, GameId, ServerMessage } from '../api/types'

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface GameSocketHandlers {
  onMessage: (msg: ServerMessage) => void

  onStatus: (status: SocketStatus, attempt: number) => void
}

const BASE_DELAY = 500
const MAX_DELAY = 15_000

function socketUrl(gameId: GameId): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws?game=${gameId}`
}

function parse(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null
  try {
    const msg = JSON.parse(data)
    return msg && typeof msg.type === 'string' ? (msg as ServerMessage) : null
  } catch {
    return null
  }
}

export class GameSocket {
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly gameId: GameId
  private readonly handlers: GameSocketHandlers

  constructor(gameId: GameId, handlers: GameSocketHandlers) {
    this.gameId = gameId
    this.handlers = handlers
    window.addEventListener('online', this.reconnectNow)
    document.addEventListener('visibilitychange', this.onVisible)
    this.connect()
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  close() {
    this.stopped = true
    window.removeEventListener('online', this.reconnectNow)
    document.removeEventListener('visibilitychange', this.onVisible)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000)
    }
    this.handlers.onStatus('closed', this.attempt)
  }

  private connect = () => {
    if (this.stopped) return
    this.timer = null
    this.handlers.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting', this.attempt)
    const ws = new WebSocket(socketUrl(this.gameId))
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.handlers.onStatus('open', 0)
    }
    ws.onmessage = (e) => {
      const msg = parse(e.data)
      if (msg) this.handlers.onMessage(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return
      this.ws = null
      this.schedule()
    }
  }

  private schedule() {
    this.attempt++
    const exp = Math.min(MAX_DELAY, BASE_DELAY * 2 ** (this.attempt - 1))
    const delay = exp * (0.75 + Math.random() * 0.5)
    this.handlers.onStatus('reconnecting', this.attempt)
    this.timer = setTimeout(this.connect, delay)
  }

  private reconnectNow = () => {
    if (this.stopped || this.ws) return
    if (this.timer) clearTimeout(this.timer)
    this.connect()
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible') this.reconnectNow()
  }
}
