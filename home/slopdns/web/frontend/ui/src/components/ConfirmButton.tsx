import { useState } from 'react'

interface ConfirmButtonProps {
  label: string
  confirmLabel?: string
  onConfirm: () => void
  disabled?: boolean
  danger?: boolean
}

export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, danger = true }: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false)
  if (!armed) {
    return (
      <button type="button" className={danger ? 'button-danger' : undefined} disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </button>
    )
  }
  return (
    <span className="confirm">
      <button
        type="button"
        className="button-danger"
        disabled={disabled}
        onClick={() => {
          setArmed(false)
          onConfirm()
        }}
      >
        {confirmLabel ?? `Confirm: ${label.toLowerCase()}`}
      </button>
      <button type="button" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  )
}
