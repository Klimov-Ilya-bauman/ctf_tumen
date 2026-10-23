import { request } from './client'
import type { Ship } from './types'

export const fleetApi = {

  random: () => request<{ ships: Ship[] }>('POST', '/api/fleet/random').then((r) => r.ships),
}
