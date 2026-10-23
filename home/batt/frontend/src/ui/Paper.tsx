import type { ReactNode } from 'react'

interface Props {
  title?: ReactNode

  actions?: ReactNode
  className?: string
  children?: ReactNode
}

export default function Paper({ title, actions, className, children }: Props) {
  return (
    <main className={className ? `page ${className}` : 'page'}>
      {(title || actions) && (
        <header className="page-head">
          {title && <h1 className="page-title">{title}</h1>}
          {actions && <div className="page-actions">{actions}</div>}
        </header>
      )}
      {children}
    </main>
  )
}

export function Card({ className, children, as: Tag = 'section' }: { className?: string; children?: ReactNode; as?: 'section' | 'div' | 'aside' }) {
  return <Tag className={className ? `card sketch ${className}` : 'card sketch'}>{children}</Tag>
}
