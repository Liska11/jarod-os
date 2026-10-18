import qrcode from 'qrcode-generator'
import { useMemo } from 'react'

/** The QR code of `text` as rows of dark (true) and light modules; error correction M, size picked to fit. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const count = qr.getModuleCount()

  return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, col) => qr.isDark(row, col)))
}

/** One SVG path for the dark modules: no HTML is generated from the text, only rectangles. */
export function qrPath(matrix: boolean[][], margin: number): string {
  let d = ''
  matrix.forEach((cells, row) => {
    cells.forEach((dark, col) => {
      if (dark) d += `M${col + margin} ${row + margin}h1v1h-1z`
    })
  })

  return d
}

/**
 * A scannable QR code: dark modules on a white square with the quiet zone the standard asks for (4 modules), so a phone camera
 * reads it on the dark theme too.
 */
export function QrCode({ value, size = 168, label }: { value: string; size?: number; label: string }) {
  const MARGIN = 4
  const matrix = useMemo(() => qrMatrix(value), [value])
  const side = matrix.length + MARGIN * 2

  return (
    <svg width={size} height={size} viewBox={`0 0 ${side} ${side}`} role="img" aria-label={label} shapeRendering="crispEdges" className="shrink-0 rounded-lg">
      <rect width={side} height={side} fill="#ffffff" />
      <path d={qrPath(matrix, MARGIN)} fill="#000000" />
    </svg>
  )
}
