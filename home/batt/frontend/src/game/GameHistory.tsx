import { memo, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { describeError } from '../api/errors'
import { gamesApi } from '../api/games'
import type { GameStatus, GameSummary, UserId } from '../api/types'
import Note from '../ui/Note'

const STATUS: Record<GameStatus, string> = {
  waiting: 'ждёт соперника',
  placing: 'расстановка',
  active: 'идёт бой',
  finished: 'окончена',
}

function outcome(g: GameSummary, me: UserId): { text: string; cls: string } {
  if (g.status !== 'finished') return { text: 'продолжить →', cls: 'go' }
  if (g.winner === me) return { text: 'победа', cls: 'win' }
  return { text: 'поражение', cls: 'loss' }
}

function GameHistory({ me, refresh = 0 }: { me: UserId;  refresh?: number }) {
  const [games, setGames] = useState<GameSummary[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    gamesApi
      .list()
      .then((g) => alive && setGames(g))
      .catch((e) => alive && setError(describeError(e, 'Не удалось загрузить историю.')))
    return () => {
      alive = false
    }
  }, [refresh])

  if (error) return <Note kind="error">{error}</Note>
  if (!games) return <p className="muted">Листаем тетрадь…</p>
  if (games.length === 0) return <p className="muted">Партий пока нет — самое время сыграть первую.</p>

  return (
    <ol className="history">
      {games.map((g) => {
        const o = outcome(g, me)
        return (
          <li key={g.id}>
            <Link to={`/game/${g.id}`} className="history-row">
              <span className="history-id">№{g.id}</span>
              <span className="history-vs">{g.mode === 'bot' ? 'с ботом' : g.opponent_name ? `с ${g.opponent_name}` : 'ждёт соперника'}</span>
              <span className="muted">{STATUS[g.status]}</span>
              <span className={`history-outcome ${o.cls}`}>{o.text}</span>
            </Link>
          </li>
        )
      })}
    </ol>
  )
}

export default memo(GameHistory)
