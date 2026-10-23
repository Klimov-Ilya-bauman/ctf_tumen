import { codePointLength } from './utf8'

export type FieldErrors = Record<string, string>

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/
const TOTP_CODE_PATTERN = /^[0-9]{6}$/
const RECOVERY_CODE_PATTERN = /^[A-Za-z2-7]{16}$/
const TOKEN_NAME_PATTERN = /^[A-Za-z0-9 ._:@-]{1,64}$/

export const MAX_TTL = 2147483647

export function validateUsername(value: string): string | null {
  if (value === '') {
    return 'Enter a username.'
  }
  if (!USERNAME_PATTERN.test(value)) {
    return 'Use 3-32 lower-case letters, digits and hyphens, starting with a letter or digit.'
  }
  return null
}

export function validatePassword(value: string): string | null {
  const length = codePointLength(value)
  if (length === 0) {
    return 'Enter a password.'
  }
  if (length < 12 || length > 128) {
    return 'The password must be 12-128 characters long.'
  }
  return null
}

export function validateOrgName(value: string): string | null {
  if (value === '') {
    return 'Enter an organization name.'
  }
  if (!SLUG_PATTERN.test(value)) {
    return 'Use 3-63 lower-case letters, digits and hyphens, starting with a letter or digit.'
  }
  return null
}

export function validateServiceAccountName(value: string): string | null {
  if (value === '') {
    return 'Enter a name.'
  }
  if (!SLUG_PATTERN.test(value)) {
    return 'Use 3-63 lower-case letters, digits and hyphens, starting with a letter or digit.'
  }
  return null
}

export function validateDescription(value: string): string | null {
  if (codePointLength(value) > 256) {
    return 'The description must be at most 256 characters.'
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      return 'The description cannot contain control characters.'
    }
  }
  return null
}

export function validateTokenName(value: string): string | null {
  if (value === '') {
    return 'Enter a token name.'
  }
  if (!TOKEN_NAME_PATTERN.test(value)) {
    return 'Use 1-64 characters: letters, digits, spaces and . _ : @ -'
  }
  return null
}

export function normalizeTotpCode(value: string): string {
  return value.replace(/\s+/g, '')
}

export function normalizeRecoveryCode(value: string): string {
  return value.replace(/[\s-]+/g, '')
}

export function validateTotpCode(value: string): string | null {
  if (value === '') {
    return 'Enter the 6-digit code from your authenticator app.'
  }
  if (!TOTP_CODE_PATTERN.test(value)) {
    return 'The code must be exactly 6 digits.'
  }
  return null
}

export function validateRecoveryCode(value: string): string | null {
  if (value === '') {
    return 'Enter a recovery code.'
  }
  if (!RECOVERY_CODE_PATTERN.test(value)) {
    return 'Recovery codes are 16 characters (letters A-Z and digits 2-7).'
  }
  return null
}

export function parseIntegerInRange(value: string, minimum: number, maximum: number): number | null {
  if (!/^[0-9]+$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return null
  }
  return parsed
}

export function validateIntegerInRange(value: string, minimum: number, maximum: number): string | null {
  if (value === '') {
    return 'Required.'
  }
  if (parseIntegerInRange(value, minimum, maximum) === null) {
    return `Enter a whole number from ${minimum} to ${maximum}.`
  }
  return null
}

export function validateOptionalTtl(value: string): string | null {
  if (value === '') {
    return null
  }
  return validateIntegerInRange(value, 0, MAX_TTL)
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0
}

export function collectErrors(checks: Record<string, string | null>): FieldErrors {
  const errors: FieldErrors = {}
  for (const [field, message] of Object.entries(checks)) {
    if (message !== null) {
      errors[field] = message
    }
  }
  return errors
}
