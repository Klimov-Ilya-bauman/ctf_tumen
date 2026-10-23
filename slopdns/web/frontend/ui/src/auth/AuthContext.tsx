import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, markSessionStarted, setUnauthenticatedListener } from '../api/client'
import { authApi } from '../api/endpoints'
import type { Me, UserMe } from '../api/types'

export const ME_QUERY_KEY = ['me'] as const

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'service_account'

interface AuthContextValue {
  status: AuthStatus
  me: UserMe | null
  reloadMe: () => Promise<Me | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

async function fetchMeOrNull(): Promise<Me | null> {
  try {
    return await authApi.me()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null
    }
    throw error
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const meQuery = useQuery({ queryKey: ME_QUERY_KEY, queryFn: fetchMeOrNull, staleTime: 60_000 })

  const forgetSession = useCallback(() => {
    queryClient.getMutationCache().clear()
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== ME_QUERY_KEY[0] })
    queryClient.setQueryData(ME_QUERY_KEY, null)
  }, [queryClient])

  useEffect(() => {
    setUnauthenticatedListener(forgetSession)
    return () => setUnauthenticatedListener(null)
  }, [forgetSession])

  const reloadMe = useCallback(async () => {
    const me = await fetchMeOrNull()
    if (me !== null) {
      markSessionStarted()
    }
    await queryClient.cancelQueries({ queryKey: ME_QUERY_KEY })
    queryClient.setQueryData(ME_QUERY_KEY, me)
    return me
  }, [queryClient])

  const signOut = useCallback(async () => {
    try {
      await authApi.logout()
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        throw error
      }
    }
    forgetSession()
  }, [forgetSession])

  const value = useMemo<AuthContextValue>(() => {
    const data = meQuery.data
    let status: AuthStatus = 'loading'
    let me: UserMe | null = null
    if (meQuery.isPending) {
      status = 'loading'
    } else if (meQuery.isError || data === null || data === undefined) {
      status = 'anonymous'
    } else if (data.principal_type === 'user') {
      status = 'authenticated'
      me = data
    } else {
      status = 'service_account'
    }
    return { status, me, reloadMe, signOut }
  }, [meQuery.data, meQuery.isPending, meQuery.isError, reloadMe, signOut])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === null) {
    throw new Error('useAuth must be used inside AuthProvider')
  }
  return value
}

export function useCurrentUser(): UserMe {
  const { me } = useAuth()
  if (me === null) {
    throw new Error('useCurrentUser requires an authenticated user')
  }
  return me
}
