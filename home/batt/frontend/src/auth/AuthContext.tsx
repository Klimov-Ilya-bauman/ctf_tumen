import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { authApi } from '../api/auth'
import { setUnauthorizedListener } from '../api/client'
import type { Credentials, User } from '../api/types'

export type AuthStatus = 'idle' | 'checking' | 'authed' | 'anon'

interface AuthValue {
  status: AuthStatus
  user: User | null

  check: () => void
  login: (c: Credentials) => Promise<void>
  register: (c: Credentials) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('idle')
  const [user, setUser] = useState<User | null>(null)
  const checking = useRef(false)

  const signedIn = useCallback((u: User) => {
    setUser(u)
    setStatus('authed')
  }, [])

  const signedOut = useCallback(() => {
    setUser(null)
    setStatus('anon')
  }, [])

  useEffect(() => {
    setUnauthorizedListener(signedOut)
    return () => setUnauthorizedListener(null)
  }, [signedOut])

  const check = useCallback(() => {
    if (checking.current) return
    checking.current = true
    setStatus((s) => (s === 'idle' ? 'checking' : s))
    authApi
      .me()
      .then(signedIn)
      .catch(signedOut)
  }, [signedIn, signedOut])

  const login = useCallback(async (c: Credentials) => signedIn(await authApi.login(c)), [signedIn])
  const register = useCallback(async (c: Credentials) => signedIn(await authApi.register(c)), [signedIn])

  const logout = useCallback(async () => {
    try {
      await authApi.logout()
    } finally {
      signedOut()
    }
  }, [signedOut])

  const value = useMemo(
    () => ({ status, user, check, login, register, logout }),
    [status, user, check, login, register, logout],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth вне AuthProvider')
  return ctx
}
