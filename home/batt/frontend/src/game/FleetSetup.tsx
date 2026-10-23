import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { describeError } from '../api/errors'
import { fleetApi } from '../api/fleet'
import type { Ship } from '../api/types'
import Button from '../ui/Button'
import Note from '../ui/Note'
import { IconCheck, IconDice, IconEraser, IconRotate } from '../ui/icons'
import Board from './Board'
import { CELLS, gridArea, idx, shipKey, type CellState } from './boardModel'
import { canPlace, clampToBoard, isComplete, remaining, shipAt, SIZES } from './fleet'
import { SHIP_NAMES } from './shipSprites'
import ShipView from './ShipView'

const EMPTY: readonly CellState[] = new Array(CELLS).fill('')

interface Props {

  onSubmit: (ships: Ship[]) => void

  canSubmit: boolean

  waitingText?: string
  submitting: boolean
}

function nextSize(left: Record<number, number>, prefer: number): number | null {
  if (left[prefer] > 0) return prefer
  return SIZES.find((n) => left[n] > 0) ?? null
}

function FleetSetup({ onSubmit, canSubmit, waitingText, submitting }: Props) {
  const [ships, setShips] = useState<Ship[]>([])
  const [size, setSize] = useState<number | null>(4)
  const [horizontal, setHorizontal] = useState(true)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const [error, setError] = useState('')
  const [rolling, setRolling] = useState(false)

  const left = useMemo(() => remaining(ships), [ships])
  const complete = useMemo(() => isComplete(ships), [ships])

  const rotate = useCallback(() => setHorizontal((h) => !h), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') && !(e.target instanceof HTMLInputElement)) rotate()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rotate])

  const candidate: Ship | null = size !== null && hover ? { x: hover.x, y: hover.y, len: size, horizontal } : null
  const candidateOk = candidate !== null && canPlace(ships, candidate)

  const onCell = useCallback(
    (x: number, y: number) => {
      setError('')
      setHover({ x, y })
      const hit = shipAt(ships, idx(x, y))
      if (hit >= 0) {

        const s = ships[hit]
        setShips(ships.filter((_, i) => i !== hit))
        setSize(s.len)
        setHorizontal(s.horizontal)
        return
      }
      if (size === null) return
      const ship = { x, y, len: size, horizontal }
      if (!canPlace(ships, ship)) return
      const next = [...ships, ship]
      setShips(next)
      setSize(nextSize(remaining(next), size))
    },
    [ships, size, horizontal],
  )

  const onHover = useCallback((x: number, y: number) => setHover({ x, y }), [])
  const onLeave = useCallback(() => setHover(null), [])

  async function randomize() {
    setRolling(true)
    setError('')
    try {
      setShips(await fleetApi.random())
      setSize(null)
    } catch (e) {
      setError(describeError(e, 'Не удалось получить расстановку.'))
    } finally {
      setRolling(false)
    }
  }

  function clear() {
    setShips([])
    setSize(4)
    setError('')
  }

  const under = useMemo(() => ships.map((s) => <ShipView key={shipKey(s)} ship={s} />), [ships])
  const preview = candidate && (
    <div className={`preview ${candidateOk ? 'ok' : 'bad'}`} style={gridArea(clampToBoard(candidate))} />
  )

  return (
    <div className="setup">
      <Board
        label="Своё поле: расстановка"
        title="Расставьте флот"
        className={size !== null ? 'placing' : undefined}
        cells={EMPTY}
        under={under}
        overlay={preview}
        onCell={onCell}
        onHover={onHover}
        onLeave={onLeave}
        onContextMenu={rotate}
      />

      <div className="setup-side stack">
        <div className="dock" role="radiogroup" aria-label="Какой корабль ставить">
          {SIZES.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={size === n}
              className="dock-item"
              disabled={left[n] === 0}
              onClick={() => setSize(n)}
            >
              <span className="dock-decks" style={{ '--len': n } as CSSProperties} aria-hidden="true" />
              <span className="dock-name">{SHIP_NAMES[n]}</span>
              <span className="dock-left">×{left[n]}</span>
            </button>
          ))}
        </div>

        <p className="small muted">
          Выберите корабль и нажмите на клетку. Нажатие на поставленный корабль — взять его снова. Повернуть — кнопка, клавиша R
          или правый клик.
        </p>

        <div className="row">
          <Button icon={<IconRotate />} onClick={rotate} aria-pressed={!horizontal}>
            {horizontal ? 'Горизонтально' : 'Вертикально'}
          </Button>
          <Button icon={<IconDice />} onClick={randomize} disabled={rolling}>
            Случайно
          </Button>
          <Button icon={<IconEraser />} variant="ghost" onClick={clear} disabled={ships.length === 0}>
            Очистить
          </Button>
        </div>

        {error && <Note kind="error">{error}</Note>}
        {!canSubmit && waitingText && <p className="muted">{waitingText}</p>}

        <Button
          variant="primary"
          icon={<IconCheck />}
          disabled={!complete || !canSubmit || submitting}
          onClick={() => onSubmit(ships)}
        >
          {submitting ? 'Отправляем…' : complete ? 'Готово, в бой!' : `Осталось кораблей: ${10 - ships.length}`}
        </Button>
      </div>
    </div>
  )
}

export default memo(FleetSetup)
