/* The Turnstile widget, wrapped so no view has to know it exists.

   §6 requires Turnstile on signup and submit. Both places need the same three things —
   render a widget into a container, wait for a token, reset it afterwards — and none of
   them are things an auth dialog should be reasoning about.

   ── A token is single-use ────────────────────────────────────

   The most consequential fact about this widget, and the one every caller gets wrong once:
   a token is spent by the first server that verifies it, and it expires on its own after a
   few minutes. So a failed submit must RESET the widget before the member can retry, or
   the second attempt sends a token the server has already seen and the member is told they
   are a robot for pressing the button twice.

   That is why `reset` is part of the returned handle and not an internal detail.

   ── Failing open is not an option, and neither is failing shut ──

   If the script is blocked — an ad blocker, a captive portal, a bad day at Cloudflare —
   there is no token and the server will refuse the submit. The widget reports that state
   through `unavailable` so the dialog can say something true, rather than showing an
   enabled button that produces `turnstile_required` from an endpoint the member cannot
   see. The server still decides; this only decides what the member is told. */

(function (global) {
  'use strict';

  var SITE_KEY = global.CONFIG.turnstile.siteKey;

  function api() {
    return global.turnstile || null;
  }

  /* The script is `async defer`, so it may not have arrived when a dialog opens. Poll
     briefly rather than blocking the dialog on it — a member opening the sign-in form
     should see the form immediately, with the widget filling in beside it. */
  function whenReady(timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 6000);
    return new Promise(function (resolve) {
      (function poll() {
        if (api()) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        global.setTimeout(poll, 100);
      })();
    });
  }

  /**
   * Renders a widget into `container` and returns a handle.
   *
   * The handle's `token()` resolves when the member has passed the challenge — usually
   * immediately and invisibly, occasionally after an interaction. It rejects only when the
   * widget itself is unavailable, never because the member "failed": Turnstile retries on
   * its own, and a challenge in progress is not a refusal.
   */
  function mount(container) {
    var current = null;
    var waiters = [];
    var widgetId = null;
    var unavailable = false;

    function settle(token) {
      current = token;
      var pending = waiters;
      waiters = [];
      pending.forEach(function (w) { w.resolve(token); });
    }

    var ready = whenReady().then(function (ok) {
      if (!ok) {
        unavailable = true;
        var pending = waiters;
        waiters = [];
        pending.forEach(function (w) { w.reject(new Error('up.err.robotUnavailable')); });
        return false;
      }
      widgetId = api().render(container, {
        sitekey: SITE_KEY,
        /* The dialogs are small and the archive is Arabic-first; `auto` follows the
           document language, which I18N already sets on <html>. */
        language: 'auto',
        callback: settle,
        'expired-callback': function () { current = null; },
        'error-callback': function () { current = null; }
      });
      return true;
    });

    return {
      /* Resolves with a token, waiting for the challenge if it is still running. */
      token: function () {
        if (current) return Promise.resolve(current);
        if (unavailable) return Promise.reject(new Error('up.err.robotUnavailable'));
        return ready.then(function (ok) {
          if (!ok) throw new Error('up.err.robotUnavailable');
          if (current) return current;
          return new Promise(function (resolve, reject) { waiters.push({ resolve: resolve, reject: reject }); });
        });
      },

      /* MUST be called after any failed submit. See the header. */
      reset: function () {
        current = null;
        if (widgetId !== null && api()) {
          try { api().reset(widgetId); } catch (e) { /* already gone */ }
        }
      },

      remove: function () {
        if (widgetId !== null && api()) {
          try { api().remove(widgetId); } catch (e) { /* already gone */ }
        }
        widgetId = null;
        current = null;
        waiters = [];
      },

      isUnavailable: function () { return unavailable; }
    };
  }

  global.TURNSTILE = { mount: mount, whenReady: whenReady };
})(window);
