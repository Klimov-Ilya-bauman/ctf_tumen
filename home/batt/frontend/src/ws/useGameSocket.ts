import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientMessage, GameId, ServerMessage } from '../api/types'
import { GameSocket, type SocketStatus } from './socket'

export function useGameSocket(gameId: GameId | null, onMessage: (msg: ServerMessage) => void) {
  const [status, setStatus] = useState<SocketStatus>('connecting')
  const [attempt, setAttempt] = useState(0)
  const socket = useRef<GameSocket | null>(null)
  const handler = useRef(onMessage)

  useEffect(() => {
    handler.current = onMessage
  }, [onMessage])

  useEffect(() => {
    if (gameId === null) return
    const s = new GameSocket(gameId, {
      onMessage: (m) => handler.current(m),
      onStatus: (st, n) => {
        setStatus(st)
        setAttempt(n)
      },
    })
    socket.current = s
    return () => {
      s.close()
      socket.current = null
    }
  }, [gameId])

  const send = useCallback((msg: ClientMessage) => socket.current?.send(msg) ?? false, [])

  return { status, attempt, send }
}
