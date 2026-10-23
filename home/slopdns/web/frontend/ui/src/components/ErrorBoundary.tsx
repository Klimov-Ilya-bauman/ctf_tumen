import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryState {
  failed: boolean
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('SlopDNS UI error', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="auth-page" role="alert">
          <h1>Something went wrong</h1>
          <p>The page failed to render. Reload to continue.</p>
          <a href="/zones">Go to zones</a>
        </main>
      )
    }
    return this.props.children
  }
}
