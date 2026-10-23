import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSecret, loadGameSecret } from '../frontend/js/store-local.js';
import { pubKey } from '../frontend/js/gf251.js';
import { b64enc, postMove, getMessages, listGames } from '../frontend/js/api.js';

test('rotating the default secret preserves private keys for existing games', () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
  };
  saveSecret(7, 17);
  saveSecret(7, 23);
  assert.equal(loadGameSecret(7, b64enc(pubKey(17))), 17);
  assert.equal(loadGameSecret(7, b64enc(pubKey(23))), 23);
  assert.equal(loadGameSecret(7, b64enc(pubKey(31))), null);
  assert.equal(loadGameSecret(8, b64enc(pubKey(17))), null);
});

test('client carries move version and pagination cursors', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({url, options});
    return {ok: true, json: async () => []};
  };
  try {
    await postMove(1, 'synthetic', 42);
    await getMessages(1, 123, 20);
    await listGames(99, 25);
    assert.equal(JSON.parse(requests[0].options.body).version, 42);
    assert.equal(requests[0].options.credentials, 'include');
    assert.equal(requests[1].url, '/api/games/1/messages?after=123&limit=20');
    assert.equal(requests[2].url, '/api/games?before=99&limit=25');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
