import { useState } from 'react'
import type { GameId } from '../api/types'
import Button from '../ui/Button'
import { IconCopy } from '../ui/icons'

function inviteLink(id: GameId): string {
  return `${location.origin}/game/${id}`
}

export default function InviteBox({ id }: { id: GameId }) {
  const link = inviteLink(id)
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {

      const input = document.getElementById(`invite-${id}`) as HTMLInputElement | null
      input?.select()
    }
  }

  return (
    <div className="invite">
      <p>
        Код комнаты: <b className="invite-code">{id}</b>
      </p>
      <div className="invite-row">
        <span className="input-wrap sketch invite-link">
          <input
            id={`invite-${id}`}
            className="input"
            readOnly
            value={link}
            aria-label="Ссылка-приглашение"
            onFocus={(e) => e.currentTarget.select()}
          />
        </span>
        <Button icon={<IconCopy />} onClick={copy}>
          {copied ? 'Скопировано' : 'Копировать'}
        </Button>
      </div>
      <p className="small muted">Отправьте код или ссылку сопернику — он вступит в партию, и можно расставлять корабли.</p>
    </div>
  )
}
