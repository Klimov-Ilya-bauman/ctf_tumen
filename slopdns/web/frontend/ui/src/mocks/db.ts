import type {
  ApiToken,
  GrantableRole,
  Invitation,
  InvitationStatus,
  Member,
  Org,
  PrincipalType,
  ResourceType,
  Role,
  RoleBinding,
  ServiceAccount,
  Soa,
  UserMe,
  UserRef,
  Zone,
  ZoneTransfer,
  ZoneTransferStatus,
} from '../api/types'
import { maxRole } from '../lib/roles'

export const MOCK_TOTP_CODE = '123456'
export const MOCK_PASSWORD = 'correct-horse-battery'

const DAY_MS = 24 * 60 * 60 * 1000
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export const TYPE_CODES: Record<string, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  PTR: 12,
  HINFO: 13,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  NAPTR: 35,
  DNAME: 39,
  SSHFP: 44,
  TLSA: 52,
  CAA: 257,
  GPT: 65280,
}

export interface MockUser {
  id: string
  username: string
  password: string
  created_at: string
  totpEnabled: boolean
  totpPendingSecret: string | null
  recoveryCodes: Array<{ code: string; used: boolean }>
  failedLogins: number
}

export interface MockOrg {
  id: string
  name: string
  created_at: string
  updated_at: string
}

export interface MockBinding {
  id: string
  principal_type: PrincipalType
  principal_id: string
  resource_type: ResourceType
  resource_id: string
  org_id: string
  role: Role
  granted_by_user_id: string | null
  created_at: string
}

export type MockSoa = { -readonly [Key in keyof Soa]: Soa[Key] }

export interface MockZone {
  id: string
  org_id: string
  name: string
  default_ttl: number
  soa: MockSoa
  created_at: string
  updated_at: string
}

export interface MockRecord {
  id: string
  zone_id: string
  name: string
  type: string
  type_code: number
  ttl: number
  data: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface MockInvitation {
  id: string
  org_id: string
  invitee_id: string
  invited_by_id: string
  role: GrantableRole
  status: InvitationStatus
  created_at: string
  expires_at: string
  decided_at: string | null
}

export interface MockTransfer {
  id: string
  zone_id: string
  zone_name: string
  from_org_id: string
  from_user_id: string
  to_user_id: string
  target_org_id: string | null
  status: ZoneTransferStatus
  created_at: string
  expires_at: string
  decided_at: string | null
}

export interface MockServiceAccount {
  id: string
  org_id: string
  name: string
  description: string
  created_by_id: string
  created_at: string
  updated_at: string
}

export interface MockToken {
  id: string
  name: string
  kind: 'user' | 'service_account'
  owner_id: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
  token: string
}

export interface MockMfaToken {
  token: string
  user_id: string
  expires_at: string
  used: boolean
}

function randomString(alphabet: string, length: number): string {
  let result = ''
  for (let index = 0; index < length; index += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return result
}

export function newId(): string {
  return crypto.randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString()
}

export function opaqueToken(prefix: 'sdpat' | 'sdsat' | 'sdmfa'): string {
  return `${prefix}_${newId()}_${randomString(BASE62, 43)}`
}

export function newRecoveryCodes(): Array<{ code: string; used: boolean }> {
  const codes = new Set<string>()
  while (codes.size < 10) {
    codes.add(randomString(BASE32, 16))
  }
  return [...codes].map((code) => ({ code, used: false }))
}

export function newTotpSecret(): string {
  return randomString(BASE32, 32)
}

export interface AddUserOptions {
  password?: string
  totpEnabled?: boolean
  withDefaultOrg?: boolean
}

export class MockDb {
  users: MockUser[] = []
  orgs: MockOrg[] = []
  bindings: MockBinding[] = []
  zones: MockZone[] = []
  records: MockRecord[] = []
  invitations: MockInvitation[] = []
  transfers: MockTransfer[] = []
  serviceAccounts: MockServiceAccount[] = []
  tokens: MockToken[] = []
  mfaTokens: MockMfaToken[] = []
  sessionUserId: string | null = null

  reset(): void {
    this.users = []
    this.orgs = []
    this.bindings = []
    this.zones = []
    this.records = []
    this.invitations = []
    this.transfers = []
    this.serviceAccounts = []
    this.tokens = []
    this.mfaTokens = []
    this.sessionUserId = null
  }

  addUser(username: string, options: AddUserOptions = {}): MockUser {
    const user: MockUser = {
      id: newId(),
      username,
      password: options.password ?? MOCK_PASSWORD,
      created_at: nowIso(),
      totpEnabled: options.totpEnabled ?? false,
      totpPendingSecret: null,
      recoveryCodes: options.totpEnabled ? newRecoveryCodes() : [],
      failedLogins: 0,
    }
    this.users.push(user)
    if (options.withDefaultOrg ?? true) {
      this.createOrg(`${username}-org`, user.id)
    }
    return user
  }

  createOrg(name: string, ownerId: string): MockOrg {
    const org: MockOrg = { id: newId(), name, created_at: nowIso(), updated_at: nowIso() }
    this.orgs.push(org)
    this.grant('user', ownerId, 'org', org.id, org.id, 'owner', null)
    return org
  }

  defaultOrgOf(user: MockUser): MockOrg {
    const org = this.orgs.find((candidate) => this.orgRole(user.id, candidate.id) === 'owner')
    if (!org) {
      throw new Error(`user ${user.username} owns no organization`)
    }
    return org
  }

  grant(
    principalType: PrincipalType,
    principalId: string,
    resourceType: ResourceType,
    resourceId: string,
    orgId: string,
    role: Role,
    grantedBy: string | null = null,
  ): MockBinding {
    const binding: MockBinding = {
      id: newId(),
      principal_type: principalType,
      principal_id: principalId,
      resource_type: resourceType,
      resource_id: resourceId,
      org_id: orgId,
      role,
      granted_by_user_id: grantedBy,
      created_at: nowIso(),
    }
    this.bindings.push(binding)
    return binding
  }

  addZone(orgId: string, name: string, defaultTtl = 3600): MockZone {
    const canonical = name.endsWith('.') ? name : `${name}.`
    const zone: MockZone = {
      id: newId(),
      org_id: orgId,
      name: canonical,
      default_ttl: defaultTtl,
      soa: {
        mname: 'ns1.slopdns.slop.',
        rname: `hostmaster.${canonical}`,
        serial: 1,
        refresh: 3600,
        retry: 600,
        expire: 1209600,
        minimum: 300,
      },
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    this.zones.push(zone)
    this.addRecord(zone.id, { name: canonical, type: 'NS', data: { nsdname: 'ns1.slopdns.slop.' } })
    this.addRecord(zone.id, { name: canonical, type: 'NS', data: { nsdname: 'ns2.slopdns.slop.' } })
    return zone
  }

  addRecord(zoneId: string, input: { name: string; type: string; ttl?: number; data: Record<string, unknown> }): MockRecord {
    const zone = this.zones.find((candidate) => candidate.id === zoneId)
    if (!zone) {
      throw new Error('zone not found')
    }
    const typeCode = TYPE_CODES[input.type] ?? Number(input.type.replace(/^TYPE/, ''))
    const record: MockRecord = {
      id: newId(),
      zone_id: zoneId,
      name: input.name,
      type: input.type,
      type_code: typeCode,
      ttl: input.ttl ?? zone.default_ttl,
      data: input.data,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    this.records.push(record)
    return record
  }

  addServiceAccount(orgId: string, name: string, createdById: string, description = ''): MockServiceAccount {
    const account: MockServiceAccount = {
      id: newId(),
      org_id: orgId,
      name,
      description,
      created_by_id: createdById,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    this.serviceAccounts.push(account)
    return account
  }

  addInvitation(
    orgId: string,
    inviteeId: string,
    invitedById: string,
    role: GrantableRole,
    options: { status?: InvitationStatus; expiresAt?: string } = {},
  ): MockInvitation {
    const invitation: MockInvitation = {
      id: newId(),
      org_id: orgId,
      invitee_id: inviteeId,
      invited_by_id: invitedById,
      role,
      status: options.status ?? 'pending',
      created_at: nowIso(),
      expires_at: options.expiresAt ?? daysFromNow(7),
      decided_at: null,
    }
    this.invitations.push(invitation)
    return invitation
  }

  addTransfer(zoneId: string, fromUserId: string, toUserId: string, options: { status?: ZoneTransferStatus } = {}): MockTransfer {
    const zone = this.zones.find((candidate) => candidate.id === zoneId)
    if (!zone) {
      throw new Error('zone not found')
    }
    const transfer: MockTransfer = {
      id: newId(),
      zone_id: zone.id,
      zone_name: zone.name,
      from_org_id: zone.org_id,
      from_user_id: fromUserId,
      to_user_id: toUserId,
      target_org_id: null,
      status: options.status ?? 'pending',
      created_at: nowIso(),
      expires_at: daysFromNow(7),
      decided_at: null,
    }
    this.transfers.push(transfer)
    return transfer
  }

  addToken(kind: 'user' | 'service_account', ownerId: string, name: string, expiresAt: string | null): MockToken {
    const token: MockToken = {
      id: newId(),
      name,
      kind,
      owner_id: ownerId,
      created_at: nowIso(),
      expires_at: expiresAt,
      last_used_at: null,
      token: opaqueToken(kind === 'user' ? 'sdpat' : 'sdsat'),
    }
    this.tokens.push(token)
    return token
  }

  signIn(user: MockUser): void {
    this.sessionUserId = user.id
  }

  user(id: string): MockUser | undefined {
    return this.users.find((candidate) => candidate.id === id)
  }

  userByName(username: string): MockUser | undefined {
    return this.users.find((candidate) => candidate.username === username)
  }

  binding(principalId: string, resourceType: ResourceType, resourceId: string): MockBinding | undefined {
    return this.bindings.find(
      (candidate) =>
        candidate.principal_id === principalId &&
        candidate.resource_type === resourceType &&
        candidate.resource_id === resourceId,
    )
  }

  orgRole(principalId: string, orgId: string): Role | null {
    return this.binding(principalId, 'org', orgId)?.role ?? null
  }

  isMember(principalId: string, orgId: string): boolean {
    return this.bindings.some((candidate) => candidate.principal_id === principalId && candidate.org_id === orgId)
  }

  resourceOrgId(resourceType: ResourceType, resourceId: string): string | null {
    if (resourceType === 'org') {
      return this.orgs.some((org) => org.id === resourceId) ? resourceId : null
    }
    if (resourceType === 'zone') {
      return this.zones.find((zone) => zone.id === resourceId)?.org_id ?? null
    }
    return this.serviceAccounts.find((account) => account.id === resourceId)?.org_id ?? null
  }

  effectiveRole(principalId: string, resourceType: ResourceType, resourceId: string): Role | null {
    const orgId = this.resourceOrgId(resourceType, resourceId)
    if (orgId === null) {
      return null
    }
    const direct = this.binding(principalId, resourceType, resourceId)?.role ?? null
    if (resourceType === 'org') {
      return direct
    }
    return maxRole(direct, this.orgRole(principalId, orgId))
  }

  ownerOf(orgId: string): MockUser {
    const binding = this.bindings.find(
      (candidate) => candidate.resource_type === 'org' && candidate.resource_id === orgId && candidate.role === 'owner',
    )
    const owner = binding ? this.user(binding.principal_id) : undefined
    if (!owner) {
      throw new Error('organization without owner')
    }
    return owner
  }

  userRef(id: string): UserRef {
    const user = this.user(id)
    return { id, username: user?.username ?? 'deleted-user' }
  }

  principalName(principalType: PrincipalType, principalId: string): string {
    if (principalType === 'user') {
      return this.user(principalId)?.username ?? 'deleted-user'
    }
    return this.serviceAccounts.find((account) => account.id === principalId)?.name ?? 'deleted-account'
  }

  meJson(user: MockUser): UserMe {
    return {
      principal_type: 'user',
      id: user.id,
      username: user.username,
      totp_enabled: user.totpEnabled,
      recovery_codes_remaining: user.totpEnabled ? user.recoveryCodes.filter((code) => !code.used).length : 0,
      created_at: user.created_at,
    }
  }

  orgJson(org: MockOrg, viewerId: string): Org {
    return {
      id: org.id,
      name: org.name,
      owner: this.userRef(this.ownerOf(org.id).id),
      my_role: this.orgRole(viewerId, org.id),
      created_at: org.created_at,
      updated_at: org.updated_at,
    }
  }

  zoneJson(zone: MockZone, viewerId: string): Zone {
    const pending = this.transfers.find((transfer) => transfer.zone_id === zone.id && this.transferStatus(transfer) === 'pending')
    return {
      id: zone.id,
      org_id: zone.org_id,
      name: zone.name,
      default_ttl: zone.default_ttl,
      soa: { ...zone.soa },
      my_role: this.effectiveRole(viewerId, 'zone', zone.id) ?? 'reader',
      pending_transfer_id: pending?.id ?? null,
      created_at: zone.created_at,
      updated_at: zone.updated_at,
    }
  }

  recordJson(record: MockRecord): Record<string, unknown> {
    return {
      id: record.id,
      zone_id: record.zone_id,
      name: record.name,
      type: record.type,
      type_code: record.type_code,
      ttl: record.ttl,
      data: record.data,
      created_at: record.created_at,
      updated_at: record.updated_at,
    }
  }

  invitationStatus(invitation: MockInvitation): InvitationStatus {
    if (invitation.status === 'pending' && new Date(invitation.expires_at).getTime() <= Date.now()) {
      return 'expired'
    }
    return invitation.status
  }

  invitationJson(invitation: MockInvitation): Invitation {
    const org = this.orgs.find((candidate) => candidate.id === invitation.org_id)
    return {
      id: invitation.id,
      org: { id: invitation.org_id, name: org?.name ?? 'deleted-org', owner: this.userRef(org ? this.ownerOf(org.id).id : invitation.invited_by_id) },
      invitee: this.userRef(invitation.invitee_id),
      invited_by: this.userRef(invitation.invited_by_id),
      role: invitation.role,
      status: this.invitationStatus(invitation),
      created_at: invitation.created_at,
      expires_at: invitation.expires_at,
      decided_at: invitation.decided_at,
    }
  }

  transferStatus(transfer: MockTransfer): ZoneTransferStatus {
    if (transfer.status === 'pending' && new Date(transfer.expires_at).getTime() <= Date.now()) {
      return 'expired'
    }
    return transfer.status
  }

  transferJson(transfer: MockTransfer): ZoneTransfer {
    return {
      id: transfer.id,
      zone: { id: transfer.zone_id, name: transfer.zone_name },
      from_org_id: transfer.from_org_id,
      from_user: this.userRef(transfer.from_user_id),
      to_user: this.userRef(transfer.to_user_id),
      target_org_id: transfer.target_org_id,
      status: this.transferStatus(transfer),
      created_at: transfer.created_at,
      expires_at: transfer.expires_at,
      decided_at: transfer.decided_at,
    }
  }

  bindingJson(binding: MockBinding): RoleBinding {
    return {
      id: binding.id,
      principal_type: binding.principal_type,
      principal_id: binding.principal_id,
      principal_name: this.principalName(binding.principal_type, binding.principal_id),
      resource_type: binding.resource_type,
      resource_id: binding.resource_id,
      org_id: binding.org_id,
      role: binding.role,
      granted_by_user_id: binding.granted_by_user_id,
      created_at: binding.created_at,
    }
  }

  serviceAccountJson(account: MockServiceAccount, viewerId: string): ServiceAccount {
    return {
      id: account.id,
      org_id: account.org_id,
      name: account.name,
      description: account.description,
      created_by: this.userRef(account.created_by_id),
      my_role: this.effectiveRole(viewerId, 'service_account', account.id) ?? 'reader',
      created_at: account.created_at,
      updated_at: account.updated_at,
    }
  }

  tokenJson(token: MockToken): ApiToken {
    return {
      id: token.id,
      name: token.name,
      kind: token.kind,
      created_at: token.created_at,
      expires_at: token.expires_at,
      last_used_at: token.last_used_at,
    }
  }

  members(orgId: string): Member[] {
    const seen = new Map<string, Member>()
    for (const binding of this.bindings.filter((candidate) => candidate.org_id === orgId)) {
      const key = `${binding.principal_type}:${binding.principal_id}`
      const existing = seen.get(key)
      const orgRole = binding.resource_type === 'org' ? binding.role : null
      if (existing) {
        existing.org_role = existing.org_role ?? orgRole
        continue
      }
      seen.set(key, {
        principal_type: binding.principal_type,
        principal_id: binding.principal_id,
        name: this.principalName(binding.principal_type, binding.principal_id),
        org_role: orgRole,
      })
    }
    return [...seen.values()]
  }

  bumpSerial(zone: MockZone): void {
    zone.soa.serial += 1
    zone.updated_at = nowIso()
  }
}
