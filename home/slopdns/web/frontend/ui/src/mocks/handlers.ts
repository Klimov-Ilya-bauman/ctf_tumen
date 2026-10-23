import { http, HttpResponse, type HttpHandler } from 'msw'
import type { GrantableRole, ResourceType, Role, SoaInput } from '../api/types'
import { absoluteOwnerName, validateOwnerName, validateUserZoneName } from '../lib/dnsName'
import { roleAtLeast } from '../lib/roles'
import type { ContractValidator } from './contract'
import {
  MOCK_TOTP_CODE,
  TYPE_CODES,
  daysFromNow,
  newRecoveryCodes,
  newTotpSecret,
  nowIso,
  opaqueToken,
  type MockDb,
  type MockUser,
} from './db'

const API = '*/api/v1'
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const MAX_LOGIN_FAILURES = 5
export const MOCK_LIMITS = { zonesPerOrg: 50, orgsPerUser: 20, pendingInvitationsPerOrg: 100, recordsPerZone: 1000 }
const RESERVED_ZONE_NAMES = ['slopdns.slop.']

type JsonObject = Record<string, unknown>

export function createHandlers(db: MockDb, validator: ContractValidator): HttpHandler[] {
  const respond = (schema: string | null, body: unknown, status = 200) => {
    if (schema !== null) {
      validator.check(schema, body, 'response')
    }
    return HttpResponse.json(body as JsonObject, { status })
  }

  const noContent = () => new HttpResponse(null, { status: 204 })

  const fail = (status: number, code: string, message: string, field?: string) => {
    const body = { error: field === undefined ? { code, message } : { code, message, field } }
    validator.check('Error', body, 'response')
    return HttpResponse.json(body, {
      status,
      headers: status === 429 ? { 'Retry-After': '30' } : undefined,
    })
  }

  const notFound = () => fail(404, 'not_found', 'Not found.')
  const forbidden = () => fail(403, 'forbidden', 'Insufficient role.')
  const conflict = (message: string) => fail(409, 'conflict', message)
  const invalid = (field: string, message: string) => fail(422, 'validation_failed', message, field)
  const quota = (field: string, message: string) => fail(422, 'quota_exceeded', message, field)
  const nestedAcrossOrgs = (name: string, orgId: string) =>
    db.zones.some(
      (zone) => zone.org_id !== orgId && (name.endsWith(`.${zone.name}`) || zone.name.endsWith(`.${name}`)),
    )
  const reservedZoneName = (name: string) =>
    RESERVED_ZONE_NAMES.some((reserved) => name === reserved || name.endsWith(`.${reserved}`) || reserved.endsWith(`.${name}`))

  const readBody = async <T,>(request: Request, schema: string): Promise<{ value: T } | { error: Response }> => {
    let value: unknown
    try {
      value = await request.json()
    } catch {
      return { error: fail(400, 'bad_request', 'Malformed JSON.') }
    }
    const violation = validator.check(schema, value, 'request')
    if (violation !== null) {
      return { error: invalid(violation.field, violation.message) }
    }
    return { value: value as T }
  }

  const authenticate = (request: Request): MockUser | Response => {
    const user = db.sessionUserId === null ? undefined : db.user(db.sessionUserId)
    if (!user) {
      return fail(401, 'unauthenticated', 'Authentication required.')
    }
    if (MUTATING.has(request.method) && request.headers.get('X-SlopDNS-CSRF') !== '1') {
      return fail(403, 'csrf_required', 'X-SlopDNS-CSRF header required.')
    }
    return user
  }

  const page = <T,>(request: Request, items: T[]) => {
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') ?? 100)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset }
  }

  const param = (params: Record<string, string | readonly string[] | undefined>, name: string): string => {
    const value = params[name]
    return typeof value === 'string' ? value : ''
  }

  const establishSession = (user: MockUser) => {
    user.failedLogins = 0
    db.signIn(user)
    return respond('LoginSuccess', {
      mfa_required: false,
      user: { id: user.id, username: user.username, created_at: user.created_at },
    })
  }

  const checkSecondFactor = (user: MockUser, code: string | undefined, recoveryCode: string | undefined): boolean => {
    if (code !== undefined) {
      return code === MOCK_TOTP_CODE
    }
    if (recoveryCode !== undefined) {
      const entry = user.recoveryCodes.find((candidate) => candidate.code === recoveryCode.toUpperCase() && !candidate.used)
      if (entry) {
        entry.used = true
        return true
      }
    }
    return false
  }

  const resourceVisible = (user: MockUser, resourceType: ResourceType, resourceId: string): Role | null | 'missing' => {
    const orgId = db.resourceOrgId(resourceType, resourceId)
    if (orgId === null) {
      return 'missing'
    }
    if (resourceType === 'org') {
      return db.isMember(user.id, resourceId) ? db.orgRole(user.id, resourceId) : 'missing'
    }
    const role = db.effectiveRole(user.id, resourceType, resourceId)
    return role === null ? 'missing' : role
  }

  const authRoutes: HttpHandler[] = [
    http.post(`${API}/auth/register`, async ({ request }) => {
      const body = await readBody<{ username: string; password: string }>(request, 'RegisterRequest')
      if ('error' in body) return body.error
      if (db.userByName(body.value.username)) {
        return conflict('Username is already taken.')
      }
      const user = db.addUser(body.value.username, { password: body.value.password })
      return respond('User', { id: user.id, username: user.username, created_at: user.created_at }, 201)
    }),
    http.post(`${API}/auth/login`, async ({ request }) => {
      const body = await readBody<{ username: string; password: string }>(request, 'LoginRequest')
      if ('error' in body) return body.error
      const user = db.userByName(body.value.username)
      if (user && user.failedLogins >= MAX_LOGIN_FAILURES) {
        return fail(429, 'rate_limited', 'Too many failed attempts.')
      }
      if (!user || user.password !== body.value.password) {
        if (user) user.failedLogins += 1
        return fail(401, 'invalid_credentials', 'Invalid username or password.')
      }
      if (user.totpEnabled) {
        const mfa = { token: opaqueToken('sdmfa'), user_id: user.id, expires_at: new Date(Date.now() + 300000).toISOString(), used: false }
        db.mfaTokens.push(mfa)
        return respond('LoginMfaRequired', { mfa_required: true, mfa_token: mfa.token, mfa_expires_at: mfa.expires_at })
      }
      return establishSession(user)
    }),
    http.post(`${API}/auth/login/totp`, async ({ request }) => {
      const body = await readBody<{ mfa_token: string; code?: string; recovery_code?: string }>(request, 'LoginTotpRequest')
      if ('error' in body) return body.error
      const mfa = db.mfaTokens.find((candidate) => candidate.token === body.value.mfa_token)
      const user = mfa ? db.user(mfa.user_id) : undefined
      if (!mfa || !user || mfa.used || new Date(mfa.expires_at).getTime() <= Date.now()) {
        return fail(401, 'mfa_invalid', 'The login session expired.')
      }
      if (user.failedLogins >= MAX_LOGIN_FAILURES) {
        return fail(429, 'rate_limited', 'Too many failed attempts.')
      }
      if (!checkSecondFactor(user, body.value.code, body.value.recovery_code)) {
        user.failedLogins += 1
        return fail(401, 'mfa_invalid', 'Invalid code.')
      }
      mfa.used = true
      return establishSession(user)
    }),
    http.post(`${API}/auth/logout`, ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      db.sessionUserId = null
      return noContent()
    }),
    http.get(`${API}/auth/me`, ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      return respond('Me', db.meJson(user))
    }),
    http.post(`${API}/auth/totp/setup`, ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      if (user.totpEnabled) return conflict('TOTP is already enabled.')
      user.totpPendingSecret = newTotpSecret()
      return respond('TotpSetupResponse', {
        secret: user.totpPendingSecret,
        otpauth_uri: `otpauth://totp/SlopDNS:${user.username}?secret=${user.totpPendingSecret}&issuer=SlopDNS`,
      })
    }),
    http.post(`${API}/auth/totp/enable`, async ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const body = await readBody<{ code: string }>(request, 'TotpEnableRequest')
      if ('error' in body) return body.error
      if (user.totpEnabled || user.totpPendingSecret === null) return conflict('No pending TOTP enrollment.')
      if (body.value.code !== MOCK_TOTP_CODE) return fail(401, 'mfa_invalid', 'Invalid code.')
      user.totpEnabled = true
      user.totpPendingSecret = null
      user.recoveryCodes = newRecoveryCodes()
      return respond('RecoveryCodesResponse', { recovery_codes: user.recoveryCodes.map((entry) => entry.code) })
    }),
    http.post(`${API}/auth/totp/disable`, async ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const body = await readBody<{ password: string; code?: string; recovery_code?: string }>(request, 'TotpDisableRequest')
      if ('error' in body) return body.error
      if (!user.totpEnabled) return conflict('TOTP is not enabled.')
      if (body.value.password !== user.password) return fail(401, 'invalid_credentials', 'Wrong password.')
      if (!checkSecondFactor(user, body.value.code, body.value.recovery_code)) return fail(401, 'mfa_invalid', 'Invalid code.')
      user.totpEnabled = false
      user.recoveryCodes = []
      return noContent()
    }),
    http.post(`${API}/auth/totp/recovery-codes`, async ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const body = await readBody<{ password: string; code: string }>(request, 'RecoveryCodesRegenerateRequest')
      if ('error' in body) return body.error
      if (!user.totpEnabled) return conflict('TOTP is not enabled.')
      if (body.value.password !== user.password) return fail(401, 'invalid_credentials', 'Wrong password.')
      if (body.value.code !== MOCK_TOTP_CODE) return fail(401, 'mfa_invalid', 'Invalid code.')
      user.recoveryCodes = newRecoveryCodes()
      return respond('RecoveryCodesResponse', { recovery_codes: user.recoveryCodes.map((entry) => entry.code) })
    }),
  ]

  const tokenRoutes: HttpHandler[] = [
    http.get(`${API}/users/me/tokens`, ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const tokens = db.tokens.filter((token) => token.kind === 'user' && token.owner_id === user.id)
      return respond('ApiTokenPage', page(request, tokens.map((token) => db.tokenJson(token))))
    }),
    http.post(`${API}/users/me/tokens`, async ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const body = await readBody<{ name: string; expires_in_days?: number; no_expiry?: boolean; totp_code?: string }>(
        request,
        'UserTokenCreate',
      )
      if ('error' in body) return body.error
      if (user.totpEnabled && body.value.totp_code !== MOCK_TOTP_CODE) {
        return fail(401, 'mfa_invalid', 'A valid TOTP code is required.')
      }
      const expiresAt = body.value.no_expiry ? null : daysFromNow(body.value.expires_in_days ?? 90)
      const token = db.addToken('user', user.id, body.value.name, expiresAt)
      return respond('CreatedApiToken', { ...db.tokenJson(token), token: token.token }, 201)
    }),
    http.delete(`${API}/users/me/tokens/:tokenId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const index = db.tokens.findIndex(
        (token) => token.id === param(params, 'tokenId') && token.kind === 'user' && token.owner_id === user.id,
      )
      if (index < 0) return notFound()
      db.tokens.splice(index, 1)
      return noContent()
    }),
  ]

  const orgRoutes: HttpHandler[] = [
    http.get(`${API}/orgs`, ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const orgs = db.orgs.filter((org) => db.isMember(user.id, org.id)).map((org) => db.orgJson(org, user.id))
      return respond('OrgPage', page(request, orgs))
    }),
    http.post(`${API}/orgs`, async ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const body = await readBody<{ name: string }>(request, 'OrgCreate')
      if ('error' in body) return body.error
      if (db.orgs.filter((org) => db.ownerOf(org.id).id === user.id).length >= MOCK_LIMITS.orgsPerUser) {
        return quota('name', `At most ${MOCK_LIMITS.orgsPerUser} organizations per user.`)
      }
      const org = db.createOrg(body.value.name, user.id)
      return respond('Org', db.orgJson(org, user.id), 201)
    }),
    http.get(`${API}/orgs/:orgId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const org = db.orgs.find((candidate) => candidate.id === param(params, 'orgId'))
      if (!org || !db.isMember(user.id, org.id)) return notFound()
      return respond('Org', db.orgJson(org, user.id))
    }),
    http.patch(`${API}/orgs/:orgId`, async ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const org = db.orgs.find((candidate) => candidate.id === param(params, 'orgId'))
      if (!org || !db.isMember(user.id, org.id)) return notFound()
      if (!roleAtLeast(db.orgRole(user.id, org.id), 'admin')) return forbidden()
      const body = await readBody<{ name: string }>(request, 'OrgUpdate')
      if ('error' in body) return body.error
      org.name = body.value.name
      org.updated_at = nowIso()
      return respond('Org', db.orgJson(org, user.id))
    }),
    http.delete(`${API}/orgs/:orgId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const org = db.orgs.find((candidate) => candidate.id === param(params, 'orgId'))
      if (!org || !db.isMember(user.id, org.id)) return notFound()
      if (db.orgRole(user.id, org.id) !== 'owner') return forbidden()
      if (db.zones.some((zone) => zone.org_id === org.id)) return conflict('The organization still contains zones.')
      const accountIds = new Set(db.serviceAccounts.filter((account) => account.org_id === org.id).map((account) => account.id))
      db.tokens = db.tokens.filter((token) => !accountIds.has(token.owner_id))
      db.serviceAccounts = db.serviceAccounts.filter((account) => account.org_id !== org.id)
      db.bindings = db.bindings.filter((binding) => binding.org_id !== org.id)
      db.invitations = db.invitations.filter((invitation) => invitation.org_id !== org.id)
      db.orgs = db.orgs.filter((candidate) => candidate.id !== org.id)
      return noContent()
    }),
    http.get(`${API}/orgs/:orgId/members`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const orgId = param(params, 'orgId')
      if (!db.isMember(user.id, orgId)) return notFound()
      if (!roleAtLeast(db.orgRole(user.id, orgId), 'reader')) return forbidden()
      return respond('MemberPage', page(request, db.members(orgId)))
    }),
    http.delete(`${API}/orgs/:orgId/members/:userId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const orgId = param(params, 'orgId')
      const targetId = param(params, 'userId')
      if (!db.isMember(user.id, orgId) || !db.isMember(targetId, orgId)) return notFound()
      if (db.orgRole(targetId, orgId) === 'owner') return forbidden()
      if (targetId !== user.id && !roleAtLeast(db.orgRole(user.id, orgId), 'admin')) return forbidden()
      db.bindings = db.bindings.filter((binding) => !(binding.principal_id === targetId && binding.org_id === orgId))
      return noContent()
    }),
    http.post(`${API}/orgs/:orgId/transfer-ownership`, async ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const org = db.orgs.find((candidate) => candidate.id === param(params, 'orgId'))
      if (!org || !db.isMember(user.id, org.id)) return notFound()
      if (db.orgRole(user.id, org.id) !== 'owner') return forbidden()
      const body = await readBody<{ user_id: string }>(request, 'TransferOwnershipRequest')
      if ('error' in body) return body.error
      const target = db.user(body.value.user_id)
      if (!target || !db.isMember(target.id, org.id) || target.id === user.id) {
        return invalid('user_id', 'The new owner must be another user member of the organization.')
      }
      const ownerBinding = db.binding(user.id, 'org', org.id)
      if (ownerBinding) ownerBinding.role = 'admin'
      const targetBinding = db.binding(target.id, 'org', org.id)
      if (targetBinding) {
        targetBinding.role = 'owner'
      } else {
        db.grant('user', target.id, 'org', org.id, org.id, 'owner', user.id)
      }
      return respond('Org', db.orgJson(org, user.id))
    }),
  ]

  const invitationRoutes: HttpHandler[] = [
    http.get(`${API}/orgs/:orgId/invitations`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const orgId = param(params, 'orgId')
      if (!db.isMember(user.id, orgId)) return notFound()
      if (!roleAtLeast(db.orgRole(user.id, orgId), 'admin')) return forbidden()
      const status = new URL(request.url).searchParams.get('status')
      const invitations = db.invitations
        .filter((invitation) => invitation.org_id === orgId)
        .map((invitation) => db.invitationJson(invitation))
        .filter((invitation) => status === null || invitation.status === status)
      return respond('InvitationPage', page(request, invitations))
    }),
    http.post(`${API}/orgs/:orgId/invitations`, async ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const orgId = param(params, 'orgId')
      if (!db.isMember(user.id, orgId)) return notFound()
      if (!roleAtLeast(db.orgRole(user.id, orgId), 'admin')) return forbidden()
      const body = await readBody<{ username: string; role: GrantableRole }>(request, 'InvitationCreate')
      if ('error' in body) return body.error
      const invitee = db.userByName(body.value.username)
      if (!invitee) return invalid('username', 'No such user.')
      if (db.orgRole(invitee.id, orgId) !== null) return conflict('The user is already a member of the organization.')
      if (db.invitations.some((invitation) => invitation.org_id === orgId && invitation.invitee_id === invitee.id && db.invitationStatus(invitation) === 'pending')) {
        return conflict('The user already has a pending invitation.')
      }
      if (db.invitations.filter((candidate) => candidate.org_id === orgId && db.invitationStatus(candidate) === 'pending').length >= MOCK_LIMITS.pendingInvitationsPerOrg) {
        return quota('org_id', `At most ${MOCK_LIMITS.pendingInvitationsPerOrg} pending invitations per organization.`)
      }
      const invitation = db.addInvitation(orgId, invitee.id, user.id, body.value.role)
      return respond('Invitation', db.invitationJson(invitation), 201)
    }),
    http.get(`${API}/invitations`, ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const status = new URL(request.url).searchParams.get('status')
      const invitations = db.invitations
        .filter((invitation) => invitation.invitee_id === user.id)
        .map((invitation) => db.invitationJson(invitation))
        .filter((invitation) => status === null || invitation.status === status)
      return respond('InvitationPage', page(request, invitations))
    }),
    http.post(`${API}/invitations/:invitationId/:action`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const invitation = db.invitations.find((candidate) => candidate.id === param(params, 'invitationId'))
      if (!invitation) return notFound()
      const action = param(params, 'action')
      if (action === 'revoke') {
        if (!db.isMember(user.id, invitation.org_id)) return notFound()
        if (!roleAtLeast(db.orgRole(user.id, invitation.org_id), 'admin')) return forbidden()
      } else if (action === 'accept' || action === 'decline') {
        if (invitation.invitee_id !== user.id) return notFound()
      } else {
        return notFound()
      }
      if (db.invitationStatus(invitation) !== 'pending') return conflict('The invitation is not pending.')
      invitation.decided_at = nowIso()
      if (action === 'accept') {
        invitation.status = 'accepted'
        const existing = db.binding(user.id, 'org', invitation.org_id)
        if (!existing) db.grant('user', user.id, 'org', invitation.org_id, invitation.org_id, invitation.role, invitation.invited_by_id)
      } else {
        invitation.status = action === 'decline' ? 'declined' : 'revoked'
      }
      return respond('Invitation', db.invitationJson(invitation))
    }),
  ]

  const roleBindingRoutes: HttpHandler[] = [
    http.get(`${API}/role-bindings`, ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const url = new URL(request.url)
      const resourceType = url.searchParams.get('resource_type') as ResourceType | null
      const resourceId = url.searchParams.get('resource_id')
      const orgId = url.searchParams.get('org_id')
      if (resourceType !== null && resourceId !== null) {
        const visible = resourceVisible(user, resourceType, resourceId)
        if (visible === 'missing') return notFound()
        if (!roleAtLeast(visible, 'reader')) return forbidden()
        const bindings = db.bindings.filter(
          (binding) => binding.resource_type === resourceType && binding.resource_id === resourceId,
        )
        return respond('RoleBindingPage', page(request, bindings.map((binding) => db.bindingJson(binding))))
      }
      if (orgId !== null) {
        if (!db.isMember(user.id, orgId)) return notFound()
        if (!roleAtLeast(db.orgRole(user.id, orgId), 'reader')) return forbidden()
        const bindings = db.bindings.filter((binding) => binding.org_id === orgId)
        return respond('RoleBindingPage', page(request, bindings.map((binding) => db.bindingJson(binding))))
      }
      return invalid('resource_type', 'resource_type with resource_id or org_id is required.')
    }),
    http.post(`${API}/role-bindings`, async ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const body = await readBody<{
        username?: string
        principal_type?: 'user' | 'service_account'
        principal_id?: string
        resource_type: ResourceType
        resource_id: string
        role: GrantableRole
      }>(request, 'RoleBindingCreate')
      if ('error' in body) return body.error
      const { resource_type: resourceType, resource_id: resourceId, role } = body.value
      const visible = resourceVisible(user, resourceType, resourceId)
      if (visible === 'missing') return notFound()
      if (!roleAtLeast(visible, 'admin')) return forbidden()
      const orgId = db.resourceOrgId(resourceType, resourceId) ?? ''
      let principalType: 'user' | 'service_account' = 'user'
      let principalId = ''
      if (body.value.username !== undefined) {
        const target = db.userByName(body.value.username)
        if (!target) return invalid('username', 'No such user.')
        principalId = target.id
      } else {
        principalType = body.value.principal_type ?? 'user'
        principalId = body.value.principal_id ?? ''
        if (principalType === 'service_account') {
          const account = db.serviceAccounts.find((candidate) => candidate.id === principalId)
          if (!account || account.org_id !== orgId) {
            return invalid('principal_id', 'Service accounts can receive roles only in their own organization.')
          }
        } else if (!db.user(principalId)) {
          return invalid('principal_id', 'No such user.')
        }
      }
      if (principalType === 'user' && !db.isMember(principalId, orgId)) {
        return invalid(
          body.value.username !== undefined ? 'username' : 'principal_id',
          'The user is not a member of the organization, invite them first.',
        )
      }
      if (principalId === user.id) return forbidden()
      if (db.binding(principalId, resourceType, resourceId)) return conflict('The principal already has a role on this resource.')
      const binding = db.grant(principalType, principalId, resourceType, resourceId, orgId, role, user.id)
      return respond('RoleBinding', db.bindingJson(binding), 201)
    }),
    http.patch(`${API}/role-bindings/:bindingId`, async ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const binding = db.bindings.find((candidate) => candidate.id === param(params, 'bindingId'))
      if (!binding) return notFound()
      const visible = resourceVisible(user, binding.resource_type, binding.resource_id)
      if (visible === 'missing') return notFound()
      if (!roleAtLeast(visible, 'admin') || binding.role === 'owner') return forbidden()
      const body = await readBody<{ role: GrantableRole }>(request, 'RoleBindingUpdate')
      if ('error' in body) return body.error
      if (binding.principal_id === user.id && roleAtLeast(body.value.role, binding.role) && body.value.role !== binding.role) {
        return forbidden()
      }
      binding.role = body.value.role
      return respond('RoleBinding', db.bindingJson(binding))
    }),
    http.delete(`${API}/role-bindings/:bindingId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const binding = db.bindings.find((candidate) => candidate.id === param(params, 'bindingId'))
      if (!binding) return notFound()
      const visible = resourceVisible(user, binding.resource_type, binding.resource_id)
      if (visible === 'missing') return notFound()
      if (!roleAtLeast(visible, 'admin') || binding.role === 'owner') return forbidden()
      db.bindings = db.bindings.filter((candidate) => candidate.id !== binding.id)
      return noContent()
    }),
  ]

  const serviceAccountRoutes: HttpHandler[] = [
    http.get(`${API}/service-accounts`, ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const orgId = new URL(request.url).searchParams.get('org_id')
      if (orgId === null) return invalid('org_id', 'org_id is required.')
      if (!db.isMember(user.id, orgId)) return notFound()
      const accounts = db.serviceAccounts
        .filter((account) => account.org_id === orgId && db.effectiveRole(user.id, 'service_account', account.id) !== null)
        .map((account) => db.serviceAccountJson(account, user.id))
      return respond('ServiceAccountPage', page(request, accounts))
    }),
    http.post(`${API}/service-accounts`, async ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const body = await readBody<{ org_id: string; name: string; description?: string }>(request, 'ServiceAccountCreate')
      if ('error' in body) return body.error
      if (!db.isMember(user.id, body.value.org_id)) return notFound()
      if (!roleAtLeast(db.orgRole(user.id, body.value.org_id), 'editor')) return forbidden()
      if (db.serviceAccounts.some((account) => account.org_id === body.value.org_id && account.name === body.value.name)) {
        return conflict('A service account with this name exists.')
      }
      const account = db.addServiceAccount(body.value.org_id, body.value.name, user.id, body.value.description ?? '')
      return respond('ServiceAccount', db.serviceAccountJson(account, user.id), 201)
    }),
    http.get(`${API}/service-accounts/:accountId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const account = db.serviceAccounts.find((candidate) => candidate.id === param(params, 'accountId'))
      if (!account || db.effectiveRole(user.id, 'service_account', account.id) === null) return notFound()
      return respond('ServiceAccount', db.serviceAccountJson(account, user.id))
    }),
    http.patch(`${API}/service-accounts/:accountId`, async ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const account = db.serviceAccounts.find((candidate) => candidate.id === param(params, 'accountId'))
      const role = account ? db.effectiveRole(user.id, 'service_account', account.id) : null
      if (!account || role === null) return notFound()
      if (!roleAtLeast(role, 'editor')) return forbidden()
      const body = await readBody<{ name?: string; description?: string }>(request, 'ServiceAccountUpdate')
      if ('error' in body) return body.error
      if (body.value.name !== undefined) account.name = body.value.name
      if (body.value.description !== undefined) account.description = body.value.description
      account.updated_at = nowIso()
      return respond('ServiceAccount', db.serviceAccountJson(account, user.id))
    }),
    http.delete(`${API}/service-accounts/:accountId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const account = db.serviceAccounts.find((candidate) => candidate.id === param(params, 'accountId'))
      const role = account ? db.effectiveRole(user.id, 'service_account', account.id) : null
      if (!account || role === null) return notFound()
      if (!roleAtLeast(role, 'admin')) return forbidden()
      db.serviceAccounts = db.serviceAccounts.filter((candidate) => candidate.id !== account.id)
      db.tokens = db.tokens.filter((token) => token.owner_id !== account.id)
      db.bindings = db.bindings.filter((binding) => binding.principal_id !== account.id && binding.resource_id !== account.id)
      return noContent()
    }),
    http.get(`${API}/service-accounts/:accountId/tokens`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const account = db.serviceAccounts.find((candidate) => candidate.id === param(params, 'accountId'))
      const role = account ? db.effectiveRole(user.id, 'service_account', account.id) : null
      if (!account || role === null) return notFound()
      if (!roleAtLeast(role, 'admin')) return forbidden()
      const tokens = db.tokens.filter((token) => token.kind === 'service_account' && token.owner_id === account.id)
      return respond('ApiTokenPage', page(request, tokens.map((token) => db.tokenJson(token))))
    }),
    http.post(`${API}/service-accounts/:accountId/tokens`, async ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const account = db.serviceAccounts.find((candidate) => candidate.id === param(params, 'accountId'))
      const role = account ? db.effectiveRole(user.id, 'service_account', account.id) : null
      if (!account || role === null) return notFound()
      if (!roleAtLeast(role, 'admin')) return forbidden()
      const body = await readBody<{ name: string }>(request, 'ServiceAccountTokenCreate')
      if ('error' in body) return body.error
      const token = db.addToken('service_account', account.id, body.value.name, null)
      return respond('CreatedApiToken', { ...db.tokenJson(token), token: token.token }, 201)
    }),
    http.delete(`${API}/service-accounts/:accountId/tokens/:tokenId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const account = db.serviceAccounts.find((candidate) => candidate.id === param(params, 'accountId'))
      const role = account ? db.effectiveRole(user.id, 'service_account', account.id) : null
      if (!account || role === null) return notFound()
      if (!roleAtLeast(role, 'admin')) return forbidden()
      const index = db.tokens.findIndex((token) => token.id === param(params, 'tokenId') && token.owner_id === account.id)
      if (index < 0) return notFound()
      db.tokens.splice(index, 1)
      return noContent()
    }),
  ]

  const zoneRoutes: HttpHandler[] = [
    http.get(`${API}/zones`, ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const url = new URL(request.url)
      const orgId = url.searchParams.get('org_id')
      const nameFilter = url.searchParams.get('name')
      const zones = db.zones
        .filter((zone) => orgId === null || zone.org_id === orgId)
        .filter((zone) => nameFilter === null || zone.name.includes(nameFilter.toLowerCase()))
        .filter((zone) => db.effectiveRole(user.id, 'zone', zone.id) !== null)
        .sort((first, second) => first.name.localeCompare(second.name))
        .map((zone) => db.zoneJson(zone, user.id))
      return respond('ZonePage', page(request, zones))
    }),
    http.post(`${API}/zones`, async ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const body = await readBody<{ org_id: string; name: string; default_ttl?: number; soa?: SoaInput }>(request, 'ZoneCreate')
      if ('error' in body) return body.error
      if (!db.isMember(user.id, body.value.org_id)) return notFound()
      if (!roleAtLeast(db.orgRole(user.id, body.value.org_id), 'editor')) return forbidden()
      const name = validateUserZoneName(body.value.name)
      if (!name.valid) return invalid('name', name.message)
      if (reservedZoneName(name.canonical)) return invalid('name', 'This name is reserved for the service infrastructure.')
      if (db.zones.some((zone) => zone.name === name.canonical)) return conflict('The zone name is already registered.')
      if (nestedAcrossOrgs(name.canonical, body.value.org_id)) {
        return conflict('A zone may be nested only with zones of the same organization.')
      }
      if (db.zones.filter((zone) => zone.org_id === body.value.org_id).length >= MOCK_LIMITS.zonesPerOrg) {
        return quota('org_id', `At most ${MOCK_LIMITS.zonesPerOrg} zones per organization.`)
      }
      const zone = db.addZone(body.value.org_id, name.canonical, body.value.default_ttl ?? 3600)
      Object.assign(zone.soa, body.value.soa ?? {})
      return respond('Zone', db.zoneJson(zone, user.id), 201)
    }),
    http.get(`${API}/zones/:zoneId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const zone = db.zones.find((candidate) => candidate.id === param(params, 'zoneId'))
      if (!zone || db.effectiveRole(user.id, 'zone', zone.id) === null) return notFound()
      return respond('Zone', db.zoneJson(zone, user.id))
    }),
    http.patch(`${API}/zones/:zoneId`, async ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const zone = db.zones.find((candidate) => candidate.id === param(params, 'zoneId'))
      const role = zone ? db.effectiveRole(user.id, 'zone', zone.id) : null
      if (!zone || role === null) return notFound()
      if (!roleAtLeast(role, 'editor')) return forbidden()
      const body = await readBody<{ default_ttl?: number; soa?: SoaInput }>(request, 'ZoneUpdate')
      if ('error' in body) return body.error
      if (body.value.default_ttl !== undefined) zone.default_ttl = body.value.default_ttl
      Object.assign(zone.soa, body.value.soa ?? {})
      db.bumpSerial(zone)
      return respond('Zone', db.zoneJson(zone, user.id))
    }),
    http.delete(`${API}/zones/:zoneId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const zone = db.zones.find((candidate) => candidate.id === param(params, 'zoneId'))
      const role = zone ? db.effectiveRole(user.id, 'zone', zone.id) : null
      if (!zone || role === null) return notFound()
      if (!roleAtLeast(role, 'admin')) return forbidden()
      db.records = db.records.filter((record) => record.zone_id !== zone.id)
      db.bindings = db.bindings.filter((binding) => !(binding.resource_type === 'zone' && binding.resource_id === zone.id))
      for (const transfer of db.transfers) {
        if (transfer.zone_id === zone.id && transfer.status === 'pending') {
          transfer.status = 'cancelled'
          transfer.decided_at = nowIso()
        }
      }
      db.zones = db.zones.filter((candidate) => candidate.id !== zone.id)
      return noContent()
    }),
    http.post(`${API}/zones/:zoneId/transfer`, async ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const zone = db.zones.find((candidate) => candidate.id === param(params, 'zoneId'))
      const role = zone ? db.effectiveRole(user.id, 'zone', zone.id) : null
      if (!zone || role === null) return notFound()
      if (!roleAtLeast(role, 'admin')) return forbidden()
      const body = await readBody<{ username: string }>(request, 'ZoneTransferCreate')
      if ('error' in body) return body.error
      const recipient = db.userByName(body.value.username)
      if (!recipient) return invalid('username', 'No such user.')
      if (recipient.id === user.id) return invalid('username', 'You cannot transfer a zone to yourself.')
      if (db.transfers.some((transfer) => transfer.zone_id === zone.id && db.transferStatus(transfer) === 'pending')) {
        return conflict('A transfer of this zone is already pending.')
      }
      const transfer = db.addTransfer(zone.id, user.id, recipient.id)
      return respond('ZoneTransfer', db.transferJson(transfer), 201)
    }),
  ]

  const recordRoutes: HttpHandler[] = [
    http.get(`${API}/zones/:zoneId/records`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const zone = db.zones.find((candidate) => candidate.id === param(params, 'zoneId'))
      if (!zone || db.effectiveRole(user.id, 'zone', zone.id) === null) return notFound()
      const url = new URL(request.url)
      const typeFilter = url.searchParams.get('type')
      const records = db.records
        .filter((record) => record.zone_id === zone.id)
        .filter((record) => typeFilter === null || record.type === typeFilter)
        .sort((first, second) => first.name.localeCompare(second.name) || first.type.localeCompare(second.type))
        .map((record) => db.recordJson(record))
      return respond('RecordPage', page(request, records))
    }),
    http.post(`${API}/zones/:zoneId/records`, async ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const zone = db.zones.find((candidate) => candidate.id === param(params, 'zoneId'))
      const role = zone ? db.effectiveRole(user.id, 'zone', zone.id) : null
      if (!zone || role === null) return notFound()
      if (!roleAtLeast(role, 'editor')) return forbidden()
      const body = await readBody<{ name: string; type: string; ttl?: number; data: Record<string, unknown> }>(request, 'RecordInput')
      if ('error' in body) return body.error
      const nameError = validateOwnerName(body.value.name, zone.name)
      if (nameError !== null) return invalid('name', nameError)
      const name = absoluteOwnerName(body.value.name, zone.name)
      if (body.value.type === 'CNAME' && name === zone.name) return invalid('name', 'CNAME is not allowed at the zone apex.')
      const duplicate = db.records.some(
        (record) =>
          record.zone_id === zone.id &&
          record.name === name &&
          record.type === body.value.type &&
          JSON.stringify(record.data) === JSON.stringify(body.value.data),
      )
      if (duplicate) return conflict('An identical record exists.')
      if (db.records.filter((record) => record.zone_id === zone.id).length >= MOCK_LIMITS.recordsPerZone) {
        return quota('zone_id', `At most ${MOCK_LIMITS.recordsPerZone} records per zone.`)
      }
      const record = db.addRecord(zone.id, { name, type: body.value.type, ttl: body.value.ttl, data: body.value.data })
      for (const sibling of db.records) {
        if (sibling.zone_id === zone.id && sibling.name === name && sibling.type === record.type) sibling.ttl = record.ttl
      }
      db.bumpSerial(zone)
      return respond('Record', db.recordJson(record), 201)
    }),
    http.get(`${API}/records/:recordId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const record = db.records.find((candidate) => candidate.id === param(params, 'recordId'))
      if (!record || db.effectiveRole(user.id, 'zone', record.zone_id) === null) return notFound()
      return respond('Record', db.recordJson(record))
    }),
    http.put(`${API}/records/:recordId`, async ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const record = db.records.find((candidate) => candidate.id === param(params, 'recordId'))
      const zone = record ? db.zones.find((candidate) => candidate.id === record.zone_id) : undefined
      const role = zone ? db.effectiveRole(user.id, 'zone', zone.id) : null
      if (!record || !zone || role === null) return notFound()
      if (!roleAtLeast(role, 'editor')) return forbidden()
      const body = await readBody<{ name: string; type: string; ttl?: number; data: Record<string, unknown> }>(request, 'RecordInput')
      if ('error' in body) return body.error
      const nameError = validateOwnerName(body.value.name, zone.name)
      if (nameError !== null) return invalid('name', nameError)
      record.name = absoluteOwnerName(body.value.name, zone.name)
      record.type = body.value.type
      record.type_code = TYPE_CODES[body.value.type] ?? Number(body.value.type.replace(/^TYPE/, ''))
      record.ttl = body.value.ttl ?? record.ttl
      record.data = body.value.data
      record.updated_at = nowIso()
      db.bumpSerial(zone)
      return respond('Record', db.recordJson(record))
    }),
    http.delete(`${API}/records/:recordId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const record = db.records.find((candidate) => candidate.id === param(params, 'recordId'))
      const zone = record ? db.zones.find((candidate) => candidate.id === record.zone_id) : undefined
      const role = zone ? db.effectiveRole(user.id, 'zone', zone.id) : null
      if (!record || !zone || role === null) return notFound()
      if (!roleAtLeast(role, 'editor')) return forbidden()
      const apexNs = db.records.filter((candidate) => candidate.zone_id === zone.id && candidate.type === 'NS' && candidate.name === zone.name)
      if (record.type === 'NS' && record.name === zone.name && apexNs.length <= 1) {
        return invalid('id', 'The last NS record at the zone apex cannot be deleted.')
      }
      db.records = db.records.filter((candidate) => candidate.id !== record.id)
      db.bumpSerial(zone)
      return noContent()
    }),
  ]

  const transferRoutes: HttpHandler[] = [
    http.get(`${API}/zone-transfers`, ({ request }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const url = new URL(request.url)
      const direction = url.searchParams.get('direction')
      const status = url.searchParams.get('status')
      const incoming = (transferUserId: string) => transferUserId === user.id
      const transfers = db.transfers
        .filter((transfer) => {
          const isIncoming = incoming(transfer.to_user_id)
          const isOutgoing =
            transfer.from_user_id === user.id || roleAtLeast(db.effectiveRole(user.id, 'zone', transfer.zone_id), 'admin')
          if (direction === 'incoming') return isIncoming
          if (direction === 'outgoing') return isOutgoing
          return isIncoming || isOutgoing
        })
        .map((transfer) => db.transferJson(transfer))
        .filter((transfer) => status === null || transfer.status === status)
      return respond('ZoneTransferPage', page(request, transfers))
    }),
    http.get(`${API}/zone-transfers/:transferId`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const transfer = db.transfers.find((candidate) => candidate.id === param(params, 'transferId'))
      if (
        !transfer ||
        (transfer.to_user_id !== user.id &&
          transfer.from_user_id !== user.id &&
          db.effectiveRole(user.id, 'zone', transfer.zone_id) === null)
      ) {
        return notFound()
      }
      return respond('ZoneTransfer', db.transferJson(transfer))
    }),
    http.post(`${API}/zone-transfers/:transferId/accept`, async ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const transfer = db.transfers.find((candidate) => candidate.id === param(params, 'transferId'))
      if (!transfer) return notFound()
      if (transfer.to_user_id !== user.id) return forbidden()
      const body = await readBody<{ target_org_id: string }>(request, 'ZoneTransferAccept')
      if ('error' in body) return body.error
      if (db.transferStatus(transfer) !== 'pending') return conflict('The transfer is not pending.')
      const zone = db.zones.find((candidate) => candidate.id === transfer.zone_id)
      if (!zone) return conflict('The zone no longer exists.')
      const targetOrgId = body.value.target_org_id
      if (!roleAtLeast(db.orgRole(user.id, targetOrgId), 'admin')) return forbidden()
      if (targetOrgId === zone.org_id) {
        return invalid('target_org_id', 'The target organization must differ from the current one.')
      }
      if (nestedAcrossOrgs(zone.name, targetOrgId)) {
        return conflict('The zone would be nested with a zone of another organization.')
      }
      if (db.zones.filter((candidate) => candidate.org_id === targetOrgId).length >= MOCK_LIMITS.zonesPerOrg) {
        return quota('target_org_id', `At most ${MOCK_LIMITS.zonesPerOrg} zones per organization.`)
      }
      db.bindings = db.bindings.filter((binding) => !(binding.resource_type === 'zone' && binding.resource_id === zone.id))
      zone.org_id = targetOrgId
      db.grant('user', user.id, 'zone', zone.id, targetOrgId, 'admin', null)
      transfer.status = 'accepted'
      transfer.target_org_id = targetOrgId
      transfer.decided_at = nowIso()
      return respond('ZoneTransfer', db.transferJson(transfer))
    }),
    http.post(`${API}/zone-transfers/:transferId/:action`, ({ request, params }) => {
      const user = authenticate(request)
      if (user instanceof Response) return user
      const transfer = db.transfers.find((candidate) => candidate.id === param(params, 'transferId'))
      if (!transfer) return notFound()
      const action = param(params, 'action')
      if (action === 'decline') {
        if (transfer.to_user_id !== user.id) return forbidden()
      } else if (action === 'cancel') {
        if (!roleAtLeast(db.effectiveRole(user.id, 'zone', transfer.zone_id), 'admin')) return forbidden()
      } else {
        return notFound()
      }
      if (db.transferStatus(transfer) !== 'pending') return conflict('The transfer is not pending.')
      transfer.status = action === 'decline' ? 'declined' : 'cancelled'
      transfer.decided_at = nowIso()
      return respond('ZoneTransfer', db.transferJson(transfer))
    }),
  ]

  return [
    ...authRoutes,
    ...tokenRoutes,
    ...orgRoutes,
    ...invitationRoutes,
    ...roleBindingRoutes,
    ...serviceAccountRoutes,
    ...zoneRoutes,
    ...recordRoutes,
    ...transferRoutes,
  ]
}
