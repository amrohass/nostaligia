-- 0043 · Editorial copy reaches the read path
--
-- §9: "All content comes from the store, never hardcoded in views. Page copy, cards, events,
-- comments, and the info page all read from content_blocks/shards so the dashboard is the
-- single source of truth."
--
-- 0009 built the table and 0015 decided who may read which column. Nothing has ever read it:
-- the front end carries its copy as JavaScript literals in assets/js/store.js, seeded into
-- localStorage. This file is the half that makes the sentence above true — a publisher-side
-- accessor, a signal so an edit actually publishes, and the existing copy moved out of the
-- JavaScript and into the table where an editor can reach it.
--
-- ── Why the copy is seeded HERE ──────────────────────────────
--
-- A migration that inserts content looks wrong, and normally is. The alternative was worse
-- in a specific way: store.js's `copy` and `pages` collections are the only place this
-- archive's Arabic and English prose exists, and M3 deletes that file. Copy that lives
-- nowhere between the deploy that removes it and the day an admin retypes it is copy that
-- gets retyped badly, in one language, by whoever is available.
--
-- So it moves rather than being re-authored. Idempotent (`on conflict do nothing`), so a
-- database whose editor has already changed a block is not overwritten by a re-run — the
-- editor is the source of truth from the moment they touch it, which is the point.
--
-- ── draft vs published ───────────────────────────────────────
--
-- Both columns are set to the same string here. `published` is what the publisher bakes;
-- `draft` is the editor's working copy and 0015 grants it to nobody. Seeding only
-- `published` would give every block an empty editor on first open, and an editor who saves
-- an empty draft over live copy has done exactly what the two columns exist to prevent.

set search_path = public, extensions;

-- ── What the publisher reads ─────────────────────────────────
--
-- One object, keyed by block, each value a {ar, en} pair — the shape every view in the front
-- end already uses for bilingual content. Rows whose `published` is null are absent rather
-- than present-and-empty: a block an editor has drafted but not published must not blank the
-- page it appears on.
--
-- `draft` is not selected. It is unpublished prose — a paragraph someone is still working
-- on — and a shard is served to everyone for a year.
create or replace function public.published_content_blocks()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(k, v order by k),
    '{}'::jsonb)
  from (
    select c.key as k,
           jsonb_strip_nulls(jsonb_build_object(
             'ar', max(c.published) filter (where c.locale = 'ar'),
             'en', max(c.published) filter (where c.locale = 'en')
           )) as v
    from public.content_blocks c
    where c.published is not null
    group by c.key
  ) blocks;
$$;

comment on function public.published_content_blocks() is
  'The published half of content_blocks, as {key: {ar, en}} — CLAUDE.md §9.';

-- Same posture as publishable_posts: not secret, not a browser endpoint. §2's read path is
-- "zero database reads for public visitors", and an RPC that returns every block in one call
-- is the most convenient possible way to violate that by accident. `authenticated` already
-- has a column grant on (key, locale, published) for the dashboard.
revoke execute on function public.published_content_blocks() from public, anon, authenticated;
grant  execute on function public.published_content_blocks() to service_role;

-- ── The signal ───────────────────────────────────────────────
--
-- 0037's rule, applied to a new table: everything the publisher reads must say when it
-- changed, or the archive serves that column's first value forever. 20_publish_cron
-- assertion 27 derives the required set from the publisher's read side, so this is not
-- optional — it is what stops that assertion failing.
--
-- Only `published` moves the revision. An editor typing into `draft` is the highest-volume
-- write this table will take and it appears in no shard; the same reasoning that excludes a
-- member editing a post draft in 0037.
create trigger content_blocks_bump_publish_revision_insert
  after insert on public.content_blocks
  for each row when (new.published is not null)
  execute function public.bump_publish_revision('content');

create trigger content_blocks_bump_publish_revision_update
  after update on public.content_blocks
  for each row when (old.published is distinct from new.published)
  execute function public.bump_publish_revision('content');

create trigger content_blocks_bump_publish_revision_delete
  after delete on public.content_blocks
  for each row when (old.published is not null)
  execute function public.bump_publish_revision('content');

-- ── The copy, moved out of assets/js/store.js ────────────────
--
-- Verbatim. Anything reworded on the way across would be an editorial change made in a
-- migration, which is the one place nobody reviews prose.
--
-- `page.order` is the info page's section order, as a comma-separated list of slugs. It is a
-- content block rather than a column because reordering the About/Contact/Support/Donate
-- sections is an editorial act, and this way it is one the dashboard can perform without a
-- deploy. Both locales carry the same list — the ORDER is not a translation — and the front
-- end reads whichever side is present.
insert into public.content_blocks (key, locale, draft, published) values

  ('page.order', 'ar', 'about,contact,support,donate', 'about,contact,support,donate'),
  ('page.order', 'en', 'about,contact,support,donate', 'about,contact,support,donate'),

  ('hero.line', 'ar',
   'هنا تُروى رام الله — صورةً وصوتًا وحكاية.',
   'هنا تُروى رام الله — صورةً وصوتًا وحكاية.'),
  ('hero.line', 'en',
   'Here, Ramallah is told — in pictures, voices, and stories.',
   'Here, Ramallah is told — in pictures, voices, and stories.'),

  ('hero.blurb', 'ar',
   'أرشيف مجتمعيّ يجمع ما تحفظه العائلات — في المدينة وفي الشتات — منذ الخمسينيات حتى اليوم.',
   'أرشيف مجتمعيّ يجمع ما تحفظه العائلات — في المدينة وفي الشتات — منذ الخمسينيات حتى اليوم.'),
  ('hero.blurb', 'en',
   'A community archive of what families keep — in the city and across the diaspora — from the 1950s to today.',
   'A community archive of what families keep — in the city and across the diaspora — from the 1950s to today.'),

  ('events.title', 'ar', 'فعاليات حول الذاكرة', 'فعاليات حول الذاكرة'),
  ('events.title', 'en', 'Events around the memory', 'Events around the memory'),

  ('events.blurb', 'ar',
   'معارض وجولات وورشات ينظّمها الأرشيف وأهل المدينة — في رام الله وعبر الإنترنت.',
   'معارض وجولات وورشات ينظّمها الأرشيف وأهل المدينة — في رام الله وعبر الإنترنت.'),
  ('events.blurb', 'en',
   'Exhibitions, tours and workshops run by the archive and by the city — in Ramallah and online.',
   'Exhibitions, tours and workshops run by the archive and by the city — in Ramallah and online.'),

  ('footer.blurb', 'ar',
   'أرشيف مجتمعيّ مستقل لذاكرة رام الله وأهلها — تُدار مواده بعناية تحريرية وتُتاح للجميع.',
   'أرشيف مجتمعيّ مستقل لذاكرة رام الله وأهلها — تُدار مواده بعناية تحريرية وتُتاح للجميع.'),
  ('footer.blurb', 'en',
   'An independent community archive of Ramallah''s memory — carefully curated, open to all.',
   'An independent community archive of Ramallah''s memory — carefully curated, open to all.'),

  ('donate.title', 'ar', 'ادعم الذاكرة', 'ادعم الذاكرة'),
  ('donate.title', 'en', 'Support the memory', 'Support the memory'),

  ('donate.blurb', 'ar',
   'مشروع أهليّ غير ربحيّ، تموّله المنح الثقافية ومساهمات الأفراد. تبرّعك يحفظ صورة أخرى من الضياع.',
   'مشروع أهليّ غير ربحيّ، تموّله المنح الثقافية ومساهمات الأفراد. تبرّعك يحفظ صورة أخرى من الضياع.'),
  ('donate.blurb', 'en',
   'A non-profit civic project, funded by cultural grants and individual gifts. Your donation keeps another photograph from being lost.',
   'A non-profit civic project, funded by cultural grants and individual gifts. Your donation keeps another photograph from being lost.'),

  -- ── The info page ──────────────────────────────────────────
  -- Paragraphs are separated by a blank line, exactly as store.js carried them, and the
  -- front end splits on that. Markdown is deliberately not introduced: §6 forbids
  -- innerHTML on content, and a renderer is a second place for markup to enter the page.

  ('page.about.title', 'ar', 'من نحن', 'من نحن'),
  ('page.about.title', 'en', 'About us', 'About us'),
  ('page.about.body', 'ar',
   'ذاكرة رام الله أرشيف مجتمعيّ مستقل، بدأ من ألبومات العائلات وأدراج البيوت. نجمع الصور والتسجيلات والحكايات التي تحفظ شكل المدينة منذ الخمسينيات، ونتيحها للجميع.

كل ما يصلنا يمرّ بمراجعة تحريرية: نتحقّق من المكان والعقد وننسب المادة إلى أصحابها قدر المستطاع. لا ننشر ما لم يوافق صاحبه على عرضه، ونصحّح ما يثبت خطؤه.

المشروع يديره فريق صغير في رام الله، ويكبر بما يضيفه الناس إليه — من المدينة ومن الشتات.',
   'ذاكرة رام الله أرشيف مجتمعيّ مستقل، بدأ من ألبومات العائلات وأدراج البيوت. نجمع الصور والتسجيلات والحكايات التي تحفظ شكل المدينة منذ الخمسينيات، ونتيحها للجميع.

كل ما يصلنا يمرّ بمراجعة تحريرية: نتحقّق من المكان والعقد وننسب المادة إلى أصحابها قدر المستطاع. لا ننشر ما لم يوافق صاحبه على عرضه، ونصحّح ما يثبت خطؤه.

المشروع يديره فريق صغير في رام الله، ويكبر بما يضيفه الناس إليه — من المدينة ومن الشتات.'),
  ('page.about.body', 'en',
   'The Ramallah Memory Atlas is an independent community archive that began in family albums and household drawers. We gather the photographs, recordings and stories that hold the shape of the city from the 1950s onward, and we open them to everyone.

Everything we receive passes an editorial review: we check the place and the decade, and attribute material to its owners as accurately as we can. We do not publish what its owner has not agreed to show, and we correct what is shown to be wrong.

A small team in Ramallah runs the project, and it grows by what people add to it — from the city and from the diaspora.',
   'The Ramallah Memory Atlas is an independent community archive that began in family albums and household drawers. We gather the photographs, recordings and stories that hold the shape of the city from the 1950s onward, and we open them to everyone.

Everything we receive passes an editorial review: we check the place and the decade, and attribute material to its owners as accurately as we can. We do not publish what its owner has not agreed to show, and we correct what is shown to be wrong.

A small team in Ramallah runs the project, and it grows by what people add to it — from the city and from the diaspora.'),

  ('page.contact.title', 'ar', 'تواصل معنا', 'تواصل معنا'),
  ('page.contact.title', 'en', 'Contact', 'Contact'),
  ('page.contact.body', 'ar',
   'نقرأ كل رسالة. إن كانت لديك صورة أو تسجيل أو تصحيح لمعلومة منشورة، اكتب لنا وسنردّ خلال ٤٨ ساعة.

للمساهمات: أرسل ما لديك عبر زر «شارك ذكرى» بعد تسجيل الدخول، أو راسلنا مباشرة إن كانت المادة كبيرة.

للصحافة والشراكات: راسلنا على البريد نفسه واذكر «صحافة» أو «شراكة» في العنوان.',
   'نقرأ كل رسالة. إن كانت لديك صورة أو تسجيل أو تصحيح لمعلومة منشورة، اكتب لنا وسنردّ خلال ٤٨ ساعة.

للمساهمات: أرسل ما لديك عبر زر «شارك ذكرى» بعد تسجيل الدخول، أو راسلنا مباشرة إن كانت المادة كبيرة.

للصحافة والشراكات: راسلنا على البريد نفسه واذكر «صحافة» أو «شراكة» في العنوان.'),
  ('page.contact.body', 'en',
   'We read every message. If you have a photograph, a recording, or a correction to something published, write to us and we will reply within 48 hours.

For contributions: send what you have through the "Share a memory" button once signed in, or write to us directly if the material is large.

For press and partnerships: use the same address and put "press" or "partnership" in the subject line.',
   'We read every message. If you have a photograph, a recording, or a correction to something published, write to us and we will reply within 48 hours.

For contributions: send what you have through the "Share a memory" button once signed in, or write to us directly if the material is large.

For press and partnerships: use the same address and put "press" or "partnership" in the subject line.'),

  ('page.support.title', 'ar', 'المساعدة والدعم', 'المساعدة والدعم'),
  ('page.support.title', 'en', 'Help & support', 'Help & support'),
  ('page.support.body', 'ar',
   'كيف أشارك ذكرى؟ أنشئ حسابًا، ثم اضغط «شارك ذكرى» واختر صورة أو تسجيلًا صوتيًا أو فعالية. أضف المكان والعقد وما تذكره من الحكاية.

متى تُنشر مساهمتي؟ نتعهّد بالردّ خلال ٤٨ ساعة. إن نقص تفصيل صغير أعدناها إليك مع ملاحظة بدل رفضها.

من يملك المادة؟ صاحبها. نعرضها في الأرشيف بإذنه، ويمكنه طلب سحبها في أي وقت.

وجدت خطأ في تاريخ أو مكان؟ استخدم زر الإبلاغ على الذكرى. نصحّح السجلّ ونبقي الذكرى.',
   'كيف أشارك ذكرى؟ أنشئ حسابًا، ثم اضغط «شارك ذكرى» واختر صورة أو تسجيلًا صوتيًا أو فعالية. أضف المكان والعقد وما تذكره من الحكاية.

متى تُنشر مساهمتي؟ نتعهّد بالردّ خلال ٤٨ ساعة. إن نقص تفصيل صغير أعدناها إليك مع ملاحظة بدل رفضها.

من يملك المادة؟ صاحبها. نعرضها في الأرشيف بإذنه، ويمكنه طلب سحبها في أي وقت.

وجدت خطأ في تاريخ أو مكان؟ استخدم زر الإبلاغ على الذكرى. نصحّح السجلّ ونبقي الذكرى.'),
  ('page.support.body', 'en',
   'How do I share a memory? Create an account, press "Share a memory", and choose a photo, a voice recording, or an event. Add the place, the decade, and what you remember of the story.

When is my contribution published? We promise a reply within 48 hours. If a small detail is missing we send it back with a note rather than rejecting it.

Who owns the material? Its owner. We show it in the archive with their permission, and they can ask for it to be withdrawn at any time.

Found a wrong date or place? Use the report control on the memory. We correct the record and keep the memory.',
   'How do I share a memory? Create an account, press "Share a memory", and choose a photo, a voice recording, or an event. Add the place, the decade, and what you remember of the story.

When is my contribution published? We promise a reply within 48 hours. If a small detail is missing we send it back with a note rather than rejecting it.

Who owns the material? Its owner. We show it in the archive with their permission, and they can ask for it to be withdrawn at any time.

Found a wrong date or place? Use the report control on the memory. We correct the record and keep the memory.'),

  ('page.donate.title', 'ar', 'ادعم الذاكرة', 'ادعم الذاكرة'),
  ('page.donate.title', 'en', 'Support the memory', 'Support the memory'),
  ('page.donate.body', 'ar',
   'ذاكرة رام الله مشروع أهليّ غير ربحيّ. تموّله المنح الثقافية ومساهمات الأفراد، ولا يعرض إعلانات ولا يبيع بيانات مستخدميه.

إلى أين يذهب تبرّعك: مسح الصور وترميمها رقميًا، وتسجيل الروايات الشفوية مع كبار السنّ، وتخزين المواد ونسخها احتياطيًا، وأجر فريق المراجعة الصغير.

شروط التبرّع: التبرّعات غير مستردّة، ولا تمنح المتبرّع أي حقّ في مواد الأرشيف ولا تأثيرًا على قرارات النشر. نصدر إيصالًا لكل تبرّع عند الطلب، وننشر ملخّصًا ماليًا سنويًا. للتبرّعات المؤسسية أو المخصّصة لبرنامج بعينه، راسلنا أولًا لنتّفق على الشروط كتابةً.',
   'ذاكرة رام الله مشروع أهليّ غير ربحيّ. تموّله المنح الثقافية ومساهمات الأفراد، ولا يعرض إعلانات ولا يبيع بيانات مستخدميه.

إلى أين يذهب تبرّعك: مسح الصور وترميمها رقميًا، وتسجيل الروايات الشفوية مع كبار السنّ، وتخزين المواد ونسخها احتياطيًا، وأجر فريق المراجعة الصغير.

شروط التبرّع: التبرّعات غير مستردّة، ولا تمنح المتبرّع أي حقّ في مواد الأرشيف ولا تأثيرًا على قرارات النشر. نصدر إيصالًا لكل تبرّع عند الطلب، وننشر ملخّصًا ماليًا سنويًا. للتبرّعات المؤسسية أو المخصّصة لبرنامج بعينه، راسلنا أولًا لنتّفق على الشروط كتابةً.'),
  ('page.donate.body', 'en',
   'The Ramallah Memory Atlas is a non-profit civic project. It is funded by cultural grants and individual gifts; it runs no advertising and does not sell its users'' data.

Where your gift goes: scanning and digitally restoring photographs, recording oral histories with older narrators, storage and backup of the material, and the wage of a small review team.

Donation terms: donations are non-refundable, and grant the donor no right over archive material and no influence on publishing decisions. We issue a receipt for any donation on request, and publish an annual financial summary. For institutional gifts, or gifts earmarked for a specific programme, write to us first so the terms can be agreed in writing.',
   'The Ramallah Memory Atlas is a non-profit civic project. It is funded by cultural grants and individual gifts; it runs no advertising and does not sell its users'' data.

Where your gift goes: scanning and digitally restoring photographs, recording oral histories with older narrators, storage and backup of the material, and the wage of a small review team.

Donation terms: donations are non-refundable, and grant the donor no right over archive material and no influence on publishing decisions. We issue a receipt for any donation on request, and publish an annual financial summary. For institutional gifts, or gifts earmarked for a specific programme, write to us first so the terms can be agreed in writing.'),

  -- The two the donate section renders as links. PLACEHOLDER until the project has an
  -- address to publish, and blank rather than fabricated: a mailto: to an address nobody
  -- reads is worse than no link, and this way filling them in is a dashboard edit.
  ('page.donate.email', 'ar', 'PLACEHOLDER_EMAIL', 'PLACEHOLDER_EMAIL'),
  ('page.donate.email', 'en', 'PLACEHOLDER_EMAIL', 'PLACEHOLDER_EMAIL'),
  ('page.donate.whatsapp', 'ar', 'PLACEHOLDER_WHATSAPP', 'PLACEHOLDER_WHATSAPP'),
  ('page.donate.whatsapp', 'en', 'PLACEHOLDER_WHATSAPP', 'PLACEHOLDER_WHATSAPP')

on conflict (key, locale) do nothing;
