export const DEFAULT_RETURN_PATH = '/zones'

export function safeReturnPath(candidate: unknown): string {
  if (typeof candidate !== 'string') {
    return DEFAULT_RETURN_PATH
  }
  if (!/^\/(?!\/)/.test(candidate) || candidate.includes('\\')) {
    return DEFAULT_RETURN_PATH
  }
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate.charCodeAt(index) < 0x20) {
      return DEFAULT_RETURN_PATH
    }
  }
  return candidate
}
