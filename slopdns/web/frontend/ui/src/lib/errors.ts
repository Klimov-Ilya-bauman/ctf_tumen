import { ApiError } from '../api/client'
import type { FieldErrors } from './validation'

export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong. Please try again.'
  }
  switch (error.status) {
    case 0:
      return error.message
    case 401:
      if (error.code === 'invalid_credentials') {
        return 'Wrong username or password.'
      }
      if (error.code === 'mfa_invalid') {
        return 'The code is wrong, already used or expired.'
      }
      return 'Your session has expired. Please sign in again.'
    case 403:
      if (error.code === 'csrf_required') {
        return 'The request was rejected by the CSRF check. Reload the page and try again.'
      }
      return 'You do not have permission to do this.'
    case 404:
      return 'Not found or not visible to you.'
    case 409:
      return error.message.trim() === '' ? 'This conflicts with an existing object.' : error.message
    case 422:
      if (error.code === 'quota_exceeded') {
        return `Quota exceeded: ${error.message} Delete unused objects or ask an administrator to raise the organization quota.`
      }
      return error.message
    case 429:
      return error.retryAfterSeconds !== undefined
        ? `Too many requests. Try again in ${error.retryAfterSeconds} seconds.`
        : 'Too many requests. Try again later.'
    default:
      if (error.status >= 500) {
        return 'The server failed to process the request. Try again later.'
      }
      return error.message
  }
}

export function serverFieldErrors(error: unknown): FieldErrors {
  if (error instanceof ApiError && error.status === 422 && error.code !== 'quota_exceeded' && error.field !== undefined) {
    return { [error.field]: error.message }
  }
  return {}
}

export function splitServerError(error: unknown, knownFields: Iterable<string>): { fields: FieldErrors; message: string | null } {
  const fields = serverFieldErrors(error)
  const known = new Set(knownFields)
  const fieldNames = Object.keys(fields)
  if (fieldNames.length > 0 && fieldNames.every((name) => known.has(name))) {
    return { fields, message: null }
  }
  return { fields: {}, message: error === null || error === undefined ? null : describeError(error) }
}
