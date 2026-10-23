import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { authApi } from '../api/endpoints'
import { ErrorMessage } from '../components/Alerts'
import { TextField } from '../components/Field'
import { splitServerError } from '../lib/errors'
import { collectErrors, hasErrors, validatePassword, validateUsername, type FieldErrors } from '../lib/validation'

export function RegisterPage() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const nextErrors = collectErrors({
      username: validateUsername(username),
      password: validatePassword(password),
      passwordConfirmation: passwordConfirmation !== password ? 'The passwords do not match.' : null,
    })
    setErrors(nextErrors)
    setMessage(null)
    if (hasErrors(nextErrors)) {
      return
    }
    setBusy(true)
    try {
      await authApi.register(username, password)
      navigate('/login', { replace: true, state: { registered: username } })
    } catch (error) {
      const split = splitServerError(error, ['username', 'password'])
      setErrors(split.fields)
      setMessage(split.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <h1>Create a SlopDNS account</h1>
      <form onSubmit={(event) => void submit(event)} noValidate aria-label="Register">
        <TextField
          label="Username"
          value={username}
          onChange={setUsername}
          error={errors.username}
          autoComplete="username"
          help="3-32 lower-case letters, digits and hyphens."
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          error={errors.password}
          autoComplete="new-password"
          help="12-128 characters."
        />
        <TextField
          label="Repeat password"
          type="password"
          value={passwordConfirmation}
          onChange={setPasswordConfirmation}
          error={errors.passwordConfirmation}
          autoComplete="new-password"
        />
        <ErrorMessage message={message} />
        <button type="submit" className="button-primary" disabled={busy}>
          Register
        </button>
      </form>
      <p>
        Already registered? <Link to="/login">Sign in</Link>
      </p>
    </main>
  )
}
