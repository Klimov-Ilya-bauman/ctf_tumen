import { useState, type FormEvent } from 'react'
import type { RecordInput } from '../api/types'
import { splitServerError } from '../lib/errors'
import {
  DATA_FIELDS,
  GPT_MAX_BYTES,
  STRUCTURED_TYPES,
  changeFormType,
  recordFormFieldNames,
  validateRecordForm,
  type DataFieldSpec,
  type RecordFormState,
  type RecordFormType,
} from '../lib/records'
import { utf8ByteLength } from '../lib/utf8'
import type { FieldErrors } from '../lib/validation'
import { ErrorMessage } from './Alerts'
import { SelectField, TextField } from './Field'

const TYPE_OPTIONS = STRUCTURED_TYPES.map((type) => ({ value: type, label: type }))

interface RecordFormProps {
  zoneName: string
  initialState: RecordFormState
  submitLabel: string
  title: string
  onSubmit: (payload: RecordInput) => Promise<unknown>
  onCancel?: () => void
}

function GptByteCounter({ text }: { text: string }) {
  const bytes = utf8ByteLength(text)
  return (
    <span className={bytes > GPT_MAX_BYTES ? 'byte-counter byte-counter-over' : 'byte-counter'} data-testid="gpt-byte-counter">
      {bytes}/{GPT_MAX_BYTES} bytes
    </span>
  )
}

export function RecordForm({ zoneName, initialState, submitLabel, title, onSubmit, onCancel }: RecordFormProps) {
  const [state, setState] = useState<RecordFormState>(initialState)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const setValue = (key: string, value: string) => setState((current) => ({ ...current, values: { ...current.values, [key]: value } }))
  const setString = (index: number, value: string) =>
    setState((current) => ({ ...current, strings: current.strings.map((item, position) => (position === index ? value : item)) }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setMessage(null)
    const result = validateRecordForm(state, zoneName)
    setErrors(result.errors)
    if (result.payload === null) {
      return
    }
    setBusy(true)
    try {
      await onSubmit(result.payload)
    } catch (error) {
      const split = splitServerError(error, recordFormFieldNames(state))
      setErrors(split.fields)
      setMessage(split.message)
    } finally {
      setBusy(false)
    }
  }

  const renderDataField = (spec: DataFieldSpec) => {
    const value = state.values[spec.key] ?? ''
    const error = errors[`data.${spec.key}`]
    if (spec.kind === 'select') {
      return (
        <SelectField
          key={spec.key}
          label={spec.label}
          value={value}
          onChange={(next) => setValue(spec.key, next)}
          error={error}
          help={spec.help}
          options={spec.options ?? []}
        />
      )
    }
    const help =
      state.formType === 'GPT' && spec.key === 'text' ? (
        <>
          {spec.help} <GptByteCounter text={value} />
        </>
      ) : (
        spec.help
      )
    return (
      <TextField
        key={spec.key}
        label={spec.label}
        value={value}
        onChange={(next) => setValue(spec.key, next)}
        error={error}
        help={help}
        placeholder={spec.placeholder}
        multiline={spec.kind === 'textarea'}
        inputMode={spec.kind === 'integer' ? 'numeric' : undefined}
        autoComplete="off"
      />
    )
  }

  return (
    <form className="record-form" onSubmit={(event) => void submit(event)} noValidate aria-label={title}>
      <h3>{title}</h3>
      <div className="form-row">
        <SelectField
          label="Type"
          value={state.formType}
          onChange={(next) => {
            setState((current) => changeFormType(current, next as RecordFormType))
            setErrors({})
          }}
          options={TYPE_OPTIONS}
        />
        <TextField
          label="Name"
          value={state.name}
          onChange={(next) => setState((current) => ({ ...current, name: next }))}
          error={errors.name}
          help={`Relative to ${zoneName}, @ for the apex.`}
          autoComplete="off"
        />
        <TextField
          label="TTL"
          value={state.ttl}
          onChange={(next) => setState((current) => ({ ...current, ttl: next }))}
          error={errors.ttl}
          help="Seconds. Empty uses the zone default."
          inputMode="numeric"
          autoComplete="off"
        />
      </div>
      <fieldset className="record-data">
        <legend>Data</legend>
        {state.formType === 'TXT' ? (
          <div className="txt-strings">
            {state.strings.map((value, index) => (
              <div className="txt-string" key={index}>
                <TextField
                  label={`String ${index + 1}`}
                  value={value}
                  onChange={(next) => setString(index, next)}
                  error={errors[`data.strings[${index}]`]}
                  help={`${utf8ByteLength(value)}/255 bytes`}
                  autoComplete="off"
                />
                {state.strings.length > 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setState((current) => ({ ...current, strings: current.strings.filter((_item, position) => position !== index) }))
                    }
                  >
                    Remove string {index + 1}
                  </button>
                ) : null}
              </div>
            ))}
            <button type="button" onClick={() => setState((current) => ({ ...current, strings: [...current.strings, ''] }))}>
              Add string
            </button>
          </div>
        ) : (
          DATA_FIELDS[state.formType].map(renderDataField)
        )}
        <ErrorMessage message={errors['data.strings'] ?? errors.data ?? null} />
      </fieldset>
      <ErrorMessage message={message} />
      <div className="actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}
