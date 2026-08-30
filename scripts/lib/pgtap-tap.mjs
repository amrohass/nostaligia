/* Rewrite a pgTAP test file so its entire TAP stream comes back as ONE result set.
 *
 * WHY. `supabase db query --linked` reaches the deployed database through the Management
 * API, and the API returns only the LAST statement's rows. pgTAP emits one row per
 * assertion, from one statement per assertion, so every line but the last is discarded —
 * and pgTAP 1.3 keeps no per-assertion table to read back afterwards (it tracks only
 * plan / curr_test / failed counters in __tcache__). Counters are enough to say a file is
 * red. They cannot say WHICH assertion failed, which is the only thing worth knowing once
 * it is. So every top-level SELECT is rewritten to append its own output to a temp table,
 * and the temp table is read at the end.
 *
 * This is a source transformation and it is the fragile half of the runner, which is why
 * it is opt-in (`--tap`) and the counting path stays the default.
 */

/* A Postgres-aware statement splitter.
 *
 * A naive split on ';' corrupts roughly half of this suite: throws_ok/lives_ok take their
 * payload as a dollar-quoted string, and those payloads are full of semicolons. Handled
 * here: single-quoted strings with doubled-quote escapes, double-quoted identifiers,
 * dollar-quoted bodies with or without a tag, line comments, and block comments (which
 * nest in Postgres, unlike C). */
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const j = sql.indexOf('\n', i);
      const k = j === -1 ? sql.length : j;
      buf += sql.slice(i, k);
      i = k;
      continue;
    }

    if (two === '/*') {
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql.slice(j, j + 2) === '/*') { depth++; j += 2; }
        else if (sql.slice(j, j + 2) === '*/') { depth--; j += 2; if (depth === 0) break; }
        else j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;   // '' / "" is an escaped quote, not the end
          else { j++; break; }
        } else j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }

    if (c === '$') {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const j = sql.indexOf(tag, i + tag.length);
        const k = j === -1 ? sql.length : j + tag.length;
        buf += sql.slice(i, k);
        i = k;
        continue;
      }
    }

    if (c === ';') {
      out.push(buf + ';');
      buf = '';
      i++;
      continue;
    }

    buf += c;
    i++;
  }

  if (buf.trim()) out.push(buf);
  return out;
}

/* Strip leading whitespace and comments so the statement's first real keyword is visible. */
function firstKeyword(stmt) {
  let s = stmt;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--')) {
      const j = s.indexOf('\n');
      s = j === -1 ? '' : s.slice(j + 1);
    } else if (s.startsWith('/*')) {
      let depth = 0;
      let j = 0;
      while (j < s.length) {
        if (s.slice(j, j + 2) === '/*') { depth++; j += 2; }
        else if (s.slice(j, j + 2) === '*/') { depth--; j += 2; if (depth === 0) break; }
        else j++;
      }
      s = s.slice(j);
    }
    if (s === before) break;
  }
  return s;
}

/* The rewrite.
 *
 * `insert into _tap(line) select t.v::text from (<stmt>) t(v)` accepts any SINGLE-column
 * result of any type, which covers every pgTAP assertion (text), plan() (text) and
 * `select * from finish()` (setof text) alike. A top-level SELECT returning more than one
 * column would fail loudly here rather than being silently skipped — there is none in this
 * suite, and a new one should be noticed rather than absorbed.
 *
 * `reset role` before the read-back: a file that ends inside `set local role authenticated`
 * would otherwise read the temp table as a role that cannot see it. */
export function toTapCapture(sql) {
  const stmts = splitStatements(sql);

  const body = stmts.map((s) => {
    const bare = firstKeyword(s);
    if (!/^(select|with)\s/i.test(bare)) return s;
    const lead = s.slice(0, s.length - bare.length);
    const inner = bare.replace(/;\s*$/, '');
    return lead + 'insert into _tap(line) select t.v::text from (' + inner + ') t(v);';
  });

  // The temp table goes in right after `create extension pgtap`, before the first plan().
  //
  // The grants are load-bearing: every RLS test asserts from inside `set local role
  // authenticated` (or anon), and those roles cannot write to a temp table owned by
  // postgres — without them the rewrite dies on the first assertion with "permission
  // denied for table _tap", which looks exactly like a failing test. The table lives
  // inside the file's own rolled-back transaction, so granting to public costs nothing
  // beyond it.
  const ext = body.findIndex((s) => /create\s+extension/i.test(s));
  body.splice(ext === -1 ? 1 : ext + 1, 0,
    '\ncreate temp table _tap(seq serial primary key, line text);\n' +
    'grant insert on _tap to public;\n' +
    'grant usage, select on sequence _tap_seq_seq to public;\n');

  // …and the read-back immediately before the file's trailing `rollback;`.
  const rb = body.map((s) => /^\s*rollback\s*;/i.test(firstKeyword(s))).lastIndexOf(true);
  body.splice(rb === -1 ? body.length : rb, 0,
    '\nreset role;\nselect seq, line from _tap order by seq;\n');

  return body.join('');
}
