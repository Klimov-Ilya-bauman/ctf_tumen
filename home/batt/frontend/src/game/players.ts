import type { GameMode, User, UserId } from '../api/types'

export interface Players {
  me: string
  them: string
  isBot: boolean
  byId: Readonly<Record<UserId, string>>
}

interface Source {
  mode: GameMode
  player1: UserId
  player2: UserId | null
  player1_name: string | null
  player2_name: string | null
}

export function players(g: Source, user: User): Players {
  const isBot = g.mode === 'bot'
  const iAmFirst = g.player1 === user.id
  const themId = iAmFirst ? g.player2 : g.player1

  const them = isBot ? 'Бот' : ((iAmFirst ? g.player2_name : g.player1_name) ?? 'Соперник')
  const byId: Record<UserId, string> = { [user.id]: user.username }
  if (themId !== null) byId[themId] = them
  return { me: user.username, them, isBot, byId }
}
