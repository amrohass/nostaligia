/* The contribution path, from the browser's side.

   Three calls, in this order, and the order is not negotiable:

     1  request-upload    auth + Turnstile + role caps + daily quota → a signed PUT
     2  PUT               straight to R2, bound to the exact type and size declared
     3  complete-upload   "the bytes are up" → begin_ingest → the worker

   ── This file enforces nothing ───────────────────────────────

   §5: the browser is hostile, and that includes this file. Every check here is a
   COURTESY — refusing a 900 MB file before the upload starts saves the member ten minutes,
   it does not protect anything. The real limits live in request-upload (role caps, from
   the JWT) and in the database (quota, ownership, state). If this file were deleted the
   system would be exactly as secure and considerably ruder.

   Which is why the size check below uses the member floor rather than the caller's actual
   cap: this cannot know the caller's role — only the server can, and only the server's
   answer counts. Guessing high would let a member start a 4 GB upload that gate 4 refuses;
   guessing low is a prompt, and the server's refusal is still the one that decides.

   ── Why the PUT is XHR and not fetch ─────────────────────────

   Progress. A contributor on a Ramallah mobile connection uploading a 200 MB video needs
   to see it moving; fetch has no upload-progress event, and `ReadableStream` request
   bodies are not available where this has to run. */

(function (global) {
  'use strict';

  var FUNCTIONS = global.CONFIG.origins.supabase + '/functions/v1';

  var MiB = 1024 * 1024;
  /* §6's member cap. See the header for why the courtesy check uses the floor. */
  var MEMBER_MAX_BYTES = 200 * MiB;
  var MEMBER_MAX_DURATION_S = 3 * 60;

  /* Declared types, mirroring request-upload's allowlist. A mirror can drift, so this is
     kept to a courtesy: the server re-checks, and the WORKER re-derives the real type from
     magic bytes and refuses anything that disagrees. */
  var ALLOWED = {
    'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
    'image/avif': 'image', 'image/tiff': 'image', 'image/heic': 'image', 'image/heif': 'image',
    'video/mp4': 'video', 'video/quicktime': 'video', 'video/webm': 'video',
    'video/x-matroska': 'video',
    'audio/mpeg': 'audio', 'audio/mp4': 'audio', 'audio/aac': 'audio', 'audio/ogg': 'audio',
    'audio/wav': 'audio', 'audio/webm': 'audio', 'audio/flac': 'audio'
  };

  /* Every refusal either endpoint can return, mapped to an i18n key.

     Exhaustive on purpose. An unmapped refusal reaches the member as "something went
     wrong", which for a quota ceiling or an oversized file is actively misleading — they
     would retry the identical upload and get the identical nothing. */
  var REFUSALS = {
    /* request-upload, gate 1 */
    method_not_allowed: 'up.err.generic',
    invalid_json: 'up.err.generic',
    invalid_object_key: 'up.err.generic',
    svg_rejected: 'up.err.svg',
    unsupported_type: 'up.err.type',
    invalid_bytes: 'up.err.generic',
    over_absolute_cap: 'up.err.tooBig',
    duration_required: 'up.err.duration',
    turnstile_required: 'up.err.robot',
    invalid_kind: 'up.err.generic',
    /* gates 2–4 */
    unauthenticated: 'up.err.signedOut',
    turnstile_failed: 'up.err.robot',
    role_lookup_failed: 'up.err.generic',
    over_size_cap: 'up.err.tooBig',
    over_duration_cap: 'up.err.tooLong',
    /* gate 5, the daily quota */
    quota_exceeded: 'up.err.quota',
    title_required: 'up.err.title',
    description_required: 'up.err.description',
    duplicate_object_key: 'up.err.generic',
    quota_check_failed: 'up.err.generic',
    signing_failed: 'up.err.generic',
    /* complete-upload */
    object_key_not_owned: 'up.err.generic',
    unknown_object: 'up.err.generic',
    terminal_state: 'up.err.alreadyDone',
    too_many_attempts: 'up.err.retriesSpent',
    begin_ingest_failed: 'up.err.generic',
    worker_not_configured: 'up.err.processing',
    worker_rejected_job: 'up.err.processing',
    worker_unreachable: 'up.err.processing'
  };

  function UploadError(key, detail) {
    var e = new Error(key);
    e.key = key;
    e.detail = detail || null;
    return e;
  }

  function refusalKey(body) {
    var name = body && body.error;
    return (name && REFUSALS[name]) || 'up.err.generic';
  }

  /* Reads a duration without decoding the file.

     §6's duration cap is enforced server-side from a DECLARED value, so something has to
     declare it. The browser can, cheaply, by pointing a media element at a blob URL and
     reading the metadata — no upload, no decode of the body.

     Resolves to null rather than rejecting when the browser cannot tell. A file whose
     duration is unreadable here is not refused: request-upload will ask for one, and the
     member gets a clear message instead of a silent failure. */
  function probeDuration(file, family) {
    if (family === 'image') return Promise.resolve(null);
    return new Promise(function (resolve) {
      var url = global.URL.createObjectURL(file);
      var media = global.document.createElement(family === 'audio' ? 'audio' : 'video');
      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        global.URL.revokeObjectURL(url);
        resolve(value);
      }
      media.preload = 'metadata';
      media.onloadedmetadata = function () {
        finish(isFinite(media.duration) && media.duration > 0 ? media.duration : null);
      };
      media.onerror = function () { finish(null); };
      /* A container the browser cannot open would otherwise leave this pending forever,
         and the submit button with it. */
      global.setTimeout(function () { finish(null); }, 5000);
      media.src = url;
    });
  }

  function post(path, token, payload) {
    return global.fetch(FUNCTIONS + '/' + path, {
      method: 'POST',
      headers: {
        apikey: global.CONFIG.supabase.anonKey,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw UploadError(refusalKey(body), body.detail);
        return body;
      });
    }, function () {
      throw UploadError('up.err.offline');
    });
  }

  /* The PUT. The signed URL binds content-type AND content-length, so the headers the
     Edge Function returned must be sent exactly — anything else is a 403 from R2 that
     reads like a credentials problem and is not (see _shared/sigv4.ts). */
  function put(signed, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new global.XMLHttpRequest();
      xhr.open(signed.method || 'PUT', signed.url, true);
      Object.keys(signed.headers || {}).forEach(function (name) {
        /* Content-Length is a forbidden header: the browser sets it from the body and
           refuses to let script override it. Sending it is a no-op at best and a console
           error at worst — and the value is already correct, which is exactly the property
           the signature relies on. */
        if (name.toLowerCase() === 'content-length') return;
        xhr.setRequestHeader(name, signed.headers[name]);
      });
      if (onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(UploadError('up.err.transfer', { status: xhr.status }));
      };
      xhr.onerror = function () { reject(UploadError('up.err.offline')); };
      xhr.onabort = function () { reject(UploadError('up.err.cancelled')); };
      xhr.send(file);
    });
  }

  /**
   * The whole contribution, start to finish.
   *
   * @param {File}   file
   * @param {object} draft   { kind, title_ar, title_en, body_ar, body_en, license, provenance, consent }
   * @param {string} turnstileToken
   * @param {object} hooks   { onProgress(fraction), onStage(name) }
   */
  function submit(file, draft, turnstileToken, hooks) {
    hooks = hooks || {};
    var stage = hooks.onStage || function () {};

    var mime = (file.type || '').toLowerCase();
    /* §6 names SVG specifically, so it gets its own message rather than falling through
       the allowlist as an anonymous unsupported type. */
    if (mime.indexOf('image/svg') === 0) return Promise.reject(UploadError('up.err.svg'));

    var family = ALLOWED[mime];
    if (!family) return Promise.reject(UploadError('up.err.type'));
    if (!file.size) return Promise.reject(UploadError('up.err.empty'));
    if (file.size > MEMBER_MAX_BYTES) {
      return Promise.reject(UploadError('up.err.tooBig', { max_bytes: MEMBER_MAX_BYTES }));
    }
    if (!turnstileToken) return Promise.reject(UploadError('up.err.robot'));

    var objectKey = null;
    var postId = null;

    stage('probing');
    return probeDuration(file, family).then(function (durationS) {
      if (durationS !== null && durationS > MEMBER_MAX_DURATION_S) {
        throw UploadError('up.err.tooLong', { max_duration_s: MEMBER_MAX_DURATION_S });
      }
      stage('requesting');
      return global.AUTH.accessToken().then(function (token) {
        return post('request-upload', token, {
          mime: mime,
          bytes: file.size,
          duration_s: durationS,
          kind: draft.kind,
          turnstile_token: turnstileToken,
          draft: draft
        }).then(function (granted) {
          objectKey = granted.object_key;
          postId = granted.post_id;
          stage('uploading');
          return put(granted.upload, file, hooks.onProgress);
        }).then(function () {
          stage('finishing');
          /* A fresh token: a 200 MB upload on a slow connection can outlive the one the
             request started with, and complete-upload's first act is an authenticated RPC. */
          return global.AUTH.accessToken();
        }).then(function (fresh) {
          return post('complete-upload', fresh, { object_key: objectKey });
        }).then(function (done) {
          stage('done');
          return { postId: done.post_id || postId, objectKey: objectKey, status: done.status };
        });
      });
    });
  }

  global.UPLOAD = {
    submit: submit,
    /* Exposed so the tests can assert the refusal map is exhaustive against the set of
       error names the two functions can actually emit, rather than against a copy. */
    _refusals: REFUSALS,
    _allowed: ALLOWED,
    _limits: { maxBytes: MEMBER_MAX_BYTES, maxDurationS: MEMBER_MAX_DURATION_S }
  };
})(window);
