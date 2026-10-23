import type { DnsRecord, RecordInput } from '../api/types'
import { ZONE_POLICY, parseName, relativeOwnerName, validateHostName, validateOwnerName } from './dnsName'
import { utf8ByteLength } from './utf8'
import { parseIntegerInRange, validateIntegerInRange, validateOptionalTtl, type FieldErrors } from './validation'

export const STRUCTURED_TYPES = [
  'A',
  'AAAA',
  'NS',
  'CNAME',
  'PTR',
  'MX',
  'TXT',
  'SRV',
  'CAA',
  'HINFO',
  'SSHFP',
  'TLSA',
  'DNAME',
  'NAPTR',
  'GPT',
] as const

export type StructuredType = (typeof STRUCTURED_TYPES)[number]
export type RecordFormType = StructuredType

export const GPT_MAX_BYTES = 40
export const CHARACTER_STRING_MAX_BYTES = 255
export const MAX_RDATA_OCTETS = 65535

export type FieldKind = 'text' | 'integer' | 'select' | 'textarea'

export interface SelectOption {
  value: string
  label: string
}

export interface DataFieldSpec {
  key: string
  label: string
  kind: FieldKind
  options?: SelectOption[]
  placeholder?: string
  help?: string
}

function options(values: Array<[string, string]>): SelectOption[] {
  return values.map(([value, label]) => ({ value, label }))
}

const UINT16 = { min: 0, max: 65535 }

export const ABSOLUTE_NAME_HINT = 'Always absolute: host.example.slop and host.example.slop. are the same name, never relative to the zone.'

function withHint(help?: string): string {
  return help ? `${help} ${ABSOLUTE_NAME_HINT}` : ABSOLUTE_NAME_HINT
}

export const DATA_FIELDS: Record<RecordFormType, DataFieldSpec[]> = {
  A: [{ key: 'address', label: 'IPv4 address', kind: 'text', placeholder: '192.0.2.1' }],
  AAAA: [{ key: 'address', label: 'IPv6 address', kind: 'text', placeholder: '2001:db8::1' }],
  NS: [{ key: 'nsdname', label: 'Name server', kind: 'text', placeholder: 'ns1.example.slop.', help: withHint() }],
  CNAME: [{ key: 'target', label: 'Target', kind: 'text', placeholder: 'host.example.slop.', help: withHint() }],
  PTR: [{ key: 'ptrdname', label: 'Pointer target', kind: 'text', placeholder: 'host.example.slop.', help: withHint() }],
  MX: [
    { key: 'preference', label: 'Preference', kind: 'integer', placeholder: '10' },
    { key: 'exchange', label: 'Mail exchange', kind: 'text', placeholder: 'mail.example.slop.', help: withHint("'.' with preference 0 is a null MX.") },
  ],
  TXT: [],
  SRV: [
    { key: 'priority', label: 'Priority', kind: 'integer', placeholder: '10' },
    { key: 'weight', label: 'Weight', kind: 'integer', placeholder: '5' },
    { key: 'port', label: 'Port', kind: 'integer', placeholder: '5060' },
    { key: 'target', label: 'Target', kind: 'text', placeholder: 'sip.example.slop.', help: withHint("'.' means the service is not available.") },
  ],
  CAA: [
    { key: 'flags', label: 'Flags', kind: 'select', options: options([['0', '0'], ['128', '128 (issuer critical)']]) },
    { key: 'tag', label: 'Tag', kind: 'text', placeholder: 'issue' },
    { key: 'value', label: 'Value', kind: 'text', placeholder: 'letsencrypt.org', help: 'issue/issuewild: a CA domain with optional ; key=value parameters. iodef: a mailto:, http: or https: URL.' },
  ],
  HINFO: [
    { key: 'cpu', label: 'CPU', kind: 'text' },
    { key: 'os', label: 'OS', kind: 'text' },
  ],
  SSHFP: [
    {
      key: 'algorithm',
      label: 'Algorithm',
      kind: 'select',
      options: options([['1', '1 RSA'], ['2', '2 DSA'], ['3', '3 ECDSA'], ['4', '4 Ed25519'], ['6', '6 Ed448']]),
    },
    {
      key: 'fingerprint_type',
      label: 'Fingerprint type',
      kind: 'select',
      options: options([['1', '1 SHA-1'], ['2', '2 SHA-256']]),
    },
    { key: 'fingerprint', label: 'Fingerprint (hex)', kind: 'text' },
  ],
  TLSA: [
    {
      key: 'usage',
      label: 'Certificate usage',
      kind: 'select',
      options: options([['0', '0 PKIX-TA'], ['1', '1 PKIX-EE'], ['2', '2 DANE-TA'], ['3', '3 DANE-EE'], ['255', '255 Private']]),
    },
    { key: 'selector', label: 'Selector', kind: 'select', options: options([['0', '0 Full certificate'], ['1', '1 SubjectPublicKeyInfo'], ['255', '255 Private']]) },
    {
      key: 'matching_type',
      label: 'Matching type',
      kind: 'select',
      options: options([['0', '0 Exact'], ['1', '1 SHA-256'], ['2', '2 SHA-512'], ['255', '255 Private']]),
    },
    { key: 'certificate_association_data', label: 'Certificate association data (hex)', kind: 'textarea' },
  ],
  DNAME: [{ key: 'target', label: 'Target', kind: 'text', placeholder: 'other.example.slop.', help: withHint() }],
  NAPTR: [
    { key: 'order', label: 'Order', kind: 'integer', placeholder: '100' },
    { key: 'preference', label: 'Preference', kind: 'integer', placeholder: '10' },
    { key: 'flags', label: 'Flags', kind: 'text', placeholder: 'U' },
    { key: 'services', label: 'Services', kind: 'text', placeholder: 'E2U+sip' },
    { key: 'regexp', label: 'Regexp', kind: 'text', placeholder: '!^.*$!sip:info@example.slop!', help: 'Form <delim>ere<delim>replacement<delim>flags, flag i only.' },
    { key: 'replacement', label: 'Replacement', kind: 'text', placeholder: '.', help: withHint("Exactly one of regexp and replacement (not '.') must be set.") },
  ],
  GPT: [{ key: 'text', label: 'Text', kind: 'text', help: 'UTF-8 text, at most 40 bytes. May be empty.' }],
}

const DEFAULT_VALUES: Partial<Record<RecordFormType, Record<string, string>>> = {
  CAA: { flags: '0' },
  SSHFP: { algorithm: '4', fingerprint_type: '2' },
  TLSA: { usage: '3', selector: '1', matching_type: '1' },
  NAPTR: { replacement: '.' },
}

export interface RecordFormState {
  formType: RecordFormType
  name: string
  ttl: string
  values: Record<string, string>
  strings: string[]
}

export function emptyRecordForm(formType: RecordFormType = 'A'): RecordFormState {
  return {
    formType,
    name: '@',
    ttl: '',
    values: { ...(DEFAULT_VALUES[formType] ?? {}) },
    strings: [''],
  }
}

export function changeFormType(state: RecordFormState, formType: RecordFormType): RecordFormState {
  return { ...emptyRecordForm(formType), name: state.name, ttl: state.ttl }
}

export function isStructuredType(type: string): type is StructuredType {
  return (STRUCTURED_TYPES as readonly string[]).includes(type)
}

export function recordToFormState(record: DnsRecord, zoneName: string): RecordFormState {
  const data = record.data as Record<string, unknown>
  if (!isStructuredType(record.type)) {
    throw new Error(`Records of type ${record.type} cannot be edited in the web interface.`)
  }
  const formType: RecordFormType = record.type
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' || typeof value === 'number') {
      values[key] = String(value)
    }
  }
  const strings = Array.isArray(data.strings) ? data.strings.map((item) => String(item)) : ['']
  return {
    formType,
    name: relativeOwnerName(record.name, zoneName),
    ttl: String(record.ttl),
    values,
    strings: strings.length > 0 ? strings : [''],
  }
}

const IPV4_PATTERN =
  /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/
const HEXTET_PATTERN = /^[0-9A-Fa-f]{1,4}$/

export function isIPv4(value: string): boolean {
  return IPV4_PATTERN.test(value)
}

export function isIPv6(value: string): boolean {
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(value)) {
    return false
  }
  let text = value
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    if (lastColon < 0 || !isIPv4(value.slice(lastColon + 1))) {
      return false
    }
    text = `${value.slice(0, lastColon + 1)}0:0`
  }
  const halves = text.split('::')
  if (halves.length > 2) {
    return false
  }
  const groups = (part: string) => (part === '' ? [] : part.split(':'))
  if (halves.length === 2) {
    const head = groups(halves[0] ?? '')
    const tail = groups(halves[1] ?? '')
    return head.length + tail.length <= 7 && [...head, ...tail].every((group) => HEXTET_PATTERN.test(group))
  }
  const all = text.split(':')
  return all.length === 8 && all.every((group) => HEXTET_PATTERN.test(group))
}

const CAA_PARAMETER_TAG = /^[A-Za-z0-9]+$/

export function validateCaaValue(tag: string, value: string): string | null {
  const normalizedTag = tag.toLowerCase()
  if (normalizedTag === 'issue' || normalizedTag === 'issuewild') {
    const parts = value.split(';')
    const issuer = (parts[0] ?? '').replace(/^[ \t]+|[ \t]+$/g, '')
    if (issuer !== '' && (issuer.endsWith('.') || !parseName(issuer, ZONE_POLICY).valid)) {
      return 'The issuer must be a domain name such as letsencrypt.org (RFC 8659 section 4.2).'
    }
    for (const rawParameter of parts.slice(1)) {
      const parameter = rawParameter.replace(/^[ \t]+|[ \t]+$/g, '')
      if (parameter === '') {
        continue
      }
      const separator = parameter.indexOf('=')
      const key = separator < 0 ? '' : parameter.slice(0, separator)
      const parameterValue = separator < 0 ? '' : parameter.slice(separator + 1)
      if (separator < 0 || !CAA_PARAMETER_TAG.test(key) || /[ \t]/.test(parameterValue)) {
        return 'Parameters must be key=value pairs separated by semicolons (RFC 8659 section 4.2).'
      }
    }
  }
  if (normalizedTag === 'iodef') {
    if (!/^(mailto:|https?:)/i.test(value)) {
      return 'iodef must be a mailto:, http: or https: URL (RFC 8659 section 4.4).'
    }
  }
  return null
}

export function validateNaptrRegexp(regexp: string): string | null {
  const characters = Array.from(regexp)
  const delimiter = characters[0] ?? ''
  if (delimiter === '\\' || delimiter === 'i' || /^[0-9]$/.test(delimiter) || delimiter === '\u0000') {
    return "The delimiter must not be a digit, a backslash or 'i' (RFC 3403 section 3.2)."
  }
  const parts: string[] = []
  let current = ''
  for (let index = 1; index < characters.length; index += 1) {
    const character = characters[index] ?? ''
    if (character === '\\' && index + 1 < characters.length) {
      const next = characters[index + 1] ?? ''
      current += next === delimiter ? next : character + next
      index += 1
      continue
    }
    if (character === delimiter) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  parts.push(current)
  if (parts.length !== 3) {
    return 'Use the form <delim>ere<delim>replacement<delim>flags, for example !^.*$!sip:info@example.slop!.'
  }
  if (parts[0] === '') {
    return 'The regular expression must not be empty.'
  }
  if (parts[2] !== '' && parts[2] !== 'i') {
    return "The only allowed flag is 'i'."
  }
  return null
}

function characterStringError(value: string): string | null {
  return utf8ByteLength(value) > CHARACTER_STRING_MAX_BYTES ? 'At most 255 bytes (UTF-8).' : null
}

function oneOf(value: string, allowed: number[]): string | null {
  if (value === '') {
    return 'Required.'
  }
  return allowed.includes(Number(value)) && /^[0-9]+$/.test(value) ? null : `Choose one of ${allowed.join(', ')}.`
}

function hexError(value: string, minLength: number, maxLength: number): string | null {
  if (value === '') {
    return 'Required.'
  }
  if (value.length < minLength || value.length > maxLength || !/^([0-9A-Fa-f]{2})+$/.test(value)) {
    return 'Enter an even number of hexadecimal digits.'
  }
  return null
}

type DataValidator = (values: Record<string, string>, strings: string[]) => FieldErrors

function prefixErrors(checks: Record<string, string | null>): FieldErrors {
  const errors: FieldErrors = {}
  for (const [key, message] of Object.entries(checks)) {
    if (message !== null) {
      errors[`data.${key}`] = message
    }
  }
  return errors
}

const field = (values: Record<string, string>, key: string) => values[key] ?? ''

const DATA_VALIDATORS: Record<RecordFormType, DataValidator> = {
  A: (values) =>
    prefixErrors({
      address:
        field(values, 'address') === ''
          ? 'Required.'
          : isIPv4(field(values, 'address'))
            ? null
            : 'Enter a dotted-quad IPv4 address without leading zeros, such as 192.0.2.1.',
    }),
  AAAA: (values) =>
    prefixErrors({
      address:
        field(values, 'address') === ''
          ? 'Required.'
          : isIPv6(field(values, 'address'))
            ? null
            : 'Enter a valid IPv6 address, such as 2001:db8::1.',
    }),
  NS: (values) => prefixErrors({ nsdname: validateHostName(field(values, 'nsdname'), false) }),
  CNAME: (values) => prefixErrors({ target: validateHostName(field(values, 'target'), false) }),
  PTR: (values) => prefixErrors({ ptrdname: validateHostName(field(values, 'ptrdname'), false) }),
  DNAME: (values) => prefixErrors({ target: validateHostName(field(values, 'target'), false) }),
  MX: (values) =>
    prefixErrors({
      preference: validateIntegerInRange(field(values, 'preference'), UINT16.min, UINT16.max),
      exchange: validateHostName(field(values, 'exchange'), true),
    }),
  TXT: (_values, strings) => {
    const errors: FieldErrors = {}
    if (strings.length === 0) {
      errors['data.strings'] = 'Add at least one string.'
      return errors
    }
    if (strings.length > 255) {
      errors['data.strings'] = 'At most 255 strings.'
      return errors
    }
    strings.forEach((value, index) => {
      const message = characterStringError(value)
      if (message !== null) {
        errors[`data.strings[${index}]`] = message
      }
    })
    const total = strings.reduce((sum, value) => sum + utf8ByteLength(value) + 1, 0)
    if (total > MAX_RDATA_OCTETS) {
      errors['data.strings'] = 'The total size of all strings must be at most 65535 octets.'
    }
    return errors
  },
  SRV: (values) =>
    prefixErrors({
      priority: validateIntegerInRange(field(values, 'priority'), UINT16.min, UINT16.max),
      weight: validateIntegerInRange(field(values, 'weight'), UINT16.min, UINT16.max),
      port: validateIntegerInRange(field(values, 'port'), UINT16.min, UINT16.max),
      target: validateHostName(field(values, 'target'), true),
    }),
  CAA: (values) => {
    const value = field(values, 'value')
    return prefixErrors({
      flags: oneOf(field(values, 'flags'), [0, 128]),
      tag: /^[A-Za-z0-9]{1,15}$/.test(field(values, 'tag')) ? null : 'Use 1-15 letters and digits, such as issue.',
      value:
        value.length > 2048
          ? 'At most 2048 characters.'
          : /^[\x20-\x7e]*$/.test(value)
            ? validateCaaValue(field(values, 'tag'), value)
            : 'Use printable ASCII characters only.',
    })
  },
  HINFO: (values) =>
    prefixErrors({ cpu: characterStringError(field(values, 'cpu')), os: characterStringError(field(values, 'os')) }),
  SSHFP: (values) => {
    const fingerprint = field(values, 'fingerprint')
    const fingerprintType = field(values, 'fingerprint_type')
    let fingerprintError: string | null = null
    if (fingerprint === '') {
      fingerprintError = 'Required.'
    } else if (!/^([0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$/.test(fingerprint)) {
      fingerprintError = 'Enter 40 (SHA-1) or 64 (SHA-256) hexadecimal digits.'
    } else if (fingerprintType === '1' && fingerprint.length !== 40) {
      fingerprintError = 'A SHA-1 fingerprint has 40 hexadecimal digits.'
    } else if (fingerprintType === '2' && fingerprint.length !== 64) {
      fingerprintError = 'A SHA-256 fingerprint has 64 hexadecimal digits.'
    }
    return prefixErrors({
      algorithm: oneOf(field(values, 'algorithm'), [1, 2, 3, 4, 6]),
      fingerprint_type: oneOf(fingerprintType, [1, 2]),
      fingerprint: fingerprintError,
    })
  },
  TLSA: (values) => {
    const matchingType = field(values, 'matching_type')
    const data = field(values, 'certificate_association_data')
    let dataError = hexError(data, 2, 16384)
    if (dataError === null && matchingType === '1' && data.length !== 64) {
      dataError = 'SHA-256 matching requires exactly 64 hexadecimal digits.'
    }
    if (dataError === null && matchingType === '2' && data.length !== 128) {
      dataError = 'SHA-512 matching requires exactly 128 hexadecimal digits.'
    }
    return prefixErrors({
      usage: oneOf(field(values, 'usage'), [0, 1, 2, 3, 255]),
      selector: oneOf(field(values, 'selector'), [0, 1, 255]),
      matching_type: oneOf(matchingType, [0, 1, 2, 255]),
      certificate_association_data: dataError,
    })
  },
  NAPTR: (values) => {
    const regexp = field(values, 'regexp')
    const replacement = field(values, 'replacement')
    const flags = field(values, 'flags')
    const services = field(values, 'services')
    let regexpError: string | null =
      regexp.length > 255 || utf8ByteLength(regexp) > CHARACTER_STRING_MAX_BYTES ? 'At most 255 bytes.' : null
    let replacementError = validateHostName(replacement, true)
    if (regexpError === null && regexp !== '') {
      regexpError = validateNaptrRegexp(regexp)
    }
    if (regexpError === null && replacementError === null) {
      const hasRegexp = regexp !== ''
      const hasReplacement = replacement !== '.'
      if (hasRegexp && hasReplacement) {
        replacementError = "Set either a regexp or a replacement, not both. Use '.' for no replacement."
      } else if (!hasRegexp && !hasReplacement) {
        regexpError = "Set a regexp or a replacement other than '.'."
      }
    }
    return prefixErrors({
      order: validateIntegerInRange(field(values, 'order'), UINT16.min, UINT16.max),
      preference: validateIntegerInRange(field(values, 'preference'), UINT16.min, UINT16.max),
      flags: flags.length <= 255 && /^[A-Za-z0-9]*$/.test(flags) ? null : 'Use letters and digits only (at most 255).',
      services:
        services.length <= 255 && /^[A-Za-z0-9+:._-]*$/.test(services)
          ? null
          : 'Use letters, digits and + : . _ - only (at most 255).',
      regexp: regexpError,
      replacement: replacementError,
    })
  },
  GPT: (values) =>
    prefixErrors({
      text:
        utf8ByteLength(field(values, 'text')) > GPT_MAX_BYTES
          ? `GPT text must be at most ${GPT_MAX_BYTES} bytes in UTF-8.`
          : null,
    }),
}

const INTEGER_KEYS = new Set([
  'preference',
  'priority',
  'weight',
  'port',
  'algorithm',
  'fingerprint_type',
  'usage',
  'selector',
  'matching_type',
  'order',
])

function buildData(state: RecordFormState): Record<string, unknown> {
  if (state.formType === 'TXT') {
    return { strings: state.strings }
  }
  const data: Record<string, unknown> = {}
  for (const spec of DATA_FIELDS[state.formType]) {
    const raw = state.values[spec.key] ?? ''
    const numeric = INTEGER_KEYS.has(spec.key) || (state.formType === 'CAA' && spec.key === 'flags')
    data[spec.key] = numeric ? parseIntegerInRange(raw, 0, 65535) : raw
  }
  return data
}

export interface RecordValidationResult {
  errors: FieldErrors
  payload: RecordInput | null
}

export function validateRecordForm(rawState: RecordFormState, zoneName: string): RecordValidationResult {
  const state = { ...rawState, name: rawState.name.trim() }
  const errors: FieldErrors = {}
  const nameError = validateOwnerName(state.name, zoneName)
  if (nameError !== null) {
    errors.name = nameError
  }
  const ttlError = validateOptionalTtl(state.ttl)
  if (ttlError !== null) {
    errors.ttl = ttlError
  }
  Object.assign(errors, DATA_VALIDATORS[state.formType](state.values, state.strings))
  if (Object.keys(errors).length > 0) {
    return { errors, payload: null }
  }
  const payload: Record<string, unknown> = {
    name: state.name,
    type: state.formType,
    data: buildData(state),
  }
  if (state.ttl !== '') {
    payload.ttl = Number(state.ttl)
  }
  return { errors, payload: payload as RecordInput }
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function formatRecordData(record: Pick<DnsRecord, 'type' | 'data'>): string {
  const data = record.data as Record<string, unknown>
  const text = (key: string) => String(data[key] ?? '')
  switch (record.type) {
    case 'A':
    case 'AAAA':
      return text('address')
    case 'NS':
      return text('nsdname')
    case 'CNAME':
    case 'DNAME':
      return text('target')
    case 'PTR':
      return text('ptrdname')
    case 'MX':
      return `${text('preference')} ${text('exchange')}`
    case 'TXT':
      return (Array.isArray(data.strings) ? data.strings : []).map((item) => quote(String(item))).join(' ')
    case 'SRV':
      return `${text('priority')} ${text('weight')} ${text('port')} ${text('target')}`
    case 'CAA':
      return `${text('flags')} ${text('tag')} ${quote(text('value'))}`
    case 'HINFO':
      return `${quote(text('cpu'))} ${quote(text('os'))}`
    case 'SSHFP':
      return `${text('algorithm')} ${text('fingerprint_type')} ${text('fingerprint')}`
    case 'TLSA':
      return `${text('usage')} ${text('selector')} ${text('matching_type')} ${text('certificate_association_data')}`
    case 'NAPTR':
      return `${text('order')} ${text('preference')} ${quote(text('flags'))} ${quote(text('services'))} ${quote(text('regexp'))} ${text('replacement')}`
    case 'GPT':
      return quote(text('text'))
    default:
      return text('rdata')
  }
}

export function recordFormFieldNames(state: RecordFormState): string[] {
  const names = ['name', 'ttl', 'type', 'data', 'data.strings']
  for (const spec of DATA_FIELDS[state.formType]) {
    names.push(`data.${spec.key}`)
  }
  state.strings.forEach((_value, index) => names.push(`data.strings[${index}]`))
  return names
}
