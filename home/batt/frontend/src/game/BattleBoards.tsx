import { memo, useMemo } from 'react'
import type { Move, Ship } from '../api/types'
import Board from './Board'
import type { LogEntry } from './gameReducer'
import { cellsFromShots, idx, shipCells, shipKey, sunkShips } from './boardModel'
import type { ShipMood } from './shipSprites'
import ShipView from './ShipView'

interface OwnProps {
  ships: readonly Ship[]

  shots: readonly Move[]
  title: string
  dim?: boolean

  fx?: readonly LogEntry[]
}

function moodOf(ship: Ship, hit: ReadonlySet<number>, sunk: ReadonlySet<string>): ShipMood {
  if (sunk.has(shipKey(ship))) return 'dead'
  return shipCells(ship).some((c) => hit.has(c)) ? 'hurt' : 'ok'
}

const hitCells = (shots: readonly Move[]) => new Set(shots.filter((s) => s.result !== 'miss').map((s) => idx(s.x, s.y)))

export const OwnBoard = memo(function OwnBoard({ ships, shots, title, dim, fx }: OwnProps) {
  const cells = useMemo(() => cellsFromShots(shots), [shots])

  const sunk = useMemo(() => sunkShips(shots), [shots])
  const under = useMemo(() => {
    const sunkKeys = new Set(sunk.map(shipKey))
    const hit = hitCells(shots)
    return ships.map((s) => <ShipView key={shipKey(s)} ship={s} mood={moodOf(s, hit, sunkKeys)} />)
  }, [ships, shots, sunk])
  return (
    <Board label="Моё поле" title={title} cells={cells} sunk={sunk} under={under} fx={fx} className={dim ? 'dim' : undefined} seed={5} />
  )
})

interface EnemyProps {

  shots: readonly Move[]
  pending: number | null
  canFire: boolean
  onFire: (x: number, y: number) => void
  title: string
  dim?: boolean

  revealed?: readonly Ship[]

  fx?: readonly LogEntry[]
}

export const EnemyBoard = memo(function EnemyBoard({ shots, pending, canFire, onFire, title, dim, revealed, fx }: EnemyProps) {
  const cells = useMemo(() => cellsFromShots(shots, pending), [shots, pending])
  const sunk = useMemo(() => sunkShips(shots), [shots])
  const wrecks = useMemo(() => {
    const dead = sunk.map((s) => <ShipView key={shipKey(s)} ship={s} mood="dead" />)
    if (!revealed?.length) return dead

    const sunkKeys = new Set(sunk.map(shipKey))
    const hit = hitCells(shots)
    const alive = revealed
      .filter((s) => !sunkKeys.has(shipKey(s)))
      .map((s) => <ShipView key={shipKey(s)} ship={s} mood={moodOf(s, hit, sunkKeys)} revealed />)
    return [...dead, ...alive]
  }, [sunk, revealed, shots])
  const cls = [canFire && 'can-fire', dim && 'dim'].filter(Boolean).join(' ') || undefined
  return (
    <Board
      label="Поле соперника"
      title={title}
      cells={cells}
      sunk={sunk}
      under={wrecks}
      fx={fx}
      className={cls}
      onCell={canFire ? onFire : undefined}
      seed={9}
    />
  )
})
