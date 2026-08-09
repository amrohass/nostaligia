# ذاكرة رام الله · Ramallah Memory Atlas

An implementation of the `Ramallah Memory Atlas.dc.html` design doc — a bilingual
community archive of Ramallah's memory, plus the back office that runs it.

Static site, no build step. Open `index.html` in a browser, or serve the folder:

```sh
npx serve .          # or: python -m http.server 8000
```

Leaflet and the two webfonts load from CDNs, so the map and typography need a
network connection; everything else works offline.

## Layout

```
index.html            public site  — hash routes #/archive · #/map · #/events · #/m/<id>
admin.html            back office  — hash routes #/overview #/queue #/archive #/events
                                                 #/places #/members #/reports #/settings
assets/css/tokens.css palette, type, radii, shadows — values lifted from the design doc
assets/css/atlas.css  public components
assets/css/admin.css  back-office components
assets/js/i18n.js     AR/EN strings, numerals, direction
assets/js/data.js     seed content (memories, events, places, members, queue, reports)
assets/js/ui.js       DOM helpers, icon set, toast, focus trap
assets/js/public.js   public app
assets/js/admin.js    back-office app
```

Two shells rather than 23 pages: the design's screens are the same chrome with
different content, so each shell renders its sections from one rail/masthead and
one set of components.

## Bilingual

Arabic and English are **one screen set, not two builds**. The language sets
`<html lang/dir>`, every string comes from `i18n.js`, and layout uses CSS logical
properties (`inset-inline-start`, `border-inline-end`, …) so the LTR mirror falls
out of the same rules. Arabic is the default.

- Toggle with the `EN` / `ع` button in the header, or link directly with
  `?lang=en` — the choice persists in `localStorage`.
- Arabic renders Arabic-Indic numerals with the `٬` thousands separator.
  `I18N.year()` exists because years are labels, not quantities, and must never
  be grouped (`٢٠٢٤`, not `٢٬٠٢٤`).
- Every title carries a gloss in the other language. The gloss runs in its own
  direction but stays flush with the page's reading edge — that's the
  `.gloss-line` class.

## What's wired

Public

- **Archive** — masonry across 4 / 3 / 2 columns by width; cards link to a memory.
- **Immersive viewer** — `#/m/<id>`, so every memory has a shareable URL. Scroll
  snaps memory-to-memory (arrow keys too) and the address bar follows.
- **Sign-in gate** — every locked control carries the gold padlock and raises the
  gate. Signing in clears the padlocks in place, without losing your position.
- **Map** — real OpenStreetMap tiles tinted to the palette via a CSS filter on the
  tile pane. Memories cluster by place with a count; the decade rail live-filters
  the pins; a pin expands the memory over the dimmed map.
- **Events**, **auth dialogs**, **share sheet** — as drawn, with the 48-hour
  review promise stated where a contributor submits.

Back office

- **Review queue** — decisions actually drain the queue and the rail badge follows.
- **Overview, published archive, events approval, gazetteer, members, reports,
  settings** — filters, role changes, suspension, report closure, place-pin
  dragging and the settings toggles all hold state for the session.

State lives in memory (plus `sessionStorage` for signed-in, `localStorage` for
language). There is no backend: reloading resets the working set.

## Notes on the design doc

- **No photographs.** Every media well uses the doc's own hatched-gradient
  placeholder with a monospace caption. That is the honest reading — the archive
  has no digitised material yet — rather than dressing the build in stock imagery.
- **Mobile masthead is terracotta**, per screen 2c. The doc sets the wordmark on
  it to olive (`#3E4A2E`), which lands at roughly 1.6:1 against the terracotta;
  it is set in cream here instead. That is the one place the implementation
  knowingly departs from the drawing.
- **Numerals.** The doc mixes Arabic-Indic and Latin digits in Arabic screens
  (e.g. `٤١٢ ذكرى` beside a coverage meter reading `61`). This build settles on
  Arabic-Indic throughout, except where the token is inherently Latin-script:
  the `9h` SLA chip, month abbreviations on the intake chart, coordinates, and
  email addresses.
- **Viewer comments rail** is the dark olive `#2E3226` in both languages. The doc
  has it dark in the Arabic viewer (2a) and terracotta in the English one (2d);
  the dark rail is the one in the live/interactive screen and it avoids a second
  large terracotta field competing with the CTAs.
- Turn 1 of the doc (the Ledger / Wall / Editorial explorations) was superseded by
  turn 2, which is marked FINAL, so only turn 2 is built.

## Verification

Checked in headless Chromium: all 13 route × language combinations render with no
console errors; 50 interaction assertions cover the viewer, gate, sign-in, share
sheet, decade filter, map cards, language switch, queue/report decisions, role
changes and settings toggles; and no page scrolls horizontally at 390 px in
either direction.
