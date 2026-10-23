import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { serviceAccountsApi } from '../api/endpoints'
import type { Org } from '../api/types'
import { ErrorMessage, Loading, Notice } from '../components/Alerts'
import { TextField } from '../components/Field'
import { splitServerError } from '../lib/errors'
import { permissions } from '../lib/roles'
import {
  collectErrors,
  hasErrors,
  validateDescription,
  validateServiceAccountName,
  type FieldErrors,
} from '../lib/validation'
import { disambiguatedOrgName, useOrgs } from '../org/OrgContext'

function CreateServiceAccountForm({ org }: { org: Org }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: serviceAccountsApi.create,
    onSuccess: async () => {
      setName('')
      setDescription('')
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
    if (hasErrors(nextErrors)) {
      return
    }
    create.mutate({ org_id: org.id, name, ...(description === '' ? {} : { description }) })
  }
  return (
    <form className="inline-form" onSubmit={submit} noValidate aria-label="Create service account">
      <h2>New service account</h2>
      <TextField label="Service account name" value={name} onChange={setName} error={errors.name} autoComplete="off" />
      <TextField label="Description" value={description} onChange={setDescription} error={errors.description} autoComplete="off" />
      <ErrorMessage message={message} />
      <button type="submit" className="button-primary" disabled={create.isPending}>
        Create service account
      </button>
    </form>
  )
}

export function ServiceAccountsPage() {
  const { currentOrg, isLoading, orgs } = useOrgs()
  const orgId = currentOrg?.id ?? ''
  const accountsQuery = useQuery({
    queryKey: ['service-accounts', orgId],
    queryFn: () => serviceAccountsApi.list(orgId),
    enabled: orgId !== '',
  })
  if (isLoading) {
    return <Loading />
  }
  if (currentOrg === null) {
    return <Notice>You are not a member of any organization yet.</Notice>
  }
  const accounts = accountsQuery.data?.items ?? []
  return (
    <div className="page">
      <h1>Service accounts in {disambiguatedOrgName(currentOrg, orgs)}</h1>
      <p className="muted">
        Service accounts work only through the API with static tokens. See <Link to="/api-help">API for scripts</Link> for curl examples.
      </p>
      {accountsQuery.isPending ? <Loading /> : null}
      <ErrorMessage error={accountsQuery.error} />
      {accounts.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Created by</th>
              <th>Your role</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>
                  <Link to={`/service-accounts/${account.id}`}>{account.name}</Link>
                </td>
                <td>{account.description}</td>
                <td>{account.created_by.username}</td>
                <td>{account.my_role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : accountsQuery.isSuccess ? (
        <p className="muted">No service accounts visible to you.</p>
      ) : null}
      {permissions.createInOrg(currentOrg.my_role) ? <CreateServiceAccountForm org={currentOrg} /> : null}
    </div>
  )
}
