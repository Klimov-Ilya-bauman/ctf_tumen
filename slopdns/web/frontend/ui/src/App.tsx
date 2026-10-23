import type { ReactNode } from 'react'
import { Link, Navigate, Route, Routes } from 'react-router'
import { AuthProvider } from './auth/AuthContext'
import { RedirectIfAuthenticated, RequireAuth } from './auth/RequireAuth'
import { AppErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/Layout'
import { OrgProvider } from './org/OrgContext'
import { ApiHelpPage } from './pages/ApiHelpPage'
import { InvitationsPage } from './pages/InvitationsPage'
import { LoginPage } from './pages/LoginPage'
import { OrgPage } from './pages/OrgPage'
import { ProfilePage } from './pages/ProfilePage'
import { RegisterPage } from './pages/RegisterPage'
import { ServiceAccountPage } from './pages/ServiceAccountPage'
import { ServiceAccountsPage } from './pages/ServiceAccountsPage'
import { TotpStepPage } from './pages/TotpStepPage'
import { TransfersPage } from './pages/TransfersPage'
import { ZonePage } from './pages/ZonePage'
import { ZonesPage } from './pages/ZonesPage'

function NotFoundPage() {
  return (
    <div className="page">
      <h1>Page not found</h1>
      <Link to="/zones">Go to zones</Link>
    </div>
  )
}

function AuthenticatedApp() {
  return (
    <RequireAuth>
      <OrgProvider>
        <Layout />
      </OrgProvider>
    </RequireAuth>
  )
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AppErrorBoundary>
      <AuthProvider>{children}</AuthProvider>
    </AppErrorBoundary>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfAuthenticated>
            <LoginPage />
          </RedirectIfAuthenticated>
        }
      />
      <Route
        path="/login/totp"
        element={
          <RedirectIfAuthenticated>
            <TotpStepPage />
          </RedirectIfAuthenticated>
        }
      />
      <Route
        path="/register"
        element={
          <RedirectIfAuthenticated>
            <RegisterPage />
          </RedirectIfAuthenticated>
        }
      />
      <Route element={<AuthenticatedApp />}>
        <Route index element={<Navigate to="/zones" replace />} />
        <Route path="/zones" element={<ZonesPage />} />
        <Route path="/zones/:zoneId" element={<ZonePage />} />
        <Route path="/transfers" element={<TransfersPage />} />
        <Route path="/org" element={<OrgPage />} />
        <Route path="/invitations" element={<InvitationsPage />} />
        <Route path="/service-accounts" element={<ServiceAccountsPage />} />
        <Route path="/service-accounts/:serviceAccountId" element={<ServiceAccountPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/api-help" element={<ApiHelpPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
