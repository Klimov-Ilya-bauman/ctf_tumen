import { memo, useEffect, useState } from 'react'
import type { ShotResult } from '../api/types'

interface Props {
  myTurn: boolean

  them: string
  isBot: boolean
  lastMine: ShotResult | null
  lastTheirs: ShotResult | null
}

function TurnBanner({ myTurn, them, isBot, lastMine, lastTheirs }: Props) {
  let title: string
  let hint: string
  if (myTurn) {
    const again = lastMine === 'hit' || lastMine === 'sunk'
    title = again ? (lastMine === 'sunk' ? 'Потопили! Стреляйте ещё' : 'Попали! Стреляйте ещё') : 'Ваш ход'
    hint = `Стреляйте по полю: ${them}. После попадания ход остаётся у вас.`
  } else {
    const again = lastTheirs === 'hit' || lastTheirs === 'sunk'
    title = again ? `${them} попадает и ходит снова` : isBot ? 'Ходит бот…' : `Ходит ${them}…`
    hint = isBot ? 'Бот прицеливается…' : 'Ждём выстрел. На ход даётся 90 секунд.'
  }
  return (
    <div className={`turn ${myTurn ? 'turn-mine' : 'turn-theirs'}`} role="status" aria-live="polite">
      <span className="turn-dot" aria-hidden="true" />
      <div>
        <p className="turn-title">{title}</p>
        <p className="small muted">{hint}</p>
      </div>
    </div>
  )
}

export default memo(TurnBanner)

export const AwayCountdown = memo(function AwayCountdown({ since, grace, them }: { since: number; grace: number; them: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, Math.ceil(grace - (now - since) / 1000))
  return (
    <p className="note sketch note-info away" role="status">
      {them} — не в сети. Ждём ещё <b>{left} с</b> — если не вернётся, победа будет засчитана вам.
    </p>
  )
})
