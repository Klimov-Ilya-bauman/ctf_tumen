import { ApiError, request } from './client'
import type { Credentials, User } from './types'

function asUser(u: User | null): User {
  if (typeof u?.id !== 'number' || typeof u.username !== 'string') throw new ApiError(0, 'network')
  return u
}

export const authApi = {
  me: () => request<User>('GET', '/api/me').then(asUser),
  register: (c: Credentials) => request<User>('POST', '/api/auth/register', c).then(asUser),
  login: (c: Credentials) => request<User>('POST', '/api/auth/login', c).then(asUser),
  logout: () => request<null>('POST', '/api/auth/logout'),
}

export function validateCredentials(c: Credentials): string | null {
  if (!/^[A-Za-z0-9_]{3,32}$/.test(c.username)) return 'Логин: 3–32 символа, латиница, цифры и «_».'

  const len = new TextEncoder().encode(c.password).length
  if (len < 8 || len > 128) return 'Пароль: от 8 до 128 символов.'
  return null
}
