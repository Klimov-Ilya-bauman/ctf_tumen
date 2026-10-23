import { BrowserRouter } from 'react-router'
import { AuthProvider } from './auth/AuthContext'
import AppRoutes from './router'
import InkDefs from './ui/InkDefs'

export default function App() {
  return (
    <BrowserRouter>
      <InkDefs />
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
