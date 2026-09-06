-- 0061 · The removal path, said out loud on the info page
--
-- §11 gate 4: "A named human on the takedown path with a stated response time. This is a
-- launch gate." §8 attaches that human to the takedown path itself. Neither is discharged
-- by a person existing — it is discharged by the person being REACHABLE, and until this
-- migration nothing anywhere on the public site said who they were or how long they take.
--
-- Amro's governance decision, 6 Sep 2026:
--   named human   Amro, sole maintainer
--   response      48 hours
--   intake        (1) the in-platform report control, kind='removal' (0053)
--                 (2) reports@ramallahnostalgia.org, for anyone who cannot sign in
--
-- reconciled-plan.md's Q6 recommended 24 hours. 48 is the maintainer's call and is also the
-- number the archive has ALREADY published twice — page.contact.body and page.support.body
-- both promise a reply within 48 hours. One commitment, not three.
--
-- ── Why the second intake path is not redundant ──────────────
--
-- F21 is "consent, licensing, third-party subjects undefined", and the third term is the one
-- that matters here. §4 gives "like / save / comment" and everything beside it to a signed-in
-- member, and 0053 leaned on that deliberately: "the person with the strongest claim to have
-- a photograph removed is frequently NOT its uploader. They are the person in it."
--
-- But 0053 only widened WHO may file a report — it did not widen who can reach the form.
-- The report control lives inside the viewer, behind the sign-in gate, and a subject, a
-- family, or a rights holder who has never had an account has no route to it at all. The
-- archive would be asking the exact population §7 exists to protect to create an account,
-- hand over an email address, and accept its terms, before it would listen to them ask to be
-- removed from it. An address that takes mail from a stranger is what closes that.
--
-- 5 Sep's amendment to §4 met the same asymmetry from the other side and resolved it the
-- same way: reporting is the one member capability NOT gated on a confirmed address, because
-- "a mail round trip in front of it would silence exactly who it is for."
--
-- ── No schema, no table, no code ─────────────────────────────
--
-- §12: the smallest change that satisfies the task. Everything operational already exists —
-- `reports` with kind='removal' (0053), request_takedown() with its audit row (0036), and
-- the Edge Function that deletes the bytes without waiting for a release (§8). What was
-- missing was prose. So this file is prose, in the table §9 makes the single source of truth
-- for it, and the operational half is docs/takedown-runbook.md.
--
-- The address is written into the BODY rather than into a `page.removal.email` block beside
-- it. `page.donate.email` exists because the donate section renders actionable rows from a
-- widget; a second copy of this address in a second block is a second thing to change and
-- the first one to go stale.

set search_path = public, extensions;

-- ── The section ──────────────────────────────────────────────
--
-- Same shape as every other info-page section (0043): a title block and a body block per
-- locale, paragraphs separated by a blank line, no markdown — §6 forbids innerHTML on
-- content and archive.js splits on the blank line. The deep-link anchor is free: archive.js
-- builds /page/{slug} from page.order and public.js renders id="section-{slug}".
--
-- Idempotent like 0043, and for the same reason: from the moment an editor touches a block
-- they are its source of truth, and a re-run must not overwrite them.
--
-- Both columns carry the same string. Seeding only `published` gives the block an empty
-- editor on first open, and an editor who saves an empty draft over live copy has done
-- exactly what the two columns exist to prevent.
insert into public.content_blocks (key, locale, draft, published) values

  ('page.removal.title', 'ar', 'طلب إزالة مادة', 'طلب إزالة مادة'),
  ('page.removal.title', 'en', 'Request removal', 'Request removal'),

  -- Arabic first, and written rather than translated: §9's "Arabic-first" is about the prose
  -- itself. Arabic-Indic digits, held consistently with the ٤٨ already in page.contact.body
  -- and page.support.body.
  --
  -- "ولستَ مطالبًا بإثبات حقّك قبل أن نسمعك" is deliberate and is the sentence a lawyer would
  -- cut. The person §7 is about has usually just found a photograph of themselves in a public
  -- archive; an archive that opens by asking them to prove standing has already answered them.
  ('page.removal.body', 'ar',
   'يمكن إزالة أي مادة من الأرشيف بناءً على طلب. إن كنت في صورة أو تسجيل، أو كنت من أهل من فيه، أو كان لك حقّ في المادة — اطلب إزالتها. ولستَ مطالبًا بإثبات حقّك قبل أن نسمعك.

كيف تصل إلينا: إن كان لك حساب، استخدم زر «إبلاغ» على الذكرى نفسها واختر «طلب إزالة». وإن لم يكن لك حساب فلا تنشئ واحدًا لأجل هذا — راسلنا على reports@ramallahnostalgia.org وأرفق رابط الذكرى وما يكفي لنعرف عمّا تتحدّث.

من يستلم الطلب: عمرو، القيّم على الأرشيف، شخصيًّا. نردّ خلال ٤٨ ساعة من وصول الطلب. والردّ خلال ٤٨ ساعة تعهّد بأن ينظر في طلبك إنسان ويجيبك، لا بأن يُقبل كل طلب.

ما يحدث عند القبول: تُحذف الملفات من التخزين فورًا — المشتقّات والنسخة الأصلية معًا — ولا ننتظر دورة النشر. ويُسجَّل القرار في سجلّ دائم؛ أمّا نصّ طلبك فلا يُنسخ إليه.',

   'يمكن إزالة أي مادة من الأرشيف بناءً على طلب. إن كنت في صورة أو تسجيل، أو كنت من أهل من فيه، أو كان لك حقّ في المادة — اطلب إزالتها. ولستَ مطالبًا بإثبات حقّك قبل أن نسمعك.

كيف تصل إلينا: إن كان لك حساب، استخدم زر «إبلاغ» على الذكرى نفسها واختر «طلب إزالة». وإن لم يكن لك حساب فلا تنشئ واحدًا لأجل هذا — راسلنا على reports@ramallahnostalgia.org وأرفق رابط الذكرى وما يكفي لنعرف عمّا تتحدّث.

من يستلم الطلب: عمرو، القيّم على الأرشيف، شخصيًّا. نردّ خلال ٤٨ ساعة من وصول الطلب. والردّ خلال ٤٨ ساعة تعهّد بأن ينظر في طلبك إنسان ويجيبك، لا بأن يُقبل كل طلب.

ما يحدث عند القبول: تُحذف الملفات من التخزين فورًا — المشتقّات والنسخة الأصلية معًا — ولا ننتظر دورة النشر. ويُسجَّل القرار في سجلّ دائم؛ أمّا نصّ طلبك فلا يُنسخ إليه.'),

  ('page.removal.body', 'en',
   'Any material in the archive can be removed on request. If you are in a photograph or a recording, if you are family to someone who is, or if you hold a right over the material — ask for it to be removed. You do not have to prove your claim before we will listen.

How to reach us: if you have an account, use the "Report" control on the memory itself and choose "Removal request". If you do not have an account, do not make one for this — write to reports@ramallahnostalgia.org with the link to the memory and enough for us to know what you mean.

Who receives it: Amro, the archive''s custodian, personally. We reply within 48 hours of a request arriving. Forty-eight hours is a commitment that a person will look and answer you — not that every request is granted.

What happens when a request is granted: the files are deleted from storage immediately — the derivatives and the archival master alike — and we do not wait for the publishing cycle. The decision is entered in a permanent log; the text of your request is not copied into it.',

   'Any material in the archive can be removed on request. If you are in a photograph or a recording, if you are family to someone who is, or if you hold a right over the material — ask for it to be removed. You do not have to prove your claim before we will listen.

How to reach us: if you have an account, use the "Report" control on the memory itself and choose "Removal request". If you do not have an account, do not make one for this — write to reports@ramallahnostalgia.org with the link to the memory and enough for us to know what you mean.

Who receives it: Amro, the archive''s custodian, personally. We reply within 48 hours of a request arriving. Forty-eight hours is a commitment that a person will look and answer you — not that every request is granted.

What happens when a request is granted: the files are deleted from storage immediately — the derivatives and the archival master alike — and we do not wait for the publishing cycle. The decision is entered in a permanent log; the text of your request is not copied into it.')

on conflict (key, locale) do nothing;

-- ── The section order ────────────────────────────────────────
--
-- page.order is a content block precisely so that reordering is a dashboard act rather than a
-- deploy (0043), which makes overwriting it here the one genuinely rude thing this file could
-- do. So it is two statements that between them never impose an order on an editor who has
-- already chosen one.
--
-- This is load-bearing rather than cosmetic in both directions, and both failures are silent.
-- 24_content_blocks assertion 13 covers one of them: archive.js SKIPS a slug whose title is
-- missing, so a slug named here without the blocks above would lose a whole section of the
-- site with nothing reporting it. The inverse is what these statements prevent — blocks with
-- no slug, sitting in the table, correct and bilingual, appearing on no page.

-- Nobody has reordered the sections, so place it where it reads: after "Help & support",
-- which is the section a person hunting for this would open first, and before the donation
-- ask. Both locales carry the same list — the ORDER is not a translation.
update public.content_blocks
   set draft     = 'about,contact,support,removal,donate',
       published = 'about,contact,support,removal,donate'
 where key = 'page.order'
   and coalesce(published, draft) = 'about,contact,support,donate';

-- An editor HAS reordered them. Append rather than impose, per column, and only where that
-- column does not already name it — so a re-run is a no-op that does not even touch
-- updated_at, and so a half-translated order (published on one side, drafted on the other)
-- gains the slug on whichever side is missing it rather than on neither.
update public.content_blocks
   set draft = case
                 when coalesce(draft, '') = '' then draft
                 when draft ~ '(^|,)\s*removal\s*(,|$)' then draft
                 else draft || ',removal'
               end,
       published = case
                 when coalesce(published, '') = '' then published
                 when published ~ '(^|,)\s*removal\s*(,|$)' then published
                 else published || ',removal'
               end
 where key = 'page.order'
   and (   (coalesce(draft, '')     <> '' and draft     !~ '(^|,)\s*removal\s*(,|$)')
        or (coalesce(published, '') <> '' and published !~ '(^|,)\s*removal\s*(,|$)'));
