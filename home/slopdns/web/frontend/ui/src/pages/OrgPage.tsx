import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invitationsApi, orgsApi } from '../api/endpoints'
import type { GrantableRole, Org } from '../api/types'
import { useCurrentUser } from '../auth/AuthContext'
import { ErrorMessage, Loading, Notice } from '../components/Alerts'
import { ConfirmButton } from '../components/ConfirmButton'
import { SelectField, TextField } from '../components/Field'
import { RoleBindingsPanel } from '../components/RoleBindingsPanel'
import { splitServerError } from '../lib/errors'
import { effectiveStatus, formatTimestamp } from '../lib/format'
import { GRANTABLE_ROLES, permissions } from '../lib/roles'
import { collectErrors, hasErrors, validateOrgName, validateUsername, type FieldErrors } from '../lib/validation'
import { ORGS_QUERY_KEY, disambiguatedOrgName, useOrgs } from '../org/OrgContext'

function useInvalidateOrgData() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ORGS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['members'] }),
      queryClient.invalidateQueries({ queryKey: ['role-bindings'] }),
      queryClient.invalidateQueries({ queryKey: ['org-invitations'] }),
    ])
}

function RenameOrg({ org }: { org: Org }) {
  const invalidate = useInvalidateOrgData()
  const [name, setName] = useState(org.name)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const rename = useMutation({
    mutationFn: (nextName: string) => orgsApi.rename(org.id, nextName),
    onSuccess: invalidate,
    onError: (error) => {
      const split = splitServerError(error, ['name'])
      setErrors(split.fields)
      setMessage(split.message)
    },
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextErrors = collectErrors({ name: validateOrgName(name) })
    setErrors(nextErrors)
    setMessage(null)
    if (!hasErrors(nextErrors)) {
      rename.mutate(name)
    }
  }
  return (
    <form className="inline-form" onSubmit={submit} noValidate aria-label="Rename organization">
      <TextField label="Organization name" value={name} onChange={setName} error={errors.name} autoComplete="off" />
      <ErrorMessage message={message} />
      <button type="submit" disabled={rename.isPending}>
        Rename
      </button>
    </form>
  )
}

function MembersSection({ org }: { org: Org }) {
  const me = useCurrentUser()
  const invalidate = useInvalidateOrgData()
  const membersQuery = useQuery({ queryKey: ['members', org.id], queryFn: () => orgsApi.members(org.id) })
  const [newOwnerId, setNewOwnerId] = useState('')
  const [ownerError, setOwnerError] = useState<string | null>(null)
  const removeMember = useMutation({
    mutationFn: (userId: string) => orgsApi.removeMember(org.id, userId),
    onSuccess: invalidate,
  })
  const transferOwnership = useMutation({
    mutationFn: (userId: string) => orgsApi.transferOwnership(org.id, userId),
    onSuccess: async () => {
      setNewOwnerId('')
      await invalidate()
    },
  })
  const canManage = permissions.manageOrgAccess(org.my_role)
  const isOwner = permissions.ownOrg(org.my_role)
  const members = membersQuery.data?.items ?? []
  const ownershipCandidates = members.filter(
    (member) => member.principal_type === 'user' && member.principal_id !== org.owner.id,
  )

  return (
    <section className="panel" aria-label="Members">
      <h2>Members</h2>
      {membersQuery.isPending ? <Loading /> : null}
      <ErrorMessage error={membersQuery.error} />
      <ErrorMessage error={removeMember.error} />
      {members.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Organization role</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const isSelf = member.principal_type === 'user' && member.principal_id === me.id
              const isOwnerMember = member.org_role === 'owner'
              const removable = member.principal_type === 'user' && !isOwnerMember && (canManage || isSelf)
              return (
                <tr key={`${member.principal_type}-${member.principal_id}`}>
                  <td>{member.name}</td>
                  <td>{member.principal_type === 'user' ? 'user' : 'service account'}</td>
                  <td>{member.org_role ?? 'zone or service account roles only'}</td>
                  <td>
                    {removable ? (
                      <ConfirmButton
                        label={isSelf ? 'Leave organization' : `Remove ${member.name}`}
                        confirmLabel={isSelf ? 'Confirm leave' : 'Confirm remove'}
                        disabled={removeMember.isPending}
                        onConfirm={() => removeMember.mutate(member.principal_id)}
                      />
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
      {isOwner ? (
        <form
          className="inline-form"
          aria-label="Transfer ownership"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (newOwnerId === '') {
              setOwnerError('Choose the new owner.')
              return
            }
            setOwnerError(null)
            transferOwnership.mutate(newOwnerId)
          }}
        >
          <h3>Transfer ownership</h3>
          <p className="muted">The new owner must be a member. You will become an admin.</p>
          <SelectField
            label="New owner"
            value={newOwnerId}
            onChange={setNewOwnerId}
            error={ownerError ?? undefined}
            options={[
              { value: '', label: ownershipCandidates.length > 0 ? 'Choose a member...' : 'No other user members' },
              ...ownershipCandidates.map((member) => ({ value: member.principal_id, label: member.name })),
            ]}
          />
          <ErrorMessage error={transferOwnership.error} />
          <button type="submit" disabled={transferOwnership.isPending}>
            Transfer ownership
          </button>
        </form>
      ) : null}
    </section>
  )
}

function InvitationsSection({ org }: { org: Org }) {
  const queryClient = useQueryClient()
  const queryKey = ['org-invitations', org.id]
  const invitationsQuery = useQuery({ queryKey, queryFn: () => invitationsApi.listForOrg(org.id) })
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<GrantableRole>('reader')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const invite = useMutation({
    mutationFn: () => invitationsApi.create(org.id, username, role),
    onSuccess: async () => {
      setUsername('')
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: (error) => {
      const split = splitServerError(error, ['username', 'role'])
      setErrors(split.fields)
      setMessage(split.message)
    },
  })
  const revoke = useMutation({
    mutationFn: (invitationId: string) => invitationsApi.revoke(invitationId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextErrors = collectErrors({ username: validateUsername(username) })
    setErrors(nextErrors)
    setMessage(null)
    if (!hasErrors(nextErrors)) {
      invite.mutate()
    }
  }
  const invitations = invitationsQuery.data?.items ?? []
  return (
    <section className="panel" aria-label="Invitations">
      <h2>Invitations</h2>
      {invitationsQuery.isPending ? <Loading /> : null}
      <ErrorMessage error={invitationsQuery.error} />
      <ErrorMessage error={revoke.error} />
      {invitations.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Invited by</th>
              <th>Expires</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((invitation) => {
              const status = effectiveStatus(invitation.status, invitation.expires_at)
              return (
                <tr key={invitation.id}>
                  <td>{invitation.invitee.username}</td>
                  <td>{invitation.role}</td>
                  <td>
                    <span className={`badge badge-${status}`}>{status}</span>
                  </td>
                  <td>{invitation.invited_by.username}</td>
                  <td>{formatTimestamp(invitation.expires_at)}</td>
                  <td>
                    {status === 'pending' ? (
                      <ConfirmButton
                        label={`Revoke invitation for ${invitation.invitee.username}`}
                        confirmLabel="Confirm revoke"
                        disabled={revoke.isPending}
                        onConfirm={() => revoke.mutate(invitation.id)}
                      />
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : invitationsQuery.isSuccess ? (
        <p className="muted">No invitations yet.</p>
      ) : null}
      <form className="inline-form" onSubmit={submit} noValidate aria-label="Invite a user">
        <h3>Invite a user</h3>
        <p className="muted">The user must accept the invitation within 7 days.</p>
        <TextField label="Username to invite" value={username} onChange={setUsername} error={errors.username} autoComplete="off" />
        <SelectField
          label="Invited role"
          value={role}
          onChange={(value) => setRole(value as GrantableRole)}
          error={errors.role}
          options={GRANTABLE_ROLES.map((option) => ({ value: option, label: option }))}
        />
        <ErrorMessage message={message} />
        <button type="submit" className="button-primary" disabled={invite.isPending}>
          Send invitation
        </button>
      </form>
    </section>
  )
}

function CreateOrg() {
  const { selectOrg } = useOrgs()
  const invalidate = useInvalidateOrgData()
  const [name, setName] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: (orgName: string) => orgsApi.create(orgName),
    onSuccess: async (org) => {
      setName('')
      await invalidate()
      selectOrg(org.id)
    },
    onError: (error) => {
      const split = splitServerError(error, ['name'])
      setErrors(split.fields)
      setMessage(split.message)
    },
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextErrors = collectErrors({ name: validateOrgName(name) })
    setErrors(nextErrors)
    setMessage(null)
    if (!hasErrors(nextErrors)) {
      create.mutate(name)
    }
  }
  return (
    <section className="panel" aria-label="New organization">
      <h2>New organization</h2>
      <form className="inline-form" onSubmit={submit} noValidate aria-label="Create organization">
        <TextField label="New organization name" value={name} onChange={setName} error={errors.name} autoComplete="off" />
        <ErrorMessage message={message} />
        <button type="submit" disabled={create.isPending}>
          Create organization
        </button>
      </form>
    </section>
  )
}

function DeleteOrg({ org }: { org: Org }) {
  const invalidate = useInvalidateOrgData()
  const remove = useMutation({ mutationFn: () => orgsApi.remove(org.id), onSuccess: invalidate })
  return (
    <section className="panel panel-danger" aria-label="Delete organization">
      <h2>Delete organization</h2>
      <p className="muted">Only an organization without zones can be deleted. Its service accounts and tokens are removed.</p>
      <ErrorMessage error={remove.error} />
      <ConfirmButton label="Delete organization" disabled={remove.isPending} onConfirm={() => remove.mutate()} />
    </section>
  )
}

export function OrgPage() {
  const { currentOrg, isLoading, orgs } = useOrgs()
  if (isLoading) {
    return <Loading />
  }
  if (currentOrg === null) {
    return (
      <div className="page">
        <h1>Organization</h1>
        <Notice>You are not a member of any organization.</Notice>
        <CreateOrg />
      </div>
    )
  }
  const role = currentOrg.my_role
  return (
    <div className="page" key={currentOrg.id}>
      <h1>{disambiguatedOrgName(currentOrg, orgs)}</h1>
      <dl className="facts">
        <dt>Owner</dt>
        <dd>{currentOrg.owner.username}</dd>
        <dt>Organization ID</dt>
        <dd>
          <code>{currentOrg.id}</code>
        </dd>
        <dt>Your role</dt>
        <dd data-testid="my-org-role">{role ?? 'none (access through zone or service account roles)'}</dd>
        <dt>Created</dt>
        <dd>{formatTimestamp(currentOrg.created_at)}</dd>
      </dl>
      {permissions.renameOrg(role) ? <RenameOrg org={currentOrg} /> : null}
      {permissions.readOrg(role) ? (
        <MembersSection org={currentOrg} />
      ) : (
        <Notice>You can see only the zones and service accounts shared with you in this organization.</Notice>
      )}
      {permissions.manageOrgAccess(role) ? <InvitationsSection org={currentOrg} /> : null}
      {permissions.readOrg(role) ? (
        <RoleBindingsPanel
          resourceType="org"
          resourceId={currentOrg.id}
          orgId={currentOrg.id}
          myRole={role}
          title="Organization roles"
        />
      ) : null}
      <CreateOrg />
      {permissions.ownOrg(role) ? <DeleteOrg org={currentOrg} /> : null}
    </div>
  )
}
