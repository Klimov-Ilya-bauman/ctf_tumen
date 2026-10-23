import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router'
import RequireAuth from './auth/RequireAuth'
import Home from './pages/Home'
import PageLoader from './ui/PageLoader'

const Login = lazy(() => import('./pages/Login'))
const Lobby = lazy(() => import('./pages/Lobby'))
const Game = lazy(() => import('./pages/Game'))

export default function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/lobby"
          element={
            <RequireAuth>
              <Lobby />
            </RequireAuth>
          }
        />
        <Route
          path="/game/:id"
          element={
            <RequireAuth>
              <Game />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Home />} />
      </Routes>
    </Suspense>
  )
}
