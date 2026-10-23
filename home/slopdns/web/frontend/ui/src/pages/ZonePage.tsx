import { useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { recordsApi, zonesApi, zoneTransfersApi } from '../api/endpoints'
import type { DnsRecord, RecordInput, Zone } from '../api/types'
import { ErrorMessage, Loading } from '../components/Alerts'
import { ConfirmButton } from '../components/ConfirmButton'
import { RecordForm } from '../components/RecordForm'
import { RoleBindingsPanel } from '../components/RoleBindingsPanel'
import { TextField } from '../components/Field'
import { displayName, validateHostName } from '../lib/dnsName'
import { splitServerError } from '../lib/errors'
import { formatTimestamp } from '../lib/format'
import { emptyRecordForm, formatRecordData, isStructuredType, recordToFormState } from '../lib/records'
import { permissions } from '../lib/roles'
import {
  MAX_TTL,
  collectErrors,
  hasErrors,
  validateIntegerInRange,
  validateUsername,
  type FieldErrors,
} from '../lib/validation'
import { TRANSFERS_QUERY_KEY } from './TransfersPage'

const RECORDS_PAGE_SIZE = 100
const RECORD_TYPE_FILTER = /^([A-Z]{1,10}|TYPE[1-9][0-9]{0,4})$/

function zoneQueryKey(zoneId: string) {
  return ['zone', zoneId] as const
}

function RecordsSection({ zone }: { zone: Zone }) {
  const queryClient = useQueryClient()
  const canEdit = permissions.editZone(zone.my_role)
  const [offset, setOffset] = useState(0)
  const [typeFilter, setTypeFilter] = useState('')
  const [appliedType, setAppliedType] = useState<string | undefined>(undefined)
  const [filterError, setFilterError] = useState<string | undefined>(undefined)
  const [editing, setEditing] = useState<DnsRecord | null>(null)
  const [createFormKey, setCreateFormKey] = useState(0)
  const recordsQuery = useQuery({
    queryKey: ['records', zone.id, offset, appliedType],
    queryFn: () => recordsApi.list(zone.id, { limit: RECORDS_PAGE_SIZE, offset, type: appliedType }),
    placeholderData: keepPreviousData,
  })
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['records', zone.id] }),
      queryClient.invalidateQueries({ queryKey: zoneQueryKey(zone.id) }),
    ])
  const remove = useMutation({ mutationFn: recordsApi.remove, onSuccess: refresh })

  const create = async (payload: RecordInput) => {
    await recordsApi.create(zone.id, payload)
    setCreateFormKey((key) => key + 1)
    await refresh()
  }
  const replace = async (record: DnsRecord, payload: RecordInput) => {
    await recordsApi.replace(record.id, payload)
    setEditing(null)
    await refresh()
  }

  const page = recordsQuery.data
  const records = page?.items ?? []
  const total = page?.total ?? 0

  return (
    <section className="panel" aria-label="Records">
      <h2>Records</h2>
      <form
        className="inline-form filter-form"
        aria-label="Filter records"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          const normalizedType = typeFilter.trim().toUpperCase()
          if (normalizedType !== '' && !RECORD_TYPE_FILTER.test(normalizedType)) {
            setFilterError('Use a type mnemonic such as MX or TYPE65280.')
            return
          }
          setFilterError(undefined)
          setOffset(0)
          setAppliedType(normalizedType === '' ? undefined : normalizedType)
        }}
      >
        <TextField label="Filter by type" value={typeFilter} onChange={setTypeFilter} error={filterError} autoComplete="off" />
        <button type="submit">Apply filter</button>
      </form>
      {recordsQuery.isPending ? <Loading /> : null}
      <ErrorMessage error={recordsQuery.error} />
      <ErrorMessage error={remove.error} />
      {records.length > 0 ? (
        <table className="records">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>TTL</th>
              <th>Data</th>
              {canEdit ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td>{displayName(record.name)}</td>
                <td>{record.type}</td>
                <td>{record.ttl}</td>
                <td className="record-data-cell">{formatRecordData(record)}</td>
                {canEdit ? (
                  <td>
                    <span className="actions">
                      {isStructuredType(record.type) ? (
                        <button type="button" onClick={() => setEditing(record)}>
                          Edit {record.type} {record.name}
                        </button>
                      ) : (
                        <span className="muted">read-only type</span>
                      )}
                      <ConfirmButton
                        label={`Delete ${record.type} ${record.name}`}
                        confirmLabel="Confirm delete"
                        disabled={remove.isPending}
                        onConfirm={() => remove.mutate(record.id)}
                      />
                    </span>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : recordsQuery.isSuccess ? (
        <p className="muted">No records.</p>
      ) : null}
      {total > RECORDS_PAGE_SIZE ? (
        <div className="pager">
          <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - RECORDS_PAGE_SIZE))}>
            Previous page
          </button>
          <span>
            {offset + 1}-{Math.min(offset + RECORDS_PAGE_SIZE, total)} of {total}
          </span>
          <button
            type="button"
            disabled={offset + RECORDS_PAGE_SIZE >= total}
            onClick={() => setOffset(offset + RECORDS_PAGE_SIZE)}
          >
            Next page
          </button>
        </div>
      ) : null}
      {canEdit && editing !== null ? (
        <RecordForm
          key={editing.id}
          zoneName={zone.name}
          title={`Edit record ${editing.type} ${editing.name}`}
          submitLabel="Save record"
          initialState={recordToFormState(editing, zone.name)}
          onSubmit={(payload) => replace(editing, payload)}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {canEdit ? (
        <RecordForm
          key={`create-${createFormKey}`}
          zoneName={zone.name}
          title="Add record"
          submitLabel="Add record"
          initialState={emptyRecordForm()}
          onSubmit={create}
        />
      ) : null}
    </section>
  )
}

interface SettingsForm {
  default_ttl: string
  mname: string
  rname: string
  refresh: string
  retry: string
  expire: string
  minimum: string
}

function settingsFromZone(zone: Zone): SettingsForm {
  return {
    default_ttl: String(zone.default_ttl),
    mname: zone.soa.mname,
    rname: zone.soa.rname,
    refresh: String(zone.soa.refresh),
    retry: String(zone.soa.retry),
    expire: String(zone.soa.expire),
    minimum: String(zone.soa.minimum),
  }
}

const SOA_SECONDS_MAX = 2147483647

function ZoneSettings({ zone }: { zone: Zone }) {
  const queryClient = useQueryClient()
  const canEdit = permissions.editZone(zone.my_role)
  const [form, setForm] = useState<SettingsForm>(() => settingsFromZone(zone))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const update = useMutation({
    mutationFn: (request: Parameters<typeof zonesApi.update>[1]) => zonesApi.update(zone.id, request),
    onSuccess: async (updated) => {
      queryClient.setQueryData(zoneQueryKey(zone.id), updated)
      setForm(settingsFromZone(updated))
      setSaved(true)
      await queryClient.invalidateQueries({ queryKey: ['zones'] })
    },
    onError: (error) => {
      const split = splitServerError(error, [
        'default_ttl',
        'soa.mname',
        'soa.rname',
        'soa.refresh',
        'soa.retry',
        'soa.expire',
        'soa.minimum',
      ])
      setErrors(split.fields)
      setMessage(split.message)
    },
  })
  const set = (key: keyof SettingsForm) => (value: string) => {
    setSaved(false)
    setForm((current) => ({ ...current, [key]: value }))
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextErrors = collectErrors({
      default_ttl: validateIntegerInRange(form.default_ttl, 0, MAX_TTL),
      'soa.mname': validateHostName(form.mname, false),
      'soa.rname': validateHostName(form.rname, false),
      'soa.refresh': validateIntegerInRange(form.refresh, 60, SOA_SECONDS_MAX),
      'soa.retry': validateIntegerInRange(form.retry, 60, SOA_SECONDS_MAX),
      'soa.expire': validateIntegerInRange(form.expire, 60, SOA_SECONDS_MAX),
      'soa.minimum': validateIntegerInRange(form.minimum, 0, 86400),
    })
    setErrors(nextErrors)
    setMessage(null)
    if (hasErrors(nextErrors)) {
      return
    }
    update.mutate({
      default_ttl: Number(form.default_ttl),
      soa: {
        mname: form.mname,
        rname: form.rname,
        refresh: Number(form.refresh),
        retry: Number(form.retry),
        expire: Number(form.expire),
        minimum: Number(form.minimum),
      },
    })
  }
  return (
    <section className="panel" aria-label="Zone settings">
      <h2>Zone settings (SOA)</h2>
      <p>
        Serial: <span data-testid="soa-serial">{zone.soa.serial}</span>
      </p>
      <form className="settings-form" onSubmit={submit} noValidate aria-label="Zone settings form">
        <TextField label="Default TTL" value={form.default_ttl} onChange={set('default_ttl')} error={errors.default_ttl} disabled={!canEdit} />
        <TextField label="Primary name server (MNAME)" value={form.mname} onChange={set('mname')} error={errors['soa.mname']} disabled={!canEdit} />
        <TextField label="Responsible mailbox (RNAME)" value={form.rname} onChange={set('rname')} error={errors['soa.rname']} disabled={!canEdit} />
        <TextField label="Refresh" value={form.refresh} onChange={set('refresh')} error={errors['soa.refresh']} disabled={!canEdit} />
        <TextField label="Retry" value={form.retry} onChange={set('retry')} error={errors['soa.retry']} disabled={!canEdit} />
        <TextField label="Expire" value={form.expire} onChange={set('expire')} error={errors['soa.expire']} disabled={!canEdit} />
        <TextField label="Negative TTL (minimum)" value={form.minimum} onChange={set('minimum')} error={errors['soa.minimum']} disabled={!canEdit} />
        <ErrorMessage message={message} />
        {saved ? <p role="status">Settings saved.</p> : null}
        {canEdit ? (
          <button type="submit" className="button-primary" disabled={update.isPending}>
            Save settings
          </button>
        ) : null}
      </form>
    </section>
  )
}

function TransferSection({ zone }: { zone: Zone }) {
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const pendingId = zone.pending_transfer_id ?? null
  const transferQuery = useQuery({
    queryKey: [...TRANSFERS_QUERY_KEY, 'detail', pendingId],
    queryFn: () => zoneTransfersApi.get(pendingId ?? ''),
    enabled: pendingId !== null,
  })
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: zoneQueryKey(zone.id) }),
      queryClient.invalidateQueries({ queryKey: TRANSFERS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['zones'] }),
    ])
  const offer = useMutation({
    mutationFn: (recipient: string) => zonesApi.offerTransfer(zone.id, recipient),
    onSuccess: async () => {
      setUsername('')
      await refresh()
    },
    onError: (error) => {
      const split = splitServerError(error, ['username'])
      setErrors(split.fields)
      setMessage(split.message)
    },
  })
  const cancel = useMutation({ mutationFn: (transferId: string) => zoneTransfersApi.cancel(transferId), onSuccess: refresh })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextErrors = collectErrors({ username: validateUsername(username) })
    setErrors(nextErrors)
    setMessage(null)
    if (!hasErrors(nextErrors)) {
      offer.mutate(username)
    }
  }
  return (
    <section className="panel" aria-label="Transfer zone">
      <h2>Transfer zone</h2>
      {pendingId !== null ? (
        <div>
          {transferQuery.data ? (
            <p>
              Offered to <strong>{transferQuery.data.to_user.username}</strong>, expires{' '}
              {formatTimestamp(transferQuery.data.expires_at)}.
            </p>
          ) : (
            <p>A transfer of this zone is pending.</p>
          )}
          <ErrorMessage error={cancel.error} />
          <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(pendingId)}>
            Cancel transfer
          </button>
        </div>
      ) : (
        <form className="inline-form" onSubmit={submit} noValidate aria-label="Offer zone transfer">
          <p className="muted">
            The recipient accepts the zone into one of their organizations. Zone-level roles from this organization are removed.
          </p>
          <TextField label="Recipient username" value={username} onChange={setUsername} error={errors.username} autoComplete="off" />
          <ErrorMessage message={message} />
          <button type="submit" disabled={offer.isPending}>
            Offer transfer
          </button>
        </form>
      )}
    </section>
  )
}

function DeleteZone({ zone }: { zone: Zone }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const remove = useMutation({
    mutationFn: () => zonesApi.remove(zone.id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: zoneQueryKey(zone.id) })
      await queryClient.invalidateQueries({ queryKey: ['zones'] })
      navigate('/zones', { replace: true })
    },
  })
  return (
    <section className="panel panel-danger" aria-label="Delete zone">
      <h2>Delete zone</h2>
      <p className="muted">All records are deleted and the DNS server stops serving the zone immediately.</p>
      <ErrorMessage error={remove.error} />
      <ConfirmButton label="Delete zone" disabled={remove.isPending} onConfirm={() => remove.mutate()} />
    </section>
  )
}

export function ZonePage() {
  const { zoneId = '' } = useParams()
  const zoneQuery = useQuery({ queryKey: zoneQueryKey(zoneId), queryFn: () => zonesApi.get(zoneId) })
  if (zoneQuery.isPending) {
    return <Loading />
  }
  if (zoneQuery.isError) {
    return <ErrorMessage error={zoneQuery.error} />
  }
  const zone = zoneQuery.data
  return (
    <div className="page" key={zone.id}>
      <h1>{displayName(zone.name)}</h1>
      {displayName(zone.name) !== zone.name ? <p className="muted">Punycode: {zone.name}</p> : null}
      <dl className="facts">
        <dt>Your role</dt>
        <dd data-testid="my-zone-role">{zone.my_role}</dd>
        <dt>Updated</dt>
        <dd>{formatTimestamp(zone.updated_at)}</dd>
      </dl>
      <RecordsSection zone={zone} />
      <ZoneSettings zone={zone} />
      {permissions.manageZoneAccess(zone.my_role) ? <TransferSection zone={zone} /> : null}
      <RoleBindingsPanel resourceType="zone" resourceId={zone.id} orgId={zone.org_id} myRole={zone.my_role} title="Zone roles" />
      {permissions.deleteZone(zone.my_role) ? <DeleteZone zone={zone} /> : null}
    </div>
  )
}
