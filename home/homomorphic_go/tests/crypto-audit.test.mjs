import test from 'node:test';
import assert from 'node:assert/strict';
import { pubKey, shared, allNonZero } from '../frontend/js/gf251.js';
import { encryptMsg, decryptMsg } from '../frontend/js/crypto.js';
import { computeNextC, recoverMFromC } from '../frontend/js/game-flow.js';

test('existing encrypted board and chat round trip on synthetic data', async () => {
  const valid = Array.from({length: 250}, (_, i) => i + 1)
    .filter(a => allNonZero(pubKey(a)));
  const a = valid[0];
  const b = valid.find(b => allNonZero(shared(pubKey(b), a)));
  assert.notEqual(b, undefined);
  const S = shared(pubKey(b), a);
  assert.deepEqual(S, shared(pubKey(a), b));
  const M = new Uint8Array(361);
  const { C2, M2 } = computeNextC(new Uint8Array(361), M, 3, 3, 1, S);
  assert.equal(M2[3 * 19 + 3], 1);
  assert.deepEqual(recoverMFromC(C2, S), M2);
  const ciphertext = await encryptMsg(S, 'local synthetic message');
  assert.equal(await decryptMsg(S, ciphertext), 'local synthetic message');
});

// This passing audit test demonstrates an UNFIXED confidentiality risk.
// It uses no network, real accounts, service records, or real flags.
test('audit: current public keys allow recovery within the 250-value client domain', async () => {
  const a = 17, b = 23;
  const A = pubKey(a), B = pubKey(b);
  const ciphertext = await encryptMsg(shared(B, a), 'synthetic confidential text');
  const recovered = Array.from({length: 250}, (_, i) => i + 1)
    .find(candidate => Buffer.from(pubKey(candidate)).equals(Buffer.from(A)));
  assert.notEqual(recovered, undefined);
  assert.equal(await decryptMsg(shared(B, recovered), ciphertext), 'synthetic confidential text');
});
