import type { InvitationStatus, ZoneTransferStatus } from '../api/types'

export function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return 'never'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')
}

export function isPast(value: string | null | undefined, now: Date = new Date()): boolean {
  if (value === null || value === undefined) {
    return false
  }
  const time = new Date(value).getTime()
  return Number.isFinite(time) && time <= now.getTime()
}

export function effectiveStatus<T extends InvitationStatus | ZoneTransferStatus>(
  status: T,
  expiresAt: string,
  now: Date = new Date(),
): T | 'expired' {
  if (status === 'pending' && isPast(expiresAt, now)) {
    return 'expired'
  }
  return status
}
