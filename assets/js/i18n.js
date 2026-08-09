/* Bilingual layer for the Atlas.
   Arabic and English are mirrors of one screen set, not two builds: the language
   choice sets <html lang/dir> and every string comes from the table below. */

(function (global) {
  'use strict';

  var STORAGE_KEY = 'rma.lang';
  var ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

  var STRINGS = {
    // ── Chrome ──────────────────────────────────────────────
    'brand.name':        { ar: 'ذاكرة رام الله',   en: 'Ramallah Memory Atlas' },
    'brand.counterpart': { ar: 'Ramallah Memory Atlas', en: 'ذاكرة رام الله' },
    'brand.admin':       { ar: 'لوحة الإدارة',      en: 'Admin dashboard' },
    'lang.other':        { ar: 'EN',                en: 'ع' },
    'lang.switchTo':     { ar: 'Switch to English', en: 'التبديل إلى العربية' },

    'nav.archive': { ar: 'الأرشيف',   en: 'Archive' },
    'nav.map':     { ar: 'الخريطة',   en: 'Map' },
    'nav.events':  { ar: 'الفعاليات', en: 'Events' },

    'action.signIn':      { ar: 'تسجيل الدخول',  en: 'Sign in' },
    'action.createAcct':  { ar: 'إنشاء حساب',    en: 'Create account' },
    'action.share':       { ar: 'شارك ذكرى',     en: 'Share a memory' },
    'action.signOut':     { ar: 'تسجيل الخروج',  en: 'Sign out' },
    'action.close':       { ar: 'إغلاق',          en: 'Close' },
    'action.cancel':      { ar: 'إلغاء',          en: 'Cancel' },

    // ── Landing ─────────────────────────────────────────────
    'hero.line':  { ar: 'هنا تُروى رام الله — صورةً وصوتًا وحكاية.',
                    en: 'Here, Ramallah is told — in pictures, voices, and stories.' },
    'hero.blurb': { ar: 'أرشيف مجتمعيّ يجمع ما تحفظه العائلات — في المدينة وفي الشتات — منذ الخمسينيات حتى اليوم.',
                    en: 'A community archive of what families keep — in the city and across the diaspora — from the 1950s to today.' },
    'hero.memories':  { ar: '{n} ذكرى',        en: '{n} memories' },
    'hero.narrators': { ar: '{n} راويًا وراوية', en: '{n} narrators' },
    'hero.decades':   { ar: 'سبعة عقود',        en: 'seven decades' },
    'feed.more':      { ar: 'يُحمَّل المزيد أثناء التمرير', en: 'more loads as you scroll' },

    // ── Footer ──────────────────────────────────────────────
    'footer.blurb':   { ar: 'أرشيف مجتمعيّ مستقل لذاكرة رام الله وأهلها — تُدار مواده بعناية تحريرية وتُتاح للجميع.',
                        en: "An independent community archive of Ramallah's memory — carefully curated, open to all." },
    'footer.project': { ar: 'المشروع',           en: 'The project' },
    'footer.about':   { ar: 'من نحن',            en: 'About us' },
    'footer.contact': { ar: 'تواصل معنا',        en: 'Contact' },
    'footer.help':    { ar: 'المساعدة والدعم',   en: 'Help & support' },
    'footer.terms':   { ar: 'شروط المساهمة',     en: 'Contribution guidelines' },
    'footer.legal':   { ar: '© ٢٠٢٦ ذاكرة رام الله — المواد المتاحة تخضع لرخصة المشاع الإبداعي حيثما أمكن',
                        en: '© 2026 Ramallah Memory Atlas — open materials under Creative Commons where possible' },
    'footer.tag':     { ar: 'Ramallah Memory Atlas · a community heritage archive',
                        en: 'أرشيف أهليّ لذاكرة المدينة' },
    'donate.title':   { ar: 'ادعم الذاكرة',      en: 'Support the memory' },
    'donate.blurb':   { ar: 'مشروع أهليّ غير ربحيّ، تموّله المنح الثقافية ومساهمات الأفراد. تبرّعك يحفظ صورة أخرى من الضياع.',
                        en: 'A non-profit civic project, funded by cultural grants and individual gifts. Your donation keeps another photograph from being lost.' },
    'donate.cta':     { ar: 'تبرّع الآن',         en: 'Donate' },

    // ── Viewer ──────────────────────────────────────────────
    'viewer.back':      { ar: '✕ العودة إلى الأرشيف',  en: '✕ Back to the archive' },
    'viewer.next':      { ar: 'مرّر للأسفل للذكرى التالية ⌄', en: 'Scroll down for the next memory ⌄' },
    'viewer.save':      { ar: 'حفظ',      en: 'Save' },
    'viewer.download':  { ar: 'تنزيل',    en: 'Download' },
    'viewer.like':      { ar: 'إعجاب',    en: 'Like' },
    'comments.title':   { ar: 'التعليقات', en: 'Comments' },
    'comments.empty':   { ar: 'لا تعليقات بعد — كن أوّل من يضيف ما يعرفه عن هذه الذكرى.',
                          en: 'No comments yet — be the first to add what you know about this memory.' },
    'comments.locked':  { ar: 'سجّل الدخول لتضيف تعليقًا أو ذكرى',
                          en: 'Sign in to add a comment or a memory' },
    'comments.lockedShort': { ar: 'سجّل الدخول لتعلّق أو تحفظ هذه الذكرى',
                              en: 'Sign in to comment on or save this memory' },

    // ── Sign-in gate ────────────────────────────────────────
    'gate.title':  { ar: 'سجّل الدخول لتتفاعل مع هذه الذكرى',
                     en: 'Sign in to take part in this memory' },
    'gate.blurb':  { ar: 'الإعجاب والتعليق والحفظ متاحة لأعضاء الأرشيف. ستعود إلى هذه الذكرى تمامًا حيث توقفت.',
                     en: 'Liking, commenting and saving are for archive members. You will come back to this memory exactly where you left it.' },
    'gate.create': { ar: 'إنشاء حساب جديد', en: 'Create a new account' },
    'gate.keep':   { ar: 'متابعة التصفّح دون حساب', en: 'Keep browsing without an account' },

    // ── Auth ────────────────────────────────────────────────
    'signup.title':  { ar: 'انضمّ إلى ذاكرة رام الله', en: 'Join the Ramallah Memory Atlas' },
    'signup.blurb':  { ar: 'حساب واحد — لتشارك، وتعلّق، وتحفظ ما يعنيك.',
                       en: 'One account — to share, comment, and keep what matters to you.' },
    'signup.submit': { ar: 'إنشاء الحساب', en: 'Create account' },
    'signup.haveAcct': { ar: 'لديك حساب؟', en: 'Already have an account?' },
    'login.title':   { ar: 'أهلًا بعودتك', en: 'Welcome back' },
    'login.blurb':   { ar: 'الذاكرة بانتظارك — تابع من حيث توقفت.',
                       en: 'The memory is waiting — pick up where you left off.' },
    'login.submit':  { ar: 'تسجيل الدخول', en: 'Sign in' },
    'login.newHere': { ar: 'جديد هنا؟',    en: 'New here?' },
    'login.createOne': { ar: 'أنشئ حسابًا', en: 'Create an account' },
    'login.forgot':  { ar: 'نسيت كلمة المرور؟', en: 'Forgot password?' },
    'login.remember':{ ar: 'تذكّرني على هذا الجهاز', en: 'Remember me on this device' },

    'field.name':      { ar: 'الاسم الكامل', en: 'Full name' },
    'field.namePh':    { ar: 'كما تحب أن يظهر مع مساهماتك', en: "As you'd like it to appear with your contributions" },
    'field.email':     { ar: 'البريد الإلكتروني', en: 'Email' },
    'field.password':  { ar: 'كلمة المرور', en: 'Password' },
    'field.city':      { ar: 'مدينتك الحالية', en: 'Current city' },
    'field.optional':  { ar: '— اختياري', en: '— optional' },
    'field.cityPh':    { ar: 'رام الله، عمّان، ديترويت…', en: 'Ramallah, Amman, Detroit…' },
    'auth.pact':       { ar: 'بإنشاء الحساب توافق على ميثاق المجتمع: احترام أصحاب الذكريات، ودقة النسبة والتاريخ قدر المستطاع.',
                         en: 'By creating an account you agree to the community pact: respect the owners of memories, and attribute and date as accurately as you can.' },
    'auth.or':         { ar: 'أو', en: 'or' },
    'auth.google':     { ar: 'غوغل', en: 'Google' },
    'auth.apple':      { ar: 'آبل', en: 'Apple' },

    // ── Share sheet ─────────────────────────────────────────
    'share.title':  { ar: 'شارك ذكرى', en: 'Share a memory' },
    'share.blurb':  { ar: 'ذاكرة المدينة تكبر بما تضيفه إليها.', en: "The city's memory grows with what you add to it." },
    'share.photo':  { ar: 'صورة / فيديو', en: 'Photo / video' },
    'share.voice':  { ar: 'تسجيل صوتي',   en: 'Voice recording' },
    'share.event':  { ar: 'فعالية',        en: 'Event' },
    'share.fTitle': { ar: 'العنوان',       en: 'Title' },
    'share.fTitlePh': { ar: 'مثال: عرس في حارة الساحة، ١٩٦٣', en: 'e.g. A wedding in Haret al-Saha, 1963' },
    'share.fPlace': { ar: 'المكان',        en: 'Place' },
    'share.fPlacePh': { ar: 'اختر من الخريطة أو اكتب اسمه', en: 'Pick from the map or type its name' },
    'share.fDecade':{ ar: 'العقد',         en: 'Decade' },
    'share.fStory': { ar: 'القصة',         en: 'The story' },
    'share.fStoryPh': { ar: 'ما الذي تذكره — أو تذكره عائلتك — من هذه اللحظة؟',
                        en: 'What do you — or your family — remember of this moment?' },
    'share.drop':   { ar: 'اسحب الملف إلى هنا أو تصفّح جهازك', en: 'Drag the file here, or browse your device' },
    'share.dropNote': { ar: 'JPG · PNG · MP3 · MP4 — حتى ٥٠ ميغابايت', en: 'JPG · PNG · MP3 · MP4 — up to 50 MB' },
    'share.review': { ar: 'تمرّ كل مساهمة بمراجعة الفريق قبل النشر. نتعهّد بالردّ خلال ٤٨ ساعة.',
                      en: 'Every contribution is reviewed by the team before publishing. We promise a reply within 48 hours.' },
    'share.submit': { ar: 'أرسل للمراجعة', en: 'Send for review' },
    'share.sent':   { ar: 'وصلتنا مساهمتك — سنردّ خلال ٤٨ ساعة.', en: 'We have your contribution — we will reply within 48 hours.' },

    // ── Map ─────────────────────────────────────────────────
    'map.inView':  { ar: '{n} ذكرى ضمن العرض', en: '{n} memories in view' },
    'map.decade':  { ar: 'العقد', en: 'Decade' },
    'map.all':     { ar: 'الكل',  en: 'All' },
    'map.back':    { ar: '✕ العودة إلى الخريطة', en: '✕ Back to the map' },

    // ── Events ──────────────────────────────────────────────
    'events.title':   { ar: 'فعاليات حول الذاكرة', en: 'Events around the memory' },
    'events.blurb':   { ar: 'معارض وجولات وورشات ينظّمها الأرشيف وأهل المدينة — في رام الله وعبر الإنترنت.',
                        en: 'Exhibitions, tours and workshops run by the archive and by the city — in Ramallah and online.' },
    'events.count':   { ar: '{n} فعاليات قادمة', en: '{n} upcoming events' },
    'publisher.municipality': { ar: 'بلدية رام الله', en: 'Ramallah Municipality' },
    'publisher.community':    { ar: 'مساهمة مجتمعية', en: 'Community submission' },
    'publisher.team':         { ar: 'فريق الأرشيف',   en: 'Archive team' },

    // ── Media kinds & decades ───────────────────────────────
    'kind.photo': { ar: 'صورة',        en: 'Photo' },
    'kind.voice': { ar: 'صوت',         en: 'Voice' },
    'kind.video': { ar: 'فيديو',       en: 'Video' },
    'kind.event': { ar: 'فعالية',      en: 'Event' },
    'kind.oral':  { ar: 'رواية شفوية', en: 'Oral history' },

    'decade.1950': { ar: 'الخمسينيات', en: '1950s' },
    'decade.1960': { ar: 'الستينيات',  en: '1960s' },
    'decade.1970': { ar: 'السبعينيات', en: '1970s' },
    'decade.1980': { ar: 'الثمانينيات', en: '1980s' },
    'decade.1990': { ar: 'التسعينيات', en: '1990s' },
    'decade.2000': { ar: 'الألفان',     en: '2000s' },
    'decade.2010': { ar: 'العشرينيات',  en: '2010s' },

    // ── Admin: rail & shared ────────────────────────────────
    'admin.overview': { ar: 'نظرة عامة',       en: 'Overview' },
    'admin.queue':    { ar: 'قائمة المراجعة',  en: 'Review queue' },
    'admin.archive':  { ar: 'الأرشيف المنشور', en: 'Published archive' },
    'admin.events':   { ar: 'الفعاليات',       en: 'Events' },
    'admin.places':   { ar: 'الأماكن والخريطة', en: 'Places & map' },
    'admin.members':  { ar: 'الأعضاء',         en: 'Members' },
    'admin.reports':  { ar: 'البلاغات',        en: 'Reports' },
    'admin.settings': { ar: 'الإعدادات',       en: 'Settings' },
    'admin.backToSite': { ar: '← عودة إلى الموقع', en: '← Back to the site' },
    'admin.me':       { ar: 'هناء ع.',          en: 'Hana A.' },
    'admin.myRole':   { ar: 'محرّرة أرشيف',     en: 'Archive editor' },

    // ── Admin: overview ─────────────────────────────────────
    'ov.greeting':   { ar: 'صباح الخير، هناء', en: 'Good morning, Hana' },
    'ov.today':      { ar: 'الأحد ٨ آذار · {n} مساهمات يقترب موعد الردّ عليها',
                       en: 'Sunday 8 March · {n} contributions approaching their deadline' },
    'ov.start':      { ar: 'ابدأ المراجعة', en: 'Start reviewing' },
    'ov.pending':    { ar: 'بانتظار المراجعة', en: 'Awaiting review' },
    'ov.pendingNote':{ ar: 'متوسط زمن الردّ ١٩ ساعة', en: 'Median reply time 19 hours' },
    'ov.published':  { ar: 'نُشرت هذا الأسبوع', en: 'Published this week' },
    'ov.publishedNote': { ar: '+١٤٪ عن الأسبوع الماضي', en: '+14% on last week' },
    'ov.newMembers': { ar: 'أعضاء جدد', en: 'New members' },
    'ov.newMembersNote': { ar: '٣١٪ منهم من الشتات', en: '31% of them from the diaspora' },
    'ov.audioHours': { ar: 'ساعات الصوت المحفوظة', en: 'Hours of audio kept' },
    'ov.audioNote':  { ar: 'من ٢٠٤ رواة', en: 'from 204 narrators' },
    'ov.intake':     { ar: 'المساهمات الواردة شهريًا', en: 'Contributions received monthly' },
    'ov.intakeRange':{ ar: 'آخر ١٢ شهرًا', en: 'Last 12 months' },
    'ov.totalPublished': { ar: '٣٬٤١٢ مساهمة منشورة إجمالًا', en: '3,412 contributions published in total' },
    'ov.mapped':     { ar: '٩١٪ منها موقّعة على الخريطة', en: '91% of them placed on the map' },
    'ov.gaps':       { ar: 'فجوات في التغطية', en: 'Gaps in coverage' },
    'ov.gapsNote':   { ar: 'الخمسينيات وحيّ الطيرة الأقل تمثيلًا — مرشّحان لجولة جمع ميدانية.',
                       en: 'The 1950s and al-Tireh are the least represented — both candidates for a field-collection round.' },
    'ov.latest':     { ar: 'آخر ما جرى', en: 'Latest activity' },

    // ── Admin: queue ────────────────────────────────────────
    'q.title':     { ar: 'قائمة المراجعة', en: 'Review queue' },
    'q.sub':       { ar: '{n} مساهمة بانتظار القرار · نتعهّد بالردّ خلال ٤٨ ساعة',
                     en: '{n} contributions awaiting a decision · we promise a reply within 48 hours' },
    'q.searchPh':  { ar: 'ابحث في المساهمات…', en: 'Search contributions…' },
    'q.oldest':    { ar: 'الأقدم أولًا', en: 'Oldest first' },
    'q.all':       { ar: 'الكل', en: 'All' },
    'q.photos':    { ar: 'صور', en: 'Photos' },
    'q.voice':     { ar: 'تسجيلات صوتية', en: 'Voice' },
    'q.video':     { ar: 'فيديو', en: 'Video' },
    'q.events':    { ar: 'فعاليات', en: 'Events' },
    'q.dueSoon':   { ar: 'يقترب موعدها', en: 'Due soon' },
    'q.awaiting':  { ar: 'بانتظار المراجعة', en: 'Awaiting review' },
    'q.inThis':    { ar: '{n} صور في هذه المساهمة', en: '{n} images in this contribution' },
    'q.place':     { ar: 'المكان', en: 'Place' },
    'q.decade':    { ar: 'العقد', en: 'Decade' },
    'q.tags':      { ar: 'الوسوم', en: 'Tags' },
    'q.addTag':    { ar: '+ وسم', en: '+ tag' },
    'q.consent':   { ar: 'أقرّ بحقوق المشاركة ووافق على العرض العام.',
                     en: 'Confirmed the sharing rights and agreed to public display.' },
    'q.internalNote': { ar: 'ملاحظة داخلية للفريق', en: 'Internal note for the team' },
    'q.internalNotePh': { ar: 'اكتب ملاحظة لا تظهر للمساهم…', en: 'A note the contributor never sees…' },
    'q.arrived':   { ar: 'وصلت {a} · يتبقّى {b} على الموعد',
                     en: 'Arrived {a} · {b} left on the promise' },
    'q.reject':    { ar: 'رفض', en: 'Reject' },
    'q.sendBack':  { ar: 'إعادة للمساهم مع ملاحظة', en: 'Send back with a note' },
    'q.publish':   { ar: 'نشر في الأرشيف', en: 'Publish to the archive' },
    'q.empty':     { ar: 'لا مساهمات في هذا التصنيف.', en: 'No contributions in this filter.' },
    'q.published': { ar: 'نُشرت «{t}» في الأرشيف.', en: '"{t}" is published to the archive.' },
    'q.sentBack':  { ar: 'أُعيدت «{t}» إلى صاحبها مع ملاحظتك.', en: '"{t}" went back to its contributor with your note.' },
    'q.rejected':  { ar: 'رُفضت «{t}».', en: '"{t}" was rejected.' },
    'q.clear':     { ar: 'انتهت القائمة — لا شيء بانتظار القرار.', en: 'Queue clear — nothing awaiting a decision.' },

    // ── Admin: published archive ────────────────────────────
    'ar.title':   { ar: 'الأرشيف المنشور', en: 'Published archive' },
    'ar.sub':     { ar: '٣٬٤١٢ ذكرى منشورة · آخر نشر قبل ١٢ دقيقة',
                    en: '3,412 memories published · last publish 12 minutes ago' },
    'ar.add':     { ar: '+ إضافة ذكرى', en: '+ Add a memory' },
    'ar.filterMore': { ar: '+ فلترة بالعقد أو المكان', en: '+ Filter by decade or place' },
    'ar.export':  { ar: 'تصدير CSV', en: 'Export CSV' },
    'ar.colTitle':{ ar: 'العنوان', en: 'Title' },
    'ar.colBy':   { ar: 'المساهم', en: 'Contributor' },
    'ar.colPlace':{ ar: 'المكان', en: 'Place' },
    'ar.colDecade': { ar: 'العقد', en: 'Decade' },
    'ar.colDate': { ar: 'تاريخ النشر', en: 'Published' },
    'ar.colViews':{ ar: 'مشاهدات', en: 'Views' },
    'ar.showing': { ar: 'تعرض {n} من ٣٬٤١٢', en: 'Showing {n} of 3,412' },
    'ar.next':    { ar: 'التالي', en: 'Next' },
    'ar.exported':{ ar: 'جُهّز ملف CSV للتنزيل.', en: 'CSV file prepared for download.' },

    // ── Admin: events ───────────────────────────────────────
    'ae.title':    { ar: 'الفعاليات', en: 'Events' },
    'ae.sub':      { ar: '{n} بانتظار الموافقة · ٦ منشورة قادمة',
                     en: '{n} awaiting approval · 6 published and upcoming' },
    'ae.add':      { ar: '+ فعالية من الفريق', en: '+ Event from the team' },
    'ae.pending':  { ar: 'بانتظار الموافقة', en: 'Awaiting approval' },
    'ae.live':     { ar: 'منشورة', en: 'Published' },
    'ae.desc':     { ar: 'وصف الفعالية', en: 'Event description' },
    'ae.date':     { ar: 'التاريخ', en: 'Date' },
    'ae.time':     { ar: 'الوقت', en: 'Time' },
    'ae.venue':    { ar: 'المكان', en: 'Venue' },
    'ae.seats':    { ar: 'المقاعد', en: 'Seats' },
    'ae.category': { ar: 'التصنيف', en: 'Category' },
    'ae.note':     { ar: 'عند الموافقة تظهر الفعالية في صفحة الفعاليات وتُرسل للمشتركين في النشرة.',
                     en: 'On approval the event appears on the events page and goes out to newsletter subscribers.' },
    'ae.submitted':{ ar: 'قُدّمت {a}', en: 'Submitted {a}' },
    'ae.requestEdit': { ar: 'طلب تعديل', en: 'Request changes' },
    'ae.approve':  { ar: 'نشر الفعالية', en: 'Publish event' },
    'ae.approved': { ar: 'نُشرت «{t}» وأُرسلت في النشرة.', en: '"{t}" is published and went out in the newsletter.' },
    'ae.empty':    { ar: 'لا فعاليات بانتظار الموافقة.', en: 'No events awaiting approval.' },

    // ── Admin: places ───────────────────────────────────────
    'pl.title':   { ar: 'الأماكن والخريطة', en: 'Places & map' },
    'pl.sub':     { ar: '{n} مكانًا موثّقًا · ٩١٪ من الذكريات موقّعة',
                    en: '{n} documented places · 91% of memories placed' },
    'pl.add':     { ar: '+ مكان جديد', en: '+ New place' },
    'pl.searchPh':{ ar: 'ابحث عن مكان…', en: 'Search for a place…' },
    'pl.count':   { ar: '{n} ذكرى', en: '{n} memories' },
    'pl.merge':   { ar: 'مكانان متشابهان: «شارع ركب» و«ركب ستريت» — يُقترح دمجهما.',
                    en: 'Two similar places: "شارع ركب" and "Rukab Street" — a merge is suggested.' },
    'pl.mergeBtn':{ ar: 'دمج', en: 'Merge' },
    'pl.merged':  { ar: 'دُمج المكانان في «شارع ركب».', en: 'Both places merged into "Rukab Street".' },
    'pl.legend':  { ar: 'اسحب الدبوس لتصحيح الإحداثيات · أصفر = مكان بلا إحداثيات مؤكدة',
                    en: 'Drag a pin to correct its coordinates · yellow = no confirmed coordinates' },
    'pl.oldest':  { ar: '{n} ذكرى · أقدمها {y} · أحدثها الأسبوع الماضي',
                    en: '{n} memories · earliest {y} · latest last week' },
    'pl.editCoords': { ar: 'تحرير الاسم والإحداثيات', en: 'Edit name and coordinates' },
    'pl.viewMemories': { ar: 'عرض الذكريات', en: 'View memories' },
    'pl.moved':   { ar: 'حُدّثت إحداثيات «{t}».', en: 'Coordinates updated for "{t}".' },

    // ── Admin: members ──────────────────────────────────────
    'mb.title':   { ar: 'الأعضاء', en: 'Members' },
    'mb.sub':     { ar: '٤٬٨١٠ أعضاء · ١٤٢ انضموا هذا الشهر',
                    en: '4,810 members · 142 joined this month' },
    'mb.invite':  { ar: '+ دعوة عضو للفريق', en: '+ Invite a team member' },
    'mb.all':     { ar: 'الكل', en: 'All' },
    'mb.contributors': { ar: 'مساهمون', en: 'Contributors' },
    'mb.team':    { ar: 'فريق الأرشيف', en: 'Archive team' },
    'mb.partners':{ ar: 'شركاء', en: 'Partners' },
    'mb.suspended': { ar: 'موقوفون', en: 'Suspended' },
    'mb.searchPh':{ ar: 'ابحث بالاسم أو البريد…', en: 'Search by name or email…' },
    'mb.colMember': { ar: 'العضو', en: 'Member' },
    'mb.colRole': { ar: 'الدور', en: 'Role' },
    'mb.colContribs': { ar: 'مساهمات', en: 'Contributions' },
    'mb.colCity': { ar: 'المدينة', en: 'City' },
    'mb.colJoined': { ar: 'انضم', en: 'Joined' },
    'mb.colStatus': { ar: 'الحالة', en: 'Status' },
    'mb.role':    { ar: 'الدور', en: 'Role' },
    'mb.rolePartner': { ar: 'شريك', en: 'Partner' },
    'mb.roleNarrator': { ar: 'راوية', en: 'Narrator' },
    'mb.roleAdminShort': { ar: 'مديرة', en: 'Admin' },
    'mb.roleContributorF': { ar: 'مساهِمة', en: 'Contributor' },
    'mb.roleContributorM': { ar: 'مساهِم', en: 'Contributor' },
    'mb.roleContributor': { ar: 'مساهِم — يرفع ويعلّق', en: 'Contributor — uploads and comments' },
    'mb.roleEditor': { ar: 'محرّر — يراجع وينشر', en: 'Editor — reviews and publishes' },
    'mb.roleAdmin': { ar: 'مدير — كل الصلاحيات', en: 'Admin — every permission' },
    'mb.factPublished': { ar: '{a} مساهمات منشورة · {b} بانتظار المراجعة',
                          en: '{a} contributions published · {b} awaiting review' },
    'mb.factLast': { ar: 'آخر نشاط: {a}', en: 'Last active: {a}' },
    'mb.factClean': { ar: 'لا بلاغات على مساهماته', en: 'No reports on their contributions' },
    'mb.save':    { ar: 'حفظ التغييرات', en: 'Save changes' },
    'mb.suspend': { ar: 'إيقاف الحساب مؤقتًا', en: 'Suspend the account' },
    'mb.restore': { ar: 'إعادة تفعيل الحساب', en: 'Restore the account' },
    'mb.saved':   { ar: 'حُفظ دور «{t}».', en: 'Role saved for "{t}".' },
    'mb.suspended.done': { ar: 'أُوقف حساب «{t}» مؤقتًا.', en: '"{t}" is suspended.' },
    'mb.restored': { ar: 'أُعيد تفعيل حساب «{t}».', en: '"{t}" is active again.' },
    'status.active': { ar: 'نشط', en: 'Active' },
    'status.activeF': { ar: 'نشطة', en: 'Active' },
    'status.suspended': { ar: 'موقوف مؤقتًا', en: 'Suspended' },

    // ── Admin: reports ──────────────────────────────────────
    'rp.title':   { ar: 'البلاغات', en: 'Reports' },
    // Phrased as "label: count" so it stays grammatical at any number.
    'rp.sub':     { ar: 'بلاغات مفتوحة: {n} · ٣١ مغلقًا هذا العام',
                    en: 'Open reports: {n} · 31 closed this year' },
    'rp.count':   { ar: 'بلاغات: {n}', en: 'Reports: {n}' },
    'rp.open':    { ar: 'مفتوحة', en: 'Open' },
    'rp.closed':  { ar: 'مغلقة', en: 'Closed' },
    'rp.avgClose':{ ar: 'متوسط زمن إغلاق البلاغ: ١١ ساعة.', en: 'Median time to close a report: 11 hours.' },
    'rp.reason':  { ar: 'سبب البلاغ: {r}', en: 'Reason: {r}' },
    'rp.reportedBy': { ar: 'أبلغ عنه: {n} · {a}', en: 'Reported by {n} · {a}' },
    'rp.content': { ar: 'المحتوى المُبلَّغ عنه', en: 'The reported content' },
    'rp.onMemory':{ ar: 'على ذكرى: «{t}» · مساهمة {n} · منشورة',
                    en: 'On the memory "{t}" · contributed by {n} · published' },
    'rp.message': { ar: 'رسالة إلى صاحب المحتوى (اختيارية)', en: 'Message to the author (optional)' },
    'rp.messagePh': { ar: 'اشرح القرار بلغة ودّية — يصل نصّها كما هو.',
                      en: 'Explain the decision kindly — it is sent exactly as written.' },
    'rp.suggest1':{ ar: 'حفظ الذاكرة، تصحيح التعليق', en: 'Keep the memory, correct the comment' },
    'rp.suggest2':{ ar: 'طلب مصدر من الطرفين', en: 'Ask both sides for a source' },
    'rp.suggest3':{ ar: 'نقاش عام مفتوح', en: 'Open a public discussion' },
    'rp.logged':  { ar: 'القرار يُسجَّل في سجلّ الإدارة ويظهر للفريق فقط',
                    en: 'The decision is written to the admin log, visible to the team only' },
    'rp.delete':  { ar: 'حذف التعليق', en: 'Delete the comment' },
    'rp.hide':    { ar: 'إخفاء ريثما يُراجع', en: 'Hide pending review' },
    'rp.keep':    { ar: 'إبقاء المحتوى وإغلاق البلاغ', en: 'Keep the content and close the report' },
    'rp.closedOne': { ar: 'أُغلق البلاغ.', en: 'Report closed.' },
    'rp.empty':   { ar: 'لا بلاغات مفتوحة.', en: 'No open reports.' },
    'reason.false': { ar: 'معلومة مغلوطة', en: 'Inaccurate information' },
    'reason.privacy': { ar: 'خصوصية', en: 'Privacy' },

    // ── Admin: settings ─────────────────────────────────────
    'st.title':   { ar: 'الإعدادات', en: 'Settings' },
    'st.sub':     { ar: 'إعدادات الأرشيف والمراجعة والفريق', en: 'Archive, review and team settings' },
    'st.secArchive':  { ar: 'الأرشيف', en: 'Archive' },
    'st.secReview':   { ar: 'المراجعة والنشر', en: 'Review & publishing' },
    'st.secLangs':    { ar: 'اللغات', en: 'Languages' },
    'st.secTaxonomy': { ar: 'التصنيفات', en: 'Categories' },
    'st.secTeam':     { ar: 'الفريق والدعوات', en: 'Team & invitations' },
    'st.secBackup':   { ar: 'النسخ والتصدير', en: 'Backup & export' },
    'st.sla':     { ar: 'مهلة الردّ على المساهمات', en: 'Reply deadline for contributions' },
    'st.slaHint': { ar: 'الوعد المعروض للمساهمين على الموقع', en: 'The promise shown to contributors on the site' },
    'st.warn':    { ar: 'تنبيه اقتراب الموعد', en: 'Deadline warning' },
    'st.warnOn':  { ar: 'ينبّه الفريق قبل ٦ ساعات من انتهاء المهلة', en: 'Warns the team 6 hours before the deadline' },
    'st.warnOff': { ar: 'لا تنبيه قبل انتهاء المهلة', en: 'No warning before the deadline' },
    'st.auto':    { ar: 'نشر تلقائي للأعضاء الموثّقين', en: 'Auto-publish for verified members' },
    'st.autoHint':{ ar: 'يُنصح بإبقائه موقوفًا في السنة الأولى', en: 'Best left off through the first year' },
    'st.autoOn':  { ar: 'مفعّل — يُنشر للموثّقين دون مراجعة', en: 'On — verified members publish without review' },
    'st.autoOff': { ar: 'موقوف — كل مساهمة تمرّ بمراجعة بشرية', en: 'Off — every contribution gets a human review' },
    'st.reviewers': { ar: 'عدد المراجعين لكل مساهمة', en: 'Reviewers per contribution' },
    'st.reviewers1': { ar: 'مراجع واحد', en: 'One reviewer' },
    'st.reviewers2': { ar: 'مراجعان', en: 'Two reviewers' },
    'st.sendBackText': { ar: 'نصّ الردّ عند الإعادة للمساهم', en: 'Reply text when sending back' },
    'st.sendBackHint': { ar: 'يُرسل مع ملاحظة المحرّر', en: 'Sent alongside the editor note' },
    'st.sendBackDefault': { ar: 'شكرًا لمشاركتك هذه الذاكرة. نحتاج تفصيلًا صغيرًا قبل نشرها…',
                            en: 'Thank you for sharing this memory. We need one small detail before publishing…' },
    'st.comments': { ar: 'مراجعة التعليقات', en: 'Comment moderation' },
    'st.commentsOn': { ar: 'تُنشر التعليقات فورًا وتُراجع عند الإبلاغ',
                       en: 'Comments post immediately and are reviewed when reported' },
    'st.commentsOff': { ar: 'كل تعليق يُراجع قبل ظهوره', en: 'Every comment is reviewed before it appears' },
    'st.save':    { ar: 'حفظ الإعدادات', en: 'Save settings' },
    'st.lastEdit':{ ar: 'آخر تعديل: هناء ع. · ٤ آذار ٢٠٢٦', en: 'Last edited by Hana A. · 4 March 2026' },
    'st.saved':   { ar: 'حُفظت الإعدادات.', en: 'Settings saved.' },
    'st.sectionSoon': { ar: 'هذا القسم من الإعدادات لم يُبنَ بعد.', en: 'This settings section is not built yet.' },

    // ── Time ────────────────────────────────────────────────
    'time.hours':    { ar: '{n} ساعة',      en: '{n} hours' },
    'time.hoursOpt': { ar: '{n} ساعة',      en: '{n}h' },
    'time.ago':      { ar: 'قبل {n} ساعة',  en: '{n} hours ago' },
    'time.minutes':  { ar: '{n} دقيقة',     en: '{n} minutes' },
    'time.days':     { ar: '{n} يوم',       en: '{n} days' },
    'time.weeks':    { ar: '{n} أسبوع',     en: '{n} weeks' }
  };

  var lang = read();

  function read() {
    // ?lang=en wins, so a link can carry the language it was read in.
    var fromUrl = /[?&]lang=(ar|en)\b/.exec(global.location.search);
    if (fromUrl) return fromUrl[1];
    try {
      var stored = global.localStorage.getItem(STORAGE_KEY);
      if (stored === 'ar' || stored === 'en') return stored;
    } catch (e) { /* private mode — fall through to the default */ }
    return 'ar';
  }

  /** Arabic-Indic digits with the Arabic thousands separator. */
  function toArabicDigits(str) {
    return String(str).replace(/[0-9]/g, function (d) { return ARABIC_DIGITS[+d]; });
  }

  /** Format a number for the active language, with thousands grouping. */
  function num(value) {
    var grouped = String(value).replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'ar' ? '٬' : ',');
    return lang === 'ar' ? toArabicDigits(grouped) : grouped;
  }

  /** A year is a label, not a quantity — never grouped. */
  function year(value) {
    return lang === 'ar' ? toArabicDigits(value) : String(value);
  }

  /** Look up a string, substituting {placeholders}. */
  function t(key, vars) {
    var entry = STRINGS[key];
    if (!entry) return key;
    var out = entry[lang] != null ? entry[lang] : entry.ar;
    if (vars) {
      out = out.replace(/\{(\w+)\}/g, function (match, name) {
        return name in vars ? vars[name] : match;
      });
    }
    return out;
  }

  /** Pick the active-language side of a {ar, en} content pair. */
  function pick(pair) {
    if (pair == null) return '';
    if (typeof pair === 'string') return pair;
    return pair[lang] != null ? pair[lang] : pair.ar;
  }

  /** Pick the *other* language — used for the gloss line under every title. */
  function gloss(pair) {
    if (pair == null || typeof pair === 'string') return '';
    return lang === 'ar' ? pair.en : pair.ar;
  }

  function apply() {
    var root = global.document.documentElement;
    root.lang = lang;
    root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }

  function set(next) {
    if (next !== 'ar' && next !== 'en') return;
    lang = next;
    try { global.localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* non-fatal */ }
    apply();
    global.dispatchEvent(new CustomEvent('langchange', { detail: { lang: lang } }));
  }

  apply();

  global.I18N = {
    get lang() { return lang; },
    get dir() { return lang === 'ar' ? 'rtl' : 'ltr'; },
    set: set,
    toggle: function () { set(lang === 'ar' ? 'en' : 'ar'); },
    t: t,
    num: num,
    year: year,
    pick: pick,
    gloss: gloss,
    digits: toArabicDigits
  };
})(window);
