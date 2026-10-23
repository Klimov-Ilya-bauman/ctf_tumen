import { memo, type CSSProperties } from 'react'
import type { Ship } from '../api/types'
import { gridArea } from './boardModel'
import { shipSprite, type ShipMood } from './shipSprites'

interface Props {
  ship: Ship

  mood?: ShipMood

  revealed?: boolean
}

function ShipView({ ship, mood = 'ok', revealed }: Props) {
  const cls = `ship ${ship.horizontal ? 'h' : 'v'}${revealed ? ' revealed' : ''}`
  const style = { ...gridArea(ship), '--len': ship.len } as CSSProperties
  return (
    <div className={cls} style={style}>
      <img src={shipSprite(ship.len, mood)} alt="" draggable={false} decoding="async" />
    </div>
  )
}

export default memo(ShipView)
