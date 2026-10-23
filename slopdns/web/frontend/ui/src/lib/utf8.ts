const encoder = new TextEncoder()

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length
}

export function codePointLength(value: string): number {
  return Array.from(value).length
}
