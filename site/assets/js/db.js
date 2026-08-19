/* PostgREST, from the browser, as whoever is signed in.

   ── Why the browser talks to the database directly ───────────

   It looks like a shortcut and it is the opposite. §5 puts authorization in "RLS policies
   and Edge Functions. Nowhere else." An Edge Function in front of the moderation queue
   would be a second place for authorization to live and a second place for it to drift —
   and it would authorize using the same token PostgREST is about to verify anyway.

   So the moderator's own JWT goes to PostgREST, PostgREST verifies the signature itself and
   derives auth.uid(), and the policies from migration 0018 decide what comes back. A member
   calling exactly these functions gets an empty queue and a refused UPDATE, from the
   database, without a line of client code being involved in that outcome.

   ── This module cannot enforce anything ──────────────────────

   Nothing here is a guard, including the `select` filters. `status=eq.pending` is a
   REQUEST; if the policies were wrong it would happily return whatever the database chose
   to hand over. The filters are here to ask for the right rows, not to keep the wrong ones
   away — that distinction is the whole of §5. */

(function (global) {
  'use strict';

  var REST = global.CONFIG.origins.supabase + '/rest/v1';

  function headers(token, extra) {
    var h = {
      apikey: global.CONFIG.supabase.anonKey,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    };
    Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }

  function DbError(key, status, detail) {
    var e = new Error(key);
    e.key = key;
    e.status = status || 0;
    e.detail = detail || null;
    return e;
  }

  /* PostgREST returns 401/403 for "not you", and RLS returns an EMPTY RESULT rather than an
     error for "not yours" — those are different failures and the second one is the common
     one. A caller that treats an empty list as an error will tell a moderator with a clear
     queue that something is broken. */
  function handle(res) {
    return res.text().then(function (text) {
      var body = null;
      if (text) { try { body = JSON.parse(text); } catch (e) { body = null; } }
      if (res.ok) return body;
      if (res.status === 401 || res.status === 403) throw DbError('admin.err.denied', res.status, body);
      if (res.status === 409) throw DbError('admin.err.conflict', res.status, body);
      throw DbError('admin.err.generic', res.status, body);
    });
  }

  function call(path, options) {
    return global.AUTH.accessToken().then(function (token) {
      return global.fetch(REST + path, {
        method: options.method || 'GET',
        headers: headers(token, options.headers),
        body: options.body ? JSON.stringify(options.body) : undefined
      });
    }, function () {
      /* No usable token: the session expired or was never there. Named, so the caller can
         send the moderator back to sign-in instead of showing a database error. */
      throw DbError('admin.err.signedOut', 401);
    }).then(handle, function (e) {
      if (e && e.key) throw e;
      throw DbError('admin.err.offline', 0);
    });
  }

  global.DB = {
    /** GET /table?<query>. `query` is a PostgREST query string, already encoded. */
    select: function (table, query) {
      return call('/' + table + (query ? '?' + query : ''), { method: 'GET' });
    },

    /**
     * PATCH /table?<filter>, returning the updated rows.
     *
     * `Prefer: return=representation` is not a nicety: without it PostgREST answers 204
     * with no body, and a moderator's screen cannot tell an update that matched one row
     * from one that matched none — which is exactly what an RLS refusal looks like.
     */
    patch: function (table, filter, body) {
      return call('/' + table + '?' + filter, {
        method: 'PATCH',
        body: body,
        headers: { Prefer: 'return=representation' }
      });
    },

    rpc: function (name, args) {
      return call('/rpc/' + name, { method: 'POST', body: args || {} });
    },

    /**
     * The CDN URL for a media_assets row — or null, if the row is not one that may have one.
     *
     * §6: "NEVER serve a row with bucket='originals' through the public CDN path." That rule
     * is enforced where it has to be — `originals/` is not CDN-fronted at all, the worker's
     * assertManifest refuses a manifest that puts the wrong role in the wrong bucket, and
     * 0023's policies decide who may read the row in the first place. This is none of those.
     *
     * It exists because the rule was previously held by CONVENTION on the client: the URL
     * builder concatenated `cdn + storage_path` for whatever it was handed, and the only
     * reason no originals path ever went through it was that the callers happened to pass
     * renditions. The master is sitting in the same function, three lines away, and §6
     * itself anticipates wanting a link to it — "the master is available as an explicit
     * download of the original, sign-in gated and rate-limited". The day somebody builds
     * that, the obvious thing to reach for is this function, and the obvious thing is wrong:
     * a signed, rate-limited download is a different mechanism, not this one with a
     * different argument.
     *
     * So: null for anything that is not in `public`. A null renders as a missing image,
     * which is a visible bug rather than a leaked archival path.
     */
    mediaUrl: function (asset) {
      if (!asset || asset.bucket !== 'public') return null;
      if (typeof asset.storage_path !== 'string' || !asset.storage_path) return null;
      return global.CONFIG.origins.cdn + '/' + asset.storage_path;
    }
  };
})(window);
