import { request } from './client'
import type { ChatMessage, CreatedGame, GameId, GameInfo, GameMode, GameSummary, JoinedGame } from './types'

export const gamesApi = {
  create: (mode: GameMode) => request<CreatedGame>('POST', '/api/games', { mode }),
  list: () => request<{ games: GameSummary[] }>('GET', '/api/games').then((r) => r.games),
  get: (id: GameId) => request<GameInfo>('GET', `/api/games/${id}`),
  join: (id: GameId) => request<JoinedGame>('POST', `/api/games/${id}/join`),

  sendChat: (id: GameId, text: string) => request<ChatMessage>('POST', `/api/games/${id}/chat`, { text }),
}

export function parseRoomCode(raw: string): GameId | null {
  const m = raw.trim().match(/(?:game\/)?#?(\d{1,18})\/?$/)
  if (!m) return null
  const id = Number(m[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
