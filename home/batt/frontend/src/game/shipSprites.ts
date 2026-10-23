

export type ShipMood = 'ok' | 'hurt' | 'dead'

const files = import.meta.glob<string>('../assets/ships/doodle/*.svg', { eager: true, import: 'default', query: '?url' })

export function shipSprite(len: number, mood: ShipMood = 'ok'): string {

  const m = len === 1 && mood === 'hurt' ? 'ok' : mood
  return files[`../assets/ships/doodle/ship${len}-${m}.svg`]
}

export const SHIP_NAMES: Readonly<Record<number, string>> = {
  4: 'линкор',
  3: 'крейсер',
  2: 'эсминец',
  1: 'катер',
}
