const BASE = '/api';

async function call(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  let json = null;
  try { json = await res.json(); } catch {  }
  if (!res.ok) {
    const err = new Error((json && json.error) || 'HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return json;
}

export function b64enc(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64dec(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const register = (username, password) => call('POST', '/register', { username, password });
export const login = (username, password) => call('POST', '/login', { username, password });
export const me = () => call('GET', '/me');
export const postKeys = pubkeyB64 => call('POST', '/keys', { pubkey_b64: pubkeyB64 });
export const listGames = () => call('GET', '/games');
export const createGame = pubkeyB64 => call('POST', '/games', { pubkey_b64: pubkeyB64 });
export const joinGame = (id, pubkeyB64) => call('POST', `/games/${id}/join`, { pubkey_b64: pubkeyB64 });
export const getGame = id => call('GET', `/games/${id}`);
export const postMove = (id, boardCB64) => call('POST', `/games/${id}/move`, { board_c_b64: boardCB64 });
export const getMoves = id => call('GET', `/games/${id}/moves`);
export const getMessages = id => call('GET', `/games/${id}/messages`);
export const postMessage = (id, ciphertext) => call('POST', `/games/${id}/messages`, { ciphertext });
