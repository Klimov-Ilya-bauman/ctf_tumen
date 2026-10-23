import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { ApiError } from '../api/client'
import { describeError } from '../api/errors'
import { gamesApi, parseRoomCode } from '../api/games'
import type { GameId } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import GameHistory from '../game/GameHistory'
import InviteBox from '../game/InviteBox'
import '../styles/lobby.css'
import Button from '../ui/Button'
import Field from '../ui/Field'
import Note from '../ui/Note'
import Paper, { Card } from '../ui/Paper'
import { IconBot, IconExit, IconFriends, IconKey } from '../ui/icons'

type Busy = null | 'bot' | 'pvp' | 'join' | 'logout'

export default function Lobby() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [created, setCreated] = useState<GameId | null>(null)

  async function run(kind: Exclude<Busy, null>, action: () => Promise<void>) {
    setBusy(kind)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(null)
    }
  }

  const playBot = () =>
    run('bot', async () => {
      const g = await gamesApi.create('bot')
      navigate(`/game/${g.id}`)
    })

  const createPvp = () =>
    run('pvp', async () => {
      const g = await gamesApi.create('pvp')
      setCreated(g.id)
    })

  function join(e: FormEvent) {
    e.preventDefault()
    const id = parseRoomCode(code)
    if (id === null) return setError('Код комнаты — это номер партии, например 42.')
    run('join', async () => {
      try {
        await gamesApi.join(id)
      } catch (err) {

        if (!(err instanceof ApiError && err.status === 409)) throw err
        const info = await gamesApi.get(id)
        if (!info.chat) throw err
      }
      navigate(`/game/${id}`)
    })
  }

  const exit = () =>
    run('logout', async () => {
      await logout()
      navigate('/login', { replace: true })
    })

  return (
    <Paper
      className="lobby"
      title={
        <>
          Привет, <span className="underline">{user?.username}</span>!
        </>
      }
      actions={
        <Button variant="ghost" icon={<IconExit />} onClick={exit} disabled={busy !== null}>
          Выйти
        </Button>
      }
    >
      {error && <Note kind="error">{error}</Note>}

      <div className="lobby-grid">
        <Card className="lobby-card">
          <h2>
            <IconBot size={30} /> С ботом
          </h2>
          <p className="muted">Быстрая партия: бот уже расставил корабли и ждёт.</p>
          <Button variant="primary" onClick={playBot} disabled={busy !== null}>
            {busy === 'bot' ? 'Создаём…' : 'Играть'}
          </Button>
        </Card>

        <Card className="lobby-card">
          <h2>
            <IconFriends size={30} /> С другом
          </h2>
          {created === null ? (
            <>
              <p className="muted">Создайте комнату и отправьте код сопернику.</p>
              <Button variant="primary" onClick={createPvp} disabled={busy !== null}>
                {busy === 'pvp' ? 'Создаём…' : 'Создать комнату'}
              </Button>
            </>
          ) : (
            <>
              <InviteBox id={created} />
              <Button variant="primary" onClick={() => navigate(`/game/${created}`)}>
                К партии →
              </Button>
            </>
          )}
        </Card>

        <Card className="lobby-card">
          <h2>
            <IconKey size={30} /> По коду
          </h2>
          <form className="stack" onSubmit={join}>
            <Field
              label="Код комнаты"
              inputMode="numeric"
              placeholder="например, 42"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button type="submit" disabled={busy !== null || !code.trim()}>
              {busy === 'join' ? 'Входим…' : 'Вступить'}
            </Button>
          </form>
        </Card>
      </div>

      <Card className="lobby-history">
        <h2>Мои партии</h2>
        {user && <GameHistory me={user.id} refresh={created ?? 0} />}
      </Card>
    </Paper>
  )
}
