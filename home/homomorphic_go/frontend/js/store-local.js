import { b64enc, b64dec } from './api.js';
import { pubKey } from './gf251.js';

const ls = () => globalThis.localStorage;

export function saveSecret(userId, secret) {
  // Preserve old private keys when rotating an account's default key.
  const old = loadSecret(userId);
  if (Number.isInteger(old) && old > 0) {
    ls().setItem(`hgo:private:${userId}:${b64enc(pubKey(old))}`, String(old));
  }
  ls().setItem(`hgo:private:${userId}:${b64enc(pubKey(secret))}`, String(secret));
  ls().setItem(`hgo:secret:${userId}`, String(secret));
}
export function loadGameSecret(userId, publicKey) {
  const current = loadSecret(userId);
  if (Number.isInteger(current) && current > 0 && b64enc(pubKey(current)) === publicKey) return current;
  const raw = ls().getItem(`hgo:private:${userId}:${publicKey}`);
  const archived = raw === null ? null : Number(raw);
  if (Number.isInteger(archived) && archived > 0 && b64enc(pubKey(archived)) === publicKey) return archived;
  return null;
}
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
