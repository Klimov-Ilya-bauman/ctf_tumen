import type { ReactNode } from 'react'

export default function Note({ kind = 'info', children }: { kind?: 'info' | 'error'; children: ReactNode }) {
  return (
    <p className={`note sketch note-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  )
}
