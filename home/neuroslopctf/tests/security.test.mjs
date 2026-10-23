import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

// Uses a fresh schema and synthetic data, and serves HTTP only on loopback.
test('NeuroslopCTF authorization and normal workflows', { timeout: 120000 }, async (t) => {
  assert.ok(process.env.NSC_TEST_DATABASE_URL, 'Set NSC_TEST_DATABASE_URL to a local test PostgreSQL');
  const url = new URL(process.env.NSC_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const schema = `nsc_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const dataDir = await mkdtemp(join(tmpdir(), 'nsc-security-'));
  let driver, server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (driver) await driver.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    await rm(dataDir, { recursive: true, force: true });
  });
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.DATA_DIR = dataDir;
  const appModule = await import('../apps/server/dist/app.js');
  const { app } = appModule;
  driver = appModule.driver;
  await driver.query(await readFile(new URL('../apps/server/migrations/001_schema.sql', import.meta.url), 'utf8'));
  await import('../apps/server/dist/models/index.js');
  const { authenticate } = await import('../apps/server/dist/auth/middleware.js');
  app.compile();
  app.web.use(authenticate).transactions((run) => appModule.orm.transaction(run));
  const controllers = new URL('../apps/server/dist/controllers/', import.meta.url);
  for (const filename of await readdir(controllers)) {
    if (!filename.endsWith('.js')) continue;
    const exports = await import(new URL(filename, controllers));
    for (const [name, Controller] of Object.entries(exports)) {
      if (name.endsWith('Controller')) app.web.controller('/api', new Controller());
    }
  }
  server = await app.web.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(actor, path, method = 'GET', body, expected = 200) {
    const headers = actor?.token ? { authorization: `Bearer ${actor.token}` }
      : actor?.cookie ? { cookie: actor.cookie } : {};
    if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
    const response = await fetch(base + path, {
      method, headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const text = await response.text();
    assert.ok([expected].flat().includes(response.status), `${method} ${path}: ${response.status} ${text}`);
    let result;
    try { result = JSON.parse(text); } catch { result = text; }
    return { data: result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const call = async (...args) => (await request(...args)).data;
  async function register(username) {
    const result = await request(null, '/auth/register', 'POST', { username, password: 'test-password-123' }, 201);
    return { ...result.data, cookie: result.cookie };
  }
  async function competition(actor, title, visibility = 'public') {
    const c = await call(actor, '/competitions', 'POST', {
      title, description: `Description of ${title}`, visibility, join_policy: 'open',
      starts_at: new Date(Date.now() - 60000).toISOString(),
      ends_at: new Date(Date.now() + 86400000).toISOString(),
    }, 201);
    await call(actor, `/competitions/${c.id}/state`, 'POST', { action: 'publish' });
    await call(actor, `/competitions/${c.id}/state`, 'POST', { action: 'start' });
    return c;
  }
  async function invite(owner, c, who, role) {
    const invitation = await call(owner, `/competitions/${c.id}/invites`, 'POST', { role, max_uses: 1 }, 201);
    await call(who, `/competitions/${c.id}/join`, 'POST', { invite_code: invitation.code });
    return invitation;
  }
  const owner = await register('owner');
  const outsider = await register('outsider');
  const player = await register('player');
  const reviewer = await register('reviewer');
  const manager = await register('manager');
  const publicComp = await competition(owner, 'Public fixture');
  const privateComp = await competition(owner, 'Private fixture', 'private');
  const otherComp = await competition(outsider, 'Other fixture');
  await call(player, `/competitions/${publicComp.id}/join`, 'POST', {});
  await invite(owner, privateComp, player, 'participant');
  await invite(owner, publicComp, reviewer, 'reviewer');
  await invite(owner, publicComp, manager, 'admin');
  const task = await call(owner, `/competitions/${publicComp.id}/tasks`, 'POST', {
    title: "Owner's task", description: "A synthetic task with owner's text and C:\\files",
    category: 'test', difficulty: 'easy', answer_flag: 'synthetic-answer', reward_token: 'synthetic-reward',
  }, 201);
  const path = `/competitions/${publicComp.id}/tasks/${task.slug}`;
  await call(owner, path + '/state', 'POST', { action: 'submit' });
  await call(reviewer, path + '/state', 'POST', { action: 'approve' });
  const hint = await call(owner, path + '/hints', 'POST', { body: 'synthetic-hint', cost: 10 }, 201);
  async function upload(visibility, text) {
    const form = new FormData();
    form.append('file', new Blob([text], { type: 'text/plain' }), 'fixture.txt');
    form.append('visibility', visibility);
    return call(owner, path + '/attachments', 'POST', form, 201);
  }
  const staffFile = await upload('staff', 'synthetic-staff-file');
  const publicFile = await upload('participants', 'synthetic-player-file');

  await t.test('roles stay inside their competition; pins convey no privileges', async () => {
    await call(outsider, '/pins', 'POST', { competition_id: privateComp.id }, 201);
    await call(outsider, `/competitions/${privateComp.id}`, 'GET', undefined, 403);
    await call(outsider, `/competitions/${publicComp.id}`, 'PATCH', { title: 'Unwanted change' }, 403);
    await call(owner, `/competitions/${otherComp.id}`, 'PATCH', { title: 'Unwanted change' }, 403);
    assert.equal((await call(owner, `/competitions/${privateComp.id}`)).viewer.role, 'owner');
  });
  await t.test('revisions and staff files require task secret access', async () => {
    for (const actor of [outsider, player]) {
      await call(actor, path + '/revisions', 'GET', undefined, 403);
      await call(actor, path + '/revisions/1', 'GET', undefined, 403);
      await call(actor, path + '/manage', 'GET', undefined, 403);
      await call(actor, `/competitions/${publicComp.id}/attachments/${staffFile.id}/download`, 'GET', undefined, 403);
    }
    assert.equal((await call(owner, path + '/revisions')).items[0].reward_token, 'synthetic-reward');
    assert.equal((await call(reviewer, path + '/revisions')).items[0].answer_flag, 'synthetic-answer');
    assert.equal(await call(owner, `/competitions/${publicComp.id}/attachments/${staffFile.id}/download`), 'synthetic-staff-file');
    assert.equal(await call(player, `/competitions/${publicComp.id}/attachments/${publicFile.id}/download`), 'synthetic-player-file');
    const view = await call(player, path);
    assert.equal(view.answer_flag, undefined);
    assert.equal(view.reward_token, undefined);
    assert.deepEqual(view.attachments.map((a) => a.id), [publicFile.id]);
  });
  await t.test('members cannot promote themselves; admin cannot grant admin', async () => {
    await call(player, `/competitions/${publicComp.id}/members/${player.id}`, 'PATCH', { role: 'admin' }, 403);
    await call(manager, `/competitions/${publicComp.id}/members/${player.id}`, 'PATCH', { role: 'admin' }, 403);
    assert.equal((await call(player, `/competitions/${publicComp.id}`)).viewer.role, 'participant');
    await call(owner, `/competitions/${publicComp.id}/members/${manager.id}`, 'PATCH', { role: 'author' });
    await call(owner, `/competitions/${publicComp.id}/members/${manager.id}`, 'PATCH', { role: 'admin' });
  });
  await t.test('private tickets and internal notes remain isolated', async () => {
    const ticket = await call(player, `/competitions/${publicComp.id}/tickets`, 'POST', {
      subject: 'Fixture ticket', body: 'synthetic-ticket', task_slug: task.slug,
    }, 201);
    const ticketPath = `/competitions/${publicComp.id}/tickets/${ticket.id}`;
    await call(owner, ticketPath + '/messages', 'POST', { body: 'synthetic-internal-note', internal: true }, 201);
    await call(outsider, ticketPath, 'GET', undefined, 403);
    assert.equal((await call(player, ticketPath)).messages.length, 1);
    assert.equal((await call(owner, ticketPath)).messages.length, 2);
    await call(player, ticketPath + '/messages', 'POST', { body: 'Followup' }, 201);
    await call(player, ticketPath + '/messages', 'POST', { body: 'Hidden', internal: true }, 403);
  });
  await t.test('hint bodies stay locked, repeated unlock succeeds', async () => {
    const hintsPath = `/competitions/${publicComp.id}/hints/${hint.id}`;
    assert.equal((await call(player, path + '/hints')).items[0].body, undefined);
    await call(player, hintsPath, 'PATCH', { body: 'Unwanted' }, 403);
    for (let n = 0; n < 2; n++) {
      assert.equal((await call(player, hintsPath + '/unlock', 'POST', {})).body, 'synthetic-hint');
    }
  });
  await t.test('normal solve returns reward only to the solver', async () => {
    assert.equal((await call(player, path + '/submit', 'POST', { flag: 'wrong' })).correct, false);
    assert.equal((await call(player, path + '/submit', 'POST', { flag: 'synthetic-answer' })).reward_token, 'synthetic-reward');
    assert.equal((await call(player, '/solves/mine')).items[0].reward_token, 'synthetic-reward');
    assert.deepEqual((await call(outsider, `/competitions/${publicComp.id}/submissions`)).items, []);
  });
  await t.test('competition bound tokens cannot read outside their binding', async () => {
    const token = await call(player, '/tokens', 'POST', {
      name: 'bound', scopes: ['competitions:read', 'competitions:write', 'tasks:read'], competition_id: privateComp.id,
    }, 201);
    await call(token, path + '/revisions', 'GET', undefined, 403);
    await call(token, `/competitions/${otherComp.id}/join`, 'POST', {}, 403);
    assert.deepEqual((await call(token, '/solves/mine')).items, []);
    assert.ok((await call(token, '/competitions')).items.every((c) => c.id === privateComp.id));
  });
  await t.test('password verifier accepts passwords and rejects stored digests', async () => {
    const { hashPassword, verifyPassword } = await import('../apps/server/dist/auth/passwords.js');
    const stored = await hashPassword('ordinary-password');
    assert.equal(await verifyPassword('ordinary-password', stored), true);
    assert.equal(await verifyPassword(stored.split('$')[2], stored), false);
    assert.equal(await verifyPassword('wrong-password', stored), false);
    assert.equal(await verifyPassword('anything', 'scrypt$bad$bad'), false);
    await call(null, '/auth/login', 'POST', { username: 'player', password: 'test-password-123' });
  });
  await t.test('SQL literals preserve apostrophes and backslashes', async () => {
    const { SqlVisitor, value } = await import('../packages/thingamajig/dist/lib.js');
    const { lit } = await import('../apps/server/dist/services/sql.js');
    for (const sample of ["O'Brien", 'C:\\files\\notes', "a\\'b", 'line\nnext', 'Привет']) {
      for (const encoded of [value(sample).accept(new SqlVisitor()), lit(sample)]) {
        const [row] = await driver.query(`SELECT ${encoded} AS text`);
        assert.equal(row.text, sample);
      }
    }
  });
  await t.test('database constraint errors do not disclose row contents', async () => {
    const result = await call(null, '/auth/register', 'POST', { username: 'owner', password: 'test-password-123' }, 409);
    assert.equal(result.code, 'conflict');
    assert.ok(!JSON.stringify(result).includes('scrypt'));
    assert.ok(!JSON.stringify(result).includes('owner'));
  });
  await t.test('browser mutations require same origin; API requests without Origin still work', async () => {
    for (const origin of [base.replace('/api', ''), 'https://unrelated.invalid']) {
      const response = await fetch(base + '/auth/login', {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'player', password: 'test-password-123' }),
      });
      assert.equal(response.status, origin.startsWith('https:') ? 403 : 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      await response.text();
    }
  });
  await t.test('one-use invitations are consumed atomically', async () => {
    const first = await register('invite-first');
    const second = await register('invite-second');
    const invitation = await call(owner, `/competitions/${privateComp.id}/invites`, 'POST', {
      role: 'observer', max_uses: 1,
    }, 201);
    const responses = await Promise.all([first, second].map((actor) => fetch(
      base + `/competitions/${privateComp.id}/join`, {
        method: 'POST', headers: { cookie: actor.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ invite_code: invitation.code }),
      },
    )));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 403]);
    await Promise.all(responses.map((r) => r.text()));
  });
});
