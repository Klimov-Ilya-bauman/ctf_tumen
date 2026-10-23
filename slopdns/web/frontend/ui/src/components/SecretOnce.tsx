import { useState } from 'react'

interface SecretOnceProps {
  title: string
  description: string
  secrets: string[]
  onDismiss: () => void
}

export function SecretOnce({ title, description, secrets, onDismiss }: SecretOnceProps) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secrets.join('\n'))
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section className="secret-once" aria-label={title}>
      <h3>{title}</h3>
      <p>{description}</p>
      <ul className="secret-list">
        {secrets.map((secret) => (
          <li key={secret}>
            <code>{secret}</code>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button type="button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="button-primary" onClick={onDismiss}>
          I have saved it
        </button>
      </div>
    </section>
  )
}
