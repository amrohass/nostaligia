/* Real sessions, against the Supabase Auth REST API.

   CLAUDE.md §2: email + password only. There is no social provider here and there must
   not be one — the buttons that used to sit in the auth dialog were prototype decoration.

   ── Why there is no Supabase JS SDK ──────────────────────────

   §9 forbids a build step, and the CSP is `script-src 'self' + Turnstile` — so a bundled
   SDK and a CDN <script> are both out. What is left is the REST API, which for the three
   calls this needs is about a hundred lines. That is the same trade _shared/sigv4.ts and
   _shared/magic-bytes.ts already record: a dependency on the credential path is a
   dependency with access to the credential path.

   ── Where the session lives, and why ─────────────────────────

   The ACCESS token is held in a module-local variable and never written anywhere. The
   REFRESH token goes to sessionStorage.

   That split is the whole design. §5 says the browser is hostile, and both storages are
   readable by any successful XSS — so the question is not "can this be stolen" but "what
   is still worth stealing after the tab closes". An access token in memory dies with the
   page. A refresh token in sessionStorage dies with the tab, rather than sitting on disk
   for the next person to open the browser — which for §7's contributors, some of whom are
   on shared or borrowed devices, is the difference that matters.

   The cost is one refresh round-trip on reload. §9 already requires the sign-in gate to
   survive a round-trip with intent intact, so that machinery exists either way. */

(function (global) {
  'use strict';

  var AUTH = global.CONFIG.origins.supabase + '/auth/v1';
  var ANON = global.CONFIG.supabase.anonKey;

  var REFRESH_KEY = 'rma.refresh';

  /* Not persisted. See the header. */
  var accessToken = null;
  var expiresAt = 0;
  var user = null;

  var listeners = [];

  function emit() {
    listeners.forEach(function (fn) { try { fn(currentUser()); } catch (e) { /* a bad listener is not an auth failure */ } });
  }

  function readRefresh() {
    try { return global.sessionStorage.getItem(REFRESH_KEY); } catch (e) { return null; }
  }

  function writeRefresh(token) {
    try {
      if (token) global.sessionStorage.setItem(REFRESH_KEY, token);
      else global.sessionStorage.removeItem(REFRESH_KEY);
    } catch (e) { /* private mode; the session simply will not survive a reload */ }
  }

  /* Every refusal the Auth API can return, mapped to an i18n key.

     Mapped rather than displayed, because the raw strings are English, change between
     Supabase versions, and occasionally say more than a visitor should be told. Anything
     unrecognised falls through to a generic message — never to the server's own text. */
  var ERRORS = {
    invalid_credentials: 'auth.err.credentials',
    email_exists: 'auth.err.emailTaken',
    user_already_exists: 'auth.err.emailTaken',
    weak_password: 'auth.err.weakPassword',
    over_email_send_rate_limit: 'auth.err.rateLimit',
    over_request_rate_limit: 'auth.err.rateLimit',
    email_not_confirmed: 'auth.err.unconfirmed',
    validation_failed: 'auth.err.invalidEmail'
  };

  function messageKey(body, status) {
    var code = body && (body.error_code || body.code || body.error);
    if (code && ERRORS[code]) return ERRORS[code];
    /* Older responses carry no code, only a message. Two are worth recognising because
       they are the two a member actually hits. */
    var msg = String((body && (body.msg || body.error_description || body.message)) || '');
    if (/invalid login credentials/i.test(msg)) return 'auth.err.credentials';
    if (/already registered|already been registered/i.test(msg)) return 'auth.err.emailTaken';
    if (status === 429) return 'auth.err.rateLimit';
    return 'auth.err.generic';
  }

  function AuthError(key) {
    var e = new Error(key);
    e.key = key;
    return e;
  }

  function request(path, payload) {
    if (!ANON) {
      /* Loud and specific. Without this the browser sends an unauthenticated request and
         gets a 401 that looks like wrong credentials — a false trail that costs an hour. */
      return Promise.reject(AuthError('auth.err.notConfigured'));
    }
    return global.fetch(AUTH + path, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw AuthError(messageKey(body, res.status));
        return body;
      });
    }, function () {
      throw AuthError('auth.err.offline');
    });
  }

  function adopt(session) {
    if (!session || !session.access_token) throw AuthError('auth.err.generic');
    accessToken = session.access_token;
    /* 60s of slack: a token that expires while a request is in flight is a request that
       fails for a reason the member cannot act on. */
    expiresAt = Date.now() + (Number(session.expires_in) || 3600) * 1000 - 60000;
    user = session.user || null;
    writeRefresh(session.refresh_token || null);
    emit();
    return currentUser();
  }

  function clear() {
    accessToken = null;
    expiresAt = 0;
    user = null;
    writeRefresh(null);
    emit();
  }

  function currentUser() {
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      /* §4: role_cache is display-only and never trusted for authorization. This is the
         same value from the token's side — useful for showing a moderator their queue
         link, useless for deciding whether they may drain it. Every real decision is made
         by RLS. */
      role: (user.app_metadata && user.app_metadata.user_role) || 'member'
    };
  }

  /* Refreshes are coalesced. Three widgets noticing an expired token at once must produce
     one refresh, not three — Supabase rotates the refresh token on use, so the second and
     third would be replaying a token that no longer exists and would sign the member out. */
  var inFlight = null;

  function refresh() {
    var token = readRefresh();
    if (!token) return Promise.reject(AuthError('auth.err.signedOut'));
    if (inFlight) return inFlight;

    inFlight = request('/token?grant_type=refresh_token', { refresh_token: token })
      .then(function (session) { return adopt(session); })
      .catch(function (e) { clear(); throw e; })
      .then(function (v) { inFlight = null; return v; }, function (e) { inFlight = null; throw e; });

    return inFlight;
  }

  /* The accessor every caller should use. Returns a token that is valid NOW, refreshing
     first if it is not. */
  function accessTokenAsync() {
    if (accessToken && Date.now() < expiresAt) return Promise.resolve(accessToken);
    return refresh().then(function () { return accessToken; });
  }

  global.AUTH = {
    /* §6 requires Turnstile on signup. The token is single-use and is verified server-side
       by Supabase's own bot protection when enabled; the submit path verifies its own
       separately in request-upload. */
    signUp: function (email, password, turnstileToken) {
      var payload = { email: email, password: password };
      if (turnstileToken) payload.gotrue_meta_security = { captcha_token: turnstileToken };
      return request('/signup', payload).then(function (body) {
        /* With email confirmation on, signup returns a user and NO session. That is a
           success, not a failure, and the caller has to say so rather than appearing to
           hang. */
        if (!body.access_token) return { confirmationRequired: true, user: null };
        return { confirmationRequired: false, user: adopt(body) };
      });
    },

    signIn: function (email, password, turnstileToken) {
      var payload = { email: email, password: password };
      if (turnstileToken) payload.gotrue_meta_security = { captcha_token: turnstileToken };
      return request('/token?grant_type=password', payload).then(adopt);
    },

    signOut: function () {
      var token = accessToken;
      clear();
      if (!token) return Promise.resolve();
      /* Best-effort revocation. The local session is already gone either way — a signOut
         that appears to fail because the network did would leave a member believing they
         are still signed in on a device they are walking away from. */
      return global.fetch(AUTH + '/logout', {
        method: 'POST',
        headers: { apikey: ANON, Authorization: 'Bearer ' + token }
      }).catch(function () { /* deliberate */ });
    },

    /* Called once at startup. Restores a session from the refresh token if there is one,
       and resolves to null rather than rejecting when there is not — "nobody is signed in"
       is the ordinary case, not an error. */
    restore: function () {
      if (!readRefresh()) return Promise.resolve(null);
      return refresh().then(currentUser, function () { return null; });
    },

    accessToken: accessTokenAsync,
    user: currentUser,
    isSignedIn: function () { return user !== null; },
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },

    /* Exposed for the tests in scripts/frontend-auth-test.mjs, which assert that the
       access token is never written to storage. Reading it any other way would mean the
       test asserting against its own copy of the rule. */
    _debug: { hasAccessTokenInMemory: function () { return accessToken !== null; } }
  };
})(window);
