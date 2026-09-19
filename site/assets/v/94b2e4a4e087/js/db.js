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
     *
     * ── The filter MUST name a select, and this is not style ──
     *
     * `return=representation` makes PostgREST SELECT the rows it just wrote, and with no
     * `select=` it selects `*`. Migration 0015 revoked table-level SELECT on posts and
     * grants it column by column, so `*` is
     *
     *     403 42501  permission denied for table posts
     *
     * every time, for every caller, however correct the update was. The UPDATE itself
     * succeeds and is then rolled back with the request — so this is not a read problem
     * that shows up as a missing field, it is an approval that does not happen.
     *
     * It shipped, and nothing in the repository could see it: pgTAP asserts the same
     * approval in SQL, where there is no representation to select, and every front-end test
     * stubs fetch. The lifecycle harness found it the first time a real moderator token
     * reached a real PostgREST.
     *
     * Thrown rather than defaulted. A default `select=id` would make the next table's call
     * site silently ask for a column it may not be granted, which is this same bug wearing
     * a helpful face.
     */
    patch: function (table, filter, body) {
      if (String(filter).indexOf('select=') === -1) {
        return Promise.reject(DbError(
          'admin.err.generic',
          0,
          'DB.patch needs an explicit select= — see db.js for why representation of * is a 403'
        ));
      }
      return call('/' + table + '?' + filter, {
        method: 'PATCH',
        body: body,
        headers: { Prefer: 'return=representation' }
      });
    },

    /**
     * POST /table.
     *
     * `Prefer: return=minimal`, and unlike PATCH that is safe rather than a compromise.
     * PostgREST answers an RLS-refused INSERT with 403, not with 200 and an empty array, so
     * a caller can tell success from refusal without asking for the row back — which is the
     * only reason PATCH needs a representation at all (see below).
     *
     * Minimal also sidesteps the `*` trap: a representation with no select= is a SELECT of
     * every column, and 0015 grants SELECT column by column on every table a browser can
     * write to. Not asking for the row is the version of that rule with nothing to remember.
     *
     * `select` is still accepted for the caller that genuinely needs the inserted row, and
     * naming columns is then mandatory for the same reason it is on patch().
     */
    insert: function (table, body, opts) {
      opts = opts || {};
      var select = opts.select || null;
      if (select && String(select).indexOf('select=') === -1) {
        return Promise.reject(DbError('admin.err.generic', 0, 'insert(): select must name its columns'));
      }
      /* `resolution=merge-duplicates` turns an INSERT into an upsert on the primary key.
         Opt-in and never the default: for `likes` a duplicate is a member double-tapping a
         heart and the 409 is the correct answer, while for `content_blocks` a key that
         exists in Arabic and not yet in English is the ordinary state of an editor adding a
         block, and two code paths for "insert or update" would get it wrong in opposite
         directions. RLS still decides — an upsert is not a way around a policy. */
      var prefer = [select ? 'return=representation' : 'return=minimal'];
      if (opts.merge) prefer.push('resolution=merge-duplicates');
      return call('/' + table + (select ? '?' + select : ''), {
        method: 'POST',
        body: body,
        headers: { Prefer: prefer.join(',') }
      });
    },

    /**
     * DELETE /table?<filter>.
     *
     * A filter is REQUIRED and an empty one is refused here rather than sent. PostgREST
     * treats a DELETE with no filter as "every row", and while RLS would cut that down to
     * the caller's own rows, "delete all of my likes" is not something any call site means
     * and is one dropped query-string concatenation away from happening.
     *
     * Cannot distinguish "deleted" from "refused": an RLS-refused DELETE removes zero rows
     * and answers 204, exactly like a delete of something that was already gone. Every call
     * site here is idempotent (unlike, unsave), so that ambiguity costs nothing — a caller
     * that needed to know would have to read the row back afterwards.
     */
    del: function (table, filter) {
      if (!filter) {
        return Promise.reject(DbError('admin.err.generic', 0, 'del(): a filter is required'));
      }
      return call('/' + table + '?' + filter, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' }
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
