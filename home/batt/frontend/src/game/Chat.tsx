import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { describeError } from '../api/errors'
import { CHAT_MAX_CHARS, type ChatMessage, type UserId } from '../api/types'
import Button from '../ui/Button'
import { IconChat, IconSend } from '../ui/icons'

interface Props {
  messages: readonly ChatMessage[]
  me: UserId

  names: Readonly<Record<UserId, string>>

  enabled: boolean
  disabledText: string
  onSend: (text: string) => Promise<void>
}

const charCount = (s: string) => [...s].length

const time = (sec: number) => new Date(sec * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

function Chat({ messages, me, names, enabled, disabledText, onSend }: Props) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const list = useRef<HTMLOListElement>(null)
  const stick = useRef(true)

  const len = charCount(text.trim())
  const tooLong = len > CHAT_MAX_CHARS

  useLayoutEffect(() => {
    const el = list.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(''), 4000)
    return () => clearTimeout(t)
  }, [error])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    const value = text.trim()
    if (!value || tooLong || sending) return
    setSending(true)
    try {
      await onSend(value)
      setText('')
      stick.current = true
    } catch (err) {
      setError(describeError(err, 'Сообщение не отправилось.'))
    } finally {
      setSending(false)
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <section className="card sketch chat" aria-label="Чат партии">
      <h3>
        <IconChat /> Чат
      </h3>
      <ol
        ref={list}
        className="chat-list"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {messages.length === 0 && <li className="small muted">Сообщений пока нет.</li>}
        {messages.map((m) => (
          <li key={m.id} className={m.user_id === me ? 'msg mine' : 'msg'}>
            <span className="msg-head">
              <b>{names[m.user_id] ?? (m.user_id === me ? 'Вы' : 'Соперник')}</b> <span className="muted">{time(m.created_at)}</span>
            </span>
            <span className="msg-text">{m.text}</span>
          </li>
        ))}
      </ol>
      {enabled ? (
        <form className="chat-form" onSubmit={submit}>
          <span className="input-wrap sketch chat-input">
            <textarea
              className="input"
              rows={2}
              value={text}
              placeholder="Сообщение…"
              aria-label="Сообщение"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
            />
          </span>
          <div className="chat-meta">
            <span className={`small ${tooLong ? 'error-text' : 'muted'}`}>
              {len}/{CHAT_MAX_CHARS}
            </span>
            <Button type="submit" icon={<IconSend />} disabled={!len || tooLong || sending}>
              Отправить
            </Button>
          </div>
          {error && (
            <p className="small error-text" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <p className="small muted">{disabledText}</p>
      )}
    </section>
  )
}

export default memo(Chat)
