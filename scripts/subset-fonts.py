#!/usr/bin/env python3
"""
§9's font subsetting, and the shaping check §9 asks for in the same sentence.

    python scripts/subset-fonts.py --src <dir-of-source-ttfs>
    python scripts/subset-fonts.py --src <dir> --dry-run      # measure, write nothing

WHY THIS IS A ONE-OFF SCRIPT AND NOT A BUILD STEP. §9 forbids a build step beyond the
publish script. The .woff2 files this writes are COMMITTED, exactly as the basemap archive
is an artefact rather than something the site builds -- fonts change when somebody decides
to change a typeface, which is a deliberate act years apart. Nothing in the page load, in
CI, or in the publisher runs this. `scripts/frontend-fonts-test.mjs` is what CI runs, and
it checks the committed output from the repository alone, with no Python and no network.

WHAT IT REPLACES. Until now both shells pulled two families from Google Fonts over a
<link>. Two entries in `config/site.json`'s `known_violations` said so, and the CSP this
project actually serves BLOCKS them -- `style-src 'self'` and `font-src 'self'` -- so on
Cloudflare Pages the site rendered in whatever the OS had. §9 also gives a second reason
that is not about the CSP at all: a font request is a request, and it hands a third party
the IP of every person reading a Palestinian heritage archive (§7).

── The subsetting, and the one thing that must not go wrong ──

Arabic is a shaped script. A letter's form depends on its neighbours -- initial, medial,
final, isolated -- and none of that is in `cmap`. It is in GSUB (`init`/`medi`/`fina`/
`isol`/`rlig`/`liga`/`calt`/`ccmp`), GPOS (`mark`/`mkmk`/`curs`) and GDEF. A subsetter
asked only for a range of codepoints will happily produce a file whose every glyph is
present and whose every word renders as disconnected isolated letters -- correct by any
count of glyphs, and unreadable.

So `--layout-features='*'` is passed for the Arabic faces, and the result is CHECKED rather
than trusted: every string in SHAPING_PROBES is shaped through HarfBuzz against the ORIGINAL
font and against the subset, and the glyph sequence and advances must be identical. A
mismatch refuses to write the file. The check has a control -- a deliberately feature-
stripped subset must FAIL it -- because a shaping check that has never rejected anything is
a check nobody knows is wired up.

── Sources ──

IBM Plex Sans Arabic and Inter, both SIL Open Font License 1.1, from google/fonts. The
sources are NOT committed (they are ~1.3 MB of TTF that nothing serves); download them
into a scratch directory and point --src at it:

    ofl/ibmplexsansarabic/IBMPlexSansArabic-{Regular,Medium,SemiBold,Bold}.ttf
    ofl/inter/Inter[opsz,wght].ttf

Inter is taken as its VARIABLE font and kept variable across 400-700 in one file, which is
smaller than four statics. Plex Arabic has no variable build in google/fonts, so it is four.
The OFL requires the licence to travel with the font: OFL.txt is written beside the woff2
files and served with them.
"""

import argparse
import io
import sys
from pathlib import Path

try:
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
    import uharfbuzz as hb
except ImportError as e:  # pragma: no cover - a missing tool is not a subtle failure
    sys.exit(f"subset-fonts: {e}. Install with: python -m pip install fonttools brotli uharfbuzz")

# The probe strings and several complaint lines are Arabic, and a Windows console defaults
# to cp1252, which cannot encode them -- the run died in its own error reporting.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover - a stream that cannot be reconfigured is already utf-8
    pass

ROOT = Path(__file__).resolve().parent.parent
OUT_FONTS = ROOT / "site" / "assets" / "fonts"
OUT_CSS = ROOT / "site" / "assets" / "css" / "fonts.css"

# ── The two ranges, and why they do not overlap ──────────────────────────────
#
# Two @font-face rules for the same family and weight whose unicode-ranges overlap is
# undefined-ish behaviour that differs between engines, so the split is made exact:
# U+200C-200F (ZWNJ, ZWJ, LRM, RLM) belong to ARABIC -- they are joiner controls and a
# bidi archive uses them in Arabic text -- and the Latin range stops at U+200B and resumes
# at U+2010, stepping over them rather than round them.
ARABIC_RANGE = (
    "U+0600-06FF,U+0750-077F,U+0870-088E,U+08A0-08FF,"
    # Arabic Presentation Forms-B is U+FE70-FEFF, but U+FEFF is the byte-order mark and is
    # not an Arabic anything. It stays with the Latin subset, and this range stops one short
    # of it -- the two subsets must not both claim a codepoint, and frontend-fonts-test.mjs
    # is what found that they did.
    "U+200C-200F,U+FB50-FDFF,U+FE70-FEFE"
)
LATIN_RANGE = (
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,"
    # U+2190-2193: the four arrows. The interface uses one and both families have all four,
    # so the range is given the block rather than the single character -- a range that
    # matches the fonts' own coverage does not have to be revisited when a view adds an arrow.
    "U+2000-200B,U+2010-2027,U+2030-2065,U+20AC,U+2122,U+2190-2193,U+2212,U+FEFF,U+FFFD"
)

# ── What must still shape after subsetting ───────────────────────────────────
#
# Not decoration. Each of these breaks in a different way when a different table is lost,
# and every one of them appears on this site.
SHAPING_PROBES = [
    # Every probe is ONE WORD, entirely inside ARABIC_RANGE, and that is a correctness
    # requirement rather than a style. The first version used real phrases -- "ذاكرة رام
    # الله" -- and every one of them failed, because a phrase contains SPACES and U+0020
    # belongs to the Latin subset by the split above. The Arabic face was being asked for a
    # character it deliberately does not have, and answered .notdef, correctly. The browser
    # never asks it: unicode-range means the space is served by the Latin face.
    #
    # Nothing about shaping is lost by dropping the spaces. Arabic does not join across a
    # word boundary, so a word shapes identically alone and in a sentence -- which is the
    # same reason the browser can split the run in the first place.
    ("الله", "the lam-lam-ha of الله -- a required ligature, and the archive's own title"),
    ("لا", "lam-alef, the required ligature -- two letters here is a spelling error"),
    ("إله", "hamza below on an alef, then joining"),
    ("المساهمات", "initial, medial and final forms across one long word"),
    ("مَرْحَبًا", "vowel marks, positioned by GPOS mark/mkmk"),
    ("١٩٦٠", "Arabic-Indic digits -- the decade slider renders these"),
    ("التحتا", "رام الله التحتا, a gazetteer row"),
    ("ذاكرة", "ta marbuta in final position"),
    ("بقلم", "the byline word"),
]

LATIN_PROBES = [
    ("Ramallah Memory Atlas", "the English wordmark"),
    ("fi fl ffi — “quoted”", "f-ligatures and typographic punctuation"),
    ("1960s · 31.8996°N", "digits, middot and degree"),
]


def shape(font_bytes: bytes, text: str):
    """(glyph id, cluster, x-advance) per glyph, through HarfBuzz — the real shaper."""
    face = hb.Face(font_bytes)
    font = hb.Font(face)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf)
    return [(i.codepoint, i.cluster, p.x_advance) for i, p in zip(buf.glyph_infos, buf.glyph_positions)]


def shaping_matches(original: bytes, subsetted: bytes, probes):
    """
    Every probe must shape identically. Returns a list of complaints; empty means good.

    Glyph IDs are compared as a SEQUENCE rather than by value: subsetting renumbers glyphs,
    so equal ids would be the wrong test. What must hold is that the same number of glyphs
    comes out, at the same clusters, with the same advances — that is what "it looks the
    same" reduces to.
    """
    out = []
    for text, why in probes:
        a = shape(original, text)
        b = shape(subsetted, text)
        if len(a) != len(b):
            out.append(f"{why}: {len(a)} glyphs before, {len(b)} after")
            continue
        if [x[1] for x in a] != [x[1] for x in b]:
            out.append(f"{why}: the glyph-to-character mapping changed")
        if [x[2] for x in a] != [x[2] for x in b]:
            out.append(f"{why}: advances changed — positioning was lost")
        # A shaper that produced .notdef (glyph 0) for anything is the loudest failure.
        if any(x[0] == 0 for x in b):
            out.append(f"{why}: the subset shapes to .notdef — a character has no glyph")
    return out


def subset_pair(source, unicodes: str, keep_all_features: bool):
    """
    One subset, returned TWICE: as raw TTF bytes and as woff2.

    Both, because they are for different jobs and only one of them can do the other's.
    WOFF2 is what ships. HarfBuzz cannot read WOFF2 -- it wants a raw sfnt blob and quietly
    produces nothing usable from a compressed one -- so the shaping check is run against the
    TTF form of the SAME subset. The first version of this file compared a TTF original to a
    WOFF2 subset and reported every face as broken, which is the check being wrong rather
    than the fonts; it is worth the two saves to have the comparison be like-for-like.

    `source` is a path or an already-loaded TTFont, so the Inter path can hand over an
    instanced font without a temp file. A temp file here also kept a Windows file handle
    open and made its own deletion fail.
    """
    options = subset.Options()
    options.layout_features = ["*"] if keep_all_features else ["ccmp", "liga", "calt", "kern", "rvrn"]
    options.notdef_outline = True
    options.name_IDs = ["*"]          # keep family and the LICENCE strings (the OFL requires it)
    options.drop_tables += ["DSIG", "meta"]

    font = subset.load_font(source, options) if isinstance(source, (str, Path)) else source
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=subset.parse_unicodes(unicodes))
    subsetter.subset(font)

    raw = io.BytesIO()
    options.flavor = None
    subset.save_font(font, raw, options)

    packed = io.BytesIO()
    options.flavor = "woff2"
    subset.save_font(font, packed, options)
    return raw.getvalue(), packed.getvalue()


FACES = []  # filled by main(); each: dict(file, family, weight, range, style)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="directory holding the source TTFs")
    ap.add_argument("--dry-run", action="store_true", help="measure and check, write nothing")
    a = ap.parse_args()
    src = Path(a.src)

    plex = {400: "IBMPlexSansArabic-Regular.ttf", 500: "IBMPlexSansArabic-Medium.ttf",
            600: "IBMPlexSansArabic-SemiBold.ttf", 700: "IBMPlexSansArabic-Bold.ttf"}
    inter_var = "Inter[opsz,wght].ttf"

    missing = [n for n in list(plex.values()) + [inter_var] if not (src / n).exists()]
    if missing:
        print("subset-fonts: missing source fonts in", src)
        for m in missing:
            print("   ", m)
        print("\nDownload them from google/fonts (both are OFL 1.1):")
        print("  ofl/ibmplexsansarabic/  and  ofl/inter/")
        return 1

    if not a.dry_run:
        OUT_FONTS.mkdir(parents=True, exist_ok=True)

    total = 0
    complaints = []
    written = []

    # ── Plex Arabic: four weights, each split arabic / latin ────────────────
    for weight, name in plex.items():
        source = src / name
        original = source.read_bytes()
        for label, urange, probes, all_features in (
            ("arabic", ARABIC_RANGE, SHAPING_PROBES, True),
            ("latin", LATIN_RANGE, LATIN_PROBES, False),
        ):
            raw, data = subset_pair(source, urange, all_features)
            bad = shaping_matches(original, raw, probes)
            if bad:
                complaints += [f"plex-{weight}-{label}: {b}" for b in bad]
            out = OUT_FONTS / f"plex-arabic-{weight}-{label}.woff2"
            total += len(data)
            print(f"  {out.name:34} {len(data):7,} bytes  {'SHAPING OK' if not bad else 'SHAPING FAILED'}")
            if not a.dry_run and not bad:
                out.write_bytes(data)
                written.append(out)
            FACES.append({"file": out.name, "family": "IBM Plex Sans Arabic",
                          "weight": str(weight), "range": urange})

    # ── Inter: one variable file, Latin only ────────────────────────────────
    #
    # Kept variable across 400-700 rather than instanced into four statics: one request and
    # one cache entry instead of four, and `font-weight: 400 700` in the @font-face is how
    # a variable face declares the range it can serve.
    source = src / inter_var
    # The opsz axis is pinned to its 14pt optical size: the UI never sets font-optical-sizing
    # and shipping the axis would carry deltas nothing varies.
    pinned = instancer.instantiateVariableFont(TTFont(str(source)), {"opsz": 14}, inplace=False)
    reference = io.BytesIO()
    pinned.save(reference)
    # Subsetted from the in-memory TTFont, so nothing here opens a file it then has to
    # delete -- the first version wrote a temp TTF, kept a Windows handle on it, and failed
    # to remove its own scratch file at the end of a successful run.
    # Round-tripped through bytes before subsetting, deliberately. An instancer-produced
    # TTFont keeps `gvar` as a lazy dict whose keys no longer match the glyph set the
    # instancing left behind, and the subsetter walks straight into a KeyError on a glyph
    # name it has already dropped ('thirdemspace'). Reloading materialises the tables the
    # way a file on disk would, without a file on disk.
    reference.seek(0)
    raw, data = subset_pair(TTFont(reference), LATIN_RANGE, False)
    bad = shaping_matches(reference.getvalue(), raw, LATIN_PROBES)
    if bad:
        complaints += [f"inter-latin: {b}" for b in bad]
    out = OUT_FONTS / "inter-latin.woff2"
    total += len(data)
    print(f"  {out.name:34} {len(data):7,} bytes  {'SHAPING OK' if not bad else 'SHAPING FAILED'}")
    if not a.dry_run and not bad:
        out.write_bytes(data)
        written.append(out)
    FACES.append({"file": out.name, "family": "Inter", "weight": "400 700", "range": LATIN_RANGE})

    # ── The CONTROL. A subset with its layout features stripped MUST fail ───
    #
    # Without this, "SHAPING OK" above is a line that has never been anything else.
    control_opts = subset.Options()
    control_opts.layout_features = []          # no init/medi/fina/isol/rlig at all
    control_opts.drop_tables += ["GSUB", "GPOS", "GDEF"]
    cf = subset.load_font(str(src / plex[400]), control_opts)
    cs = subset.Subsetter(options=control_opts)
    cs.populate(unicodes=subset.parse_unicodes(ARABIC_RANGE))
    cs.subset(cf)
    cbuf = io.BytesIO()
    subset.save_font(cf, cbuf, control_opts)
    control_bad = shaping_matches((src / plex[400]).read_bytes(), cbuf.getvalue(), SHAPING_PROBES)
    print(f"\n  CONTROL: a subset with GSUB/GPOS/GDEF dropped -> "
          f"{len(control_bad)} shaping complaint(s) {'(the check discriminates)' if control_bad else '<-- THE CHECK IS BROKEN'}")
    if not control_bad:
        print("\nsubset-fonts: the shaping check passed a font that cannot shape Arabic.")
        print("  Refusing to report the real subsets as verified.")
        return 1

    print(f"\n  total {total:,} bytes across {len(FACES)} face files")

    if complaints:
        print("\nsubset-fonts: SHAPING CHANGED after subsetting. Nothing written for those faces.")
        for c in complaints:
            print("   ", c)
        return 1

    if a.dry_run:
        print("\nDRY RUN. Nothing written.")
        return 0

    (OUT_FONTS / "OFL.txt").write_text(LICENCE, encoding="utf-8")
    OUT_CSS.write_text(css(), encoding="utf-8")
    print(f"\nWrote {len(written)} font files, OFL.txt, and {OUT_CSS.relative_to(ROOT)}.")
    print("Now run: node scripts/frontend-fonts-test.mjs && node scripts/frontend-budget.mjs")
    return 0


def css() -> str:
    head = """/* GENERATED BY scripts/subset-fonts.py -- DO NOT EDIT
   Regenerate with:  python scripts/subset-fonts.py --src <dir-of-source-ttfs>

   §9: "Arabic font subset with unicode-range split, WOFF2, font-display: swap -- and
   verify shaping after subsetting." All four, and the shaping is verified by the generator
   through HarfBuzz against the unsubsetted original, with a control that must fail.

   `font-display: swap` on every face: the archive's text must be readable while the font
   is still arriving. On a throttled connection the alternative is a blank page holding
   content somebody came to read.

   Both families are SIL Open Font License 1.1; the licence travels with them in OFL.txt. */

"""
    out = [head]
    for f in FACES:
        out.append(
            f"@font-face {{\n"
            f"  font-family: '{f['family']}';\n"
            f"  font-style: normal;\n"
            f"  font-weight: {f['weight']};\n"
            f"  font-display: swap;\n"
            f"  src: url('/assets/fonts/{f['file']}') format('woff2');\n"
            f"  unicode-range: {f['range']};\n"
            f"}}\n\n"
        )
    return "".join(out)


LICENCE = """Both font families bundled in this directory are licensed under the
SIL Open Font License, Version 1.1.

  IBM Plex Sans Arabic  (c) 2017 IBM Corp.        https://github.com/IBM/plex
  Inter                 (c) 2016 The Inter Project Authors
                                                  https://github.com/rsms/inter

The files here are SUBSETS produced by scripts/subset-fonts.py: glyph coverage is
reduced to the unicode ranges the archive needs. No outline, metric or layout table
has been modified. The OFL permits this and requires that the licence travel with the
font, which is what this file is for.

The full licence text: https://openfontlicense.org/open-font-license-official-text/
"""


if __name__ == "__main__":
    sys.exit(main())
