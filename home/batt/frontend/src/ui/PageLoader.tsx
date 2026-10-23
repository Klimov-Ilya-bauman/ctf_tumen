import { IconAnchor } from './icons'

export default function PageLoader({ text = 'Минутку…' }: { text?: string }) {
  return (
    <main className="page page-loader" aria-busy="true">
      <span className="spinner">
        <IconAnchor size={40} />
      </span>
      <span className="muted">{text}</span>
    </main>
  )
}
