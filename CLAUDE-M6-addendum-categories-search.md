# M6 Addendum — Category Tabs, Live Search, Description Display

Supplements CLAUDE.md §2, §3, §9, §10. Does not reopen M3 (closed, audited
2026-08-29). Lands as new M6 scope. No schema migration, no RLS change, no new
secret. If anything below conflicts with CLAUDE.md, CLAUDE.md wins — flag it,
don't resolve it silently.

---

## 1. Scope

Three additions to the media grid, all read-path / front-end:

1. **Category tabs** — All / Images / Videos / Voice, filtering the existing
   grid. Default: All.
2. **Live title search** — search-as-you-type across `title_ar` + `title_en`,
   filtered within the active tab.
3. **Description display** — `body_ar`/`body_en` rendered on the item view if
   not already.

---

## 2. Read path — §2 amendment

New shard axis, same shape and cache rules as the existing `feed/page-N.json`
(immutable, `max-age=31536000`, rebuilt incrementally per M2's publish logic):

```
category/image/page-N.json
category/video/page-N.json
category/voice/page-N.json
```

New standalone file, versioned under `/v/{ISO-ts}/`, referenced from
`manifest.json`:

```
search-index.json   → [{ id, title_ar, title_en, category, decade }, ...]
```

Not paginated at current/projected item counts (§9 budget note below). Both
additions preserve **zero database reads for public visitors** — generated
entirely at publish time from the same approved rows the feed shards already
draw from, and filtered through `redactions.json` the same way.

---

## 3. Category derivation — §3 note

**No new `kind` value, no migration.** Category is derived at publish time,
not stored:

| `posts.kind` | Category |
|---|---|
| `voice` | `voice` |
| `media`, master asset mime `image/*` | `image` |
| `media`, master asset mime `video/*` | `video` |
| `event` | excluded — events are a separate surface (§1), not part of this grid |

---

## 4. Front end — §9 addition

- **Tabs:** above the grid, CSS logical properties only, order reads naturally
  in both LTR/RTL (same pattern as the decade slider's RTL requirement).
  Selecting a tab swaps the grid's data source to the matching
  `category/*` shard; no fork of the grid component. Active tab reflected in
  the URL via the existing History API router.
- **Search:** live, debounced ~150–200ms. `search-index.json` lazy-loads on
  first interaction with the search box — **must not** count against the
  <150 KB first-paint budget (currently 84.6 KiB measured, per
  `docs/closeout-audit-2026-08-29.md`). Case-insensitive substring match
  against both title fields regardless of UI language. Results pass through
  `redactions.json` before render. Rendered via `textContent`/DOMPurify inside
  `<bdi>` — no `innerHTML` on any title or query-derived string (D15).
- **Description:** `body_ar`/`body_en` already exist on `posts` — render on
  `/item/{id}` (prerendered and hydrated views) if not already, same
  sanitization rule as above.

---

## 5. Milestone table — §10 addition

| M | Contents | Exit criteria |
|---|---|---|
| M6 (add) | Category shards (image/video/voice); `search-index.json`; tabs + live search UI; description render on item view | Tabs and search correct in ar + en; search-index lazy-loaded, not in first-paint budget; budget test still passes; CI green |

---

## 6. Open decision — flag, don't assume silently

**Search scope:** this addendum assumes search filters **within the active
tab** (default All = search everything). Cross-tab search (ignore the active
tab while searching) was not requested and is not built. If that's wrong,
say so before Claude Code wires the filter logic.

- **Settled as written, 9 Sep 2026 — within-tab, and cross-tab is NOT the better
  default.** Recorded here rather than assumed, per this section's own instruction.
  Three reasons, in the order they matter:
  **(a)** the tab is a visible, deliberate filter the reader set. A search that ignored it
  would leave "Videos" highlighted above a list of photographs — the control saying one
  thing and the results another, which is the same defect as a decade slider that stops
  applying once you type;
  **(b)** the case cross-tab exists to serve is already the default. All is the tab a
  visitor lands on and never leaves unless they choose to, so a search from All searches
  the whole archive. The only person cross-tab would help is the one who deliberately
  narrowed, and that is exactly whose choice it would be overriding;
  **(c)** the one real weakness — a match that exists but is in another tab — is answered
  without changing the scope. Each tab shows its own share of the current matches beside
  its label, so the reader on Videos sees "Images ٣" and is one click from it. That is a
  pass over an array already in memory, and it makes the narrow scope legible instead of
  mysterious. `frontend-nav-test.mjs` asserts both halves: the Images match does not
  appear under Videos, and the Images tab still reports that it holds one.

---

## 7. Resolved against CLAUDE.md — flagged, not silently resolved

§0 of this addendum: "If anything below conflicts with CLAUDE.md, CLAUDE.md wins — flag
it, don't resolve it silently." One conflict arose. It is recorded here and in a comment
at the code that implements it.

**`manifest.json` versus `index.json` for the new per-release counts.** §2 of this
addendum asks for `search-index.json` to be "referenced from manifest.json", and the build
request asked for the category page counts to go "in manifest.json alongside the existing
feed count".

**There is no feed count in `manifest.json`.** It carries exactly two fields — `release`
and `generated_on` — and has since M2. The feed's page count has lived in `index.json`
since M3, which CLAUDE.md §2's 21 Aug amendment introduced for precisely this purpose:
"which decades and geo cells this release actually has, so the front end carries no
hardcoded list of either."

So `categories` and `search` are in **`index.json`**, beside the feed's `pages` they
belong with. Putting them in the pointer would create a second per-release description
that can disagree with the first, which is the failure `index.json` was added to remove —
and CLAUDE.md wins. Nothing is lost: `search-index.json` still resolves relative to the
release the manifest names, and `index.json` naming it is what tells the front end that
this release has one at all (a release built before this addendum has no `search` key, and
the box must not be offered on one).

**Not a conflict, but worth recording beside it:** CLAUDE.md §2's 19 Aug amendment counts
what a release writes — "~325 objects at 300 items becomes ~660" — and this addendum moves
that number again.

**Measured 9 Sep 2026, not estimated** (`deno run -A scripts/load-test-300.ts`, 300 synthetic
rows at the deployed archive's real kind distribution): the new shards add **14 objects** —
one `search-index.json`, and 13 category pages (one per 24 items per tab, with a floor of one
page for a tab that is empty). A release at 300 items now writes **~684 objects**: 341 from
`buildShards()`, 40 profile shards, `content.json` / `places.json` / `redactions.json`, and
300 prerendered item pages.

The gap between that and §2's "~660" is **not** all this addendum's. The 19 Aug figure
counted the shards and the item pages and omitted the per-contributor profile shards and the
three standalone files — 43 of them at 40 contributors. So of the +24, fourteen are new and
ten were always there and uncounted. `scripts/load-test-300.ts` now counts `releaseFiles()`
rather than `buildShards()`, so the number it prints is the one the threshold is about.

The amendment's three thresholds for reinstating the incremental diff (1,500 items, 100
releases/day, 5 GB under `/v/`) are unchanged; this arrives at them very slightly sooner.

**One figure to re-read later, recorded here rather than discovered later.** §2 of this
addendum says `search-index.json` is "not paginated at current/projected item counts". At 300
items that is comfortable — 17.4 KiB at the live archive's real compression ratio, fetched
once, on the first keystroke and never at first paint. At the 1,500 items §2 itself names it
is **87.9 KiB**. Still one lazy fetch and still outside §9's budget, but no longer trivial on
a phone over 3G. It is not a problem to fix now, and it arrives at the same time as §2's
incremental-diff threshold rather than separately.
