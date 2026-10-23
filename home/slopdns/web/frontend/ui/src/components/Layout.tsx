import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router'
import { useAuth, useCurrentUser } from '../auth/AuthContext'
import { orgOptionLabel, useOrgs } from '../org/OrgContext'
import { describeError } from '../lib/errors'
import { ErrorMessage } from './Alerts'

function OrgSwitcher() {
  const { orgs, currentOrg, selectOrg } = useOrgs()
  if (orgs.length === 0) {
    return null
  }
  return (
    <label className="org-switcher">
      <span>Organization</span>
      <select
        aria-label="Current organization"
        value={currentOrg?.id ?? ''}
        onChange={(event) => selectOrg(event.target.value)}
      >
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {orgOptionLabel(org, orgs)}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Layout() {
  const me = useCurrentUser()
  const { signOut } = useAuth()
  const { error } = useOrgs()
  const navigate = useNavigate()
  const [logoutError, setLogoutError] = useState<unknown>(null)
  const [signingOut, setSigningOut] = useState(false)
  const logout = async () => {
    setLogoutError(null)
    setSigningOut(true)
    try {
      await signOut()
      navigate('/login', { replace: true })
    } catch (failure) {
      setLogoutError(failure)
      setSigningOut(false)
    }
  }
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">SlopDNS</span>
        <nav aria-label="Main">
          <NavLink to="/zones">Zones</NavLink>
          <NavLink to="/transfers">Zone transfers</NavLink>
          <NavLink to="/org">Organization</NavLink>
          <NavLink to="/service-accounts">Service accounts</NavLink>
          <NavLink to="/invitations">Invitations</NavLink>
          <NavLink to="/api-help">API</NavLink>
          <NavLink to="/profile">Profile</NavLink>
        </nav>
        <OrgSwitcher />
        <span className="whoami">{me.username}</span>
        <button type="button" disabled={signingOut} onClick={() => void logout()}>
          Sign out
        </button>
      </header>
      <main className="content">
        {logoutError ? (
          <p className="alert alert-error" role="alert">
            Sign out failed: {describeError(logoutError)} Your session is still active.
          </p>
        ) : null}
        <ErrorMessage error={error} />
        <Outlet />
      </main>
    </div>
  )
}
