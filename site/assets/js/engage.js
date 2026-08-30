/* Likes, saves, comments and reports — the four things a signed-in member writes.

   §1: "Browsing is open; all engagement requires sign-in." Everything in this file needs a
   session, and every one of these calls goes to PostgREST with the member's own token, so
   the policies in 0019 and 0020 decide the outcome. Nothing here is a guard; the `if
   (!signed in)` checks are so a member gets the gate instead of a 401.

   ── This replaces store.js, and the difference is the point ──

   The prototype kept memories, comments, likes and profiles in localStorage and let any
   view write to them. README listed that as "client-authoritative unmoderated writes",
   scheduled for M3, against §5: "unapproved content must be UNREADABLE by non-moderators at
   the policy level, not hidden in the client."

   What actually changes: a comment written here lands with status='pending' — stamped by
   the trigger in 0014, not chosen here — and is invisible to everyone but its author and a
   moderator until somebody approves it. The client cannot publish it, cannot read anyone
   else's pending one, and cannot set the status column, because 0015 does not grant it and
   0019's WITH CHECK refuses it. The screen shows "awaiting review" because that is true,
   not to be polite about a write that already happened.

   ── Counts are baked; your own state is live ────────────────

   §2/D20 bakes like_count and comment_count into the shards at publish time, and CLAUDE.md
   §2's 20 Aug amendment says those counters now go live with the next CONTENT change rather
   than within §6's hour floor. So the number on a card is "as of the last release" and can
   be days old on a quiet week.

   What is NOT stale is whether YOU liked it: that is your own row, read through a policy
   that returns only your own rows, and it answers immediately. So the heart fills the
   instant you press it, and the number beside it moves by one locally — an honest
   composition of a published figure and a fact about the current session, rather than a
   pretence that the archive has republished. */

(function (global) {
  'use strict';

  function signedInUserId() {
    var account = global.AUTH.user();
    return account ? account.id : null;
  }

  function EngageError(key) {
    var e = new Error(key);
    e.key = key;
    return e;
  }

  function needSession() {
    return Promise.reject(EngageError('admin.err.signedOut'));
  }

  /* ── Likes ───────────────────────────────────────────────── */

  /**
   * Which of these posts the signed-in member has liked.
   *
   * One request for the whole visible page rather than one per card. `in.(…)` is bounded by
   * the URL length, and a feed page is 24 items (FEED_PAGE_SIZE), so a page never comes
   * close — but the chunking is here rather than assumed, because the profile page passes a
   * contributor's entire published history.
   *
   * Resolves to {} for a signed-out visitor without asking. `likes` is granted to
   * `authenticated` only and anon holds nothing, so the request would 401; a signed-out
   * archive is the ordinary case and must not log an error on every page.
   */
  function likedMap(postIds) {
    var uid = signedInUserId();
    if (!uid || !postIds || !postIds.length) return Promise.resolve({});

    var chunks = [];
    for (var i = 0; i < postIds.length; i += 50) chunks.push(postIds.slice(i, i + 50));

    return Promise.all(chunks.map(function (chunk) {
      var list = chunk.map(encodeURIComponent).join(',');
      // user_id is in the filter as well as in the policy. The policy is what enforces it;
      // this is what stops PostgREST returning every row the policy allows when a future
      // change widens it — the same "ask for the right rows" posture db.js records.
      return global.DB.select('likes',
        'select=post_id&user_id=eq.' + encodeURIComponent(uid) + '&post_id=in.(' + list + ')');
    })).then(function (results) {
      var map = {};
      results.forEach(function (rows) {
        (rows || []).forEach(function (row) { map[row.post_id] = true; });
      });
      return map;
    }, function () {
      // A failed read here must not blank the archive. The card renders unliked, which is
      // wrong in the least harmful direction: pressing it again is refused by the primary
      // key with a 409, which setLike below reads as "already liked".
      return {};
    });
  }

  /**
   * Like or unlike, idempotently.
   *
   * The composite primary key (user_id, post_id) makes a duplicate INSERT a 409, and db.js
   * maps that to `admin.err.conflict`. Treated as success rather than surfaced: a member
   * who double-taps a heart has expressed the same intent twice and should not be told off
   * for it, and the resulting state is the one they asked for.
   */
  function setLike(postId, on) {
    var uid = signedInUserId();
    if (!uid) return needSession();
    if (!on) {
      return global.DB.del('likes',
        'user_id=eq.' + encodeURIComponent(uid) + '&post_id=eq.' + encodeURIComponent(postId));
    }
    return global.DB.insert('likes', { user_id: uid, post_id: postId })
      .catch(function (err) {
        if (err && err.key === 'admin.err.conflict') return null;
        throw err;
      });
  }

  /* ── Saves ───────────────────────────────────────────────── */

  /* Identical mechanics to likes, and deliberately a separate table rather than a column on
     one: §7 makes a save STRICTLY private, including from moderators, because "what someone
     bookmarked is a profile of their interests, and in this archive that is political
     information about them." A like is counted in public; a save is never counted anywhere. */

  function savedMap(postIds) {
    var uid = signedInUserId();
    if (!uid || !postIds || !postIds.length) return Promise.resolve({});
    var chunks = [];
    for (var i = 0; i < postIds.length; i += 50) chunks.push(postIds.slice(i, i + 50));
    return Promise.all(chunks.map(function (chunk) {
      return global.DB.select('saves',
        'select=post_id&user_id=eq.' + encodeURIComponent(uid) +
        '&post_id=in.(' + chunk.map(encodeURIComponent).join(',') + ')');
    })).then(function (results) {
      var map = {};
      results.forEach(function (rows) { (rows || []).forEach(function (r) { map[r.post_id] = true; }); });
      return map;
    }, function () { return {}; });
  }

  function setSave(postId, on) {
    var uid = signedInUserId();
    if (!uid) return needSession();
    if (!on) {
      return global.DB.del('saves',
        'user_id=eq.' + encodeURIComponent(uid) + '&post_id=eq.' + encodeURIComponent(postId));
    }
    return global.DB.insert('saves', { user_id: uid, post_id: postId })
      .catch(function (err) {
        if (err && err.key === 'admin.err.conflict') return null;
        throw err;
      });
  }

  /* ── Comments ────────────────────────────────────────────── */

  /**
   * The member's OWN comments on a post, whatever their status.
   *
   * Published comments come from the item shard — §9 puts them there and §2 requires it, so
   * a signed-out visitor can read the thread with no database at all. This call exists for
   * the one thing a shard structurally cannot carry: the comment you just wrote, which is
   * pending and which nobody else may see.
   *
   * Without it the archive would take a member's comment, tell them nothing, and show them a
   * thread that does not contain it — which reads as the comment having been lost.
   */
  function myComments(postId) {
    var uid = signedInUserId();
    if (!uid) return Promise.resolve([]);
    return global.DB.select('comments',
      'select=id,body,lang,status,created_on&post_id=eq.' + encodeURIComponent(postId) +
      '&created_by=eq.' + encodeURIComponent(uid) + '&order=created_on.asc'
    ).then(function (rows) { return rows || []; }, function () { return []; });
  }

  /**
   * Write a comment. It arrives pending; nothing here can change that.
   *
   * `status` and `created_by` are not sent and could not be honoured if they were: 0015's
   * INSERT grant on comments is (post_id, body, lang) and nothing else, and 0014's trigger
   * stamps the rest. A client that tried would be refused at the privilege layer, before any
   * policy ran.
   *
   * `lang` is the interface language rather than a guess at the text's script. The archive
   * is Arabic-first (§9) and a member writes in whichever language they are reading in; a
   * script detector would file a transliterated Arabic remark as English, and the column is
   * a hint for rendering rather than a fact about the content.
   */
  function comment(postId, body, lang) {
    if (!signedInUserId()) return needSession();
    var text = String(body || '').trim();
    if (!text) return Promise.reject(EngageError('comments.err.empty'));
    // comments_body_length is 1..4000. Checked here as a courtesy so a long remark is
    // refused before it is sent, not as a guard — the constraint is the guard.
    if (text.length > 4000) return Promise.reject(EngageError('comments.err.tooLong'));
    return global.DB.insert('comments', {
      post_id: postId,
      body: text,
      lang: lang === 'en' ? 'en' : 'ar'
    });
  }

  /* ── Reports ─────────────────────────────────────────────── */

  /**
   * Report a post or a comment.
   *
   * §4 gives moderators "review reports"; nothing until now could create one, so the screen
   * that reviews them had no source and the info page's promise — "use the report control on
   * the memory" — was not true.
   *
   * reported_by and status are stamped by 0014's trigger and are not in the INSERT grant, so
   * a report cannot be filed in somebody else's name. 0020's policy additionally makes a
   * report readable only by its reporter and by moderators, because showing a reporter to
   * the person they reported is how retaliation happens.
   */
  function report(targetType, targetId, reason, kind) {
    if (!signedInUserId()) return needSession();
    var text = String(reason || '').trim();
    if (!text) return Promise.reject(EngageError('report.err.empty'));
    if (text.length > 2000) return Promise.reject(EngageError('report.err.tooLong'));
    return global.DB.insert('reports', {
      target_type: targetType,
      target_id: targetId,
      reason: text,
      /* M5's removal request (migration 0053). Defaulted here rather than left undefined
         so the column is always sent explicitly: 'abuse' is also the database default, so
         a caller that omits it files the same row either way, and a caller that MEANT
         'removal' cannot get 'abuse' by forgetting a truthiness check somewhere. */
      kind: kind === 'removal' ? 'removal' : 'abuse'
    });
  }

  /* §7's right to withdraw, for material the asker does not control.
     The author of a post can withdraw it themselves (0018's policy); this is for everyone
     else — most importantly the person IN the photograph. It raises a request; §8's
     takedown, which is a moderator's, is what removes the bytes. */
  function requestRemoval(targetType, targetId, reason) {
    return report(targetType, targetId, reason, 'removal');
  }

  global.ENGAGE = {
    likedMap: likedMap,
    setLike: setLike,
    savedMap: savedMap,
    setSave: setSave,
    myComments: myComments,
    comment: comment,
    report: report,
    requestRemoval: requestRemoval
  };
})(window);
