import type { GrantableRole, Role } from '../api/types'

const ROLE_RANK: Record<Role, number> = { reader: 1, editor: 2, admin: 3, owner: 4 }

export const GRANTABLE_ROLES: GrantableRole[] = ['reader', 'editor', 'admin']

export function roleAtLeast(role: Role | null | undefined, minimum: Role): boolean {
  if (role === null || role === undefined) {
    return false
  }
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

export function maxRole(first: Role | null | undefined, second: Role | null | undefined): Role | null {
  if (first === null || first === undefined) {
    return second ?? null
  }
  if (second === null || second === undefined) {
    return first
  }
  return ROLE_RANK[first] >= ROLE_RANK[second] ? first : second
}

export const permissions = {
  readOrg: (role: Role | null | undefined) => roleAtLeast(role, 'reader'),
  renameOrg: (role: Role | null | undefined) => roleAtLeast(role, 'admin'),
  createInOrg: (role: Role | null | undefined) => roleAtLeast(role, 'editor'),
  manageOrgAccess: (role: Role | null | undefined) => roleAtLeast(role, 'admin'),
  ownOrg: (role: Role | null | undefined) => role === 'owner',
  editZone: (role: Role | null | undefined) => roleAtLeast(role, 'editor'),
  deleteZone: (role: Role | null | undefined) => roleAtLeast(role, 'admin'),
  manageZoneAccess: (role: Role | null | undefined) => roleAtLeast(role, 'admin'),
  editServiceAccount: (role: Role | null | undefined) => roleAtLeast(role, 'editor'),
  manageServiceAccount: (role: Role | null | undefined) => roleAtLeast(role, 'admin'),
  acceptTransferInto: (role: Role | null | undefined) => roleAtLeast(role, 'admin'),
}

export function assignableRoles(actorRole: Role | null | undefined, ownBindingRole: Role | null): GrantableRole[] {
  if (!roleAtLeast(actorRole, 'admin')) {
    return []
  }
  if (ownBindingRole === null) {
    return GRANTABLE_ROLES
  }
  return GRANTABLE_ROLES.filter((role) => ROLE_RANK[role] <= ROLE_RANK[ownBindingRole])
}
