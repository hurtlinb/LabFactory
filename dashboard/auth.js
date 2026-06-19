import crypto from 'node:crypto';
import session from 'express-session';

const jsonRequest = async (url, options = {}) => {
  const response = await fetch(url, {
    redirect: 'follow',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers ?? {})
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      payload.error_description ||
      payload.error ||
      `OIDC request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
};

const createBase64Url = input =>
  Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const randomBase64Url = size => createBase64Url(crypto.randomBytes(size));

const sha256Base64Url = value =>
  createBase64Url(
    crypto
      .createHash('sha256')
      .update(value)
      .digest()
  );

const buildExternalBaseUrl = req => {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = typeof forwardedProto === 'string' ? forwardedProto.split(',')[0].trim() : req.protocol;
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = typeof forwardedHost === 'string' ? forwardedHost.split(',')[0].trim() : req.get('host');
  return `${protocol}://${host}`;
};

const asBoolean = value => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

const ROLES = { ADMIN: 'admin', TEACHER: 'teacher' };
const ROLE_GROUPS = { ADMIN_ONLY: [ROLES.ADMIN], LABS: [ROLES.TEACHER, ROLES.ADMIN] };

const resolveUser = (claims, clientId) => {
  if (!claims || typeof claims !== 'object') {
    return null;
  }

  const preferredUsername = String(claims.preferred_username ?? '').trim();
  const name = String(claims.name ?? '').trim();
  const email = String(claims.email ?? '').trim();
  const initials = String(claims.initials ?? '').trim();
  const givenName = String(claims.given_name ?? '').trim();
  const familyName = String(claims.family_name ?? '').trim();
  const displayName = name || [givenName, familyName].filter(Boolean).join(' ').trim();

  const clientRoles = Array.isArray(claims.resource_access?.[clientId]?.roles) ? claims.resource_access[clientId].roles : [];
  const realmRoles = Array.isArray(claims.realm_access?.roles) ? claims.realm_access.roles : [];

  return {
    subject: String(claims.sub ?? '').trim(),
    username: preferredUsername || null,
    name: displayName || preferredUsername || email || 'Authenticated user',
    email: email || null,
    initials: initials || null,
    firstName: givenName || null,
    lastName: familyName || null,
    roles: [...new Set([...clientRoles, ...realmRoles])]
  };
};

const decodeJwtPayload = token => {
  const [, payload = ''] = String(token ?? '').split('.');
  if (!payload) {
    return {};
  }

  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
};

const issuerWellKnownUrl = issuerUrl => new URL('.well-known/openid-configuration', issuerUrl.endsWith('/') ? issuerUrl : `${issuerUrl}/`).toString();

export const initializeOidcAuth = async app => {
  const issuerUrl = String(process.env.OIDC_ISSUER_URL ?? '').trim();
  const clientId = String(process.env.OIDC_CLIENT_ID ?? '').trim();
  const sessionSecret = String(process.env.SESSION_SECRET ?? '').trim();
  const enabled = Boolean(issuerUrl && clientId);

  if (!enabled) {
    return {
      enabled: false,
      attachUser: (_req, _res, next) => next(),
      requireAuth: (_req, _res, next) => next(),
      requireRole: () => (_req, _res, next) => next(),
      ROLES,
      ROLE_GROUPS,
      describeSession: () => ({
        enabled: false,
        user: null,
        loginUrl: null,
        logoutUrl: null
      })
    };
  }

  if (!sessionSecret) {
    throw new Error('SESSION_SECRET is required when OIDC authentication is enabled');
  }

  const discovery = await jsonRequest(issuerWellKnownUrl(issuerUrl));
  const clientSecret = String(process.env.OIDC_CLIENT_SECRET ?? '').trim();
  const scope = String(process.env.OIDC_SCOPES ?? 'openid profile email').trim();
  const secureCookie = asBoolean(process.env.SESSION_COOKIE_SECURE) || process.env.NODE_ENV === 'production';
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy && !['0', 'false', 'no', 'off'].includes(String(trustProxy).trim().toLowerCase())) {
    app.set('trust proxy', trustProxy === 'true' ? 1 : trustProxy);
  }

  app.use(
    session({
      name: 'labfactory.sid',
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookie,
        maxAge: Number(process.env.SESSION_MAX_AGE_MS ?? 8 * 60 * 60 * 1000)
      }
    })
  );

  const startLogin = (req, res) => {
    const state = randomBase64Url(24);
    const nonce = randomBase64Url(24);
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = sha256Base64Url(codeVerifier);
    const returnTo = String(req.query.returnTo ?? req.session.returnTo ?? '/').trim() || '/';
    const redirectUri =
      String(process.env.OIDC_REDIRECT_URI ?? '').trim() || `${buildExternalBaseUrl(req)}/auth/callback`;

    req.session.oidc = {
      state,
      nonce,
      codeVerifier,
      redirectUri,
      returnTo
    };

    const authorizeUrl = new URL(discovery.authorization_endpoint);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', scope);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('nonce', nonce);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    res.redirect(authorizeUrl.toString());
  };

  app.get('/auth/login', startLogin);

  app.get('/auth/callback', async (req, res) => {
    try {
      const oidcSession = req.session.oidc;
      if (!oidcSession || req.query.state !== oidcSession.state || !req.query.code) {
        res.status(400).send('Invalid authentication callback');
        return;
      }

      const tokenPayload = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: String(req.query.code),
        redirect_uri: oidcSession.redirectUri,
        code_verifier: oidcSession.codeVerifier
      });

      if (clientSecret) {
        tokenPayload.set('client_secret', clientSecret);
      }

      const tokenResponse = await jsonRequest(discovery.token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: tokenPayload.toString()
      });

      const idTokenClaims = tokenResponse.id_token ? decodeJwtPayload(tokenResponse.id_token) : {};
      if (idTokenClaims.nonce && idTokenClaims.nonce !== oidcSession.nonce) {
        res.status(400).send('Invalid authentication nonce');
        return;
      }

      const userInfo =
        discovery.userinfo_endpoint && tokenResponse.access_token
          ? await jsonRequest(discovery.userinfo_endpoint, {
              headers: {
                Authorization: `Bearer ${tokenResponse.access_token}`
              }
            })
          : idTokenClaims;

      // Keycloak client roles (resource_access) are reliably present on the access token;
      // the userinfo response and ID token may omit them depending on protocol-mapper config.
      const accessTokenClaims = tokenResponse.access_token ? decodeJwtPayload(tokenResponse.access_token) : {};
      const roleSource = accessTokenClaims.resource_access
        ? accessTokenClaims
        : idTokenClaims.resource_access
          ? idTokenClaims
          : userInfo;

      req.session.user = resolveUser(
        { ...userInfo, resource_access: roleSource.resource_access, realm_access: roleSource.realm_access },
        clientId
      );
      req.session.oidcTokens = {
        idToken: tokenResponse.id_token ?? null
      };
      delete req.session.oidc;
      delete req.session.returnTo;

      res.redirect(oidcSession.returnTo || '/');
    } catch (error) {
      console.error('OIDC callback failed', error);
      res.status(500).send('Authentication failed');
    }
  });

  app.get('/auth/logout', (req, res) => {
    const baseUrl = buildExternalBaseUrl(req);
    const postLogoutRedirectUri =
      String(process.env.OIDC_POST_LOGOUT_REDIRECT_URI ?? '').trim() || `${baseUrl}/`;
    const endSessionEndpoint = discovery.end_session_endpoint;
    const idTokenHint = req.session?.oidcTokens?.idToken;

    req.session.destroy(error => {
      if (error) {
        console.error('Unable to destroy authenticated session', error);
      }

      if (!endSessionEndpoint) {
        res.redirect(postLogoutRedirectUri);
        return;
      }

      const logoutUrl = new URL(endSessionEndpoint);
      logoutUrl.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
      if (clientId) {
        logoutUrl.searchParams.set('client_id', clientId);
      }
      if (idTokenHint) {
        logoutUrl.searchParams.set('id_token_hint', idTokenHint);
      }
      res.redirect(logoutUrl.toString());
    });
  });

  const attachUser = (req, _res, next) => {
    req.auth = {
      user: req.session?.user ?? null
    };
    next();
  };

  const requireAuth = (req, res, next) => {
    if (req.session?.user) {
      next();
      return;
    }

    if (req.path.startsWith('/api/')) {
      res.status(401).json({
        error: 'authentication required',
        loginUrl: '/auth/login'
      });
      return;
    }

    req.session.returnTo = req.originalUrl || '/';
    startLogin(req, res);
  };

  const requireRole = allowedRoles => (req, res, next) => {
    const roles = req.session?.user?.roles ?? [];
    if (allowedRoles.some(role => roles.includes(role))) {
      next();
      return;
    }
    res.status(403).json({ error: 'forbidden' });
  };

  const describeSession = req => ({
    enabled: true,
    user: req.session?.user ?? null,
    loginUrl: '/auth/login',
    logoutUrl: '/auth/logout'
  });

  return {
    enabled: true,
    attachUser,
    requireAuth,
    requireRole,
    ROLES,
    ROLE_GROUPS,
    describeSession
  };
};
