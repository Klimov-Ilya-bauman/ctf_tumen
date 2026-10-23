import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authApi, tokensApi } from '../api/endpoints'
import type { CreatedApiToken, TotpSetupResponse, UserMe, UserTokenCreate } from '../api/types'
import { useAuth, useCurrentUser } from '../auth/AuthContext'
import { ErrorMessage, Loading, Notice } from '../components/Alerts'
import { ConfirmButton } from '../components/ConfirmButton'
import { CheckboxField, TextField } from '../components/Field'
import { QrCode } from '../components/QrCode'
import { SecretOnce } from '../components/SecretOnce'
import { splitServerError } from '../lib/errors'
import { formatTimestamp, isPast } from '../lib/format'
import {
  collectErrors,
  hasErrors,
  normalizeRecoveryCode,
  normalizeTotpCode,
  parseIntegerInRange,
  validateIntegerInRange,
  validatePassword,
  validateRecoveryCode,
  validateTokenName,
  validateTotpCode,
  type FieldErrors,
} from '../lib/validation'

function RecoveryCodesOnce({ codes, onDismiss }: { codes: string[]; onDismiss: () => void }) {
  return (
    <SecretOnce
      title="Recovery codes"
      description="Store these one-time recovery codes in a safe place. Each code can be used once instead of an authentication code. They will not be shown again."
      secrets={codes}
      onDismiss={onDismiss}
    />
  )
}

function EnableTotp({ onRecoveryCodes }: { onRecoveryCodes: (codes: string[]) => void }) {
  const { reloadMe } = useAuth()
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null)
  const [code, setCode] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const start = async () => {
    setFailure(null)
    setBusy(true)
    try {
      setSetup(await authApi.totpSetup())
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedCode = normalizeTotpCode(code)
    const nextErrors = collectErrors({ code: validateTotpCode(normalizedCode) })
    setErrors(nextErrors)
    setFailure(null)
    if (hasErrors(nextErrors)) {
      return
    }
    setBusy(true)
    try {
      const response = await authApi.totpEnable(normalizedCode)
      setSetup(null)
      setCode('')
      onRecoveryCodes(response.recovery_codes)
      await reloadMe()
    } catch (error) {
      const split = splitServerError(error, ['code'])
      setErrors(split.fields)
      setFailure(split.message === null ? null : error)
    } finally {
      setBusy(false)
    }
  }

  if (setup === null) {
    return (
      <div>
        <p>Two-factor authentication is disabled.</p>
        <ErrorMessage error={failure} />
        <button type="button" className="button-primary" disabled={busy} onClick={() => void start()}>
          Enable two-factor authentication
        </button>
      </div>
    )
  }
  return (
    <div className="totp-setup">
      <p>Scan the QR code with an authenticator app, or enter the secret manually, then confirm with a code.</p>
      <QrCode value={setup.otpauth_uri} label="TOTP QR code" />
      <p>
        Secret: <code data-testid="totp-secret">{setup.secret}</code>
      </p>
      <form onSubmit={(event) => void confirm(event)} noValidate aria-label="Confirm two-factor authentication">
        <TextField
          label="Authentication code"
          value={code}
          onChange={setCode}
          error={errors.code}
          autoComplete="one-time-code"
          inputMode="numeric"
        />
        <ErrorMessage error={failure} />
        <button type="submit" className="button-primary" disabled={busy}>
          Confirm and enable
        </button>
        <button type="button" onClick={() => setSetup(null)}>
          Cancel
        </button>
      </form>
    </div>
  )
}

function DisableTotp() {
  const { reloadMe } = useAuth()
  const [password, setPassword] = useState('')
  const [useRecoveryCode, setUseRecoveryCode] = useState(false)
  const [code, setCode] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedRecovery = normalizeRecoveryCode(recoveryCode)
    const normalizedCode = normalizeTotpCode(code)
    const nextErrors = collectErrors({
      password: validatePassword(password),
      code: useRecoveryCode ? null : validateTotpCode(normalizedCode),
      recovery_code: useRecoveryCode ? validateRecoveryCode(normalizedRecovery) : null,
    })
    setErrors(nextErrors)
    setFailure(null)
    if (hasErrors(nextErrors)) {
      return
    }
    setBusy(true)
    try {
      await authApi.totpDisable(
        useRecoveryCode ? { password, recovery_code: normalizedRecovery } : { password, code: normalizedCode },
      )
      await reloadMe()
    } catch (error) {
      const split = splitServerError(error, ['password', 'code', 'recovery_code'])
      setErrors(split.fields)
      setFailure(split.message === null ? null : error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-label="Disable two-factor authentication">
      <h3>Disable two-factor authentication</h3>
      <TextField
        label="Current password"
        type="password"
        value={password}
        onChange={setPassword}
        error={errors.password}
        autoComplete="current-password"
      />
      <CheckboxField label="Use a recovery code" checked={useRecoveryCode} onChange={setUseRecoveryCode} />
      {useRecoveryCode ? (
        <TextField label="Recovery code" value={recoveryCode} onChange={setRecoveryCode} error={errors.recovery_code} />
      ) : (
        <TextField label="Authentication code" value={code} onChange={setCode} error={errors.code} inputMode="numeric" />
      )}
      <ErrorMessage error={failure} />
      <button type="submit" className="button-danger" disabled={busy}>
        Disable
      </button>
    </form>
  )
}

function RegenerateRecoveryCodes({ onRecoveryCodes }: { onRecoveryCodes: (codes: string[]) => void }) {
  const { reloadMe } = useAuth()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedCode = normalizeTotpCode(code)
    const nextErrors = collectErrors({ password: validatePassword(password), code: validateTotpCode(normalizedCode) })
    setErrors(nextErrors)
    setFailure(null)
    if (hasErrors(nextErrors)) {
      return
    }
    setBusy(true)
    try {
      const response = await authApi.regenerateRecoveryCodes(password, normalizedCode)
      setPassword('')
      setCode('')
      onRecoveryCodes(response.recovery_codes)
      await reloadMe()
    } catch (error) {
      const split = splitServerError(error, ['password', 'code'])
      setErrors(split.fields)
      setFailure(split.message === null ? null : error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-label="Regenerate recovery codes">
      <h3>Regenerate recovery codes</h3>
      <p className="muted">All previous recovery codes stop working.</p>
      <TextField
        label="Current password"
        type="password"
        value={password}
        onChange={setPassword}
        error={errors.password}
        autoComplete="current-password"
      />
      <TextField label="Authentication code" value={code} onChange={setCode} error={errors.code} inputMode="numeric" />
      <ErrorMessage error={failure} />
      <button type="submit" disabled={busy}>
        Regenerate
      </button>
    </form>
  )
}

function TotpSection({ me }: { me: UserMe }) {
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  return (
    <section className="panel" aria-label="Two-factor authentication">
      <h2>Two-factor authentication</h2>
      {recoveryCodes !== null ? (
        <RecoveryCodesOnce codes={recoveryCodes} onDismiss={() => setRecoveryCodes(null)} />
      ) : null}
      {me.totp_enabled ? (
        <>
          <p>Two-factor authentication is enabled.</p>
          <p data-testid="recovery-remaining">Recovery codes remaining: {me.recovery_codes_remaining}</p>
          {me.recovery_codes_remaining === 0 ? (
            <Notice>You have no recovery codes left. Regenerate them to keep a way back into your account.</Notice>
          ) : null}
          <RegenerateRecoveryCodes onRecoveryCodes={setRecoveryCodes} />
          <DisableTotp />
        </>
      ) : (
        <EnableTotp onRecoveryCodes={setRecoveryCodes} />
      )}
    </section>
  )
}

const TOKENS_QUERY_KEY = ['my-tokens'] as const

function TokensSection({ me }: { me: UserMe }) {
  const queryClient = useQueryClient()
  const tokensQuery = useQuery({ queryKey: TOKENS_QUERY_KEY, queryFn: () => tokensApi.list() })
  const [name, setName] = useState('')
  const [noExpiry, setNoExpiry] = useState(false)
  const [expiresInDays, setExpiresInDays] = useState('90')
  const [totpCode, setTotpCode] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [created, setCreated] = useState<CreatedApiToken | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const createToken = async (request: UserTokenCreate) => {
    setCreating(true)
    try {
      const token = await tokensApi.create(request)
      setCreated(token)
      setName('')
      setTotpCode('')
      await queryClient.invalidateQueries({ queryKey: TOKENS_QUERY_KEY })
    } catch (error) {
      const split = splitServerError(error, ['name', 'expires_in_days', 'totp_code'])
      setErrors(split.fields)
      setFailure(split.message)
    } finally {
      setCreating(false)
    }
  }
  const revoke = useMutation({
    mutationFn: tokensApi.revoke,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TOKENS_QUERY_KEY }),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const normalizedTotp = normalizeTotpCode(totpCode)
    const nextErrors = collectErrors({
      name: validateTokenName(name),
      expires_in_days: noExpiry ? null : validateIntegerInRange(expiresInDays, 1, 3650),
      totp_code: me.totp_enabled ? validateTotpCode(normalizedTotp) : null,
    })
    setErrors(nextErrors)
    setFailure(null)
    if (hasErrors(nextErrors)) {
      return
    }
    void createToken({
      name,
      ...(noExpiry ? { no_expiry: true } : { expires_in_days: parseIntegerInRange(expiresInDays, 1, 3650) ?? 90 }),
      ...(me.totp_enabled ? { totp_code: normalizedTotp } : {}),
    })
  }

  const tokens = tokensQuery.data?.items ?? []
  return (
    <section className="panel" aria-label="API tokens">
      <h2>Personal API tokens</h2>
      <p className="muted">Tokens act on your behalf with your current permissions. Use them as Authorization: Bearer.</p>
      {created !== null ? (
        <SecretOnce
          title="New API token"
          description={`Copy the token "${created.name}" now. It will not be shown again.`}
          secrets={[created.token]}
          onDismiss={() => setCreated(null)}
        />
      ) : null}
      {tokensQuery.isPending ? <Loading /> : null}
      <ErrorMessage error={tokensQuery.error} />
      <ErrorMessage error={revoke.error} />
      {tokens.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Last used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => (
              <tr key={token.id}>
                <td>{token.name}</td>
                <td>{formatTimestamp(token.created_at)}</td>
                <td>
                  {token.expires_at === null ? 'never' : formatTimestamp(token.expires_at)}
                  {isPast(token.expires_at) ? <span className="badge badge-muted">expired</span> : null}
                </td>
                <td>{formatTimestamp(token.last_used_at)}</td>
                <td>
                  <ConfirmButton
                    label={`Revoke ${token.name}`}
                    confirmLabel="Confirm revoke"
                    disabled={revoke.isPending}
                    onConfirm={() => revoke.mutate(token.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : tokensQuery.isSuccess ? (
        <p className="muted">You have no API tokens.</p>
      ) : null}
      <form className="inline-form" onSubmit={submit} noValidate aria-label="Create API token">
        <h3>Create a token</h3>
        <TextField label="Token name" value={name} onChange={setName} error={errors.name} autoComplete="off" />
        <CheckboxField label="Never expires" checked={noExpiry} onChange={setNoExpiry} />
        {noExpiry ? null : (
          <TextField
            label="Lifetime in days"
            value={expiresInDays}
            onChange={setExpiresInDays}
            error={errors.expires_in_days}
            inputMode="numeric"
          />
        )}
        {me.totp_enabled ? (
          <TextField
            label="Authentication code"
            value={totpCode}
            onChange={setTotpCode}
            error={errors.totp_code}
            inputMode="numeric"
            help="Required because two-factor authentication is enabled."
          />
        ) : null}
        <ErrorMessage message={failure} />
        <button type="submit" className="button-primary" disabled={creating}>
          Create token
        </button>
      </form>
    </section>
  )
}

export function ProfilePage() {
  const me = useCurrentUser()
  return (
    <div className="page">
      <h1>Profile</h1>
      <dl className="facts">
        <dt>Username</dt>
        <dd>{me.username}</dd>
        <dt>Registered</dt>
        <dd>{formatTimestamp(me.created_at)}</dd>
      </dl>
      <TotpSection me={me} />
      <TokensSection me={me} />
    </div>
  )
}
