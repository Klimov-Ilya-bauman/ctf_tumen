import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router'
import { AppProviders, AppRoutes } from './App'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
})

async function startMockApiIfRequested(): Promise<void> {
  if (import.meta.env.MODE === 'mock') {
    const { startBrowserMocks } = await import('./mocks/browser')
    await startBrowserMocks()
  }
}

async function bootstrap(): Promise<void> {
  await startMockApiIfRequested()
  const container = document.getElementById('root')
  if (container === null) {
    throw new Error('Root element #root is missing')
  }
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppProviders>
            <AppRoutes />
          </AppProviders>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  )
}

void bootstrap()
