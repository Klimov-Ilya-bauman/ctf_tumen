import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { safeReturnPath } from '../lib/navigation'
import { useAuth } from './AuthContext'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, signOut } = useAuth()
  const location = useLocation()
  if (status === 'loading') {
    return <p className="loading" role="status">Loading...</p>
  }
  if (status === 'service_account') {
    return (
      <main className="auth-page">
        <h1>Service accounts cannot use the web interface</h1>
        <p>Service accounts work only through the API with their tokens.</p>
        <button type="button" onClick={() => void signOut()}>Sign out</button>
      </main>
    )
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: safeReturnPath(location.pathname + location.search) }} />
  }
  return <>{children}</>
}

export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') {
    return <p className="loading" role="status">Loading...</p>
  }
  if (status === 'authenticated') {
    const from = (location.state as { from?: unknown } | null)?.from
    return <Navigate to={safeReturnPath(from)} replace />
  }
  return <>{children}</>
}
