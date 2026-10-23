import { memo } from 'react'
import type { Move, ShotResult } from '../api/types'
import { cellName } from './boardModel'
import type { LogEntry } from './gameReducer'

const RESULT: Record<ShotResult, string> = { miss: 'мимо', hit: 'ранил', sunk: 'убил' }

interface Props {
  log: readonly LogEntry[]

  myName: string
  them: string
  myShots: readonly Move[]
  enemyShots: readonly Move[]
}

const sunkCount = (shots: readonly Move[]) => shots.reduce((n, s) => n + (s.result === 'sunk' ? 1 : 0), 0)

function ShotLog({ log, myName, them, myShots, enemyShots }: Props) {
  return (
    <section className="card sketch shot-log" aria-label="Журнал выстрелов">
      <h3>Журнал</h3>
      <p className="score">
        Потоплено: <b>{sunkCount(myShots)}</b>/10 · Потеряно: <b>{sunkCount(enemyShots)}</b>/10
      </p>
      {log.length === 0 ? (
        <p className="small muted">Здесь будут записи выстрелов.</p>
      ) : (
        <ol className="log-list">
          {log.map((e) => (
            <li key={e.n} className={`log-${e.result}`}>
              <span className={e.mine ? 'log-who mine' : 'log-who'}>{e.mine ? myName : them}</span> → {cellName(e.x, e.y)}:{' '}
              <span className="log-res">{RESULT[e.result]}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export default memo(ShotLog)
