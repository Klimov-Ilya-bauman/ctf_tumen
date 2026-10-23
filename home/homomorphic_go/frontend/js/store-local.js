import { b64enc, b64dec } from './api.js';

const ls = () => globalThis.localStorage;

export function saveSecret(userId, secret) { ls().setItem(`hgo:secret:${userId}`, String(secret)); }
export function loadSecret(userId) {
  const v = ls().getItem(`hgo:secret:${userId}`);
  return v === null ? null : Number(v);
}
export function saveShared(gameId, S) { ls().setItem(`hgo:S:${gameId}`, b64enc(S)); }
export function loadShared(gameId) {
  const v = ls().getItem(`hgo:S:${gameId}`);
  return v === null ? null : b64dec(v);
}
export function saveBoard(gameId, M) { ls().setItem(`hgo:M:${gameId}`, b64enc(M)); }
export function loadBoard(gameId) {
  const v = ls().getItem(`hgo:M:${gameId}`);
  return v === null ? null : b64dec(v);
}
export function randomSecret() {
  const buf = new Uint32Array(1);
  const limit = 0x100000000 - (0x100000000 % 250);
  do { globalThis.crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return (buf[0] % 250) + 1;
}
