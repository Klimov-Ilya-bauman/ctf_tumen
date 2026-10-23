import { useId, type InputHTMLAttributes } from 'react'

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: string
}

export default function Field({ label, hint, className, ...rest }: Props) {
  const id = useId()
  return (
    <label className={className ? `field ${className}` : 'field'} htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className="input-wrap sketch">
        <input id={id} className="input" {...rest} />
      </span>
      {hint && <span className="field-hint small muted">{hint}</span>}
    </label>
  )
}
