import { memo } from 'react'
import { MARK_VARIANTS } from '../ui/InkDefs'
import type { CellState } from './boardModel'

function Cell({ i, s }: { i: number; s: CellState }) {
  const v = (i * 7 + 3) % MARK_VARIANTS
  let mark = null
  if (s === 'hit' || s === 'sunk') mark = <use href={`#m-hit-${v}`} />
  else if (s === 'miss' || s === 'auto') mark = <use href={`#m-miss-${v}`} />
  return (
    <div className="cell" data-i={i} data-s={s || undefined}>
      {mark && (
        <svg className="mark" viewBox="0 0 20 20" aria-hidden="true">
          {mark}
        </svg>
      )}
    </div>
  )
}

export default memo(Cell)
