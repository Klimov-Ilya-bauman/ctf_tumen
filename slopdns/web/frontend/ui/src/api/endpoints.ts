import { apiRequest } from './client'
import type {
  ApiToken,
  CreatedApiToken,
  DnsRecord,
  GrantableRole,
  Invitation,
  InvitationStatus,
  LoginResponse,
  LoginSuccess,
  LoginTotpRequest,
  Me,
  Member,
  Org,
  Page,
  RecordInput,
  RecoveryCodesResponse,
  ResourceType,
  RoleBinding,
  RoleBindingCreate,
  ServiceAccount,
  ServiceAccountCreate,
  ServiceAccountUpdate,
  TotpDisableRequest,
  TotpSetupResponse,
  User,
  UserTokenCreate,
  Zone,
  ZoneCreate,
  ZoneTransfer,
  ZoneTransferStatus,
  ZoneUpdate,
} from './types'

export const MAX_PAGE_SIZE = 500

const pageQuery = { limit: MAX_PAGE_SIZE, offset: 0 }

function segment(id: string): string {
  return encodeURIComponent(id)
}

export const authApi = {
  register: (username: string, password: string) =>
    apiRequest<User>('/auth/register', { method: 'POST', body: { username, password } }),
  login: (username: string, password: string) =>
    apiRequest<LoginResponse>('/auth/login', { method: 'POST', body: { username, password } }),
  loginTotp: (request: LoginTotpRequest) =>
    apiRequest<LoginSuccess>('/auth/login/totp', { method: 'POST', body: request }),
  logout: () => apiRequest<void>('/auth/logout', { method: 'POST' }),
  me: () => apiRequest<Me>('/auth/me'),
  totpSetup: () => apiRequest<TotpSetupResponse>('/auth/totp/setup', { method: 'POST' }),
  totpEnable: (code: string) =>
    apiRequest<RecoveryCodesResponse>('/auth/totp/enable', { method: 'POST', body: { code } }),
  totpDisable: (request: TotpDisableRequest) =>
    apiRequest<void>('/auth/totp/disable', { method: 'POST', body: request }),
  regenerateRecoveryCodes: (password: string, code: string) =>
    apiRequest<RecoveryCodesResponse>('/auth/totp/recovery-codes', {
      method: 'POST',
      body: { password, code },
    }),
}

export const tokensApi = {
  list: () => apiRequest<Page<ApiToken>>('/users/me/tokens', { query: pageQuery }),
  create: (request: UserTokenCreate) =>
    apiRequest<CreatedApiToken>('/users/me/tokens', { method: 'POST', body: request }),
  revoke: (tokenId: string) =>
    apiRequest<void>(`/users/me/tokens/${segment(tokenId)}`, { method: 'DELETE' }),
}

export const orgsApi = {
  list: () => apiRequest<Page<Org>>('/orgs', { query: pageQuery }),
  create: (name: string) => apiRequest<Org>('/orgs', { method: 'POST', body: { name } }),
  get: (orgId: string) => apiRequest<Org>(`/orgs/${segment(orgId)}`),
  rename: (orgId: string, name: string) =>
    apiRequest<Org>(`/orgs/${segment(orgId)}`, { method: 'PATCH', body: { name } }),
  remove: (orgId: string) => apiRequest<void>(`/orgs/${segment(orgId)}`, { method: 'DELETE' }),
  members: (orgId: string) =>
    apiRequest<Page<Member>>(`/orgs/${segment(orgId)}/members`, { query: pageQuery }),
  removeMember: (orgId: string, userId: string) =>
    apiRequest<void>(`/orgs/${segment(orgId)}/members/${segment(userId)}`, { method: 'DELETE' }),
  transferOwnership: (orgId: string, userId: string) =>
    apiRequest<Org>(`/orgs/${segment(orgId)}/transfer-ownership`, {
      method: 'POST',
      body: { user_id: userId },
    }),
}

export const invitationsApi = {
  listForOrg: (orgId: string, status?: InvitationStatus) =>
    apiRequest<Page<Invitation>>(`/orgs/${segment(orgId)}/invitations`, {
      query: { ...pageQuery, status },
    }),
  create: (orgId: string, username: string, role: GrantableRole) =>
    apiRequest<Invitation>(`/orgs/${segment(orgId)}/invitations`, {
      method: 'POST',
      body: { username, role },
    }),
  listMine: (status?: InvitationStatus) =>
    apiRequest<Page<Invitation>>('/invitations', { query: { ...pageQuery, status } }),
  accept: (invitationId: string) =>
    apiRequest<Invitation>(`/invitations/${segment(invitationId)}/accept`, { method: 'POST' }),
  decline: (invitationId: string) =>
    apiRequest<Invitation>(`/invitations/${segment(invitationId)}/decline`, { method: 'POST' }),
  revoke: (invitationId: string) =>
    apiRequest<Invitation>(`/invitations/${segment(invitationId)}/revoke`, { method: 'POST' }),
}

export const roleBindingsApi = {
  listForResource: (resourceType: ResourceType, resourceId: string) =>
    apiRequest<Page<RoleBinding>>('/role-bindings', {
      query: { ...pageQuery, resource_type: resourceType, resource_id: resourceId },
    }),
  listForOrg: (orgId: string) =>
    apiRequest<Page<RoleBinding>>('/role-bindings', { query: { ...pageQuery, org_id: orgId } }),
  create: (request: RoleBindingCreate) =>
    apiRequest<RoleBinding>('/role-bindings', { method: 'POST', body: request }),
  update: (bindingId: string, role: GrantableRole) =>
    apiRequest<RoleBinding>(`/role-bindings/${segment(bindingId)}`, { method: 'PATCH', body: { role } }),
  remove: (bindingId: string) =>
    apiRequest<void>(`/role-bindings/${segment(bindingId)}`, { method: 'DELETE' }),
}

export const serviceAccountsApi = {
  list: (orgId: string) =>
    apiRequest<Page<ServiceAccount>>('/service-accounts', { query: { ...pageQuery, org_id: orgId } }),
  create: (request: ServiceAccountCreate) =>
    apiRequest<ServiceAccount>('/service-accounts', { method: 'POST', body: request }),
  get: (serviceAccountId: string) =>
    apiRequest<ServiceAccount>(`/service-accounts/${segment(serviceAccountId)}`),
  update: (serviceAccountId: string, request: ServiceAccountUpdate) =>
    apiRequest<ServiceAccount>(`/service-accounts/${segment(serviceAccountId)}`, {
      method: 'PATCH',
      body: request,
    }),
  remove: (serviceAccountId: string) =>
    apiRequest<void>(`/service-accounts/${segment(serviceAccountId)}`, { method: 'DELETE' }),
  listTokens: (serviceAccountId: string) =>
    apiRequest<Page<ApiToken>>(`/service-accounts/${segment(serviceAccountId)}/tokens`, {
      query: pageQuery,
    }),
  createToken: (serviceAccountId: string, name: string) =>
    apiRequest<CreatedApiToken>(`/service-accounts/${segment(serviceAccountId)}/tokens`, {
      method: 'POST',
      body: { name },
    }),
  revokeToken: (serviceAccountId: string, tokenId: string) =>
    apiRequest<void>(`/service-accounts/${segment(serviceAccountId)}/tokens/${segment(tokenId)}`, {
      method: 'DELETE',
    }),
}

export interface RecordListFilter {
  limit: number
  offset: number
  name?: string
  type?: string
}

export const zonesApi = {
  list: (orgId?: string) => apiRequest<Page<Zone>>('/zones', { query: { ...pageQuery, org_id: orgId } }),
  create: (request: ZoneCreate) => apiRequest<Zone>('/zones', { method: 'POST', body: request }),
  get: (zoneId: string) => apiRequest<Zone>(`/zones/${segment(zoneId)}`),
  update: (zoneId: string, request: ZoneUpdate) =>
    apiRequest<Zone>(`/zones/${segment(zoneId)}`, { method: 'PATCH', body: request }),
  remove: (zoneId: string) => apiRequest<void>(`/zones/${segment(zoneId)}`, { method: 'DELETE' }),
  offerTransfer: (zoneId: string, username: string) =>
    apiRequest<ZoneTransfer>(`/zones/${segment(zoneId)}/transfer`, { method: 'POST', body: { username } }),
}

export const recordsApi = {
  list: (zoneId: string, filter: RecordListFilter) =>
    apiRequest<Page<DnsRecord>>(`/zones/${segment(zoneId)}/records`, {
      query: { limit: filter.limit, offset: filter.offset, name: filter.name, type: filter.type },
    }),
  create: (zoneId: string, record: RecordInput) =>
    apiRequest<DnsRecord>(`/zones/${segment(zoneId)}/records`, { method: 'POST', body: record }),
  replace: (recordId: string, record: RecordInput) =>
    apiRequest<DnsRecord>(`/records/${segment(recordId)}`, { method: 'PUT', body: record }),
  remove: (recordId: string) => apiRequest<void>(`/records/${segment(recordId)}`, { method: 'DELETE' }),
}

export type TransferDirection = 'incoming' | 'outgoing'

export const zoneTransfersApi = {
  list: (direction: TransferDirection, status?: ZoneTransferStatus) =>
    apiRequest<Page<ZoneTransfer>>('/zone-transfers', { query: { ...pageQuery, direction, status } }),
  get: (transferId: string) => apiRequest<ZoneTransfer>(`/zone-transfers/${segment(transferId)}`),
  accept: (transferId: string, targetOrgId: string) =>
    apiRequest<ZoneTransfer>(`/zone-transfers/${segment(transferId)}/accept`, {
      method: 'POST',
      body: { target_org_id: targetOrgId },
    }),
  decline: (transferId: string) =>
    apiRequest<ZoneTransfer>(`/zone-transfers/${segment(transferId)}/decline`, { method: 'POST' }),
  cancel: (transferId: string) =>
    apiRequest<ZoneTransfer>(`/zone-transfers/${segment(transferId)}/cancel`, { method: 'POST' }),
}
