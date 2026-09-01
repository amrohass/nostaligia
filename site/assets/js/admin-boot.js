/* The door to the dashboard — and it is a door, not a lock.

   §5, stated as plainly as the file can manage: "The sign-in gate and the admin UI are UX
   only — never a guard." Everything below decides what to RENDER. Nothing below decides
   what a moderator may do; migration 0018's policies decide that, and they decide it again
   for every request whether or not this file ran.

   Deleting this file would not grant anyone a single extra capability. It would just mean a
   member browsing to /admin.html sees a dashboard whose every query comes back empty and
   whose every button is refused — which is a worse experience, not a worse posture.

   ── Why admin.js is loaded rather than shipped ───────────────

   §5 asks for admin.js to be "dynamically imported on moderator/admin login". It is a
   classic IIFE, not an ES module, so `import()` cannot take it — but the property that rule
   is after is that the bytes are not fetched until someone is a moderator, and a script tag
   injected after the role check achieves exactly that.

   The point is bundle weight and tidiness, NEVER secrecy. §5 again: "Hiding client code is
   not security." Anyone can request assets/js/admin.js directly and read all of it. They
   will learn which endpoints exist, which the anon key already tells them, and they will
   still be refused by the database. */

(function (global) {
  'use strict';

  var el = UI.el, mount = UI.mount, qs = UI.qs;
  var t = function (k, v) { return I18N.t(k, v); };

  var main = qs('#main');
  var rail = qs('#rail');

  function screen(children) {
    if (rail) rail.replaceChildren();
    mount(main, el('div.admin-gate', null, children));
  }

  function loading() {
    screen([el('p.admin-gate__note', { text: t('admin.checking') })]);
  }

  function refused(roleName) {
    screen([
      el('h1.admin-gate__title', { text: t('admin.refusedTitle') }),
      el('p.admin-gate__note', { text: t('admin.refusedBody', { role: roleName || 'member' }) }),
      el('a.abtn.abtn--quiet', { href: '/', text: t('admin.toArchive') })
    ]);
  }

  /* Both failure shapes, reduced to one i18n key.

     AUTH rejects with an AuthError carrying `.key`; TURNSTILE rejects with a plain Error
     whose `.message` IS a key ('up.err.robotUnavailable'). Reading only `.key` — which is
     what this file used to do — turned "the challenge widget never loaded" into the
     generic "try again later", which is the one message that cannot be acted on. */
  function errorKeyOf(err) {
    if (err && err.key) return err.key;
    if (err && typeof err.message === 'string' && /^[a-z]+\.[a-zA-Z.]+$/.test(err.message)) return err.message;
    return 'auth.err.generic';
  }

  function signInForm(errorKey) {
    var email = el('input.input', { type: 'email', autocomplete: 'email', placeholder: 'name@example.com' });
    var password = el('input.input', { type: 'password', autocomplete: 'current-password', placeholder: '••••••••' });
    var button = el('button.abtn.abtn--primary', { type: 'submit', text: t('login.submit') });
    var note = el('p.form-error', { role: 'alert', hidden: !errorKey, text: errorKey ? t(errorKey) : '' });
    /* `.captcha` is atlas.css's, which admin.html already links — the same reserved box
       the public dialog uses, so the form does not jump when the widget arrives. */
    var captchaSlot = el('div.captcha');

    /* Mounted for the same reason the public dialog mounts one: this form posts to
       /token?grant_type=password, GoTrue's captcha protection covers that endpoint, and a
       request without a token is refused before the credentials are ever looked at. From
       M1 until 1 Sep 2026 there was no widget here — harmless while the project's captcha
       was off, and a total lockout of the dashboard from the moment it was switched on.
       The symptom was a correct password answered with a generic failure. */
    var widget = TURNSTILE.mount(captchaSlot);

    var busy = false;

    var form = el('form.admin-gate__form', {
      onsubmit: function (event) {
        event.preventDefault();
        if (busy) return;
        busy = true;
        button.disabled = true;
        button.textContent = t('auth.working');

        var address = email.value;
        var secret = password.value;

        widget.token()
          .then(function (captcha) { return AUTH.signIn(address, secret, captcha); })
          .then(function () {
            /* remove() before start(): start() replaces #main, and a widget left rendered
               into a detached node keeps its iframe and its timers. */
            widget.remove();
            return start();
          })
          .catch(function (err) {
            /* The token was spent by the attempt that just failed. Re-rendering the form
               mounts a fresh widget, so this one is removed rather than reset — reset()
               would leave two widgets alive on a page that only shows one. */
            widget.remove();
            signInForm(errorKeyOf(err));
          });
      }
    }, [
      el('h1.admin-gate__title', { text: t('admin.signInTitle') }),
      el('label.field__label', { text: t('field.email') }), email,
      el('label.field__label', { text: t('field.password') }), password,
      captchaSlot,
      note,
      button
    ]);

    screen([form]);
    email.focus();
  }

  /* Loaded once, and only once — a second call would re-run admin.js's IIFE and give the
     dashboard two sets of event listeners on the same nodes. */
  var loaded = false;
  function loadDashboard() {
    if (loaded) return;
    loaded = true;
    var script = global.document.createElement('script');
    script.src = '/assets/js/admin.js';
    script.onerror = function () {
      screen([el('p.form-error', { text: t('admin.err.loadFailed') })]);
    };
    global.document.body.appendChild(script);
  }

  function start() {
    loading();

    /* The role comes from authz_role() — the DATABASE — and not from the JWT claim beside
       it. §4: "Role lives in a JWT claim ... profiles.role_cache is display-only and must
       never be trusted for authorization." The claim would also be stale for up to an hour
       after a demotion, so the dashboard would keep rendering for someone who has just lost
       access. It would be refused on every action, but showing it at all is a lie. */
    return DB.rpc('authz_role').then(function (role) {
      if (role === 'moderator' || role === 'admin') {
        loadDashboard();
        return;
      }
      refused(role);
    }).catch(function (err) {
      if (err && (err.key === 'admin.err.signedOut' || err.status === 401)) {
        signInForm(null);
        return;
      }
      screen([el('p.form-error', { text: t(err && err.key ? err.key : 'admin.err.generic') })]);
    });
  }

  loading();
  AUTH.restore().then(function (account) {
    if (!account) { signInForm(null); return; }
    start();
  });

  /* A session that ends while the dashboard is open must not leave a moderator clicking
     buttons that are all being refused. */
  AUTH.onChange(function (account) {
    if (!account && loaded) global.location.reload();
  });
})(window);
