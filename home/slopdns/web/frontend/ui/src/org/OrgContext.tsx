import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { orgsApi } from '../api/endpoints'
import type { Org, UserRef } from '../api/types'

export const ORGS_QUERY_KEY = ['orgs'] as const
const STORAGE_KEY = 'slopdns.currentOrgId'

interface OrgContextValue {
  orgs: Org[]
  currentOrg: Org | null
  isLoading: boolean
  error: unknown
  selectOrg: (orgId: string) => void
}

const OrgContext = createContext<OrgContextValue | null>(null)

function readStoredOrgId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(-8)
}

export interface NamedOrg {
  id: string
  name: string
  owner: UserRef
}

export function disambiguatedOrgName(org: NamedOrg, peers: NamedOrg[]): string {
  const sameName = peers.filter((candidate) => candidate.name === org.name && candidate.id !== org.id)
  if (sameName.length === 0) {
    return org.name
  }
  const ownerPart = ` · owner ${org.owner.username}`
  const sameOwner = sameName.some((candidate) => candidate.owner.id === org.owner.id)
  return sameOwner ? `${org.name}${ownerPart} · #${shortId(org.id)}` : `${org.name}${ownerPart}`
}

export function orgOptionLabel(org: Org, orgs: NamedOrg[], options: { withRole?: boolean } = {}): string {
  const name = disambiguatedOrgName(org, orgs)
  if (!org.my_role || !(options.withRole ?? true)) {
    return name
  }
  const separator = name.indexOf(' · ')
  return separator < 0 ? `${name} (${org.my_role})` : `${name.slice(0, separator)} (${org.my_role})${name.slice(separator)}`
}

function pickDefaultOrg(orgs: Org[]): Org | null {
  return orgs.find((org) => org.my_role === 'owner') ?? orgs.find((org) => org.my_role !== null) ?? orgs[0] ?? null
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const orgsQuery = useQuery({ queryKey: ORGS_QUERY_KEY, queryFn: () => orgsApi.list() })
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(readStoredOrgId)

  const selectOrg = useCallback((orgId: string) => {
    setSelectedOrgId(orgId)
    try {
      window.localStorage.setItem(STORAGE_KEY, orgId)
    } catch {
      return
    }
  }, [])

  const value = useMemo<OrgContextValue>(() => {
    const orgs = orgsQuery.data?.items ?? []
    const currentOrg = orgs.find((org) => org.id === selectedOrgId) ?? pickDefaultOrg(orgs)
    return { orgs, currentOrg, isLoading: orgsQuery.isPending, error: orgsQuery.error, selectOrg }
  }, [orgsQuery.data, orgsQuery.isPending, orgsQuery.error, selectedOrgId, selectOrg])

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export function useOrgs(): OrgContextValue {
  const value = useContext(OrgContext)
  if (value === null) {
    throw new Error('useOrgs must be used inside OrgProvider')
  }
  return value
}
