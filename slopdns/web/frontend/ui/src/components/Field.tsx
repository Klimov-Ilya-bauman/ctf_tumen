import { useId, type ReactNode } from 'react'

interface BaseFieldProps {
  label: string
  error?: string | undefined
  help?: ReactNode
  disabled?: boolean
}

interface TextFieldProps extends BaseFieldProps {
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'password' | 'number'
  autoComplete?: string
  placeholder?: string | undefined
  multiline?: boolean
  inputMode?: 'text' | 'numeric'
}

function describedBy(errorId: string, helpId: string, error: string | undefined, help: ReactNode): string | undefined {
  const ids = [error ? errorId : null, help ? helpId : null].filter((id): id is string => id !== null)
  return ids.length > 0 ? ids.join(' ') : undefined
}

export function TextField(props: TextFieldProps) {
  const id = useId()
  const errorId = `${id}-error`
  const helpId = `${id}-help`
  const common = {
    id,
    value: props.value,
    disabled: props.disabled,
    placeholder: props.placeholder,
    'aria-invalid': props.error ? true : undefined,
    'aria-describedby': describedBy(errorId, helpId, props.error, props.help),
  }
  return (
    <div className={props.error ? 'field field-invalid' : 'field'}>
      <label htmlFor={id}>{props.label}</label>
      {props.multiline ? (
        <textarea {...common} rows={3} onChange={(event) => props.onChange(event.target.value)} />
      ) : (
        <input
          {...common}
          type={props.type ?? 'text'}
          autoComplete={props.autoComplete}
          inputMode={props.inputMode}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {props.help ? (
        <small id={helpId} className="field-help">
          {props.help}
        </small>
      ) : null}
      {props.error ? (
        <small id={errorId} className="field-error" role="alert">
          {props.error}
        </small>
      ) : null}
    </div>
  )
}

interface SelectFieldProps extends BaseFieldProps {
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}

export function SelectField(props: SelectFieldProps) {
  const id = useId()
  const errorId = `${id}-error`
  const helpId = `${id}-help`
  return (
    <div className={props.error ? 'field field-invalid' : 'field'}>
      <label htmlFor={id}>{props.label}</label>
      <select
        id={id}
        value={props.value}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(errorId, helpId, props.error, props.help)}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {props.help ? (
        <small id={helpId} className="field-help">
          {props.help}
        </small>
      ) : null}
      {props.error ? (
        <small id={errorId} className="field-error" role="alert">
          {props.error}
        </small>
      ) : null}
    </div>
  )
}

interface CheckboxFieldProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

export function CheckboxField(props: CheckboxFieldProps) {
  const id = useId()
  return (
    <div className="field field-checkbox">
      <input
        id={id}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <label htmlFor={id}>{props.label}</label>
    </div>
  )
}
