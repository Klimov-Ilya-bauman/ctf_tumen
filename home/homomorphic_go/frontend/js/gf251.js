export const P = 251, N = 19;
export const G = Uint8Array.of(7,3,11,2,5,13,17,19,23,29,31,37,41,43,47,53,59,61,67);

export function conv(u, v) {
  const out = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    let acc = 0;
    for (let i = 0; i < N; i++) acc += u[i] * v[((k - i) % N + N) % N];
    out[k] = acc % P;
  }
  return out;
}
function delta() { const d = new Uint8Array(N); d[0] = 1; return d; }
export function powv(v, e) {
  let r = delta(), b = Uint8Array.from(v);
  while (e > 0) { if (e & 1) r = conv(r, b); b = conv(b, b); e >>= 1; }
  return r;
}
export function pubKey(secret) { return powv(G, secret); }
export function shared(peerPub, secret) { return powv(peerPub, secret); }
export function invScalar(x) {
  if (x === 0) throw new Error('no inverse for 0');
  let res = 1, base = x, e = P - 2;
  while (e > 0) { if (e & 1) res = (res * base) % P; base = (base * base) % P; e >>= 1; }
  return res;
}
export function allNonZero(v) { return v.every(x => x !== 0); }
export function encryptBoard(M, S) {
  const C = new Uint8Array(361);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) C[i*N+j] = (S[i] * M[i*N+j]) % P;
  return C;
}
export function decryptBoard(C, S) {
  const M = new Uint8Array(361);
  for (let i = 0; i < N; i++) { const inv = invScalar(S[i]); for (let j = 0; j < N; j++) M[i*N+j] = (C[i*N+j] * inv) % P; }
  return M;
}
