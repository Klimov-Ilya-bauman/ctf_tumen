import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router'
import { validateCredentials } from '../api/auth'
import { ApiError } from '../api/client'
import { describeError } from '../api/errors'
import { useAuth } from '../auth/AuthContext'
import '../styles/login.css'
import Button from '../ui/Button'
import Field from '../ui/Field'
import Note from '../ui/Note'
import { Card } from '../ui/Paper'
import { IconAnchor, IconKey } from '../ui/icons'

type Mode = 'login' | 'register'

export default function Login() {
  const { status, check, login, register } = useAuth()
  const location = useLocation()
  const [params] = useSearchParams()
  const state = location.state as { from?: string; mode?: Mode } | null

  const from = params.get('return_to') ?? state?.from ?? '/lobby'

  const [mode, setMode] = useState<Mode>(state?.mode === 'register' ? 'register' : 'login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (status === 'idle') check()
  }, [status, check])

  if (status === 'authed') return <Navigate to={from} replace />

  function switchMode(m: Mode) {
    setMode(m)
    setError('')
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const creds = { username: username.trim(), password }
    if (!creds.username || !password) return setError('Введите логин и пароль.')
    if (mode === 'register') {
      const invalid = validateCredentials(creds)
      if (invalid) return setError(invalid)
      if (password !== repeat) return setError('Пароли не совпадают.')
    }
    setBusy(true)
    setError('')
    try {
      await (mode === 'login' ? login(creds) : register(creds))
    } catch (err) {
      if (mode === 'login' && err instanceof ApiError && err.status === 401) setError('Неверный логин или пароль.')
      else setError(describeError(err))
      setBusy(false)
    }
  }

  return (
    <main className="page login-page">
      <div className="login-logo">
        <IconAnchor size={48} />
        <h1 className="underline">Морской бой</h1>
      </div>

      <Card className="login-card">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" className="tab" aria-selected={mode === 'login'} onClick={() => switchMode('login')}>
            Вход
          </button>
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={mode === 'register'}
            onClick={() => switchMode('register')}
          >
            Регистрация
          </button>
        </div>

        <form className="stack" onSubmit={submit} noValidate>
          <Field
            label="Логин"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={32}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            hint={mode === 'register' ? '3–32 символа: латиница, цифры, «_»' : undefined}
          />
          <Field
            label="Пароль"
            name="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={mode === 'register' ? 'не короче 8 символов' : undefined}
          />
          {mode === 'register' && (
            <Field
              label="Пароль ещё раз"
              name="repeat"
              type="password"
              autoComplete="new-password"
              maxLength={128}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          )}
          {error && <Note kind="error">{error}</Note>}
          <Button type="submit" variant="primary" icon={<IconKey />} disabled={busy}>
            {mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
          </Button>
        </form>
      </Card>
    </main>
  )
}
