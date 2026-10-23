import { BOARD_SIZE, FLEET, type Ship } from '../api/types'
import { CELLS, shipCells, shipHalo } from './boardModel'

export const SIZES = [4, 3, 2, 1] as const

export function inside(s: Ship): boolean {
  const endX = s.horizontal ? s.x + s.len - 1 : s.x
  const endY = s.horizontal ? s.y : s.y + s.len - 1
  return s.x >= 0 && s.y >= 0 && endX < BOARD_SIZE && endY < BOARD_SIZE
}

export function canPlace(ships: readonly Ship[], cand: Ship): boolean {
  if (!inside(cand)) return false
  const blocked = new Uint8Array(CELLS)
  for (const s of ships) {
    for (const c of shipCells(s)) blocked[c] = 1
    for (const c of shipHalo(s)) blocked[c] = 1
  }
  return shipCells(cand).every((c) => !blocked[c])
}

export function remaining(ships: readonly Ship[]): Record<number, number> {
  const left: Record<number, number> = { 4: 0, 3: 0, 2: 0, 1: 0 }
  for (const len of FLEET) left[len]++
  for (const s of ships) left[s.len]--
  return left
}

export function isComplete(ships: readonly Ship[]): boolean {
  const left = remaining(ships)
  if (SIZES.some((n) => left[n] !== 0)) return false
  return ships.every((s, i) => canPlace(ships.filter((_, j) => j !== i), s))
}

export function shipAt(ships: readonly Ship[], cell: number): number {
  return ships.findIndex((s) => shipCells(s).includes(cell))
}

export function clampToBoard(s: Ship): Ship {
  const room = s.horizontal ? BOARD_SIZE - s.x : BOARD_SIZE - s.y
  return { ...s, len: Math.max(1, Math.min(s.len, room)) }
}
