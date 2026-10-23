import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { roleBindingsApi, serviceAccountsApi } from '../api/endpoints'
import type { GrantableRole, ResourceType, Role, RoleBinding, RoleBindingCreate } from '../api/types'
import { useCurrentUser } from '../auth/AuthContext'
import { splitServerError } from '../lib/errors'
import { formatTimestamp } from '../lib/format'
import { assignableRoles, permissions } from '../lib/roles'
import { collectErrors, hasErrors, validateUsername, type FieldErrors } from '../lib/validation'
import { ErrorMessage, Loading } from './Alerts'
import { ConfirmButton } from './ConfirmButton'
import { SelectField, TextField } from './Field'

interface RoleBindingsPanelProps {
  resourceType: ResourceType
  resourceId: string
  orgId: string
  myRole: Role | null | undefined
  title?: string
}

const RESOURCE_LABELS: Record<ResourceType, string> = {
  org: 'organization',
  zone: 'zone',
  service_account: 'service account',
}

export function roleBindingsQueryKey(resourceType: ResourceType, resourceId: string) {
  return ['role-bindings', resourceType, resourceId] as const
}

function RoleSelect({ binding, options, onChange, disabled }: {
  binding: RoleBinding
  options: GrantableRole[]
  onChange: (role: GrantableRole) => void
  disabled: boolean
}) {
  return (
    <select
      aria-label={`Role of ${binding.principal_name}`}
      value={binding.role}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as GrantableRole)}
    >
      {options.includes(binding.role as GrantableRole) ? null : <option value={binding.role}>{binding.role}</option>}
      {options.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
    </select>
  )
}

export function RoleBindingsPanel({ resourceType, resourceId, orgId, myRole, title }: RoleBindingsPanelProps) {
  const me = useCurrentUser()
  const queryClient = useQueryClient()
  const queryKey = roleBindingsQueryKey(resourceType, resourceId)
  const canManage = permissions.manageOrgAccess(myRole)
  const bindingsQuery = useQuery({
    queryKey,
    queryFn: () => roleBindingsApi.listForResource(resourceType, resourceId),
  })
  const serviceAccountsQuery = useQuery({
    queryKey: ['service-accounts', orgId],
    queryFn: () => serviceAccountsApi.list(orgId),
    enabled: canManage,
  })
  const [principalKind, setPrincipalKind] = useState<'user' | 'service_account'>('user')
  const [username, setUsername] = useState('')
  const [serviceAccountId, setServiceAccountId] = useState('')
  const [role, setRole] = useState<GrantableRole>('reader')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [actionError, setActionError] = useState<unknown>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['role-bindings'] })

  const grant = useMutation({
    mutationFn: (request: RoleBindingCreate) => roleBindingsApi.create(request),
    onSuccess: async () => {
      setUsername('')
      setServiceAccountId('')
      await invalidate()
    },
    onError: (error) => setFieldErrors(splitServerError(error, ['username', 'principal_id', 'role']).fields),
  })
  const update = useMutation({
    mutationFn: ({ bindingId, nextRole }: { bindingId: string; nextRole: GrantableRole }) =>
      roleBindingsApi.update(bindingId, nextRole),
    onSuccess: invalidate,
    onError: setActionError,
  })
  const revoke = useMutation({
    mutationFn: (bindingId: string) => roleBindingsApi.remove(bindingId),
    onSuccess: invalidate,
    onError: setActionError,
  })

  const bindings = bindingsQuery.data?.items ?? []
  const ownBinding = bindings.find((binding) => binding.principal_type === 'user' && binding.principal_id === me.id)
  const ownBindingRole = ownBinding ? ownBinding.role : null
  const grantOptions = assignableRoles(myRole, null)
  const serviceAccounts = serviceAccountsQuery.data?.items ?? []

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setActionError(null)
    grant.reset()
    if (principalKind === 'user') {
      const errors = collectErrors({ username: validateUsername(username) })
      setFieldErrors(errors)
      if (hasErrors(errors)) {
        return
      }
      grant.mutate({ username, resource_type: resourceType, resource_id: resourceId, role })
      return
    }
    const errors = collectErrors({ principal_id: serviceAccountId === '' ? 'Choose a service account.' : null })
    setFieldErrors(errors)
    if (hasErrors(errors)) {
      return
    }
    grant.mutate({
      principal_type: 'service_account',
      principal_id: serviceAccountId,
      resource_type: resourceType,
      resource_id: resourceId,
      role,
    })
  }

  const grantMessage = grant.error ? splitServerError(grant.error, ['username', 'principal_id', 'role']).message : null

  return (
    <section className="panel" aria-label={title ?? 'Roles'}>
      <h2>{title ?? 'Roles'}</h2>
      {bindingsQuery.isPending ? <Loading /> : null}
      <ErrorMessage error={bindingsQuery.error} />
      <ErrorMessage error={actionError} />
      {bindings.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Principal</th>
              <th>Type</th>
              <th>Role</th>
              <th>Granted</th>
              {canManage ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {bindings.map((binding) => {
              const isOwnerBinding = binding.role === 'owner'
              const isSelf = binding.principal_type === 'user' && binding.principal_id === me.id
              const options = isSelf ? assignableRoles(myRole, ownBindingRole) : grantOptions
              return (
                <tr key={binding.id}>
                  <td>{binding.principal_name}</td>
                  <td>{binding.principal_type === 'user' ? 'user' : 'service account'}</td>
                  <td>
                    {canManage && !isOwnerBinding ? (
                      <RoleSelect
                        binding={binding}
                        options={options}
                        disabled={update.isPending}
                        onChange={(nextRole) => {
                          setActionError(null)
                          update.mutate({ bindingId: binding.id, nextRole })
                        }}
                      />
                    ) : (
                      binding.role
                    )}
                  </td>
                  <td>{formatTimestamp(binding.created_at)}</td>
                  {canManage ? (
                    <td>
                      {isOwnerBinding ? (
                        <span className="muted">owner</span>
                      ) : (
                        <ConfirmButton
                          label={`Revoke ${binding.principal_name}`}
                          confirmLabel="Confirm revoke"
                          disabled={revoke.isPending}
                          onConfirm={() => {
                            setActionError(null)
                            revoke.mutate(binding.id)
                          }}
                        />
                      )}
                    </td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : bindingsQuery.isSuccess ? (
        <p className="muted">No roles granted directly on this {RESOURCE_LABELS[resourceType]}.</p>
      ) : null}
      {canManage ? (
        <form className="inline-form" onSubmit={submit} noValidate aria-label="Grant a role">
          <h3>Grant a role</h3>
          <p className="muted">
            Roles can be granted only to members of the organization and to its service accounts. Invite new people from the
            organization page first.
          </p>
          <SelectField
            label="Principal type"
            value={principalKind}
            onChange={(value) => {
              setPrincipalKind(value as 'user' | 'service_account')
              setFieldErrors({})
            }}
            options={[
              { value: 'user', label: 'User' },
              { value: 'service_account', label: 'Service account' },
            ]}
          />
          {principalKind === 'user' ? (
            <TextField label="Username" value={username} onChange={setUsername} error={fieldErrors.username} autoComplete="off" />
          ) : (
            <SelectField
              label="Service account"
              value={serviceAccountId}
              onChange={setServiceAccountId}
              error={fieldErrors.principal_id}
              options={[
                { value: '', label: serviceAccounts.length > 0 ? 'Choose...' : 'No service accounts in this organization' },
                ...serviceAccounts.map((account) => ({ value: account.id, label: account.name })),
              ]}
            />
          )}
          <SelectField
            label="Role to grant"
            value={role}
            onChange={(value) => setRole(value as GrantableRole)}
            error={fieldErrors.role}
            options={grantOptions.map((option) => ({ value: option, label: option }))}
          />
          <ErrorMessage message={grantMessage} />
          <button type="submit" className="button-primary" disabled={grant.isPending}>
            Grant
          </button>
        </form>
      ) : null}
    </section>
  )
}
