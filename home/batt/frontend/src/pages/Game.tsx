import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { describeError } from '../api/errors'
import { gamesApi } from '../api/games'
import { isSpectatorView, type GameInfo, type Move, type ServerMessage, type Ship, type SpectatorView } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { EnemyBoard, OwnBoard } from '../game/BattleBoards'
import Chat from '../game/Chat'
import FleetSetup from '../game/FleetSetup'
import '../game/game.css'
import GameOverCard from '../game/GameOverCard'
import { gameReducer, initialGameState, POST_GAME_CHAT_GRACE_MS } from '../game/gameReducer'
import InviteBox from '../game/InviteBox'
import { players } from '../game/players'
import ShotLog from '../game/ShotLog'
import TurnBanner, { AwayCountdown } from '../game/TurnBanner'
import Button from '../ui/Button'
import Note from '../ui/Note'
import PageLoader from '../ui/PageLoader'
import Paper, { Card } from '../ui/Paper'
import { IconBack } from '../ui/icons'
import type { SocketStatus } from '../ws/socket'
import { useGameSocket } from '../ws/useGameSocket'

type Load = { phase: 'loading' } | { phase: 'error'; text: string } | { phase: 'ready'; info: GameInfo }

const NO_NAMES: Readonly<Record<number, string>> = {}

const STATUS_TEXT: Record<GameInfo['status'], string> = {
  waiting: 'ждёт второго игрока',
  placing: 'расстановка кораблей',
  active: 'идёт бой',
  finished: 'окончена',
}

export default function GamePage() {
  const { id } = useParams()
  return <Game key={id} />
}

function Game() {
  const params = useParams()
  const gameId = /^\d+$/.test(params.id ?? '') ? Number(params.id) : null
  const { user } = useAuth()
  const me = user!.id
  const navigate = useNavigate()

  const [load, setLoad] = useState<Load>({ phase: 'loading' })
  const [state, dispatch] = useReducer(gameReducer, initialGameState)

  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    if (gameId === null) return
    let alive = true
    gamesApi.get(gameId).then(
      (info) => {
        if (!alive) return
        dispatch({ type: 'info', info })
        setLoad({ phase: 'ready', info })
      },
      (e) => alive && setLoad({ phase: 'error', text: describeError(e) }),
    )
    return () => {
      alive = false
    }
  }, [gameId, version])

  const participant = load.phase === 'ready' && load.info.chat !== undefined
  const onMessage = useCallback((msg: ServerMessage) => dispatch({ type: 'server', msg, me }), [me])
  const { status: conn, attempt, send } = useGameSocket(gameId, onMessage)

  useEffect(() => {
    if (attempt === 3 && gameId !== null) gamesApi.get(gameId).catch(() => {})
  }, [attempt, gameId])

  const view = state.view

  const pview = view && !isSpectatorView(view) ? view : null

  const src = view ?? (load.phase === 'ready' ? load.info : null)
  const [srcMode, p1, p2, n1, n2] = [src?.mode, src?.player1, src?.player2, src?.player1_name, src?.player2_name]
  const names = useMemo(
    () =>
      srcMode === undefined || p1 === undefined
        ? null
        : players({ mode: srcMode, player1: p1, player2: p2 ?? null, player1_name: n1 ?? null, player2_name: n2 ?? null }, user!),
    [srcMode, p1, p2, n1, n2, user],
  )
  const myTurn = pview?.status === 'active' && pview.turn === me
  const canFire = myTurn && state.pending === null && conn === 'open'

  const live = useRef({ canFire, cells: pview?.my_shots })
  useEffect(() => {
    live.current = { canFire, cells: pview?.my_shots }
  }, [canFire, pview?.my_shots])
  const onFire = useCallback(
    (x: number, y: number) => {
      const { canFire, cells } = live.current
      if (!canFire || cells?.some((s: Move) => s.x === x && s.y === y)) return
      if (!send({ type: 'fire', x, y })) return dispatch({ type: 'notice', kind: 'error', text: 'Нет связи с сервером.' })
      dispatch({ type: 'fire', x, y })
    },
    [send],
  )

  const onPlace = useCallback(
    (ships: Ship[]) => {
      if (!send({ type: 'place_ships', ships })) return dispatch({ type: 'notice', kind: 'error', text: 'Нет связи с сервером.' })
      dispatch({ type: 'submit' })
    },
    [send],
  )

  const onChat = useCallback(
    async (text: string) => {
      if (send({ type: 'chat_send', text }) || gameId === null) return
      const message = await gamesApi.sendChat(gameId, text)
      dispatch({ type: 'server', msg: { type: 'chat_message', message }, me })
    },
    [send, gameId, me],
  )

  useEffect(() => {
    if (!state.notice) return
    const t = setTimeout(() => dispatch({ type: 'clear-notice' }), state.notice.kind === 'error' ? 5000 : 3500)
    return () => clearTimeout(t)
  }, [state.notice])

  useEffect(() => {
    if (state.finishedAt === null) return
    const remain = POST_GAME_CHAT_GRACE_MS - (Date.now() - state.finishedAt)
    if (remain <= 0) return
    const t = setTimeout(() => dispatch({ type: 'tick' }), remain)
    return () => clearTimeout(t)
  }, [state.finishedAt])
  const chatGraceOpen = state.finishedAt !== null && Date.now() - state.finishedAt < POST_GAME_CHAT_GRACE_MS

  if (gameId === null || load.phase === 'error')
    return (
      <Paper title="Партия">
        <Note kind="error">{load.phase === 'error' ? load.text : 'Такой партии нет.'}</Note>
        <p>
          <Link to="/lobby">← в лобби</Link>
        </p>
      </Paper>
    )
  if (load.phase === 'loading') return <PageLoader text="Открываем партию…" />

  const info = load.info
  const modeText =
    info.mode === 'bot' ? 'с ботом' : names && (view ?? info).player2 !== null ? `с ${names.them}` : 'ждёт соперника'
  const head = (
    <Button variant="ghost" icon={<IconBack />} onClick={() => navigate('/lobby')}>
      Лобби
    </Button>
  )

  if (!participant)
    return (
      <SpectatorGame
        info={info}
        head={head}
        onJoined={reload}
        view={view && isSpectatorView(view) ? view : null}
        conn={conn}
      />
    )

  const them = names?.them ?? 'Соперник'
  const isBot = info.mode === 'bot'

  const connBadge =
    conn === 'open' ? null : (
      <span className="conn small" role="status">
        {conn === 'reconnecting' ? 'Связь потеряна, переподключаемся…' : 'Подключаемся…'}
      </span>
    )

  return (
    <Paper
      className="game"
      title={
        <>
          Партия №{info.id} <span className="muted game-mode">{modeText}</span>
        </>
      }
      actions={
        <>
          {connBadge}
          {head}
        </>
      }
    >
      {state.notice && <Note kind={state.notice.kind}>{state.notice.text}</Note>}

      {!pview ? (
        <p className="muted">Получаем состояние партии…</p>
      ) : (
        <div className="game-layout">
          <div className="game-main">
            {pview.status === 'waiting' && (
              <Card className="game-invite">
                <h2>Ждём соперника</h2>
                <InviteBox id={pview.id} />
              </Card>
            )}

            {(pview.status === 'waiting' || (pview.status === 'placing' && !pview.placed)) && (
              <FleetSetup
                onSubmit={onPlace}
                canSubmit={pview.status === 'placing' && conn === 'open'}
                waitingText={pview.status === 'waiting' ? 'Можно расставить корабли заранее — отправить получится, когда соперник вступит.' : 'Нет связи с сервером.'}
                submitting={state.submitting}
              />
            )}

            {pview.status === 'placing' && pview.placed && (
              <>
                <p className="turn turn-theirs">
                  <span className="turn-dot" aria-hidden="true" />
                  <span className="turn-title">Флот на позициях. Ждём, пока {names?.them ?? 'соперник'} расставит корабли…</span>
                </p>
                <div className="boards">
                  <OwnBoard ships={pview.my_ships} shots={pview.enemy_shots} title={`Флот: ${names?.me ?? user!.username}`} />
                </div>
              </>
            )}

            {(pview.status === 'active' || pview.status === 'finished') && (
              <>
                {state.over ? (
                  <GameOverCard winner={state.over.winner} reason={state.over.reason} me={me} them={them} isBot={isBot} />
                ) : (
                  <TurnBanner myTurn={myTurn} them={them} isBot={isBot} lastMine={state.lastMine} lastTheirs={state.lastTheirs} />
                )}
                {state.away && !state.over && <AwayCountdown since={state.away.since} grace={state.away.grace} them={them} />}
                <div className="boards">
                  <OwnBoard
                    ships={pview.my_ships}
                    shots={pview.enemy_shots}
                    title={`Флот: ${names?.me ?? user!.username}`}
                    dim={myTurn}
                    fx={state.fxOwn}
                  />
                  <EnemyBoard
                    shots={pview.my_shots}
                    pending={state.pending}
                    canFire={canFire && !state.over}
                    onFire={onFire}
                    title={isBot ? 'Флот бота' : `Флот: ${them}`}
                    dim={!myTurn && !state.over}
                    revealed={pview.status === 'finished' ? pview.enemy_ships : undefined}
                    fx={state.fxEnemy}
                  />
                </div>
              </>
            )}
          </div>

          <aside className="game-side">
            {(pview.status === 'active' || pview.status === 'finished') && (
              <ShotLog log={state.log} myName={names?.me ?? 'Вы'} them={them} myShots={pview.my_shots} enemyShots={pview.enemy_shots} />
            )}
            {state.chat && (
              <Chat
                messages={state.chat}
                me={me}
                names={names?.byId ?? NO_NAMES}
                enabled={pview.status === 'placing' || pview.status === 'active' || (pview.status === 'finished' && chatGraceOpen)}
                disabledText={pview.status === 'waiting' ? 'Чат откроется, когда соперник вступит.' : 'Партия окончена — чат только для чтения.'}
                onSend={onChat}
              />
            )}
          </aside>
        </div>
      )}
    </Paper>
  )
}

function SpectatorGame({
  info,
  head,
  onJoined,
  view,
  conn,
}: {
  info: GameInfo
  head: ReactNode
  onJoined: () => void
  view: SpectatorView | null
  conn: SocketStatus
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const canJoin = info.mode === 'pvp' && info.status === 'waiting' && info.player2 === null

  async function join() {
    setBusy(true)
    setError('')
    try {
      await gamesApi.join(info.id)
      onJoined()
    } catch (e) {
      setError(describeError(e, 'Не удалось вступить.'))
      setBusy(false)
    }
  }

  const p1Name = (view?.player1_name ?? info.player1_name) ?? 'Игрок'
  const p2Name = info.mode === 'bot' ? 'Бот' : (view?.player2_name ?? info.player2_name) ?? 'Игрок 2'

  const p1Shots = useMemo(() => view?.moves.filter((m) => m.user_id === view.player2) ?? [], [view])
  const p2Shots = useMemo(() => view?.moves.filter((m) => m.user_id === view.player1) ?? [], [view])

  return (
    <Paper title={`Партия №${info.id}`} actions={head}>
      <Card className="spectator">
        <p>
          {info.mode === 'bot' ? `${p1Name} против бота` : info.player2_name ? `${p1Name} против ${p2Name}` : `${p1Name} ждёт соперника`}
          , {STATUS_TEXT[info.status]}
          {view?.winner !== undefined && view?.winner !== null && (view.winner === view.player1 ? `. Победил ${p1Name}` : `. Победил ${p2Name}`)}
          {!canJoin && '.'}
        </p>
        {canJoin && (
          <>
            <p className="muted">Вас пригласили в эту партию.</p>
            <Button variant="primary" onClick={join} disabled={busy}>
              {busy ? 'Вступаем…' : 'Вступить в игру'}
            </Button>
          </>
        )}
        {error && <Note kind="error">{error}</Note>}
      </Card>
      {!canJoin && (
        <>
          {!view ? (
            <p className="muted">Подключаемся к партии…</p>
          ) : (
            <div className="boards">
              <OwnBoard ships={view.player1_ships} shots={p1Shots} title={`Флот: ${p1Name}`} />
              <OwnBoard ships={view.player2_ships} shots={p2Shots} title={`Флот: ${p2Name}`} />
            </div>
          )}
          {conn !== 'open' && (
            <span className="conn small" role="status">
              {conn === 'reconnecting' ? 'Связь потеряна, переподключаемся…' : 'Подключаемся…'}
            </span>
          )}
        </>
      )}
    </Paper>
  )
}
