import { memo, useCallback, useMemo, useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import type { Ship } from '../api/types'
import { cached, roughRect } from '../ui/rough'
import SketchBorder from '../ui/SketchBorder'
import { COLS, gridArea, shipKey, type CellState } from './boardModel'
import Cell from './Cell'
import type { LogEntry } from './gameReducer'
import ShotFx from './ShotFx'

interface Props {
  cells: readonly CellState[]

  title?: ReactNode

  under?: ReactNode

  overlay?: ReactNode

  fx?: readonly LogEntry[]

  sunk?: readonly Ship[]

  onCell?: (x: number, y: number) => void

  onHover?: (x: number, y: number, i: number) => void
  onLeave?: () => void
  onContextMenu?: () => void
  className?: string
  label: string
  seed?: number
}

function cellFromEvent(e: { target: EventTarget }): number | null {
  const el = (e.target as Element).closest?.('[data-i]') as HTMLElement | null
  return el ? Number(el.dataset.i) : null
}

const SunkOutline = memo(function SunkOutline({ ship }: { ship: Ship }) {
  const w = ship.horizontal ? ship.len * 20 : 20
  const h = ship.horizontal ? 20 : ship.len * 20
  const key = shipKey(ship)
  const d = useMemo(
    () => cached(`sunk:${key}`, () => roughRect(1, 1, w - 2, h - 2, ship.x * 31 + ship.y * 17 + ship.len, 2, 0.9)),
    [key, w, h, ship],
  )
  return (
    <svg className="sunk-outline" style={gridArea(ship)} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  )
})

function Board({ cells, title, under, overlay, fx, sunk, onCell, onHover, onLeave, onContextMenu, className, label, seed = 3 }: Props) {
  const hovered = useRef<number | null>(null)

  const handleClick = useCallback(
    (e: MouseEvent) => {
      const i = cellFromEvent(e)
      if (i !== null && onCell) onCell(i % 10, Math.floor(i / 10))
    },
    [onCell],
  )

  const handleMove = useCallback(
    (e: PointerEvent) => {
      if (!onHover) return
      const i = cellFromEvent(e)
      if (i === null || i === hovered.current) return
      hovered.current = i
      onHover(i % 10, Math.floor(i / 10), i)
    },
    [onHover],
  )

  const handleLeave = useCallback(() => {
    hovered.current = null
    onLeave?.()
  }, [onLeave])

  const handleContext = useCallback(
    (e: MouseEvent) => {
      if (!onContextMenu) return
      e.preventDefault()
      onContextMenu()
    },
    [onContextMenu],
  )

  return (
    <figure className={className ? `board ${className}` : 'board'}>
      {title && <figcaption className="board-title">{title}</figcaption>}
      <div className="board-grid">
        <div className="board-cols" aria-hidden="true">
          {COLS.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="board-rows" aria-hidden="true">
          {COLS.map((_, n) => (
            <span key={n}>{n + 1}</span>
          ))}
        </div>
        <div
          className="board-field"
          role="grid"
          aria-label={label}
          onClick={onCell ? handleClick : undefined}
          onPointerMove={onHover ? handleMove : undefined}
          onPointerLeave={onLeave || onHover ? handleLeave : undefined}
          onContextMenu={onContextMenu ? handleContext : undefined}
        >
          {under && <div className="board-layer board-under">{under}</div>}
          <div className="board-cells">
            {cells.map((s, i) => (
              <Cell key={i} i={i} s={s} />
            ))}
          </div>
          <div className="board-layer">
            {sunk?.map((s) => <SunkOutline key={shipKey(s)} ship={s} />)}
            {overlay}
            {fx?.map((f) => <ShotFx key={f.n} fx={f} />)}
          </div>
          <SketchBorder seed={seed} />
        </div>
      </div>
    </figure>
  )
}

export default memo(Board)

