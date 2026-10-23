import { useMemo } from 'react'
import QRCode from 'qrcode'

interface QrCodeProps {
  value: string
  label: string
  moduleSize?: number
}

export function QrCode({ value, label, moduleSize = 4 }: QrCodeProps) {
  const matrix = useMemo(() => {
    const code = QRCode.create(value, { errorCorrectionLevel: 'M' })
    return { size: code.modules.size, data: code.modules.data }
  }, [value])
  const quietZone = 4
  const total = matrix.size + quietZone * 2
  const path = useMemo(() => {
    const parts: string[] = []
    for (let row = 0; row < matrix.size; row += 1) {
      for (let column = 0; column < matrix.size; column += 1) {
        if (matrix.data[row * matrix.size + column]) {
          parts.push(`M${column + quietZone} ${row + quietZone}h1v1h-1z`)
        }
      }
    }
    return parts.join('')
  }, [matrix])
  return (
    <svg
      role="img"
      aria-label={label}
      className="qr-code"
      width={total * moduleSize}
      height={total * moduleSize}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}
