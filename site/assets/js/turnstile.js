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
  /* How long a rendered widget may go on saying nothing before `token()` gives up.
     Generous on purpose: an interactive challenge is not a refusal and a member on a slow
     connection must not be cut off mid-puzzle. It is a ceiling on silence, not a budget. */
  var TOKEN_DEADLINE_MS = 30000;

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

    /* The counterpart to settle(), and it did not exist until 31 Aug 2026.
       `waiters` was drained ONLY by settle(), so every path where the challenge does not
       produce a token left every caller pending forever: 'error-callback' cleared `current`
       and returned, remove() discarded the array, and a widget that simply never called
       back — measured for 45s against the live origin with a real browser, no callback of
       any kind — was not handled at all. Upstream that is `await token()` never returning,
       so the sign-in and upload dialogs sit on their working state with no message, no
       error and nothing to retry. A refusal a member can see beats a spinner that is right
       about nothing. */
    function abandon() {
      current = null;
      var pending = waiters;
      waiters = [];
      pending.forEach(function (w) { w.reject(new Error('up.err.robotUnavailable')); });
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
        /* An expiry is not a failure: the token is stale, the widget refreshes itself, and
           anyone who asks again waits for the new one. Nothing to reject. */
        'expired-callback': function () { current = null; },
        /* These two ARE failures, and both used to be swallowed. `unavailable` is
           deliberately NOT set: Turnstile retries on its own and reset() re-arms the
           widget, so the next attempt should be allowed to try rather than refused from
           memory. Only a script that never arrived is treated as permanent. */
        'error-callback': abandon,
        'timeout-callback': abandon
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
          return new Promise(function (resolve, reject) {
            /* The deadline is the backstop behind the two callbacks above. Turnstile is
               not obliged to call either one — against an automated browser it renders the
               widget, opens no challenge frame, and says nothing at all — and a caller
               cannot tell that apart from a member reading the puzzle. Both callbacks and
               this timer go through the same rejection, so upstream has one failure to
               handle rather than three. */
            var timer = global.setTimeout(function () {
              var i = waiters.indexOf(w);
              if (i !== -1) waiters.splice(i, 1);
              reject(new Error('up.err.robotUnavailable'));
            }, TOKEN_DEADLINE_MS);

            var w = {
              resolve: function (t) { global.clearTimeout(timer); resolve(t); },
              reject: function (e) { global.clearTimeout(timer); reject(e); }
            };
            waiters.push(w);
          });
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
        /* Rejects outstanding waiters rather than dropping the array. A dialog closed
           while the challenge is still running used to leave its caller pending on a
           widget that no longer exists. */
        abandon();
      },

      isUnavailable: function () { return unavailable; }
    };
  }

  global.TURNSTILE = { mount: mount, whenReady: whenReady };
})(window);
