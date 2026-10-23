import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { zonesApi } from '../api/endpoints'
import type { Org } from '../api/types'
import { ErrorMessage, Loading, Notice } from '../components/Alerts'
import { TextField } from '../components/Field'
import { displayName, validateUserZoneName } from '../lib/dnsName'
import { splitServerError } from '../lib/errors'
import { permissions } from '../lib/roles'
import { collectErrors, hasErrors, validateOptionalTtl, type FieldErrors } from '../lib/validation'
import { disambiguatedOrgName, useOrgs } from '../org/OrgContext'

function CreateZoneForm({ org }: { org: Org }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [defaultTtl, setDefaultTtl] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: zonesApi.create,
    onSuccess: async () => {
      setName('')
      setDefaultTtl('')
      await queryClient.invalidateQueries({ queryKey: ['zones'] })
    },
    onError: (error) => {
      const split = splitServerError(error, ['name', 'default_ttl'])
      setErrors(split.fields)
      setMessage(split.message)
    },
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const zoneName = validateUserZoneName(name.trim())
    const nextErrors = collectErrors({
      name: zoneName.valid ? null : zoneName.message,
      default_ttl: validateOptionalTtl(defaultTtl),
    })
    setErrors(nextErrors)
    setMessage(null)
    if (hasErrors(nextErrors) || !zoneName.valid) {
      return
    }
    create.mutate({
      org_id: org.id,
      name: zoneName.canonical,
      ...(defaultTtl === '' ? {} : { default_ttl: Number(defaultTtl) }),
    })
  }
  return (
    <form className="inline-form" onSubmit={submit} noValidate aria-label="Create zone">
      <h2>New zone</h2>
      <TextField
        label="Zone name"
        value={name}
        onChange={setName}
        error={errors.name}
        placeholder="example.slop"
        help="Only subdomains of .slop can be registered. Internationalized names are converted to punycode."
        autoComplete="off"
      />
      <TextField
        label="Default TTL"
        value={defaultTtl}
        onChange={setDefaultTtl}
        error={errors.default_ttl}
        help="Seconds. Empty uses the server default."
        inputMode="numeric"
        autoComplete="off"
      />
      <ErrorMessage message={message} />
      <button type="submit" className="button-primary" disabled={create.isPending}>
        Create zone
      </button>
    </form>
  )
}

export function ZonesPage() {
  const { currentOrg, isLoading, orgs } = useOrgs()
  const orgId = currentOrg?.id
  const zonesQuery = useQuery({
    queryKey: ['zones', orgId],
    queryFn: () => zonesApi.list(orgId),
    enabled: orgId !== undefined,
  })
  if (isLoading) {
    return <Loading />
  }
  if (currentOrg === null) {
    return <Notice>You are not a member of any organization yet.</Notice>
  }
  const zones = zonesQuery.data?.items ?? []
  return (
    <div className="page">
      <h1>Zones in {disambiguatedOrgName(currentOrg, orgs)}</h1>
      {zonesQuery.isPending ? <Loading /> : null}
      <ErrorMessage error={zonesQuery.error} />
      {zones.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Zone</th>
              <th>Your role</th>
              <th>Serial</th>
              <th>Default TTL</th>
              <th>Transfer</th>
            </tr>
          </thead>
          <tbody>
            {zones.map((zone) => (
              <tr key={zone.id}>
                <td>
                  <Link to={`/zones/${zone.id}`}>{displayName(zone.name)}</Link>
                  {displayName(zone.name) !== zone.name ? <span className="muted"> ({zone.name})</span> : null}
                </td>
                <td>{zone.my_role}</td>
                <td>{zone.soa.serial}</td>
                <td>{zone.default_ttl}</td>
                <td>{zone.pending_transfer_id ? <span className="badge badge-pending">pending</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : zonesQuery.isSuccess ? (
        <p className="muted">No zones visible to you in this organization.</p>
      ) : null}
      {permissions.createInOrg(currentOrg.my_role) ? <CreateZoneForm org={currentOrg} /> : null}
    </div>
  )
}
