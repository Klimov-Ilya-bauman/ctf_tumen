import { useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import PageLoader from '../ui/PageLoader'
import { useAuth } from './AuthContext'

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { status, check } = useAuth()
  const location = useLocation()

  useEffect(() => {
    if (status === 'idle') check()
  }, [status, check])

  useEffect(() => {
    if (status === 'anon') {
      const returnTo = location.pathname + location.search
      window.location.href = `/api/auth/refresh?return_to=${encodeURIComponent(returnTo)}`
    }
  }, [status, location])

  if (status !== 'authed') return <PageLoader />
  return children
}
