import { memo } from 'react'
import { cached, rng, roughCross, roughDot, roughEllipse } from './rough'

export const MARK_VARIANTS = 4
export const MARK_BOX = 20

const fx = (n: number) => Math.round(n * 10) / 10

function starburst(rOut: number, rIn: number, rays: number, seed: number): string {
  const r = rng(seed)
  const pts: string[] = []
  for (let i = 0; i < rays * 2; i++) {
    const a = (i / (rays * 2)) * Math.PI * 2 + (r() - 0.5) * 0.25
    const rad = (i % 2 ? rIn : rOut) * (0.8 + r() * 0.35)
    pts.push(`${fx(Math.cos(a) * rad)} ${fx(Math.sin(a) * rad)}`)
  }
  return `M${pts.join('L')}Z`
}

function debris(seed: number): string {
  const r = rng(seed)
  let d = ''
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + r() * 0.5
    const r0 = 22 + r() * 6
    const r1 = r0 + 7 + r() * 8
    d += `M${fx(Math.cos(a) * r0)} ${fx(Math.sin(a) * r0)}L${fx(Math.cos(a + 0.12) * r1)} ${fx(Math.sin(a + 0.12) * r1)}`
  }
  return d
}

function droplets(seed: number): string {
  const r = rng(seed)
  let d = ''
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 - Math.PI / 2 + (r() - 0.5) * 0.3
    const dist = 22 + r() * 8
    const cx = Math.cos(a) * dist
    const cy = Math.sin(a) * dist
    const s = 2.6 + r() * 1.6

    const tx = cx - Math.cos(a) * s * 1.8
    const ty = cy - Math.sin(a) * s * 1.8
    const nx = -Math.sin(a) * s
    const ny = Math.cos(a) * s
    d += `M${fx(tx)} ${fx(ty)}Q${fx(cx + nx * 1.4)} ${fx(cy + ny * 1.4)} ${fx(cx + Math.cos(a) * s)} ${fx(cy + Math.sin(a) * s)}Q${fx(cx - nx * 1.4)} ${fx(cy - ny * 1.4)} ${fx(tx)} ${fx(ty)}Z`
  }
  return d
}

function InkDefs() {
  const variants = Array.from({ length: MARK_VARIANTS }, (_, i) => i)
  return (
    <svg className="ink-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id="ink" x="-4%" y="-4%" width="108%" height="108%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="11" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.2" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="ink-fine" x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="1" seed="4" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.6" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {variants.map((v) => (
          <symbol key={`h${v}`} id={`m-hit-${v}`} viewBox={`0 0 ${MARK_BOX} ${MARK_BOX}`}>
            <path d={roughCross(MARK_BOX, 101 + v)} fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
          </symbol>
        ))}
        {variants.map((v) => (
          <symbol key={`m${v}`} id={`m-miss-${v}`} viewBox={`0 0 ${MARK_BOX} ${MARK_BOX}`}>
            <path d={roughDot(MARK_BOX, 201 + v)} fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </symbol>
        ))}
        <symbol id="fx-boom-fire" viewBox="-50 -50 100 100" overflow="visible">
          <path d={cached('fx:outer', () => starburst(34, 17, 11, 301))} fill="#d2492a" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
          <path d={cached('fx:inner', () => starburst(19, 9, 8, 302))} fill="#f6b23e" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d={cached('fx:core', () => starburst(8, 4, 6, 303))} fill="#fff4c9" />
        </symbol>
        <symbol id="fx-boom-debris" viewBox="-50 -50 100 100" overflow="visible">
          <path d={cached('fx:debris', () => debris(304))} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </symbol>
        <symbol id="fx-splash-ring" viewBox="-50 -50 100 100" overflow="visible">
          <path d={cached('fx:ring', () => roughEllipse(0, 0, 30, 11, 305, 1.4))} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <path d={cached('fx:ring2', () => roughEllipse(0, 0, 17, 6, 306, 1))} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </symbol>
        <symbol id="fx-splash-drops" viewBox="-50 -50 100 100" overflow="visible">
          <path d={cached('fx:drops', () => droplets(307))} fill="#6f97e0" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </symbol>
      </defs>
    </svg>
  )
}

export default memo(InkDefs)
