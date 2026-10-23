import { useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { serviceAccountsApi } from '../api/endpoints'
import type { CreatedApiToken, ServiceAccount } from '../api/types'
import { ErrorMessage, Loading } from '../components/Alerts'
import { ConfirmButton } from '../components/ConfirmButton'
import { TextField } from '../components/Field'
import { RoleBindingsPanel } from '../components/RoleBindingsPanel'
import { SecretOnce } from '../components/SecretOnce'
import { splitServerError } from '../lib/errors'
import { formatTimestamp } from '../lib/format'
import { permissions } from '../lib/roles'
import {
  collectErrors,
  hasErrors,
  validateDescription,
  validateServiceAccountName,
  validateTokenName,
  type FieldErrors,
} from '../lib/validation'

function serviceAccountKey(id: string) {
  return ['service-account', id] as const
}

function EditServiceAccount({ account }: { account: ServiceAccount }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(account.name)
  const [description, setDescription] = useState(account.description ?? '')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const update = useMutation({
    mutationFn: (request: Parameters<typeof serviceAccountsApi.update>[1]) => serviceAccountsApi.update(account.id, request),
    onSuccess: async (updated) => {
      queryClient.setQueryData(serviceAccountKey(account.id), updated)
      await queryClient.invalidateQueries({ queryKey: ['service-accounts'] })
    },
    onError: (error) => {
      const split = splitServerError(error, ['name', 'description'])
      setErrors(split.fields)
      setMessage(split.message)
    },
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextErrors = collectErrors({
      name: validateServiceAccountName(name),
      description: validateDescription(description),
    })
    setErrors(nextErrors)
    setMessage(null)
    if (!hasErrors(nextErrors)) {
      update.mutate({ name, description })
    }
  }
  return (
    <form className="inline-form" onSubmit={submit} noValidate aria-label="Edit service account">
      <TextField label="Service account name" value={name} onChange={setName} error={errors.name} autoComplete="off" />
      <TextField label="Description" value={description} onChange={setDescription} error={errors.description} autoComplete="off" />
      <ErrorMessage message={message} />
      <button type="submit" disabled={update.isPending}>
        Save
      </button>
    </form>
  )
}

function TokensSection({ account }: { account: ServiceAccount }) {
  const queryClient = useQueryClient()
  const queryKey = ['service-account-tokens', account.id]
  const tokensQuery = useQuery({ queryKey, queryFn: () => serviceAccountsApi.listTokens(account.id) })
  const [name, setName] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedApiToken | null>(null)
  const [creating, setCreating] = useState(false)
  const createToken = async (tokenName: string) => {
    setCreating(true)
    try {
      const token = await serviceAccountsApi.createToken(account.id, tokenName)
      setCreated(token)
      setName('')
      await queryClient.invalidateQueries({ queryKey })
    } catch (error) {
      const split = splitServerError(error, ['name'])
      setErrors(split.fields)
      setMessage(split.message)
    } finally {
      setCreating(false)
    }
  }
  const revoke = useMutation({
    mutationFn: (tokenId: string) => serviceAccountsApi.revokeToken(account.id, tokenId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextErrors = collectErrors({ name: validateTokenName(name) })
    setErrors(nextErrors)
    setMessage(null)
    if (!hasErrors(nextErrors)) {
      void createToken(name)
    }
  }
  const tokens = tokensQuery.data?.items ?? []
  return (
    <section className="panel" aria-label="Service account tokens">
      <h2>Tokens</h2>
      <p className="muted">Service account tokens never expire until revoked.</p>
      {created !== null ? (
        <SecretOnce
          title="New service account token"
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
              <th>Last used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => (
              <tr key={token.id}>
                <td>{token.name}</td>
                <td>{formatTimestamp(token.created_at)}</td>
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
        <p className="muted">No tokens.</p>
      ) : null}
      <form className="inline-form" onSubmit={submit} noValidate aria-label="Create service account token">
        <TextField label="Token name" value={name} onChange={setName} error={errors.name} autoComplete="off" />
        <ErrorMessage message={message} />
        <button type="submit" className="button-primary" disabled={creating}>
          Create token
        </button>
      </form>
    </section>
  )
}

export function ServiceAccountPage() {
  const { serviceAccountId = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const accountQuery = useQuery({
    queryKey: serviceAccountKey(serviceAccountId),
    queryFn: () => serviceAccountsApi.get(serviceAccountId),
  })
  const remove = useMutation({
    mutationFn: () => serviceAccountsApi.remove(serviceAccountId),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: serviceAccountKey(serviceAccountId) })
      await queryClient.invalidateQueries({ queryKey: ['service-accounts'] })
      navigate('/service-accounts', { replace: true })
    },
  })
  if (accountQuery.isPending) {
    return <Loading />
  }
  if (accountQuery.isError) {
    return <ErrorMessage error={accountQuery.error} />
  }
  const account = accountQuery.data
  return (
    <div className="page" key={account.id}>
      <h1>Service account {account.name}</h1>
      <dl className="facts">
        <dt>Description</dt>
        <dd>{account.description || 'none'}</dd>
        <dt>Created by</dt>
        <dd>{account.created_by.username}</dd>
        <dt>Your role</dt>
        <dd data-testid="my-sa-role">{account.my_role}</dd>
      </dl>
      {permissions.editServiceAccount(account.my_role) ? <EditServiceAccount account={account} /> : null}
      {permissions.manageServiceAccount(account.my_role) ? <TokensSection account={account} /> : null}
      <RoleBindingsPanel
        resourceType="service_account"
        resourceId={account.id}
        orgId={account.org_id}
        myRole={account.my_role}
        title="Service account roles"
      />
      {permissions.manageServiceAccount(account.my_role) ? (
        <section className="panel panel-danger" aria-label="Delete service account">
          <h2>Delete service account</h2>
          <ErrorMessage error={remove.error} />
          <ConfirmButton label="Delete service account" disabled={remove.isPending} onConfirm={() => remove.mutate()} />
        </section>
      ) : null}
    </div>
  )
}
