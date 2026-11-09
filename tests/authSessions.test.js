import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { initializeOidcAuth } from '../dashboard/auth.js';

test('probes bypass sessions; OIDC sessions have Redis TTL and survive a new app instance', async t => {
  const originalEnv = { ...process.env };
  t.after(() => { process.env = originalEnv; });
  Object.assign(process.env, {
    OIDC_ISSUER_URL: 'https://identity.example/realm/', OIDC_CLIENT_ID: 'labfactory-test',
    SESSION_SECRET: 'test-secret', SESSION_COOKIE_SECURE: 'false', NODE_ENV: 'test',
    SESSION_MAX_AGE_MS: '60000'
  });
  const realFetch = globalThis.fetch;
  const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
    return { ok: true, json: async () => String(url).endsWith('/token')
      ? { id_token: jwt({ sub: 'teacher', email: 'teacher@example.test' }) }
      : { authorization_endpoint: 'https://identity.example/login', token_endpoint: 'https://identity.example/token' } };
  });
  // Exercise the real express-session / connect-redis adapters with a Redis command double.
  const entries = new Map();
  const calls = [];
  let unavailable = false;
  const redisClient = {
    async get(key) {
      calls.push(['get', key]);
      if (unavailable) throw new Error('Redis unavailable');
      return entries.get(key)?.value ?? null;
    },
    async set(key, value, options) {
      calls.push(['set', key]);
      if (unavailable) throw new Error('Redis unavailable');
      entries.set(key, { value, ttl: options.expiration.value });
    },
    async expire(key, ttl) { calls.push(['expire', key]); entries.get(key).ttl = ttl; },
    async del(keys) { for (const key of keys) entries.delete(key); }
  };
  const startApp = async () => {
    const app = express();
    const auth = await initializeOidcAuth(app, { redisClient });
    app.use(auth.requireAuth);
    app.get('/', (req, res) => res.json({ user: req.session.user }));
    app.use((error, _req, res, _next) => res.status(503).send('Session storage unavailable'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const first = await startApp();
  for (let i = 0; i < 30; i++) {
    const response = await fetch(`${first}/healthz`, { redirect: 'manual', headers: { cookie: 'labfactory.sid=invalid' } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('location'), null);
  }
  assert.equal(calls.length, 0, 'probes must not access Redis or create sessions');
  const login = await fetch(first, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  assert.equal(entries.size, 1);
  const [key, entry] = [...entries][0];
  assert(key.startsWith('labfactory:session:labfactory-test:'));
  assert(entry.ttl > 0 && entry.ttl <= 60, 'session must be written with an expiry');

  const second = await startApp();
  const callback = await fetch(`${second}/auth/callback?state=${state}&code=test`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(callback.status, 302, 'another instance must be able to complete the login');
  const page = await fetch(second, { headers: { cookie }, redirect: 'manual' });
  assert.equal((await page.json()).user.email, 'teacher@example.test');
  assert(calls.some(([command]) => command === 'expire'), 'active sessions refresh their TTL');

  unavailable = true;
  const failed = await fetch(second, { headers: { cookie }, redirect: 'manual' });
  assert.equal(failed.status, 503, 'Redis failure must not fall back to local sessions');
  const probe = await fetch(`${second}/healthz`);
  assert.equal(probe.status, 200, 'dependency outages must not cause liveness restarts');
  unavailable = false;

  const logout = await fetch(`${second}/auth/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
  assert.equal(logout.status, 303);
  assert.equal(entries.size, 0, 'logout removes the Redis session');
});

test('health endpoint is available with OIDC disabled', async () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    const routes = new Map();
    const auth = await initializeOidcAuth({ get: (path, handler) => routes.set(path, handler) });
    assert.equal(auth.enabled, false);
    let body;
    routes.get('/healthz')({}, { status(code) { assert.equal(code, 200); return this; }, send(value) { body = value; } });
    assert.equal(body, 'ok');
  } finally { process.env = originalEnv; }
});
