import { memo, useMemo } from 'react'
import { cached, roughRect } from './rough'

interface Props {

  width?: number
  height?: number
  seed?: number
  className?: string
}

function SketchBorder({ width = 100, height = 100, seed = 1, className }: Props) {
  const d = useMemo(
    () => cached(`rect:${width}:${height}:${seed}`, () => roughRect(1.5, 1.5, width - 3, height - 3, seed, 2, 1.2)),
    [width, height, seed],
  )
  return (
    <svg
      className={className ? `sketch-border ${className}` : 'sketch-border'}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export default memo(SketchBorder)
