

export type Rng = () => number

export function rng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const f = (n: number) => Math.round(n * 100) / 100

export function roughLine(x1: number, y1: number, x2: number, y2: number, r: Rng, wobble = 1): string {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1
  const j = (k: number) => (r() - 0.5) * k * wobble
  const over = Math.min(len * 0.04, 2) * wobble
  const ux = (x2 - x1) / len
  const uy = (y2 - y1) / len
  const sx = x1 - ux * over * r() + j(1)
  const sy = y1 - uy * over * r() + j(1)
  const ex = x2 + ux * over * r() + j(1)
  const ey = y2 + uy * over * r() + j(1)

  const bow = (r() - 0.5) * Math.min(len * 0.03, 2.5) * wobble
  const cx = (sx + ex) / 2 - uy * bow
  const cy = (sy + ey) / 2 + ux * bow
  return `M${f(sx)} ${f(sy)}Q${f(cx)} ${f(cy)} ${f(ex)} ${f(ey)}`
}

export function roughRect(x: number, y: number, w: number, h: number, seed: number, passes = 2, wobble = 1): string {
  const r = rng(seed)
  const parts: string[] = []
  for (let p = 0; p < passes; p++) {
    const k = wobble * (p === 0 ? 1 : 1.6)
    parts.push(
      roughLine(x, y, x + w, y, r, k),
      roughLine(x + w, y, x + w, y + h, r, k),
      roughLine(x + w, y + h, x, y + h, r, k),
      roughLine(x, y + h, x, y, r, k),
    )
  }
  return parts.join('')
}

export function roughEllipse(cx: number, cy: number, rx: number, ry: number, seed: number, wobble = 1): string {
  const r = rng(seed)
  const steps = 9
  const start = r() * Math.PI * 2
  const sweep = Math.PI * 2 * (1.08 + r() * 0.08)
  const pts: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const a = start + (sweep * i) / steps
    const k = 1 + (r() - 0.5) * 0.12 * wobble
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k])
  }

  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(i + 2, pts.length - 1)]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`
  }
  return d
}

export function roughCross(size: number, seed: number): string {
  const r = rng(seed)
  const m = size * 0.18
  return roughLine(m, m, size - m, size - m, r, 1.4) + roughLine(size - m, m, m, size - m, r, 1.4)
}

export function roughDot(size: number, seed: number): string {
  const c = size / 2
  return roughEllipse(c, c, size * 0.12, size * 0.11, seed, 2)
}

const cache = new Map<string, string>()

export function cached(key: string, make: () => string): string {
  let d = cache.get(key)
  if (d === undefined) {
    d = make()
    cache.set(key, d)
  }
  return d
}
