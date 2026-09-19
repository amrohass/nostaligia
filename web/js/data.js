/* Reference data. Not content.

   ── What used to be here ─────────────────────────────────────

   Twelve invented memories, seven places, three events, a moderation queue, a members
   table, a reports list, three months of intake statistics and a coverage-by-decade chart —
   all of it written to stand in for an archive that did not exist yet, and all of it read
   directly by the views.

   Every one of those is gone in M3. §9: "All content comes from the store, never hardcoded
   in views. Page copy, cards, events, comments, and the info page all read from
   content_blocks/shards so the dashboard is the single source of truth." The archive now
   comes from the release shards (archive.js) and the copy from content_blocks; the
   dashboard's own screens read the database.

   The invented numbers were the part worth being most deliberate about deleting. A
   dashboard that shows a moderator "142 new members" and "31:40 hours of audio" — figures
   nothing computed — is not a placeholder, it is a screen that lies quietly to the person
   using it to make decisions.

   ── What is left, and why it belongs here ────────────────────

   Presentation constants with no editorial content in them: the gradient pairs the hatched
   placeholder plates are drawn from, and a decade list that is only a FALLBACK. Neither is
   something an editor would ever want to change, and neither is data about the archive. */

(function (global) {
  'use strict';

  /* The tone pairs `.plate` reads through --p1/--p2. Lifted from the design doc. They are
     applied by hashing an id rather than being stored per item: a heritage archive has no
     opinion about which gradient stands in for a photograph that has not loaded, and a
     `tone` column would be a decision somebody has to keep making. */
  var TONES = {
    sand:     ['#D9C49C', '#B29470'],
    clay:     ['#D8B49B', '#B37E5F'],
    olive:    ['#AEB292', '#7C8261'],
    wheat:    ['#C4B18E', '#8F7B58'],
    stone:    ['#C9BD9A', '#8F956E'],
    ochre:    ['#CBB799', '#9E8663'],
    dust:     ['#D8C3A2', '#A98D66'],
    amber:    ['#F0D8B4', '#C09A66'],
    parchment:['#E0CBA8', '#B2946A']
  };

  var TONE_NAMES = Object.keys(TONES);

  /* A FALLBACK only. The decades that actually have items come from the release's
     index.json, which the publisher derives from what it just built — so a 1940s photograph
     or a 2020s event appears in the slider without a deploy. This list is what the slider
     offers before index.json has loaded, and if it ever disagrees with index.json the
     shard wins.

     It stops at the 2020s because a decade that has not begun cannot hold a memory. */
  var DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];

  function tone(name) {
    return TONES[name] || TONES.sand;
  }

  global.DATA = {
    TONES: TONES,
    TONE_NAMES: TONE_NAMES,
    DECADES: DECADES,
    tone: tone
  };
})(window);
