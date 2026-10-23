import type { CSSProperties } from 'react'
import { BOARD_SIZE, type Move, type Ship } from '../api/types'

export type CellState = '' | 'miss' | 'auto' | 'hit' | 'sunk' | 'pending'

export const CELLS = BOARD_SIZE * BOARD_SIZE
export const COLS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К']

export const idx = (x: number, y: number) => y * BOARD_SIZE + x
export const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE

export const cellName = (x: number, y: number) => `${COLS[x]}${y + 1}`

export function shipCells(s: Ship): number[] {
  const out: number[] = []
  for (let i = 0; i < s.len; i++) out.push(s.horizontal ? idx(s.x + i, s.y) : idx(s.x, s.y + i))
  return out
}

export function shipHalo(s: Ship): number[] {
  const w = s.horizontal ? s.len : 1
  const h = s.horizontal ? 1 : s.len
  const out: number[] = []
  for (let y = s.y - 1; y <= s.y + h; y++)
    for (let x = s.x - 1; x <= s.x + w; x++) {
      const inside = x >= s.x && x < s.x + w && y >= s.y && y < s.y + h
      if (!inside && inBounds(x, y)) out.push(idx(x, y))
    }
  return out
}

export const shipKey = (s: Ship) => `${s.x}:${s.y}:${s.len}:${s.horizontal ? 'h' : 'v'}`

export function cellsFromShots(shots: readonly Move[], pending: number | null = null): CellState[] {
  const cells: CellState[] = new Array(CELLS).fill('')
  for (const s of shots) cells[idx(s.x, s.y)] = s.result === 'miss' ? 'miss' : 'hit'
  for (const s of shots) {
    if (!s.sunk) continue
    for (const c of shipCells(s.sunk)) cells[c] = 'sunk'

    for (const c of shipHalo(s.sunk)) if (cells[c] === '') cells[c] = 'auto'
  }
  if (pending !== null && cells[pending] === '') cells[pending] = 'pending'
  return cells
}

export function sunkShips(shots: readonly Move[]): Ship[] {
  const out: Ship[] = []
  for (const s of shots) if (s.sunk) out.push(s.sunk)
  return out
}

export function gridArea(s: Pick<Ship, 'x' | 'y' | 'len' | 'horizontal'>): CSSProperties {
  return s.horizontal
    ? { gridColumn: `${s.x + 1} / span ${s.len}`, gridRow: `${s.y + 1}` }
    : { gridColumn: `${s.x + 1}`, gridRow: `${s.y + 1} / span ${s.len}` }
}
