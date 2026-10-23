import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PgDriver } from '../packages/thingamajig/dist/lib.js';
const require = createRequire(new URL('../packages/thingamajig/package.json', import.meta.url));
const { Pool } = require('pg');

// Only runs against a new disposable database, never migrates an existing DB.
test('security regression flows against real HTTP and PostgreSQL', { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 }, async t => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const dbName = `neuroslop_security_${process.pid}_${Date.now()}`;
  const appRole = dbName + '_app';
  const appPassword = randomBytes(24).toString('hex');
  const temp = await mkdtemp(join(tmpdir(), 'neuroslop-integration-'));
  let child, db;
  try {
    await admin.query(`CREATE ROLE "${appRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${appPassword}'`);
    await admin.query(`CREATE DATABASE "${dbName}" OWNER "${appRole}"`);
    const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = '/' + dbName;
    db = new Pool({ connectionString: url.href });
    url.username = appRole; url.password = appPassword;
    const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(r => listener.close(r));
    child = spawn(process.execPath, ['apps/server/dist/main.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATABASE_URL: url.href, PORT: String(port), DATA_DIR: temp, DESCRIBE: '0', COOKIE_SECURE: 'false', PUBLIC_ORIGIN: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    child.stderr.on('data', b => { logs += b; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Startup timed out: ' + logs)), 15000);
      child.stdout.on('data', b => { logs += b; if (logs.includes('Listening on')) { clearTimeout(timeout); resolve(); } });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${logs}`)); });
    });
    const base = `http://127.0.0.1:${port}/api`;
    function client(token) {
      let cookie = '';
      return async (path, method = 'GET', body, expected = 200, extra = {}) => {
        const form = body instanceof FormData;
        const headers = { ...(cookie ? { cookie } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body && !form ? { 'content-type': 'application/json' } : {}), ...extra };
        const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
        if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
        const text = await res.text(); let data;
        try { data = JSON.parse(text); } catch { data = text; }
        if (Array.isArray(expected)) assert.ok(expected.includes(res.status), `${method} ${path}: ${res.status} ${text}`);
        else assert.equal(res.status, expected, `${method} ${path}: ${text}`);
        return { data, res, cookie };
      };
    }
    const guest = client(), owner = client(), outsider = client(), player = client(), teammate = client(), late = client();
    const accounts = {};
    for (const [name, api] of Object.entries({ owner, outsider, player, teammate, late })) accounts[name] = (await api('/auth/register', 'POST', { username: name, password: 'valid_password_123' }, 201)).data;
    await t.test('guest authentication and session digest storage', async () => {
      await guest('/auth/me', 'GET', undefined, 401);
      const me = await owner('/auth/me'); assert.equal(me.data.username, 'owner');
      const cookie = decodeURIComponent(me.cookie.split('=')[1]);
      const { rows } = await db.query('SELECT "token" FROM "session" WHERE "userId" = $1', [accounts.owner.id]);
      assert.equal(rows[0].token.length, 64); assert.notEqual(rows[0].token, cookie);
    });
    const compBody = { title: "Owner's private contest", description: 'PRIVATE_DESCRIPTION_CANARY', visibility: 'private', join_policy: 'invite', starts_at: '2099-01-01T00:00:00Z', ends_at: '2099-01-02T00:00:00Z', team_mode: true, team_size_max: 2 };
    const c = (await owner('/competitions', 'POST', compBody, 201)).data;
    const other = (await outsider('/competitions', 'POST', { ...compBody, title: 'Other contest', description: 'Public description', visibility: 'public', team_mode: false }, 201)).data;
    const prefix = `/competitions/${c.id}`;
    const taskBody = { title: "O'Reilly task", description: 'Task description is long enough', category: 'web', difficulty: 'easy', answer_flag: 'flag{security_canary}', reward_token: 'reward_CANARY', max_solves: 1 };
    const task = (await owner(prefix + '/tasks', 'POST', taskBody, 201)).data;
    const taskPath = prefix + '/tasks/' + task.slug;
    await t.test('pins and unrelated owner membership grant no authority', async () => {
      await outsider('/pins', 'POST', { competition_id: c.id }, 201);
      await outsider(prefix, 'GET', undefined, [403, 404]);
      await outsider(prefix, 'PATCH', { title: 'Taken over' }, [403, 404]);
      await outsider(prefix + '/state', 'POST', { action: 'publish' }, [403, 404]);
      await outsider(prefix, 'DELETE', { confirm_slug: c.slug }, [403, 404]);
      await outsider(taskPath + '/revisions', 'GET', undefined, [403, 404]);
      const unchanged = (await owner(prefix)).data; assert.equal(unchanged.title, compBody.title);
    });
    await db.query('UPDATE "competition" SET "state" = \'running\', "visibility" = \'public\' WHERE "id" = ANY($1)', [[c.id, other.id]]);
    await db.query('INSERT INTO "membership" ("competitionId","userId","role","status") VALUES ($1,$2,\'participant\',\'active\'),($1,$3,\'participant\',\'active\'),($1,$4,\'participant\',\'active\')', [c.id, accounts.player.id, accounts.teammate.id, accounts.late.id]);
    await db.query('UPDATE "task" SET "state" = \'published\' WHERE "id" = $1', [task.id]);
    await t.test('participant cannot self-promote or view secret revisions', async () => {
      await player(prefix + '/members/' + accounts.player.id, 'PATCH', { role: 'admin', status: 'active' }, 403);
      await player(taskPath + '/revisions', 'GET', undefined, 403);
      await player(taskPath + '/revisions/1', 'GET', undefined, 403);
      await player(taskPath + '/manage', 'GET', undefined, 403);
      const detail = (await player(taskPath)).data; assert.ok(!JSON.stringify(detail).includes('reward_CANARY'));
      assert.equal((await owner(taskPath + '/revisions')).data.items[0].answer_flag, taskBody.answer_flag);
    });
    await t.test('search treats injection as data and does not search unrelated descriptions', async () => {
      const injection = "x'; SELECT pg_sleep(1); --";
      assert.equal((await guest('/competitions?q=' + encodeURIComponent(injection))).data.total, 0);
      await db.query('UPDATE "competition" SET "visibility" = \'private\' WHERE "id" = $1', [c.id]);
      assert.equal((await guest('/competitions?q=PRIVATE_DESCRIPTION_CANARY')).data.total, 0);
      await db.query('UPDATE "competition" SET "visibility" = \'public\' WHERE "id" = $1', [c.id]);
      const body = { ...taskBody, title: "Literal '; SELECT 1; --", reward_token: 'SECOND_REWARD' };
      const created = (await owner(prefix + '/tasks', 'POST', body, 201)).data; assert.equal(created.title, body.title);
    });
    let team;
    await t.test('team capacity is serialized under concurrent joins', async () => {
      team = (await player(prefix + '/teams', 'POST', { name: "Player's team" }, 201)).data;
      const results = await Promise.all([teammate, late].map(api => api(prefix + `/teams/${team.id}/join`, 'POST', { join_code: team.join_code }, [200, 409])));
      assert.deepEqual(results.map(r => r.res.status).sort(), [200, 409]);
    });
    const { rows: members } = await db.query('SELECT "userId" FROM "membership" WHERE "teamId" = $1 AND "userId" <> $2', [team.id, accounts.player.id]);
    const mateName = Object.keys(accounts).find(k => accounts[k].id === members[0].userId);
    const mateApi = { teammate, late }[mateName];
    let hint;
    await t.test('hint unlock is idempotent per team and failed insert uses savepoint', async () => {
      hint = (await owner(taskPath + '/hints', 'POST', { body: 'HINT_BODY_CANARY', cost: 5 }, 201)).data;
      await player(prefix + `/hints/${hint.id}/unlock`, 'POST', {});
      await player(prefix + `/hints/${hint.id}/unlock`, 'POST', {});
      await mateApi(prefix + `/hints/${hint.id}/unlock`, 'POST', {});
      assert.equal((await db.query('SELECT COUNT(*) AS n FROM "hint_unlock" WHERE "hintId" = $1', [hint.id])).rows[0].n, '1');
      await player(prefix + `/teams/${team.id}`, 'DELETE', {}, 409);
      await player(prefix + `/teams/${team.id}/members/${accounts.player.id}`, 'DELETE', {}, 409);
      await player(prefix + '/leave', 'POST', {}, 409);
    });
    await t.test('submission throttle cannot be bypassed with parallel requests', async () => {
      const results = await Promise.all(Array.from({ length: 14 }, () => player(taskPath + '/submit', 'POST', { flag: 'wrong' }, [200, 429])));
      assert.equal(results.filter(r => r.res.status === 200).length, 10);
      assert.equal(results.filter(r => r.res.status === 429).length, 4);
      await db.query('DELETE FROM "submission" WHERE "userId" = $1', [accounts.player.id]);
    });
    await t.test('solve reward, scoped tokens, bans and frozen statistics', async () => {
      const solved = (await player(taskPath + '/submit', 'POST', { flag: taskBody.answer_flag })).data;
      assert.equal(solved.reward_token, taskBody.reward_token);
      const token = (await player('/tokens', 'POST', { name: 'bound elsewhere', scopes: ['competitions:read', 'tasks:read', 'competitions:write'], competition_id: other.id }, 201)).data.token;
      const bound = client(token);
      assert.equal((await bound('/solves/mine')).data.items.length, 0);
      assert.ok((await bound('/competitions')).data.items.every(x => x.id === other.id));
      await bound(taskPath + '/revisions', 'GET', undefined, 403);
      await bound('/competitions', 'POST', compBody, 403);
      await bound(prefix + '/join', 'POST', {}, 403);
      await owner(prefix + '/members/' + accounts[mateName].id, 'PATCH', { status: 'banned' });
      await mateApi(prefix + '/members/' + accounts[mateName].id, 'PATCH', { status: 'active' }, 403);
      assert.equal((await mateApi('/solves/mine')).data.items.length, 0);
      const { rows: member } = await db.query('SELECT "teamId" FROM "membership" WHERE "competitionId"=$1 AND "userId"=$2', [c.id, accounts[mateName].id]); assert.equal(member[0].teamId, null);
      await db.query('UPDATE "competition" SET "frozenAt" = now() - interval \'1 hour\', "state"=\'frozen\' WHERE "id"=$1', [c.id]);
      assert.equal((await guest(prefix)).data.stats.solves, 0);
      assert.equal((await guest('/stats')).data.solves, 0);
      assert.equal((await owner(prefix)).data.stats.solves, 1);
      assert.equal((await player(prefix + '/tasks')).data.items.find(x => x.id === task.id).solve_count, 0);
    });
    await t.test('cross-origin, MIME confusion and download headers', async () => {
      await owner('/auth/logout', 'POST', {}, 403, { origin: 'https://evil.test' });
      await owner('/auth/logout', 'POST', {}, 415, { 'content-type': 'text/plain; application/json' });
      const form = new FormData(); form.set('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'untrusted.html');
      const file = (await owner(taskPath + '/attachments', 'POST', form, 201)).data;
      const download = await player(prefix + `/attachments/${file.id}/download`);
      assert.match(download.res.headers.get('content-disposition'), /^attachment;/);
      assert.equal(download.res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(download.res.headers.get('content-security-policy'), /sandbox/);
    });
    await t.test('one-use invite is consumed exactly once concurrently', async () => {
      const invitation = (await outsider(`/competitions/${other.id}/invites`, 'POST', { role: 'participant', max_uses: 1 }, 201)).data;
      const results = await Promise.all([teammate, late].map(api => api(`/competitions/${other.id}/join`, 'POST', { invite_code: invitation.code }, [200, 403])));
      assert.deepEqual(results.map(r => r.res.status).sort(), [200, 403]);
    });
    await t.test('padded join IDs recheck competition state after canonical row lock', async () => {
      const racer = client();
      await racer('/auth/register', 'POST', { username: 'racer', password: 'valid_password_123' }, 201);
      const invitation = (await outsider(`/competitions/${other.id}/invites`, 'POST', { role: 'participant', max_uses: 1 }, 201)).data;
      const lock = await db.connect();
      let joining;
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT "id" FROM "competition" WHERE "id"=$1 FOR UPDATE', [other.id]);
        joining = racer(`/competitions/000${other.id}/join`, 'POST', { invite_code: invitation.code }, 410);
        await new Promise(r => setTimeout(r, 75));
        await lock.query('UPDATE "competition" SET "state"=\'finished\' WHERE "id"=$1', [other.id]);
        await lock.query('COMMIT');
        await joining;
      } finally { await lock.query('ROLLBACK'); lock.release(); }
    });
    await t.test('attachment count limit survives simultaneous uploads', async () => {
      const form = () => { const f = new FormData(); f.set('file', new Blob(['test']), 'test.txt'); return f; };
      for (let i = 0; i < 8; i++) await owner(taskPath + '/attachments', 'POST', form(), 201);
      const results = await Promise.all([0, 1].map(() => owner(taskPath + '/attachments', 'POST', form(), [201, 409])));
      assert.deepEqual(results.map(r => r.res.status).sort(), [201, 409]);
    });
    await t.test('solve cap is enforced for a different team', async () => {
      await db.query('INSERT INTO "membership" ("competitionId","userId","role","status") VALUES ($1,$2,\'participant\',\'active\')', [c.id, accounts.outsider.id]);
      await outsider(prefix + '/teams', 'POST', { name: 'Second team' }, 201);
      await outsider(taskPath + '/submit', 'POST', { flag: taskBody.answer_flag }, 410);
    });
    await t.test('slow request bodies do not hold business transaction locks', async () => {
      const cookie = (await outsider('/auth/me')).cookie;
      let slow;
      const done = new Promise((resolve, reject) => {
        slow = httpRequest(`http://127.0.0.1:${port}/api/competitions/${c.id}/tasks`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'content-length': '2' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        slow.on('error', reject);
      });
      slow.write('{');
      try {
        // Give the incomplete request time to enter body reading.
        await new Promise(r => setTimeout(r, 75));
        await owner(prefix, 'PATCH', { title: "Owner's private contest" });
      } finally { slow.end('}'); }
      assert.equal(await done, 403);
    });
    await t.test('idle database disconnect is handled, not an unhandled process error', async () => {
      const driver = PgDriver.connect({ connectionString: url.href, options: '-c idle_in_transaction_session_timeout=100' });
      try {
        await assert.rejects(driver.transaction(async () => { await new Promise(r => setTimeout(r, 250)); }));
        assert.equal((await driver.query('SELECT 1 AS value'))[0].value, 1);
      } finally { await driver.close(); }
    });
    await t.test('URL-encoded authentication remains compatible with existing clients', async () => {
      const res = await fetch(base + '/auth/login', { method: 'POST', body: new URLSearchParams({ username: 'owner', password: 'valid_password_123' }) });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).username, 'owner');
      assert.match(res.headers.get('set-cookie'), /HttpOnly/);
    });
    await t.test('HTML response CSP contains hashes for inline boot scripts', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/login/`);
      assert.equal(res.status, 200); assert.match(res.headers.get('content-security-policy'), /sha256-/);
    });
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS "${appRole}"`);
    await admin.end();
    await rm(temp, { recursive: true, force: true });
  }
});
