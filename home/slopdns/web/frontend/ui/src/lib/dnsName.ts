import { toUnicode as punycodeToUnicode } from 'punycode/punycode.js'
import { toASCII as uts46ToAscii, toUnicode as uts46ToUnicode } from 'tr46'

export const USER_ZONE_SUFFIX = 'slop'
export const MAX_LABEL_OCTETS = 63
export const MAX_NAME_OCTETS = 253

export type NameReason =
  | 'empty'
  | 'invalid_characters'
  | 'root_not_allowed'
  | 'empty_label'
  | 'invalid_label'
  | 'invalid_punycode'
  | 'label_too_long'
  | 'name_too_long'
  | 'outside_user_zone_suffix'
  | 'outside_zone'

export type ZoneNameReason = NameReason

export interface NamePolicy {
  underscore: boolean
  wildcard: boolean
  root: boolean
  strict: boolean
}

export const ZONE_POLICY: NamePolicy = { underscore: false, wildcard: false, root: false, strict: true }
export const OWNER_POLICY: NamePolicy = { underscore: true, wildcard: true, root: false, strict: true }
export const HOST_POLICY: NamePolicy = { underscore: true, wildcard: false, root: false, strict: false }
export const HOST_ROOT_POLICY: NamePolicy = { underscore: true, wildcard: false, root: true, strict: false }

export type NameResult = { valid: true; canonical: string } | { valid: false; reason: NameReason; message: string }
export type ZoneNameResult = NameResult

const UTS46_LOOKUP_OPTIONS = {
  checkBidi: true,
  checkHyphens: true,
  checkJoiners: true,
  useSTD3ASCIIRules: true,
  processingOption: 'nontransitional' as const,
  verifyDNSLength: false,
}

const NAME_MESSAGES: Record<NameReason, string> = {
  empty: 'Enter a name.',
  invalid_characters: 'Names cannot contain whitespace, control characters or backslashes.',
  root_not_allowed: 'The root name is not allowed here.',
  empty_label: 'Names cannot contain empty labels (two dots in a row or a leading dot).',
  invalid_label: 'Each label may contain only letters, digits and inner hyphens.',
  invalid_punycode: 'A label starting with xn-- is not valid punycode.',
  label_too_long: 'Each label must be at most 63 octets.',
  name_too_long: 'The name must be at most 253 octets.',
  outside_user_zone_suffix: `Only subdomains of .${USER_ZONE_SUFFIX} can be registered, for example example.${USER_ZONE_SUFFIX}.`,
  outside_zone: 'The name must be equal to or below the zone apex.',
}

const ZONE_LABEL_MESSAGE =
  'Each label may contain only letters, digits and inner hyphens (no underscores, wildcards, leading or trailing hyphens).'

function failure(reason: NameReason, message: string = NAME_MESSAGES[reason]): NameResult {
  return { valid: false, reason, message }
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false
    }
  }
  return true
}

function hasForbiddenCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (/\s/u.test(character) || character === '\\' || code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffd) {
      return true
    }
  }
  return false
}

function isLdhCharacter(code: number, policy: NamePolicy): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    (code === 0x5f && policy.underscore)
  )
}

type LabelResult = { label: string } | { reason: NameReason }

const PVALID_EXCEPTIONS = new Set([0x00df, 0x03c2, 0x06fd, 0x06fe, 0x0f0b, 0x3007])
const LETTER_DIGIT = /^[\p{Ll}\p{Lo}\p{Lm}\p{Mn}\p{Mc}\p{Nd}]$/u
const IGNORABLE = /^[\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\p{Noncharacter_Code_Point}\p{White_Space}]$/u
const COMBINING_MARK = /^[\p{Mn}\p{Mc}]$/u
const EXCLUDED_RANGES: Array<[number, number]> = [
  [0x20d0, 0x20ff],
  [0x1d100, 0x1d1ff],
  [0x1d200, 0x1d24f],
  [0x1100, 0x11ff],
  [0xa960, 0xa97f],
  [0xd7b0, 0xd7ff],
]

export function isPValid(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  if (PVALID_EXCEPTIONS.has(code)) {
    return true
  }
  if (code === 0x2d || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) {
    return true
  }
  if (code < 0x80) {
    return false
  }
  if (!LETTER_DIGIT.test(character) || IGNORABLE.test(character)) {
    return false
  }
  if (EXCLUDED_RANGES.some(([low, high]) => code >= low && code <= high)) {
    return false
  }
  return character.normalize('NFKC').toLowerCase().normalize('NFKC') === character
}

function checkALabel(alabel: string): NameReason | null {
  const decoded = uts46ToUnicode(alabel, UTS46_LOOKUP_OPTIONS)
  if (decoded.error) {
    return 'invalid_punycode'
  }
  const unicode = decoded.domain
  if (uts46ToAscii(unicode, UTS46_LOOKUP_OPTIONS) !== alabel) {
    return 'invalid_punycode'
  }
  if (unicode.normalize('NFC') !== unicode) {
    return 'invalid_label'
  }
  const characters = Array.from(unicode)
  if (characters.some((character) => !isPValid(character))) {
    return 'invalid_label'
  }
  if (characters.length > 0 && COMBINING_MARK.test(characters[0] ?? '')) {
    return 'invalid_label'
  }
  return null
}

function parseLabel(rawLabel: string, policy: NamePolicy, first: boolean): LabelResult {
  if (rawLabel === '') {
    return { reason: 'empty_label' }
  }
  if (rawLabel === '*') {
    return policy.wildcard && first ? { label: '*' } : { reason: 'invalid_label' }
  }
  const ascii = isAscii(rawLabel)
  let label = rawLabel
  if (!ascii) {
    const converted = uts46ToAscii(rawLabel.replace(/\u1e9e/g, 'ss'), UTS46_LOOKUP_OPTIONS)
    if (converted === null || converted === '' || converted.includes('.')) {
      return { reason: 'invalid_label' }
    }
    if (policy.strict) {
      const reason = checkALabel(converted)
      if (reason !== null) {
        return { reason }
      }
    }
    label = converted
  }
  label = label.toLowerCase()
  if (label.length > MAX_LABEL_OCTETS) {
    return { reason: 'label_too_long' }
  }
  for (let index = 0; index < label.length; index += 1) {
    if (!isLdhCharacter(label.charCodeAt(index), policy)) {
      return { reason: 'invalid_label' }
    }
  }
  if (label.startsWith('-') || label.endsWith('-')) {
    return { reason: 'invalid_label' }
  }
  if (ascii && label.startsWith('xn--')) {
    if (uts46ToUnicode(label, UTS46_LOOKUP_OPTIONS).error) {
      return { reason: 'invalid_punycode' }
    }
    if (policy.strict) {
      const reason = checkALabel(label)
      if (reason !== null) {
        return { reason }
      }
    }
  }
  return { label }
}

export function parseName(input: string, policy: NamePolicy): NameResult {
  if (input === '') {
    return failure('empty')
  }
  if (input === '.') {
    return policy.root ? { valid: true, canonical: '.' } : failure('root_not_allowed')
  }
  if (hasForbiddenCharacter(input)) {
    return failure('invalid_characters')
  }
  const body = input.endsWith('.') ? input.slice(0, -1) : input
  const labels: string[] = []
  const rawLabels = body.split('.')
  for (let index = 0; index < rawLabels.length; index += 1) {
    const result = parseLabel(rawLabels[index] ?? '', policy, index === 0)
    if ('reason' in result) {
      return failure(result.reason, result.reason === 'invalid_label' && !policy.underscore ? ZONE_LABEL_MESSAGE : undefined)
    }
    labels.push(result.label)
  }
  const name = labels.join('.')
  if (name.length > MAX_NAME_OCTETS) {
    return failure('name_too_long')
  }
  return { valid: true, canonical: `${name}.` }
}

function absoluteZone(zoneName: string): string {
  return zoneName.endsWith('.') ? zoneName : `${zoneName}.`
}

export function isSubdomain(name: string, parent: string): boolean {
  return parent === '.' || name === parent || name.endsWith(`.${parent}`)
}

export function validateUserZoneName(input: string): NameResult {
  const result = parseName(input, ZONE_POLICY)
  if (!result.valid) {
    return result
  }
  const suffix = `${USER_ZONE_SUFFIX}.`
  if (result.canonical === suffix || !isSubdomain(result.canonical, suffix)) {
    return failure('outside_user_zone_suffix')
  }
  return result
}

export function parseOwnerName(value: string, zoneName: string): NameResult {
  const apex = absoluteZone(zoneName).toLowerCase()
  if (value === '@') {
    return { valid: true, canonical: apex }
  }
  if (value === '') {
    return failure('empty', 'Required. Use @ for the zone apex.')
  }
  const full = value.endsWith('.') ? value : `${value}.${apex}`
  const result = parseName(full, OWNER_POLICY)
  if (!result.valid) {
    return result
  }
  if (!isSubdomain(result.canonical, apex)) {
    return failure('outside_zone', `Absolute names must be equal to or below the zone ${apex}`)
  }
  return result
}

export function validateOwnerName(value: string, zoneName: string): string | null {
  const result = parseOwnerName(value, zoneName)
  return result.valid ? null : result.message
}

export function absoluteOwnerName(value: string, zoneName: string): string {
  const result = parseOwnerName(value, zoneName)
  if (result.valid) {
    return result.canonical
  }
  const apex = absoluteZone(zoneName)
  return value.endsWith('.') ? value.toLowerCase() : `${value.toLowerCase()}.${apex}`
}

export function validateHostName(value: string, allowRoot: boolean): string | null {
  if (value === '') {
    return 'Required.'
  }
  if (value.length > 254) {
    return 'The name must be at most 253 octets.'
  }
  const result = parseName(value, allowRoot ? HOST_ROOT_POLICY : HOST_POLICY)
  if (result.valid) {
    return null
  }
  if (result.reason === 'root_not_allowed') {
    return "The root '.' is not allowed here. Enter a domain name such as host.example.slop."
  }
  return result.message
}

export function relativeOwnerName(absolute: string, zoneName: string): string {
  const zone = absoluteZone(zoneName)
  if (absolute === zone) {
    return '@'
  }
  if (absolute.endsWith(`.${zone}`)) {
    return absolute.slice(0, -(zone.length + 1))
  }
  return absolute
}

export function displayName(canonical: string): string {
  if (!canonical.split('.').some((label) => label.startsWith('xn--'))) {
    return canonical
  }
  try {
    return punycodeToUnicode(canonical)
  } catch {
    return canonical
  }
}
