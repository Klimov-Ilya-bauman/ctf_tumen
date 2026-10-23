const b64enc = (bytes) => btoa(String.fromCharCode(...bytes));
const b64dec = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const hasSubtle = typeof crypto !== 'undefined' && crypto.subtle &&
  typeof crypto.subtle.digest === 'function';

function randomNonce() {
  const n = new Uint8Array(12);
  (globalThis.crypto || crypto).getRandomValues(n);
  return n;
}

// ---------------------------------------------------------------- subtle path
async function subtleKey(S) {
  const digest = await crypto.subtle.digest('SHA-256', S);
  const key16 = new Uint8Array(digest).slice(0, 16);
  return crypto.subtle.importKey('raw', key16, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function subtleEncrypt(S, plaintext) {
  const key = await subtleKey(S);
  const nonce = randomNonce();
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce); out.set(ct, nonce.length);
  return b64enc(out);
}

async function subtleDecrypt(S, b64) {
  const key = await subtleKey(S);
  const raw = b64dec(b64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  return new TextDecoder().decode(pt);
}

// ------------------------------------------------------------- pure-JS SHA-256
const K256 = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(msg) {
  const H = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = msg.length * 8;
  const withOne = msg.length + 1;
  const total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  buf[total - 8] = (hi >>> 24) & 0xff; buf[total - 7] = (hi >>> 16) & 0xff;
  buf[total - 6] = (hi >>> 8) & 0xff; buf[total - 5] = hi & 0xff;
  buf[total - 4] = (lo >>> 24) & 0xff; buf[total - 3] = (lo >>> 16) & 0xff;
  buf[total - 2] = (lo >>> 8) & 0xff; buf[total - 1] = lo & 0xff;

  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (buf[off + i * 4] << 24) | (buf[off + i * 4 + 1] << 16) |
        (buf[off + i * 4 + 2] << 8) | buf[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (H[i] >>> 24) & 0xff; out[i * 4 + 1] = (H[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (H[i] >>> 8) & 0xff; out[i * 4 + 3] = H[i] & 0xff;
  }
  return out;
}

// ------------------------------------------------------------- pure-JS AES-128
const SBOX = (() => {
  const s = new Uint8Array(256), inv = new Uint8Array(256);
  let p = 1, q = 1;
  do {
    p = p ^ (p << 1) ^ (p & 0x80 ? 0x11b : 0);
    p &= 0xff;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >>> 7)) ^ ((q << 2) | (q >>> 6)) ^
      ((q << 3) | (q >>> 5)) ^ ((q << 4) | (q >>> 4)) ^ 0x63;
    s[p] = x & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  for (let i = 0; i < 256; i++) inv[s[i]] = i;
  return s;
})();

const RCON = Uint8Array.from([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

function expandKey(key) {
  const rk = new Uint8Array(176);
  rk.set(key);
  for (let i = 16, r = 0; i < 176; i += 4) {
    let a = rk[i - 4], b = rk[i - 3], c = rk[i - 2], d = rk[i - 1];
    if (i % 16 === 0) {
      [a, b, c, d] = [SBOX[b] ^ RCON[r++], SBOX[c], SBOX[d], SBOX[a]];
    }
    rk[i] = rk[i - 16] ^ a; rk[i + 1] = rk[i - 15] ^ b;
    rk[i + 2] = rk[i - 14] ^ c; rk[i + 3] = rk[i - 13] ^ d;
  }
  return rk;
}

const xtime = (x) => ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff;
const mul = (a, b) => {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) r ^= a;
    const hi = a & 0x80; a = (a << 1) & 0xff; if (hi) a ^= 0x1b; b >>= 1;
  }
  return r & 0xff;
};

function encryptBlock(rk, inp) {
  const s = Uint8Array.from(inp);
  for (let i = 0; i < 16; i++) s[i] ^= rk[i];
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    // ShiftRows
    let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
    if (round < 10) {
      for (let c = 0; c < 4; c++) {
        const o = c * 4;
        const a0 = s[o], a1 = s[o + 1], a2 = s[o + 2], a3 = s[o + 3];
        s[o] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
        s[o + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
        s[o + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
        s[o + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
      }
    }
    const ro = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= rk[ro + i];
  }
  return s;
}

// -------------------------------------------------------------- pure-JS GCM
function ghashMul(x, y) {
  const z = new Uint8Array(16);
  const v = Uint8Array.from(y);
  for (let i = 0; i < 128; i++) {
    if ((x[i >>> 3] >>> (7 - (i & 7))) & 1) for (let k = 0; k < 16; k++) z[k] ^= v[k];
    const lsb = v[15] & 1;
    for (let k = 15; k > 0; k--) v[k] = ((v[k] >>> 1) | ((v[k - 1] & 1) << 7)) & 0xff;
    v[0] >>>= 1;
    if (lsb) v[0] ^= 0xe1;
  }
  return z;
}

function ghash(h, ct) {
  let x = new Uint8Array(16);
  const blocks = Math.ceil(ct.length / 16);
  for (let b = 0; b < blocks; b++) {
    for (let k = 0; k < 16; k++) x[k] ^= (ct[b * 16 + k] || 0);
    x = ghashMul(x, h);
  }
  const lenBlock = new Uint8Array(16);
  const bits = ct.length * 8;
  lenBlock[8] = (bits / 0x100000000000000) & 0xff;
  lenBlock[9] = (bits / 0x1000000000000) & 0xff;
  lenBlock[10] = (bits / 0x10000000000) & 0xff;
  lenBlock[11] = (bits / 0x100000000) & 0xff;
  lenBlock[12] = (bits >>> 24) & 0xff; lenBlock[13] = (bits >>> 16) & 0xff;
  lenBlock[14] = (bits >>> 8) & 0xff; lenBlock[15] = bits & 0xff;
  for (let k = 0; k < 16; k++) x[k] ^= lenBlock[k];
  return ghashMul(x, h);
}

function inc32(ctr) {
  for (let i = 15; i >= 12; i--) { ctr[i] = (ctr[i] + 1) & 0xff; if (ctr[i]) break; }
}

function ctrXor(rk, j0, data) {
  const out = new Uint8Array(data.length);
  const ctr = Uint8Array.from(j0);
  for (let off = 0; off < data.length; off += 16) {
    inc32(ctr);
    const ks = encryptBlock(rk, ctr);
    for (let k = 0; k < 16 && off + k < data.length; k++) out[off + k] = data[off + k] ^ ks[k];
  }
  return out;
}

function gcmSeal(key16, nonce, plaintext) {
  const rk = expandKey(key16);
  const h = encryptBlock(rk, new Uint8Array(16));
  const j0 = new Uint8Array(16);
  j0.set(nonce); j0[15] = 1;
  const ct = ctrXor(rk, j0, plaintext);
  const s = ghash(h, ct);
  const ej0 = encryptBlock(rk, j0);
  const tag = new Uint8Array(16);
  for (let k = 0; k < 16; k++) tag[k] = s[k] ^ ej0[k];
  const out = new Uint8Array(ct.length + 16);
  out.set(ct); out.set(tag, ct.length);
  return out;
}

function gcmOpen(key16, nonce, ctWithTag) {
  const ct = ctWithTag.slice(0, ctWithTag.length - 16);
  const tag = ctWithTag.slice(ctWithTag.length - 16);
  const rk = expandKey(key16);
  const h = encryptBlock(rk, new Uint8Array(16));
  const j0 = new Uint8Array(16);
  j0.set(nonce); j0[15] = 1;
  const s = ghash(h, ct);
  const ej0 = encryptBlock(rk, j0);
  let diff = 0;
  for (let k = 0; k < 16; k++) diff |= (s[k] ^ ej0[k]) ^ tag[k];
  if (diff !== 0) throw new Error('auth tag mismatch');
  return ctrXor(rk, j0, ct);
}

function jsEncrypt(S, plaintext) {
  const key16 = sha256(S).slice(0, 16);
  const nonce = randomNonce();
  const sealed = gcmSeal(key16, nonce, new TextEncoder().encode(plaintext));
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce); out.set(sealed, nonce.length);
  return b64enc(out);
}

function jsDecrypt(S, b64) {
  const key16 = sha256(S).slice(0, 16);
  const raw = b64dec(b64);
  const pt = gcmOpen(key16, raw.slice(0, 12), raw.slice(12));
  return new TextDecoder().decode(pt);
}

// ------------------------------------------------------------------- exports
export async function encryptMsg(S, plaintext) {
  return hasSubtle ? subtleEncrypt(S, plaintext) : jsEncrypt(S, plaintext);
}

export async function decryptMsg(S, b64) {
  return hasSubtle ? subtleDecrypt(S, b64) : jsDecrypt(S, b64);
}
