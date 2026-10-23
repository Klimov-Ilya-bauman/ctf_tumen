import { me, postKeys, b64enc } from '../api.js';
import { pubKey, allNonZero } from '../gf251.js';
import { loadSecret, saveSecret, randomSecret } from '../store-local.js';

export async function requireMe() {
  try {
    return await me();
  } catch (err) {
    if (err.status === 401) {
      location.href = 'index.html';
      return new Promise(() => {});
    }
    throw err;
  }
}

export function randomValidSecret() {
  let a = randomSecret();
  for (let i = 0; i < 64 && !allNonZero(pubKey(a)); i++) a = randomSecret();
  return a;
}

export function ensureSecret(userId) {
  let a = loadSecret(userId);
  if (a === null || !Number.isInteger(a) || a <= 0 || !allNonZero(pubKey(a))) {
    a = randomValidSecret();
    saveSecret(userId, a);
  }
  return a;
}

export function regenerateSecret(userId) {
  const a = randomValidSecret();
  saveSecret(userId, a);
  return a;
}

export const pubB64 = a => b64enc(pubKey(a));

export async function syncKeys(user, a) {
  const A = pubB64(a);
  if (user.pubkey_b64 === A) return;
  try { await postKeys(A); } catch { }
}
