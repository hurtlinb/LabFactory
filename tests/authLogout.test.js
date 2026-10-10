import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeOidcAuth } from '../dashboard/auth.js';

test('logout destroys the local session and ends the identity provider session', async t => {
  const originalEnv = { ...process.env };
  t.after(() => { process.env = originalEnv; });
  Object.assign(process.env, {
    OIDC_ISSUER_URL: 'https://identity.example/realm/', OIDC_CLIENT_ID: 'labfactory',
    SESSION_SECRET: 'test-session-secret', SESSION_COOKIE_SECURE: 'false', NODE_ENV: 'test'
  });
  delete process.env.OIDC_POST_LOGOUT_REDIRECT_URI;
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, json: async () => ({ end_session_endpoint: 'https://identity.example/logout' })
  }));
  const routes = new Map();
  await initializeOidcAuth({ use() {}, set() {}, get() {}, post(path, handler) { routes.set(path, handler); } });
  const logout = routes.get('/auth/logout');
  let destroyed = false;
  let cleared = false;
  let redirect;
  const req = {
    headers: {}, protocol: 'https', get: () => 'labfactory.example',
    session: { idToken: 'identity-token', destroy(cb) { destroyed = true; cb(); } }
  };
  logout(req, {
    clearCookie(name) { assert.equal(destroyed, true); assert.equal(name, 'labfactory.sid'); cleared = true; },
    redirect(status, url) { assert.equal(status, 303); redirect = new URL(url); }
  });
  assert.equal(cleared, true);
  assert.equal(redirect.origin, 'https://identity.example');
  assert.equal(redirect.searchParams.get('id_token_hint'), 'identity-token');
  assert.equal(redirect.searchParams.get('client_id'), 'labfactory');
  assert.equal(redirect.searchParams.get('post_logout_redirect_uri'), 'https://labfactory.example/');

  // Existing sessions created before this change have no saved ID token.
  delete req.session.idToken;
  logout(req, { clearCookie() {}, redirect(_status, url) {
    assert.equal(new URL(url).searchParams.has('id_token_hint'), false);
    assert.equal(new URL(url).searchParams.get('client_id'), 'labfactory');
  } });

  req.session.destroy = cb => cb(new Error('session store unavailable'));
  logout(req, { status(code) { assert.equal(code, 500); return this; }, send(message) {
    assert.equal(message, 'Unable to sign out');
  }, redirect() { assert.fail('failed session destruction must not report success'); } });
});
