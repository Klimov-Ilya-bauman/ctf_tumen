import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application, AccessResolver, SqlVisitor, query, t, value, serveStatic } from '../packages/thingamajig/dist/lib.js';
import { hashPassword, verifyPassword } from '../apps/server/dist/auth/passwords.js';
import { security } from '../apps/server/dist/auth/security.js';

// Regression for the password-hash-as-password backdoor.
test('password verification derives scrypt; digest itself is not a password', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong password', stored), false);
  assert.equal(await verifyPassword(stored.split('$')[2], stored), false);
  assert.equal(await verifyPassword('anything', 'scrypt$bad$bad'), false);
});

test('ORM uses parameters for strings, JSON candidates and boolean policies', () => {
  class Principal { id = 1; }
  class Row { id = 0; name = ''; }
  const app = new Application(Principal);
  const row = app.define('row', Row, d => d.permissions({ read: () => value(true), create: () => value(true), update: () => value(true) }));
  app.compile();
  const payload = "x'; SELECT pg_sleep(10); --\\\"";
  for (const expression of [query().select(row).where(r => r.name.value().equals(value(payload))), query().insert(row, { name: payload }), query().update(row, { name: payload })]) {
    const visitor = new SqlVisitor();
    const sql = new AccessResolver(app, new Principal(), false).secure(expression).accept(visitor);
    assert.ok(!sql.includes(payload));
    assert.ok(sql.includes('$1'));
    assert.ok(visitor.parameters.some(v => v === payload || (typeof v === 'string' && v.startsWith('{') && JSON.parse(v).name === payload)));
  }
});

test('nested application queries are read-filtered without recursing policy queries', () => {
  class Principal { id = 1; }
  class Public { id = 0; }
  class Secret { id = 0; }
  const app = new Application(Principal);
  const secret = app.define('secret', Secret, d => d.permissions({ read: () => value(false) }));
  const visible = app.define('visible', Public, d => d.permissions({ read: () => value(true) }));
  app.compile();
  for (const predicate of [r => r.subselect(secret).exists(), r => r.id.value().equals(r.subselect(secret).pick('id'))]) {
    const visitor = new SqlVisitor();
    const sql = new AccessResolver(app, new Principal(), false).secure(query().select(visible).where(predicate)).accept(visitor);
    assert.ok(sql.includes('"secret"'));
    assert.ok(visitor.parameters.includes(false), 'nested read-deny predicate is bound');
  }
});

test('unsafe integers and inherited input properties are rejected', () => {
  assert.throws(() => t.int().parse('9'.repeat(500)));
  assert.throws(() => t.int().parse(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => t.object({ name: t.string() }).parse(Object.create({ name: 'inherited' })));
  assert.deepEqual(Object.keys(t.object({ name: t.string() }).parse(JSON.parse('{"name":"ok","__proto__":{"admin":true}}'))), ['name']);
});

test('static serving rejects symlinks outside its root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neuroslop-static-'));
  try {
    await mkdir(join(dir, 'public'));
    await writeFile(join(dir, 'secret.txt'), 'secret');
    await symlink(join(dir, 'secret.txt'), join(dir, 'public', 'leak.txt'));
    const middleware = serveStatic(join(dir, 'public'));
    const ctx = { request: { method: 'GET', path: '/leak.txt' }, response: { headers: {} } };
    let next = false;
    await middleware(ctx, async () => { next = true; });
    assert.equal(next, true);
    assert.equal(ctx.response.body, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('auth limits use matched actions, including slash aliases', async () => {
  for (let i = 0; i < 31; i++) {
    const ctx = { request: { method: 'POST', path: i % 2 ? '/api//auth/login/' : '//api/auth/login', headers: {}, remoteAddress: 'unit-limiter' }, response: { headers: {} }, route: { controller: 'AuthController', action: 'login' } };
    if (i < 30) await security(ctx, async () => {});
    else await assert.rejects(security(ctx, async () => assert.fail('auth limit bypassed')), e => e.status === 429);
  }
});

test('cross-origin mutations and MIME confusion are rejected before handlers', async () => {
  for (const headers of [
    { host: 'example.test', origin: 'https://evil.test' },
    { host: 'example.test', 'sec-fetch-site': 'cross-site' },
    { host: 'example.test', 'content-type': 'text/plain; application/json', 'content-length': '2' },
  ]) {
    const ctx = { request: { method: 'POST', path: '/api/test', headers }, response: { headers: {} } };
    await assert.rejects(security(ctx, async () => assert.fail('handler reached')), e => [403, 415].includes(e.status));
  }
});
