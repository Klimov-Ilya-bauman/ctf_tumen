import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { zoneTransfersApi } from '../api/endpoints'
import type { ZoneTransfer } from '../api/types'
import { ErrorMessage, Loading } from '../components/Alerts'
import { SelectField } from '../components/Field'
import { displayName } from '../lib/dnsName'
import { effectiveStatus, formatTimestamp } from '../lib/format'
import { permissions } from '../lib/roles'
import { ORGS_QUERY_KEY, orgOptionLabel, useOrgs } from '../org/OrgContext'

export const TRANSFERS_QUERY_KEY = ['zone-transfers'] as const

function useRefreshTransfers() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: TRANSFERS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['zones'] }),
      queryClient.invalidateQueries({ queryKey: ['zone'] }),
      queryClient.invalidateQueries({ queryKey: ORGS_QUERY_KEY }),
    ])
}

function IncomingTransferRow({ transfer }: { transfer: ZoneTransfer }) {
  const { orgs } = useOrgs()
  const refresh = useRefreshTransfers()
  const targets = orgs.filter((org) => permissions.acceptTransferInto(org.my_role) && org.id !== transfer.from_org_id)
  const [targetOrgId, setTargetOrgId] = useState(targets[0]?.id ?? '')
  const [choiceError, setChoiceError] = useState<string | null>(null)
  const accept = useMutation({
    mutationFn: () => zoneTransfersApi.accept(transfer.id, targetOrgId),
    onSuccess: refresh,
  })
  const decline = useMutation({ mutationFn: () => zoneTransfersApi.decline(transfer.id), onSuccess: refresh })
  const status = effectiveStatus(transfer.status, transfer.expires_at)
  return (
    <tr>
      <td>{displayName(transfer.zone.name)}</td>
      <td>{transfer.from_user.username}</td>
      <td>
        <span className={`badge badge-${status}`}>{status}</span>
      </td>
      <td>{formatTimestamp(transfer.expires_at)}</td>
      <td>
        {status === 'pending' ? (
          <div className="transfer-actions">
            {targets.length > 0 ? (
              <SelectField
                label={`Target organization for ${transfer.zone.name}`}
                value={targetOrgId}
                onChange={setTargetOrgId}
                error={choiceError ?? undefined}
                options={[
                  { value: '', label: 'Choose...' },
                  ...targets.map((org) => ({ value: org.id, label: orgOptionLabel(org, targets, { withRole: false }) })),
                ]}
              />
            ) : (
              <p className="muted">
                You need the owner or admin role in an organization other than the current one to accept this zone.
              </p>
            )}
            <span className="actions">
              <button
                type="button"
                className="button-primary"
                disabled={targets.length === 0 || accept.isPending}
                onClick={() => {
                  if (targetOrgId === '') {
                    setChoiceError('Choose the organization that will receive the zone.')
                    return
                  }
                  setChoiceError(null)
                  accept.mutate()
                }}
              >
                Accept {transfer.zone.name}
              </button>
              <button type="button" disabled={decline.isPending} onClick={() => decline.mutate()}>
                Decline {transfer.zone.name}
              </button>
            </span>
            <ErrorMessage error={accept.error ?? decline.error} />
          </div>
        ) : null}
      </td>
    </tr>
  )
}

function OutgoingTransferRow({ transfer }: { transfer: ZoneTransfer }) {
  const refresh = useRefreshTransfers()
  const cancel = useMutation({ mutationFn: () => zoneTransfersApi.cancel(transfer.id), onSuccess: refresh })
  const status = effectiveStatus(transfer.status, transfer.expires_at)
  return (
    <tr>
      <td>{displayName(transfer.zone.name)}</td>
      <td>{transfer.to_user.username}</td>
      <td>
        <span className={`badge badge-${status}`}>{status}</span>
      </td>
      <td>{formatTimestamp(transfer.expires_at)}</td>
      <td>
        {status === 'pending' ? (
          <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel transfer of {transfer.zone.name}
          </button>
        ) : null}
        <ErrorMessage error={cancel.error} />
      </td>
    </tr>
  )
}

export function TransfersPage() {
  const incomingQuery = useQuery({
    queryKey: [...TRANSFERS_QUERY_KEY, 'incoming'],
    queryFn: () => zoneTransfersApi.list('incoming'),
  })
  const outgoingQuery = useQuery({
    queryKey: [...TRANSFERS_QUERY_KEY, 'outgoing'],
    queryFn: () => zoneTransfersApi.list('outgoing'),
  })
  const incoming = incomingQuery.data?.items ?? []
  const outgoing = outgoingQuery.data?.items ?? []
  return (
    <div className="page">
      <h1>Zone transfers</h1>
      <section className="panel" aria-label="Incoming transfers">
        <h2>Incoming</h2>
        {incomingQuery.isPending ? <Loading /> : null}
        <ErrorMessage error={incomingQuery.error} />
        {incoming.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Zone</th>
                <th>From</th>
                <th>Status</th>
                <th>Expires</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {incoming.map((transfer) => (
                <IncomingTransferRow key={transfer.id} transfer={transfer} />
              ))}
            </tbody>
          </table>
        ) : incomingQuery.isSuccess ? (
          <p className="muted">No zones have been offered to you.</p>
        ) : null}
      </section>
      <section className="panel" aria-label="Outgoing transfers">
        <h2>Outgoing</h2>
        {outgoingQuery.isPending ? <Loading /> : null}
        <ErrorMessage error={outgoingQuery.error} />
        {outgoing.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Zone</th>
                <th>To</th>
                <th>Status</th>
                <th>Expires</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {outgoing.map((transfer) => (
                <OutgoingTransferRow key={transfer.id} transfer={transfer} />
              ))}
            </tbody>
          </table>
        ) : outgoingQuery.isSuccess ? (
          <p className="muted">You have not offered any zones.</p>
        ) : null}
      </section>
    </div>
  )
}
