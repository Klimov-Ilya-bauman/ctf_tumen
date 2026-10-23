import { memo, useEffect, useState, type CSSProperties } from 'react'
import type { LogEntry } from './gameReducer'

const FX_DURATION = {

  miss: 750,

  hit: 700,

  sunk: 1000,
}

const FX_TAIL = 150

function ShotFx({ fx }: { fx: LogEntry }) {
  const [done, setDone] = useState(false)
  const duration = FX_DURATION[fx.result]
  useEffect(() => {
    const t = setTimeout(() => setDone(true), duration + FX_TAIL)
    return () => clearTimeout(t)
  }, [duration])
  if (done) return null
  const boom = fx.result !== 'miss'
  const cls = boom ? (fx.result === 'sunk' ? 'fx fx-boom fx-big' : 'fx fx-boom') : 'fx fx-splash'
  return (
    <div
      className={cls}
      style={{ gridColumn: fx.x + 1, gridRow: fx.y + 1, '--fx-dur': `${duration}ms` } as CSSProperties}
      aria-hidden="true"
    >
      {boom ? (
        <>
          <svg className="fx-part fx-debris" viewBox="0 0 100 100">
            <use href="#fx-boom-debris" />
          </svg>
          <svg className="fx-part fx-fire" viewBox="0 0 100 100">
            <use href="#fx-boom-fire" />
          </svg>
        </>
      ) : (
        <>
          <svg className="fx-part fx-ring" viewBox="0 0 100 100">
            <use href="#fx-splash-ring" />
          </svg>
          <svg className="fx-part fx-drops" viewBox="0 0 100 100">
            <use href="#fx-splash-drops" />
          </svg>
        </>
      )}
    </div>
  )
}

export default memo(ShotFx)
