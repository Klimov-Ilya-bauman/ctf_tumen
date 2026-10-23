

export class ApiError extends Error {
  readonly status: number

  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

type UnauthorizedListener = () => void
let onUnauthorized: UnauthorizedListener | null = null

export function setUnauthorizedListener(fn: UnauthorizedListener | null) {
  onUnauthorized = fn
}

export async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network')
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    const code = typeof data?.error === 'string' ? data.error : res.statusText
    if (res.status === 401 && onUnauthorized) onUnauthorized()
    throw new ApiError(res.status, code)
  }
  return data as T
}
