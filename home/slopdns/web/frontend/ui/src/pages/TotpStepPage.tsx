import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation } from 'react-router'
import { authApi } from '../api/endpoints'
import { useAuth } from '../auth/AuthContext'
import { ErrorMessage } from '../components/Alerts'
import { TextField } from '../components/Field'
import { formatTimestamp } from '../lib/format'
import {
  collectErrors,
  hasErrors,
  normalizeRecoveryCode,
  normalizeTotpCode,
  validateRecoveryCode,
  validateTotpCode,
  type FieldErrors,
} from '../lib/validation'

interface TotpStepState {
  mfaToken?: string
  expiresAt?: string
  from?: string
}

export function TotpStepPage() {
  const location = useLocation()
  const { reloadMe } = useAuth()
  const state = (location.state ?? {}) as TotpStepState
  const [useRecoveryCode, setUseRecoveryCode] = useState(false)
  const [code, setCode] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  if (!state.mfaToken) {
    return <Navigate to="/login" replace />
  }
  const mfaToken = state.mfaToken

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedRecovery = normalizeRecoveryCode(recoveryCode)
    const normalizedCode = normalizeTotpCode(code)
    const nextErrors = useRecoveryCode
      ? collectErrors({ recovery_code: validateRecoveryCode(normalizedRecovery) })
      : collectErrors({ code: validateTotpCode(normalizedCode) })
    setErrors(nextErrors)
    setFailure(null)
    if (hasErrors(nextErrors)) {
      return
    }
    setBusy(true)
    try {
      await authApi.loginTotp(
        useRecoveryCode ? { mfa_token: mfaToken, recovery_code: normalizedRecovery } : { mfa_token: mfaToken, code: normalizedCode },
      )
      await reloadMe()
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <h1>Two-factor authentication</h1>
      {state.expiresAt ? <p className="muted">This step expires at {formatTimestamp(state.expiresAt)}.</p> : null}
      <form onSubmit={(event) => void submit(event)} noValidate aria-label="Second factor">
        {useRecoveryCode ? (
          <TextField
            label="Recovery code"
            value={recoveryCode}
            onChange={setRecoveryCode}
            error={errors.recovery_code}
            autoComplete="off"
          />
        ) : (
          <TextField
            label="Authentication code"
            value={code}
            onChange={setCode}
            error={errors.code}
            autoComplete="one-time-code"
            inputMode="numeric"
          />
        )}
        <ErrorMessage error={failure} />
        <button type="submit" className="button-primary" disabled={busy}>
          Verify
        </button>
      </form>
      <p>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setUseRecoveryCode(!useRecoveryCode)
            setErrors({})
            setFailure(null)
          }}
        >
          {useRecoveryCode ? 'Use an authentication code instead' : 'Use a recovery code instead'}
        </button>
      </p>
      <p>
        <Link to="/login">Back to sign in</Link>
      </p>
    </main>
  )
}
