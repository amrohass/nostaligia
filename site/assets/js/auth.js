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

  /* A recovery link's tokens, between landing on /reset and setting a password. Held
     here rather than adopted, and never written to storage — see beginRecovery below. */
  var recovery = null;

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
    /* Two different events, and they were mapped to one message until 31 Aug 2026.
       over_request_rate_limit IS about this caller: they sent too many requests.
       over_email_send_rate_limit is a PROJECT-WIDE cap on outbound mail per hour — with
       Supabase's built-in sender it is a very small number — so it fires on the first
       attempt of somebody who has never been here, and telling them they tried too often
       sends them away to wait for a cooldown that is not theirs. */
    over_email_send_rate_limit: 'auth.err.mailLimit',
    over_request_rate_limit: 'auth.err.rateLimit',
    email_not_confirmed: 'auth.err.unconfirmed',
    validation_failed: 'auth.err.invalidEmail',
    /* Added 1 Sep 2026, after this exact refusal spent two days looking like a wrong
       password. GoTrue's captcha protection covers /signup, /token and /recover; a request
       that carries no captcha_token is refused with this code BEFORE the credentials are
       read, so the account and the password are irrelevant to it. It fell through to
       auth.err.generic, and "something went wrong, try again later" is indistinguishable
       from every other failure — which is why the admin dashboard's missing widget was
       found by a person locked out rather than by the screen that locked them out. */
    captcha_failed: 'auth.err.captcha',
    /* The password-reset path, added 3 Sep 2026. All three are refusals of PUT /user with
       a recovery session, and all three used to fall through to auth.err.generic — which
       on a screen whose only job is "type a new password" tells the member nothing about
       which of the three things they must do differently. */
    same_password: 'auth.err.samePassword',
    reauthentication_needed: 'auth.err.reauth',
    session_not_found: 'auth.err.linkExpired',
    bad_jwt: 'auth.err.linkExpired'
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

  /* `opts` exists for the recovery path and nothing else so far:

       method      — /user is a PUT. Everything else here is a POST.
       token       — a Bearer, for the one call that is authenticated by a session rather
                     than by the anon key.
       statusKeys  — a per-call override for a status whose meaning depends on which
                     endpoint answered it. A 401 from /user during a password reset means
                     the recovery link has been spent or has aged out; a 401 anywhere else
                     does not, so this is not something messageKey() can know. */
  function request(path, payload, opts) {
    opts = opts || {};
    if (!ANON) {
      /* Loud and specific. Without this the browser sends an unauthenticated request and
         gets a 401 that looks like wrong credentials — a false trail that costs an hour. */
      return Promise.reject(AuthError('auth.err.notConfigured'));
    }
    var headers = { apikey: ANON, 'Content-Type': 'application/json' };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    return global.fetch(AUTH + path, {
      method: opts.method || 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var key = messageKey(body, res.status);
          var override = opts.statusKeys && opts.statusKeys[res.status];
          /* The override applies only where the body said nothing useful. A response that
             names its own error code is more specific than a status, always. */
          if (override && key === 'auth.err.generic') key = override;
          throw AuthError(key);
        }
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

    /* ── Password reset ──────────────────────────────────────
       Added 3 Sep 2026. Two halves, an email round-trip apart.

       GoTrue's captcha protection covers /recover exactly as it covers /signup and
       /token, so the token is not optional in practice — a request without one is refused
       with `captcha_failed` before the address is even looked at. §6 wants the widget
       there anyway; this is the endpoint that also insists.

       `redirect_to` is sent as the CALLING page's own origin + /reset rather than a value
       from config, and the reason is that it must match Amro's Auth redirect allowlist,
       which this repository cannot read and must not change. A value the allowlist does
       not admit is not an error: GoTrue silently falls back to the project's Site URL.
       So sending it costs nothing and, where it IS admitted, the member lands on the
       screen built for them instead of on the archive with a fragment in the URL. The
       front end handles both landings (see captureRecovery in public.js).

       The response is deliberately not inspected. GoTrue answers 200 for an address it
       has never seen, which is the correct behaviour and the reason §7 can keep the
       confirmation panel identical either way — this must not become a way to ask the
       archive who has an account. */
    requestPasswordReset: function (email, turnstileToken, redirectTo) {
      var payload = { email: email };
      if (turnstileToken) payload.gotrue_meta_security = { captcha_token: turnstileToken };
      if (redirectTo) payload.redirect_to = redirectTo;
      return request('/recover', payload).then(function () { return true; });
    },

    /* The tokens a recovery link arrives with, HELD rather than adopted.

       GoTrue's /verify hands back a full session, so the obvious implementation is to
       adopt it on landing and let the member browse. That is what the official SDK does
       and it is not what happens here: §7's contributors are on shared and borrowed
       devices, and a recovery link opened on one of those would leave a live session
       behind for whoever opens the tab next, whether or not a password was ever set.

       So nothing is emitted, nothing is written to sessionStorage, and AUTH.isSignedIn()
       stays false until completeRecovery() succeeds. Abandoning the screen costs the
       visitor nothing and leaves nothing behind. */
    beginRecovery: function (tokens) {
      recovery = tokens && tokens.access_token ? tokens : null;
      return recovery !== null;
    },

    hasRecovery: function () { return recovery !== null; },

    discardRecovery: function () { recovery = null; },

    /**
     * Set the new password with the recovery session, and only then become signed in.
     *
     * PUT /auth/v1/user returns the USER, not a session — so the session adopted here is
     * assembled from the tokens the link carried plus the user the update answered with.
     * That is the same shape adopt() takes from /token, which is why there is one adopt().
     */
    completeRecovery: function (password) {
      if (!recovery) return Promise.reject(AuthError('auth.err.linkExpired'));
      var held = recovery;
      return request('/user', { password: password }, {
        method: 'PUT',
        token: held.access_token,
        /* A recovery session that has been spent or has aged out answers 401 with a body
           this file does not recognise. Left generic it reads as "that did not go
           through", and the member retypes the same password into a link that will never
           work again. */
        statusKeys: { 401: 'auth.err.linkExpired', 403: 'auth.err.linkExpired' }
      }).then(function (body) {
        recovery = null;
        return adopt({
          access_token: held.access_token,
          refresh_token: held.refresh_token,
          expires_in: held.expires_in,
          user: body
        });
      });
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
    _debug: {
      hasAccessTokenInMemory: function () { return accessToken !== null; },
      /* The §7 decision in beginRecovery is one line from being undone by someone
         "fixing" the reload, and nothing about the screen would look different. */
      hasRecoveryInMemory: function () { return recovery !== null; }
    }
  };
})(window);
