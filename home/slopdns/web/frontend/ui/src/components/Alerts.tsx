import type { ReactNode } from 'react'
import { describeError } from '../lib/errors'

export function ErrorMessage({ error, message }: { error?: unknown; message?: string | null }) {
  const text = message ?? (error === null || error === undefined ? null : describeError(error))
  if (text === null || text === undefined || text === '') {
    return null
  }
  return (
    <p className="alert alert-error" role="alert">
      {text}
    </p>
  )
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="alert alert-info" role="status">
      {children}
    </p>
  )
}

export function Loading({ label = 'Loading...' }: { label?: string }) {
  return (
    <p className="loading" role="status">
      {label}
    </p>
  )
}
