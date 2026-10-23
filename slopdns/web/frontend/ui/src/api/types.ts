import type { components } from './generated/schema'

type Schemas = components['schemas']

export type ApiErrorBody = Schemas['Error']
export type ErrorCode = Schemas['Error']['error']['code']
export type Role = Schemas['Role']
export type GrantableRole = Schemas['GrantableRole']
export type PrincipalType = Schemas['PrincipalType']
export type ResourceType = Schemas['ResourceType']
export type User = Schemas['User']
export type UserRef = Schemas['UserRef']
export type UserMe = Schemas['UserMe']
export type ServiceAccountMe = Schemas['ServiceAccountMe']
export type Me = Schemas['Me']
export type LoginResponse = Schemas['LoginResponse']
export type LoginSuccess = Schemas['LoginSuccess']
export type LoginTotpRequest = Schemas['LoginTotpRequest']
export type TotpSetupResponse = Schemas['TotpSetupResponse']
export type RecoveryCodesResponse = Schemas['RecoveryCodesResponse']
export type TotpDisableRequest = Schemas['TotpDisableRequest']
export type ApiToken = Schemas['ApiToken']
export type CreatedApiToken = Schemas['CreatedApiToken']
export interface UserTokenCreate {
  name: Schemas['UserTokenCreate']['name']
  expires_in_days?: number
  no_expiry?: boolean
  totp_code?: string
}
export type Org = Schemas['Org']
export type Member = Schemas['Member']
export type Invitation = Schemas['Invitation']
export type InvitationStatus = Schemas['InvitationStatus']
export type RoleBinding = Schemas['RoleBinding']
export type RoleBindingCreate = Schemas['RoleBindingCreate']
export type ServiceAccount = Schemas['ServiceAccount']
export type ServiceAccountCreate = Schemas['ServiceAccountCreate']
export type ServiceAccountUpdate = Schemas['ServiceAccountUpdate']
export type Zone = Schemas['Zone']
export type ZoneCreate = Schemas['ZoneCreate']
export type ZoneUpdate = Schemas['ZoneUpdate']
export type Soa = Schemas['Soa']
export type SoaInput = Schemas['SoaInput']
export type ZoneTransfer = Schemas['ZoneTransfer']
export type ZoneTransferStatus = Schemas['ZoneTransferStatus']
export type RecordInput = Schemas['RecordVariant']

export type DnsRecord = (Schemas['RecordVariant'] | Schemas['GenericRecordVariant']) & {
  id: string
  zone_id: string
  type_code: number
  ttl: number
  created_at: string
  updated_at: string
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}
