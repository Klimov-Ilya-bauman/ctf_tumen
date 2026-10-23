import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { authApi } from '../api/endpoints'
import { useAuth } from '../auth/AuthContext'
import { ErrorMessage, Notice } from '../components/Alerts'
import { TextField } from '../components/Field'
import { safeReturnPath } from '../lib/navigation'
import { collectErrors, hasErrors, validatePassword, validateUsername, type FieldErrors } from '../lib/validation'

export interface LoginLocationState {
  from?: string
  registered?: string
}

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = (location.state ?? {}) as LoginLocationState
  const { reloadMe } = useAuth()
  const [username, setUsername] = useState(typeof state.registered === 'string' ? state.registered : '')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const nextErrors = collectErrors({ username: validateUsername(username), password: validatePassword(password) })
    setErrors(nextErrors)
    setFailure(null)
    if (hasErrors(nextErrors)) {
      return
    }
    setBusy(true)
    try {
      const response = await authApi.login(username, password)
      if (response.mfa_required) {
        navigate('/login/totp', {
          state: { mfaToken: response.mfa_token, expiresAt: response.mfa_expires_at, from: safeReturnPath(state.from) },
        })
        return
      }
      await reloadMe()
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <h1>Sign in to SlopDNS</h1>
      {state.registered ? <Notice>Account created. Sign in with your new credentials.</Notice> : null}
      <form onSubmit={(event) => void submit(event)} noValidate aria-label="Sign in">
        <TextField label="Username" value={username} onChange={setUsername} error={errors.username} autoComplete="username" />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          error={errors.password}
          autoComplete="current-password"
        />
        <ErrorMessage error={failure} />
        <button type="submit" className="button-primary" disabled={busy}>
          Sign in
        </button>
      </form>
      <p>
        No account? <Link to="/register">Register</Link>
      </p>
    </main>
  )
}
