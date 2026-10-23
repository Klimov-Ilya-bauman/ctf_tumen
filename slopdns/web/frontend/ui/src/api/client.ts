import type { ApiErrorBody } from './types'

export const API_PREFIX = '/api/v1'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly field: string | undefined
  readonly retryAfterSeconds: number | undefined

  constructor(status: number, code: string, message: string, field?: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.field = field
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type UnauthenticatedListener = () => void

let unauthenticatedListener: UnauthenticatedListener | null = null

let sessionEpoch = 0

export function setUnauthenticatedListener(listener: UnauthenticatedListener | null): void {
  unauthenticatedListener = listener
}

export function markSessionStarted(): void {
  sessionEpoch += 1
}

export type QueryValue = string | number | boolean | null | undefined

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, QueryValue>
}

function buildUrl(path: string, query: Record<string, QueryValue> | undefined): URL {
  const url = new URL(API_PREFIX + path, window.location.origin)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false
  }
  const inner = (value as { error: unknown }).error
  return typeof inner === 'object' && inner !== null && 'code' in inner
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) {
    return undefined
  }
  const seconds = Number.parseInt(header, 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

function toApiError(response: Response, payload: unknown): ApiError {
  const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
  if (isErrorBody(payload)) {
    return new ApiError(
      response.status,
      payload.error.code,
      payload.error.message,
      payload.error.field,
      retryAfter,
    )
  }
  return new ApiError(response.status, 'unknown_error', `Request failed with status ${response.status}`, undefined, retryAfter)
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const listenerAtStart = unauthenticatedListener
  const epochAtStart = sessionEpoch
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (MUTATING_METHODS.has(method)) {
    headers['X-SlopDNS-CSRF'] = '1'
  }
  let body: string | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  let response: Response
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, 'network_error', 'The server could not be reached. Check your connection and try again.')
  }
  const payload = response.status === 204 ? undefined : await readJson(response)
  if (response.ok) {
    return payload as T
  }
  const error = toApiError(response, payload)
  if (error.status === 401 && error.code === 'unauthenticated' && epochAtStart === sessionEpoch) {
    listenerAtStart?.()
  }
  throw error
}
