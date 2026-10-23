import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invitationsApi } from '../api/endpoints'
import { ErrorMessage, Loading } from '../components/Alerts'
import { effectiveStatus, formatTimestamp } from '../lib/format'
import { ORGS_QUERY_KEY, disambiguatedOrgName, shortId, useOrgs } from '../org/OrgContext'

const MY_INVITATIONS_KEY = ['my-invitations'] as const

export function InvitationsPage() {
  const queryClient = useQueryClient()
  const invitationsQuery = useQuery({ queryKey: MY_INVITATIONS_KEY, queryFn: () => invitationsApi.listMine() })
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: MY_INVITATIONS_KEY }),
      queryClient.invalidateQueries({ queryKey: ORGS_QUERY_KEY }),
    ])
  const accept = useMutation({ mutationFn: invitationsApi.accept, onSuccess: refresh })
  const decline = useMutation({ mutationFn: invitationsApi.decline, onSuccess: refresh })
  const invitations = invitationsQuery.data?.items ?? []
  const { orgs } = useOrgs()
  const peers = [...orgs, ...invitations.map((invitation) => invitation.org)]
  const labelOf = (org: (typeof invitations)[number]['org']) => disambiguatedOrgName(org, peers)
  const busy = accept.isPending || decline.isPending
  return (
    <div className="page">
      <h1>Invitations</h1>
      <p className="muted">
        Organization names are not unique. Check who invited you and the organization ID before accepting.
      </p>
      {invitationsQuery.isPending ? <Loading /> : null}
      <ErrorMessage error={invitationsQuery.error} />
      <ErrorMessage error={accept.error ?? decline.error} />
      {invitations.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Organization</th>
              <th>Organization owner</th>
              <th>Role</th>
              <th>Invited by</th>
              <th>Status</th>
              <th>Expires</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((invitation) => {
              const status = effectiveStatus(invitation.status, invitation.expires_at)
              return (
                <tr key={invitation.id}>
                  <td>
                    {invitation.org.name}
                    <span className="muted"> #{shortId(invitation.org.id)}</span>
                  </td>
                  <td>{invitation.org.owner.username}</td>
                  <td>{invitation.role}</td>
                  <td>{invitation.invited_by.username}</td>
                  <td>
                    <span className={`badge badge-${status}`}>{status}</span>
                  </td>
                  <td>{formatTimestamp(invitation.expires_at)}</td>
                  <td>
                    {status === 'pending' ? (
                      <span className="actions">
                        <button
                          type="button"
                          className="button-primary"
                          disabled={busy}
                          onClick={() => accept.mutate(invitation.id)}
                        >
                          Accept invitation to {labelOf(invitation.org)}
                        </button>
                        <button type="button" disabled={busy} onClick={() => decline.mutate(invitation.id)}>
                          Decline invitation to {labelOf(invitation.org)}
                        </button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : invitationsQuery.isSuccess ? (
        <p className="muted">You have no invitations.</p>
      ) : null}
    </div>
  )
}
