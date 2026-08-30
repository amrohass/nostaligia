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
    'hero.decades':   { ar: 'سبعة عقود',        en: 'seven decades' },
    'feed.more':      { ar: 'يُحمَّل المزيد أثناء التمرير', en: 'more loads as you scroll' },

    // ── Footer ──────────────────────────────────────────────
    'footer.blurb':   { ar: 'أرشيف مجتمعيّ مستقل لذاكرة رام الله وأهلها — تُدار مواده بعناية تحريرية وتُتاح للجميع.',
                        en: "An independent community archive of Ramallah's memory — carefully curated, open to all." },
    'footer.project': { ar: 'المشروع',           en: 'The project' },
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
    'viewer.like':      { ar: 'إعجاب',    en: 'Like' },
    'comments.title':   { ar: 'التعليقات', en: 'Comments' },
    'comments.empty':   { ar: 'لا تعليقات بعد — كن أوّل من يضيف ما يعرفه عن هذه الذكرى.',
                          en: 'No comments yet — be the first to add what you know about this memory.' },
    'comments.locked':  { ar: 'سجّل الدخول لتضيف تعليقًا أو ذكرى',
                          en: 'Sign in to add a comment or a memory' },

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

    'field.email':     { ar: 'البريد الإلكتروني', en: 'Email' },
    'field.password':  { ar: 'كلمة المرور', en: 'Password' },
    'auth.pact':       { ar: 'بإنشاء الحساب توافق على ميثاق المجتمع: احترام أصحاب الذكريات، ودقة النسبة والتاريخ قدر المستطاع.',
                         en: 'By creating an account you agree to the community pact: respect the owners of memories, and attribute and date as accurately as you can.' },
    // Google and Apple are gone, not hidden. CLAUDE.md §2: email + password only. The
    // buttons were prototype decoration and a social provider is not something to leave a
    // string lying around for.
    'auth.confirmSent': { ar: 'أرسلنا رسالة تأكيد إلى بريدك. افتحها لتفعيل حسابك.',
                          en: 'We have sent a confirmation email. Open it to activate your account.' },
    'auth.working':     { ar: 'لحظة…', en: 'One moment…' },

    // ── Auth refusals ───────────────────────────────────────
    // Mapped from the Auth API's own codes in auth.js. Its raw messages are English, shift
    // between versions, and occasionally say more than a visitor should be told.
    'auth.err.credentials':   { ar: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
                                en: 'That email or password is not right.' },
    'auth.err.emailTaken':    { ar: 'هذا البريد مسجَّل لدينا. جرّب تسجيل الدخول.',
                                en: 'That email is already registered. Try signing in.' },
    'auth.err.weakPassword':  { ar: 'كلمة المرور قصيرة جدًا — ثمانية أحرف على الأقل.',
                                en: 'That password is too short — eight characters at least.' },
    'auth.err.rateLimit':     { ar: 'محاولات كثيرة خلال وقت قصير. انتظر قليلًا ثم أعد المحاولة.',
                                en: 'Too many attempts just now. Wait a little and try again.' },
    'auth.err.unconfirmed':   { ar: 'فعِّل حسابك من رسالة التأكيد التي وصلتك أولًا.',
                                en: 'Activate your account from the confirmation email first.' },
    'auth.err.invalidEmail':  { ar: 'تحقّق من صيغة البريد الإلكتروني.',
                                en: 'Check the format of that email address.' },
    'auth.err.signedOut':     { ar: 'انتهت جلستك. سجّل الدخول من جديد.',
                                en: 'Your session ended. Please sign in again.' },
    'auth.err.offline':       { ar: 'لا يوجد اتصال. تحقّق من الشبكة وأعد المحاولة.',
                                en: 'No connection. Check the network and try again.' },
    'auth.err.notConfigured': { ar: 'تسجيل الدخول غير مهيّأ على هذه النسخة بعد.',
                                en: 'Sign-in is not configured on this deployment yet.' },
    'auth.err.generic':       { ar: 'تعذّر إتمام الطلب. أعد المحاولة بعد قليل.',
                                en: 'That did not go through. Try again shortly.' },

    // ── Upload refusals ─────────────────────────────────────
    // One message per refusal request-upload and complete-upload can return. A generic
    // "something went wrong" over a quota ceiling or an oversized file is worse than
    // useless — the member retries the identical upload and gets the identical nothing.
    'up.err.svg':        { ar: 'صيغة SVG غير مقبولة في الأرشيف.', en: 'SVG files are not accepted.' },
    'up.err.type':       { ar: 'صيغة الملف غير مدعومة.', en: 'That file type is not supported.' },
    'up.err.tooBig':     { ar: 'الملف أكبر من الحدّ المسموح ({n} ميغابايت).',
                           en: 'That file is over the size limit ({n} MB).' },
    'up.err.tooLong':    { ar: 'المقطع أطول من الحدّ المسموح ({n} دقيقة).',
                           en: 'That clip is longer than the limit ({n} minutes).' },
    'up.err.duration':   { ar: 'تعذّر قراءة مدة المقطع. جرّب ملفًا آخر.',
                           en: 'The length of that clip could not be read. Try another file.' },
    'up.err.robot':      { ar: 'أكمل التحقّق من أنك لست روبوتًا.', en: 'Complete the human check first.' },
    'up.err.robotUnavailable': { ar: 'تعذّر تحميل أداة التحقّق. عطّل مانع الإعلانات وأعد المحاولة.',
                                 en: 'The human check could not load. Disable your ad blocker and retry.' },
    'up.err.signedOut':  { ar: 'انتهت جلستك. سجّل الدخول ثم أعد الإرسال.',
                           en: 'Your session ended. Sign in and send again.' },
    'up.err.quota':      { ar: 'بلغت حدّك اليومي للرفع. جرّب غدًا.',
                           en: 'You have reached your daily upload limit. Try tomorrow.' },
    'up.err.title':      { ar: 'العنوان مطلوب.', en: 'A title is required.' },
    'up.err.description':{ ar: 'الوصف مطلوب — هو ما يجعل المادة قابلة للبحث لاحقًا.',
                           en: 'A description is required — it is what makes this findable later.' },
    'up.err.license':    { ar: 'اختر رخصة للمادة قبل الإرسال.',
                           en: 'Choose a licence for this material before sending.' },
    'up.err.licenseUnknown': { ar: 'الرخصة المختارة غير معروفة. اختر واحدة من القائمة.',
                               en: 'That licence is not one we can record. Pick one from the list.' },
    'up.err.provenance': { ar: 'من أين جاءت هذه المادة؟ الحقل مطلوب.',
                           en: 'Where did this come from? The field is required.' },
    'up.err.consent':    { ar: 'أكّد أنّ لديك الحقّ في مشاركة هذه المادة.',
                           en: 'Confirm that you have the right to share this material.' },
    'up.err.alreadyDone':{ ar: 'عولجت هذه المساهمة سابقًا.', en: 'This contribution was already processed.' },
    'up.err.retriesSpent': { ar: 'استُنفدت محاولات المعالجة لهذا الملف. ارفعه من جديد.',
                             en: 'Processing attempts for this file are used up. Upload it again.' },
    'up.err.processing': { ar: 'تعذّر بدء المعالجة. أعد المحاولة بعد قليل.',
                           en: 'Processing could not start. Try again shortly.' },
    'up.err.transfer':   { ar: 'انقطع الرفع قبل اكتماله.', en: 'The upload stopped before it finished.' },
    'up.err.cancelled':  { ar: 'أُلغي الرفع.', en: 'Upload cancelled.' },
    'up.err.empty':      { ar: 'الملف فارغ.', en: 'That file is empty.' },
    'up.err.noFile':     { ar: 'اختر ملفًا أولًا.', en: 'Choose a file first.' },
    'up.err.offline':    { ar: 'لا يوجد اتصال. تحقّق من الشبكة وأعد المحاولة.',
                           en: 'No connection. Check the network and try again.' },
    'up.err.generic':    { ar: 'تعذّر إتمام الرفع. أعد المحاولة.', en: 'The upload did not go through. Try again.' },
    /* M5's precision floor. The message names what to do rather than what went wrong: a
       contributor who chose a sharp precision and then moved to a dropped pin has not made
       a mistake, they have changed a thing the other setting depended on. */
    'up.err.precisionTooPrecise': {
      ar: 'الدقّة المختارة أعلى ممّا يسمح به الموقع الذي حدّدته. اختر دقّة أقلّ، أو اختر مكانًا من الفهرس.',
      en: 'That precision is sharper than the location you picked allows. Choose a looser one, or pick a place from the index.' },
    'up.err.precisionUnknown': {
      ar: 'قيمة الدقّة غير معروفة.', en: 'That precision is not a value we recognise.' },

    // ── Upload progress ─────────────────────────────────────
    'up.stage.probing':    { ar: 'نقرأ الملف…', en: 'Reading the file…' },
    'up.stage.requesting': { ar: 'نطلب إذن الرفع…', en: 'Requesting permission…' },
    'up.stage.uploading':  { ar: 'يجري الرفع…', en: 'Uploading…' },
    'up.stage.finishing':  { ar: 'ننهي المعالجة…', en: 'Finishing up…' },
    'up.stage.done':       { ar: 'اكتمل الرفع.', en: 'Upload complete.' },

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
    /* §7's precision control (M5). The label asks what to PUBLISH rather than what the
       coordinate is, because those are different questions and only the first is the
       contributor's to answer. */
    'share.fPrecision': { ar: 'دقّة الموقع المنشور', en: 'Published location precision' },
    'share.fPrecisionNote': {
      ar: 'يمكنك دائمًا نشر موقع أقلّ دقّة ممّا حدّدت — لا أدقّ. الإحداثيّة الأصليّة تبقى محفوظة ولا تُنشر.',
      en: 'You can always publish something vaguer than you picked — never sharper. The original coordinate is kept and never published.' },
    'share.fStory': { ar: 'القصة',         en: 'The story' },
    'share.fStoryPh': { ar: 'ما الذي تذكره — أو تذكره عائلتك — من هذه اللحظة؟',
                        en: 'What do you — or your family — remember of this moment?' },
    'share.drop':   { ar: 'اسحب الملف إلى هنا أو تصفّح جهازك', en: 'Drag the file here, or browse your device' },
    // 200 MB, not 50: §6 sets the member cap and this string was prototype copy that
    // contradicted it. A limit shown lower than the one enforced turns an allowed upload
    // into one the member never attempts.
    'share.dropNote': { ar: 'JPG · PNG · MP3 · MP4 — حتى ٢٠٠ ميغابايت', en: 'JPG · PNG · MP3 · MP4 — up to 200 MB' },

    // ── Rights, asked at upload (§7) ────────────────────────
    // The labels are deliberately plain-language. "CC-BY-SA-4.0" is the value stored and
    // exported; it is not a thing to put in front of a contributor and expect a decision.
    'share.fLicense': { ar: 'رخصة الاستخدام', en: 'Licence' },
    'share.fLicenseNote': { ar: 'ماذا يحقّ للآخرين أن يفعلوا بهذه المادة؟',
                            en: 'What may others do with this material?' },
    'license.CC-BY-SA-4.0': { ar: 'يجوز إعادة استخدامها مع ذكر المصدر وبالشروط نفسها',
                              en: 'Reusable with credit, on the same terms' },
    'license.CC0-1.0': { ar: 'ملك عام — يجوز استخدامها بلا شروط',
                         en: 'Public domain — usable without conditions' },
    'license.rights-reserved': { ar: 'للأرشيف أن ينشرها فقط — أي استخدام آخر يحتاج إذنًا',
                                 en: 'The archive may publish it — any other use needs permission' },
    'share.fProvenance': { ar: 'من أين جاءت؟', en: 'Where did it come from?' },
    'share.fProvenancePh': { ar: 'مثال: ألبوم جدّي · صوّرتها بنفسي · من أرشيف العائلة',
                             en: "e.g. my grandfather's album · I took it myself · family archive" },
    'share.consent': { ar: 'أؤكّد أنّ لديّ الحقّ في مشاركة هذه المادة، وأنّ بإمكاني سحبها لاحقًا.',
                       en: 'I confirm I have the right to share this material, and that I may withdraw it later.' },

    'share.review': { ar: 'تمرّ كل مساهمة بمراجعة الفريق قبل النشر. نتعهّد بالردّ خلال ٤٨ ساعة.',
                      en: 'Every contribution is reviewed by the team before publishing. We promise a reply within 48 hours.' },
    'share.submit': { ar: 'أرسل للمراجعة', en: 'Send for review' },
    'share.sent':   { ar: 'وصلتنا مساهمتك — سنردّ خلال ٤٨ ساعة.', en: 'We have your contribution — we will reply within 48 hours.' },

    // ── Map ─────────────────────────────────────────────────
    'map.inView':  { ar: '{n} ذكرى ضمن العرض', en: '{n} memories in view' },
    'map.decade':  { ar: 'العقد', en: 'Decade' },
    'map.all':     { ar: 'الكل',  en: 'All' },

    // ── Events ──────────────────────────────────────────────
    'events.title':   { ar: 'فعاليات حول الذاكرة', en: 'Events around the memory' },
    'events.blurb':   { ar: 'معارض وجولات وورشات ينظّمها الأرشيف وأهل المدينة — في رام الله وعبر الإنترنت.',
                        en: 'Exhibitions, tours and workshops run by the archive and by the city — in Ramallah and online.' },
    'events.count':   { ar: '{n} فعاليات قادمة', en: '{n} upcoming events' },

    // ── Profile ─────────────────────────────────────────────
    'profile.mine':          { ar: 'ملفّي الشخصي', en: 'My profile' },
    'profile.you':           { ar: 'أنت', en: 'You' },
    'profile.memberSince':   { ar: 'عضو منذ {n}', en: 'Member since {n}' },
    'profile.contributions': { ar: 'المساهمات', en: 'Contributions' },
    'profile.comments':      { ar: 'التعليقات', en: 'Comments made' },
    'profile.noContributions': { ar: 'لا مساهمات منشورة بعد.', en: 'No published contributions yet.' },
    'profile.noComments':    { ar: 'لا تعليقات بعد.', en: 'No comments yet.' },
    'profile.onMemory':      { ar: 'على «{t}»', en: 'On “{t}”' },
    'profile.notFound':      { ar: 'لا يوجد عضو بهذا المعرّف.', en: 'No member with that id.' },
    'profile.ownerOnly':     { ar: 'يظهر لك وحدك', en: 'Visible to you only' },
    'profile.public':        { ar: 'عام', en: 'Public' },
    'profile.private':       { ar: 'خاص', en: 'Private' },
    'profile.editTitle':     { ar: 'تحرير الملف والخصوصية', en: 'Edit profile & privacy' },
    'profile.previewLink':   { ar: 'اعرضه كما يراه الزائر', en: 'View as a visitor sees it' },
    'profile.previewNotice': { ar: 'هذا ما يراه الزوّار من ملفك.', en: 'This is what visitors see of your profile.' },
    'profile.backToMine':    { ar: 'العودة إلى ملفّي', en: 'Back to my profile' },
    'profile.privacyTitle':  { ar: 'ما الذي يراه الآخرون', en: 'What others can see' },
    'profile.privacyNote':   { ar: 'اسمك وصورتك ودورك تظهر دائمًا — بها تُنسب الذكريات إلى أصحابها.',
                               en: 'Your name, avatar and role are always shown — they are how memories stay attributed.' },
    'profile.displayName':   { ar: 'الاسم المعروض', en: 'Display name' },
    'profile.bio':           { ar: 'نبذة', en: 'Bio' },
    'profile.save':          { ar: 'حفظ الملف', en: 'Save profile' },
    'profile.saved':         { ar: 'حُفظ ملفك الشخصي.', en: 'Your profile is saved.' },
    'profile.field.bio':           { ar: 'النبذة', en: 'Bio' },
    'profile.field.personalInfo':  { ar: 'معلومات شخصية', en: 'Personal info' },
    'profile.field.contributions': { ar: 'المساهمات', en: 'Contributions' },
    'profile.field.comments':      { ar: 'التعليقات', en: 'Comments' },
    'profile.hint.bio':           { ar: 'النصّ التعريفي أعلى ملفك.', en: 'The introduction at the top of your profile.' },
    'profile.hint.personalInfo':  { ar: 'مدينتك وسنة انضمامك.', en: 'Your city and the year you joined.' },
    'profile.hint.contributions': { ar: 'قائمة ذكرياتك على ملفك. تبقى منشورة في الأرشيف في الحالتين.',
                                    en: 'The list of your memories on your profile. They stay published in the archive either way.' },
    'profile.hint.comments':      { ar: 'قائمة تعليقاتك على ملفك. تبقى ظاهرة تحت كل ذكرى.',
                                    en: 'The list of your comments on your profile. They stay visible under each memory.' },

    // ── Info page ───────────────────────────────────────────
    'page.title':       { ar: 'عن الأرشيف', en: 'About the archive' },
    'page.blurb':       { ar: 'من نحن، وكيف تتواصل معنا، وكيف تدعم الذاكرة.',
                          en: 'Who we are, how to reach us, and how to support the memory.' },
    'page.donateReach': { ar: 'للتبرّع أو الاستفسار', en: 'To donate or ask' },
    'page.email':       { ar: 'البريد الإلكتروني', en: 'Email' },
    'page.whatsapp':    { ar: 'واتساب', en: 'WhatsApp' },
    'page.donateNote':  { ar: 'اكتب لنا قبل التحويل إن كان التبرّع مؤسسيًا أو مخصّصًا لبرنامج بعينه.',
                          en: 'Write to us before transferring if the gift is institutional or earmarked for a specific programme.' },

    // ── Media kinds & decades ───────────────────────────────
    'kind.photo': { ar: 'صورة',        en: 'Photo' },
    'kind.voice': { ar: 'صوت',         en: 'Voice' },
    'kind.video': { ar: 'فيديو',       en: 'Video' },
    'kind.event': { ar: 'فعالية',      en: 'Event' },

    'decade.1950': { ar: 'الخمسينيات', en: '1950s' },
    'decade.1960': { ar: 'الستينيات',  en: '1960s' },
    'decade.1970': { ar: 'السبعينيات', en: '1970s' },
    'decade.1980': { ar: 'الثمانينيات', en: '1980s' },
    'decade.1990': { ar: 'التسعينيات', en: '1990s' },
    'decade.2000': { ar: 'الألفان',        en: '2000s' },
    /* ٢٠١٠–٢٠١٩ rather than a name, and this is the honest answer rather than a
       placeholder. Arabic has settled names for the decades of a century — الخمسينيات
       through التسعينيات — and none for the first two of a new one: العشرينيات is the
       TWENTIES, which is 2020, and this key carried it until M3. A wrong label on a slider
       that filters an archive by era files a photograph under the wrong decade in the
       reader's head, which is the one error an archive cannot correct later. */
    'decade.2010': { ar: '٢٠١٠–٢٠١٩',      en: '2010s' },

    // ── Admin: rail & shared ────────────────────────────────
    'admin.overview': { ar: 'نظرة عامة',       en: 'Overview' },
    'admin.queue':    { ar: 'قائمة المراجعة',  en: 'Review queue' },
    'admin.archive':  { ar: 'الأرشيف المنشور', en: 'Published archive' },
    'admin.events':   { ar: 'الفعاليات',       en: 'Events' },
    'admin.places':   { ar: 'الأماكن والخريطة', en: 'Places & map' },
    'admin.members':  { ar: 'الأعضاء',         en: 'Members' },
    'admin.reports':  { ar: 'البلاغات',        en: 'Reports' },
    'admin.backToSite': { ar: '← عودة إلى الموقع', en: '← Back to the site' },
    'admin.me':       { ar: 'هناء ع.',          en: 'Hana A.' },

    // ── Admin: overview ─────────────────────────────────────
    'ov.greeting':   { ar: 'صباح الخير، هناء', en: 'Good morning, Hana' },
    'ov.today':      { ar: 'الأحد ٨ آذار · {n} مساهمات يقترب موعد الردّ عليها',
                       en: 'Sunday 8 March · {n} contributions approaching their deadline' },
    'ov.start':      { ar: 'ابدأ المراجعة', en: 'Start reviewing' },
    'ov.pending':    { ar: 'بانتظار المراجعة', en: 'Awaiting review' },
    'ov.pendingNote':{ ar: 'متوسط زمن الردّ ١٩ ساعة', en: 'Median reply time 19 hours' },
    'ov.published':  { ar: 'نُشرت هذا الأسبوع', en: 'Published this week' },
    'ov.publishedNote': { ar: '+١٤٪ عن الأسبوع الماضي', en: '+14% on last week' },
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
    // R1 (§7). `exact` is legitimate — a public landmark has no doorstep to expose — so
    // the schema does not refuse it and the control is editorial. These three strings ARE
    // that control: they are the only place the choice is put in front of a moderator.
    'q.exactFlag': { ar: 'إحداثيات دقيقة', en: 'Exact coordinates' },
    'q.exactWhy':  { ar: 'سيُنشر موقع دقيق غير مموّه. راجعه كقرار، لا كإعداد افتراضي (§٧).',
                     en: 'A precise, unfuzzed location will be published. Review it as a decision, not a default (§7).' },
    'q.precision': { ar: 'دقّة الموقع', en: 'Location precision' },
    // ── The control R1's flag was missing (M4) ──────────────
    'q.locationFix':   { ar: 'تصحيح الموقع', en: 'Location' },
    'q.locationFixDo': { ar: 'صحِّح الموقع', en: 'Correct it' },
    'q.locationBlurb': { ar: 'اربطه بمكان من الفهرس، أو ضع دبّوسًا، أو امسح الموقع تمامًا.',
                         en: 'Attach it to a place, drop a pin, or clear the location entirely.' },
    'q.locationSearch': { ar: 'ابحث في الفهرس', en: 'Search the gazetteer' },
    'q.locationPlace': { ar: 'المكان الحاليّ: {name}', en: 'Currently: {name}' },
    'q.locationPin':   { ar: 'دبّوس على الخريطة، سيُنشر بدقّة حيّ تقريبًا.',
                         en: 'A pin, which publishes to about a block.' },
    'q.locationNone':  { ar: 'بلا موقع. لن يظهر على الخريطة.',
                         en: 'No location. It will not appear on the map.' },
    'q.locationPinDo': { ar: 'ضع دبّوسًا', en: 'Drop a pin' },
    'q.locationClear': { ar: 'امسح الموقع', en: 'Clear the location' },
    'q.locationNote':  { ar: 'الموقع جزء من المحتوى المعتمَد — تعديله على مادة منشورة يعيدها إلى المراجعة (§٥).',
                         en: 'Location is part of approved content — editing a published item returns it to the queue (§5).' },
    'q.locationSave':  { ar: 'احفظ الموقع', en: 'Save location' },
    'q.locationSaved': { ar: 'حُفظ الموقع.', en: 'Location saved.' },
    'q.locationErr.unknown_place': { ar: 'هذا المكان لم يعد في الفهرس.', en: 'That place is no longer in the gazetteer.' },
    'q.locationErr.invalid_coordinates': { ar: 'الإحداثيات غير صالحة.', en: 'Those coordinates are not valid.' },
    'q.locationErr.post_required': { ar: 'لم تُحدَّد المادة.', en: 'No item was named.' },
    'q.locationErr.not_found_or_refused': { ar: 'تعذّر الحفظ — إمّا أن المادة لم تعد موجودة أو أن صلاحيتك لا تسمح.',
                                            en: 'Could not save — the item is gone, or your role does not allow it.' },
    'q.locationErr.generic': { ar: 'تعذّر حفظ الموقع.', en: 'The location could not be saved.' },
    'precision.exact':  { ar: 'دقيق', en: 'Exact' },
    'precision.street': { ar: 'الشارع', en: 'Street' },
    'precision.area':   { ar: 'المنطقة', en: 'Area' },
    'precision.hidden': { ar: 'مخفي — لا إحداثيات', en: 'Hidden — no coordinates' },
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
    'q.loading':   { ar: 'نجلب القائمة…', en: 'Loading the queue…' },
    // §7: nothing goes public without a recorded licence and provenance. The share sheet
    // does not collect either until M5, so a moderator meets this on most member uploads.
    'q.rightsMissing': { ar: 'لا يمكن النشر: الترخيص أو المصدر غير مسجَّل (§7).',
                         en: 'Cannot publish: licence or provenance is not recorded (§7).' },
    // "Send back to the contributor" has no post_status to map onto — 'withdrawn' means the
    // AUTHOR pulled it. Saying so is better than quietly filing it as something else.
    'q.err.sendBackUnsupported': { ar: 'الإعادة إلى المساهم غير مفعّلة بعد.',
                                   en: 'Sending back to the contributor is not enabled yet.' },

    // ── Dashboard gate and errors ───────────────────────────
    // The gate is UX (§5). These strings explain a refusal; they never cause one.
    'admin.checking':    { ar: 'نتحقّق من صلاحياتك…', en: 'Checking your access…' },
    'admin.signInTitle': { ar: 'دخول لوحة الإدارة', en: 'Dashboard sign-in' },
    'admin.refusedTitle':{ ar: 'لا صلاحية', en: 'No access' },
    'admin.refusedBody': { ar: 'هذه اللوحة للمشرفين والإداريين. حسابك مسجَّل كـ {role}.',
                           en: 'This dashboard is for moderators and admins. Your account is a {role}.' },
    'admin.toArchive':   { ar: 'العودة إلى الأرشيف', en: 'Back to the archive' },
    'admin.err.denied':  { ar: 'رفضت قاعدة البيانات هذا الإجراء.', en: 'The database refused that action.' },
    'admin.err.conflict':{ ar: 'تغيّر هذا العنصر منذ فتح الصفحة. حدّث القائمة.',
                           en: 'This item changed since the page loaded. Refresh the queue.' },
    'admin.err.signedOut': { ar: 'انتهت جلستك. سجّل الدخول من جديد.', en: 'Your session ended. Sign in again.' },
    'admin.err.offline': { ar: 'لا يوجد اتصال بقاعدة البيانات.', en: 'No connection to the database.' },
    'admin.err.loadFailed': { ar: 'تعذّر تحميل اللوحة.', en: 'The dashboard failed to load.' },
    'admin.err.generic': { ar: 'تعذّر إتمام الطلب.', en: 'That request did not go through.' },

    // ── Admin: published archive ────────────────────────────
    'ar.title':   { ar: 'الأرشيف المنشور', en: 'Published archive' },
    'ar.sub':     { ar: '٣٬٤١٢ ذكرى منشورة · آخر نشر قبل ١٢ دقيقة',
                    en: '3,412 memories published · last publish 12 minutes ago' },
    'ar.colTitle':{ ar: 'العنوان', en: 'Title' },
    'ar.colDecade': { ar: 'العقد', en: 'Decade' },
    'ar.colDate': { ar: 'تاريخ النشر', en: 'Published' },

    // ── Admin: events ───────────────────────────────────────
    'ae.title':    { ar: 'الفعاليات', en: 'Events' },
    'ae.sub':      { ar: '{n} بانتظار الموافقة · ٦ منشورة قادمة',
                     en: '{n} awaiting approval · 6 published and upcoming' },
    'ae.note':     { ar: 'عند الموافقة تظهر الفعالية في صفحة الفعاليات وتُرسل للمشتركين في النشرة.',
                     en: 'On approval the event appears on the events page and goes out to newsletter subscribers.' },
    'ae.empty':    { ar: 'لا فعاليات بانتظار الموافقة.', en: 'No events awaiting approval.' },

    // ── Admin: places ───────────────────────────────────────
    'pl.title':   { ar: 'الأماكن والخريطة', en: 'Places & map' },
    // "· 91% of memories placed" was here, and nothing has ever computed it. Same family
    // as the overview's invented counters, removed for the same reason: a dashboard that
    // states a figure nobody derived is a dashboard lying to the person deciding from it.
    'pl.sub':     { ar: '{n} مكانًا في الفهرس', en: '{n} places in the gazetteer' },

    // ── Admin: members ──────────────────────────────────────
    'mb.title':   { ar: 'الأعضاء', en: 'Members' },
    'mb.sub':     { ar: '٤٬٨١٠ أعضاء · ١٤٢ انضموا هذا الشهر',
                    en: '4,810 members · 142 joined this month' },
    'mb.colStatus': { ar: 'الحالة', en: 'Status' },

    // ── Admin: reports ──────────────────────────────────────
    'rp.title':   { ar: 'البلاغات', en: 'Reports' },
    // Phrased as "label: count" so it stays grammatical at any number.
    'rp.sub':     { ar: 'بلاغات مفتوحة: {n} · ٣١ مغلقًا هذا العام',
                    en: 'Open reports: {n} · 31 closed this year' },
    'rp.open':    { ar: 'مفتوحة', en: 'Open' },
    'rp.closed':  { ar: 'مغلقة', en: 'Closed' },
    'rp.reason':  { ar: 'سبب البلاغ: {r}', en: 'Reason: {r}' },
    'rp.logged':  { ar: 'القرار يُسجَّل في سجلّ الإدارة ويظهر للفريق فقط',
                    en: 'The decision is written to the admin log, visible to the team only' },
    'rp.keep':    { ar: 'إبقاء المحتوى وإغلاق البلاغ', en: 'Keep the content and close the report' },
    'rp.closedOne': { ar: 'أُغلق البلاغ.', en: 'Report closed.' },
    'rp.empty':   { ar: 'لا بلاغات مفتوحة.', en: 'No open reports.' },

    // ── Time ────────────────────────────────────────────────
    'time.hours':    { ar: '{n} ساعة',      en: '{n} hours' },
    'time.ago':      { ar: 'قبل {n} ساعة',  en: '{n} hours ago' },

    // ── The read path (M3) ──────────────────────────────────
    // Every failure archive.js can report. They are separate strings on purpose: "you are
    // offline" and "this item is not in the archive" are different facts, and a reader who
    // is told the wrong one either reloads forever or gives up on a page that would work.
    'archive.err.title':       { ar: 'تعذّر فتح الأرشيف', en: 'The archive could not be opened' },
    'archive.err.offline':     { ar: 'لا يوجد اتصال بالشبكة. أعد المحاولة عند عودة الاتصال.',
                                 en: 'No connection. Try again when you are back online.' },
    'archive.err.missing':     { ar: 'هذه الذكرى ليست في الأرشيف — قد تكون سُحبت.',
                                 en: 'This memory is not in the archive — it may have been withdrawn.' },
    'archive.err.unpublished': { ar: 'لم يُنشر الأرشيف بعد.', en: 'The archive has not been published yet.' },
    'archive.err.notReady':    { ar: 'لم يُنشر الأرشيف بعد.', en: 'The archive has not been published yet.' },
    'archive.err.generic':     { ar: 'تعذّر تحميل الأرشيف.', en: 'The archive could not be loaded.' },

    'feed.empty':     { ar: 'لا ذكريات منشورة بعد.', en: 'Nothing published yet.' },
    // Shown on a card whose derivative is not there — an item published before its thumb
    // landed, or one whose bytes a takedown removed from a release still in someone's cache.
    'feed.noPreview': { ar: 'لا معاينة', en: 'no preview' },

    // ── Comments (M3) ───────────────────────────────────────
    'comments.someone':    { ar: 'عضو', en: 'A member' },
    'comments.you':        { ar: 'أنت', en: 'You' },
    // §1: everything user-submitted is reviewed before it is public. A member's own pending
    // comment is shown to them, flagged — a comment that vanished on submit reads as lost.
    'comments.awaiting':   { ar: 'بانتظار المراجعة', en: 'awaiting review' },
    'comments.placeholder':{ ar: 'اكتب ما تذكره…', en: 'Write what you remember…' },
    'comments.send':       { ar: 'إرسال', en: 'Send' },
    'comments.sent':       { ar: 'وصل تعليقك. سيظهر بعد المراجعة.',
                             en: 'Your comment arrived. It appears after review.' },
    'comments.reviewNote': { ar: 'كل تعليق يُراجع قبل نشره', en: 'Every comment is reviewed before it appears' },
    'comments.err.empty':  { ar: 'اكتب شيئًا قبل الإرسال.', en: 'Write something first.' },
    'comments.err.tooLong':{ ar: 'التعليق أطول من ٤٠٠٠ حرف.', en: 'That is longer than 4000 characters.' },

    // ── Reports (M3) ────────────────────────────────────────
    'viewer.report':      { ar: 'إبلاغ', en: 'Report' },
    'report.title':       { ar: 'الإبلاغ عن هذه الذكرى', en: 'Report this memory' },
    'report.blurb':       { ar: 'اشرح ما الخطأ. يصل بلاغك إلى فريق المراجعة وحده.',
                            en: 'Tell us what is wrong. Your report reaches the review team only.' },
    'report.reason':      { ar: 'سبب البلاغ', en: 'Reason' },
    'report.placeholder': { ar: 'تاريخ خاطئ، مكان خاطئ، مسألة خصوصية…',
                            en: 'Wrong date, wrong place, a privacy concern…' },
    'report.submit':      { ar: 'إرسال البلاغ', en: 'Send the report' },
    'report.sent':        { ar: 'وصل بلاغك. شكرًا.', en: 'Your report arrived. Thank you.' },
    'report.err.empty':   { ar: 'اكتب سبب البلاغ.', en: 'Say what is wrong.' },
    'report.err.tooLong': { ar: 'البلاغ أطول من ٢٠٠٠ حرف.', en: 'That is longer than 2000 characters.' },

    // ── The three roles (§4) ────────────────────────────────
    // CLAUDE.md §4 has exactly three. The front end used to carry five —
    // contributor/editor/partner/narrator/admin — invented for the prototype and listed in
    // the README as a known departure. A vocabulary the database cannot express is a
    // vocabulary that will eventually be used to decide something.
    'role.member':    { ar: 'عضو',    en: 'Member' },
    'role.moderator': { ar: 'محرِّر',  en: 'Moderator' },
    'role.admin':     { ar: 'مدير',   en: 'Admin' },

    // ── Handles (§3, §7) ────────────────────────────────────
    // The signup field used to ask for a full name. §3: "handle is user-chosen, NOT a legal
    // name", and §7 makes this archive one where asking for a real name is a safety
    // question rather than a form-design one.
    'field.handle':     { ar: 'الاسم المستعار', en: 'Handle' },
    'field.handlePh':   { ar: 'مثال: ramallah_1967', en: 'e.g. ramallah_1967' },
    'field.handleNote': { ar: 'اسم تختاره أنت ويظهر للجميع — ليس اسمك الحقيقي',
                          en: 'A public name you choose — not your legal name' },
    'signup.err.handleRequired': { ar: 'اختر اسمًا مستعارًا.', en: 'Choose a handle.' },
    'signup.err.handleTaken':    { ar: 'هذا الاسم المستعار محجوز. غيّره من صفحتك.',
                                   en: 'That handle is taken. Change it from your profile.' },

    // ── A member's own submissions (M3) ─────────────────────
    // The surface a refused upload never had. §6 holds `expect_by` until a timing probe
    // against the deployed worker replaces the estimated factor in JOB_DEADLINE_MS, so
    // nothing here says WHEN — only which state a submission is in, which is true today.
    'mine.title': { ar: 'مساهماتك قيد المعالجة', en: 'Your submissions in progress' },
    'mine.blurb': { ar: 'ما لم يُنشر بعد. تظهر المساهمة في الأرشيف بعد اكتمال المعالجة والمراجعة.',
                    en: 'Not published yet. A contribution appears once processing and review are done.' },
    'mine.state.processing': { ar: 'قيد المعالجة', en: 'Processing' },
    'mine.state.incomplete': { ar: 'لم يكتمل الرفع', en: 'Upload incomplete' },
    'mine.state.failed':     { ar: 'تعذّرت المعالجة', en: 'Processing failed' },
    'mine.state.inReview':   { ar: 'قيد المراجعة', en: 'In review' },
    'mine.state.rejected':   { ar: 'لم تُقبل', en: 'Not accepted' },
    'mine.state.withdrawn':  { ar: 'مسحوبة', en: 'Withdrawn' },
    // The worker's own failure names, as a contributor can act on them. An unmapped one
    // falls through to the key itself, which is visibly wrong rather than silently missing.
    'mine.err.unsupported_type':  { ar: 'نوع الملف غير مدعوم.', en: 'That file type is not supported.' },
    'mine.err.declared_mismatch': { ar: 'محتوى الملف لا يطابق نوعه المعلن.',
                                    en: 'The file’s contents do not match its declared type.' },
    'mine.err.svg_rejected':      { ar: 'ملفات SVG غير مقبولة.', en: 'SVG files are not accepted.' },
    'mine.err.decode_failed':     { ar: 'تعذّر فتح الملف. جرّب تصديره من جديد.',
                                    en: 'The file could not be opened. Try exporting it again.' },
    'mine.err.job_deadline':      { ar: 'المعالجة استغرقت وقتًا أطول من المسموح.',
                                    en: 'Processing ran longer than allowed.' },

    // ── Share sheet (M3) ────────────────────────────────────
    'share.fDecadeUnknown': { ar: 'العقد غير معروف', en: 'Decade unknown' },
    /* The same four enum values as `precision.*` above, in the OTHER register — and a
       separate namespace rather than a second definition of the same keys, which is what
       this was first written as. A duplicate key in an object literal silently wins, so
       the contributor's wording would have replaced the moderator's everywhere the
       dashboard renders it, and nothing would have said so.
       `precision.*` is terse, for a moderator scanning a queue. These are a choice a
       contributor is making about their own safety, so they describe what a READER of the
       archive will end up seeing. */
    'share.precision.exact':  { ar: 'الموقع بالضبط',      en: 'The exact spot' },
    'share.precision.street': { ar: 'الشارع أو الحارة',   en: 'Street or block' },
    'share.precision.area':   { ar: 'المنطقة العامّة',     en: 'General area' },
    'share.precision.hidden': { ar: 'لا تنشر الموقع',     en: 'Do not publish a location' },
    // ── M4: the place, the pin, and what each publishes ─────
    'share.fPlaceHint':     { ar: 'اختياريّ. المكان المعروف يُنشر كما هو؛ الدبّوس يُنشر بدقّة حيّ تقريبًا.',
                              en: 'Optional. A known place is published as it stands; a pin is published to about a block.' },
    'share.fPlaceChosen':   { ar: 'المكان: {name}', en: 'Place: {name}' },
    'share.fPlacePinned':   { ar: 'موقع محدَّد بدبّوس على الخريطة.', en: 'A pin you placed on the map.' },
    'share.fPlaceNone':     { ar: 'لا مكان بهذا الاسم في الفهرس بعد.',
                              en: 'No place by that name in the gazetteer yet.' },
    'share.fPlaceUnconfirmed': { ar: 'بلا إحداثيات مؤكَّدة', en: 'no confirmed coordinates' },
    'share.fPlacePin':      { ar: 'حدِّد على الخريطة', en: 'Place a pin instead' },
    'share.fPlaceClear':    { ar: 'امسح المكان', en: 'Clear' },
    'share.pinTitle':       { ar: 'أين كان هذا؟', en: 'Where was this?' },
    'share.pinBlurb':       { ar: 'اسحب الدبّوس أو انقر على المكان.', en: 'Drag the pin, or tap the spot.' },
    'share.pinConfirm':     { ar: 'أكِّد هذا الموقع', en: 'Confirm this spot' },
    'share.pinPrivacy':     { ar: 'يُنشر هذا الموقع بدقّة حيّ تقريبًا، لا بالعنوان.',
                              en: 'This is published to roughly a block, never to an address.' },
    'share.pinNear':        { ar: 'أماكن معروفة قريبة — اختر واحدًا إن كان هو المقصود:',
                              en: 'Known places nearby — pick one if that is what you meant:' },
    'share.pinDistance':    { ar: 'على بُعد {n} م', en: '{n} m away' },
    'share.pinNoMap':       { ar: 'الخريطة غير متاحة الآن. اكتب اسم المكان بدل ذلك.',
                              en: 'The map is unavailable. Type the place name instead.' },
    'up.err.decade':        { ar: 'العقد المُرسل غير صالح.', en: 'That decade is not valid.' },
    'up.err.place':         { ar: 'المكان المُرسل غير موجود في الفهرس.',
                              en: 'That place is not in the gazetteer.' },
    'up.err.coordinates':   { ar: 'الإحداثيات المُرسلة غير صالحة.',
                              en: 'Those coordinates are not valid.' },

    // ── Located memories (M4) ───────────────────────────────
    'map.title':     { ar: 'ذكريات على الخريطة', en: 'Memories on the map' },
    'map.blurb':     { ar: 'الذكريات التي تحمل موقعًا، على خريطة المدينة. حرِّك المؤشّر لتغيير العقد.',
                       en: 'Memories that carry a location, on the city map. Move the slider to change the decade.' },
    // Still used, and not a leftover: this is what /map says when there is no basemap to
    // draw — which is a configuration state, not a failure. map.err.tiles is the failure.
    'map.blurbList': { ar: 'الذكريات التي تحمل موقعًا، مرتّبة بالعقد.',
                       en: 'Memories that carry a location, by decade.' },
    'map.canvasLabel': { ar: 'خريطة رام الله. الأسهم للتحريك، + و− للتقريب.',
                         en: 'Map of Ramallah. Arrow keys pan, plus and minus zoom.' },
    'map.err.tiles': { ar: 'تعذّر تحميل خريطة المدينة. الذكريات المحدَّدة الموقع مسرودة أدناه.',
                       en: 'The city map could not be loaded. Located memories are listed below.' },
    'map.empty':     { ar: 'لا ذكريات محدَّدة الموقع في هذا العقد.',
                       en: 'No located memories in this decade.' },
    // §7's four precisions, said as what they mean for a reader rather than as enum values.
    'map.precision.exact':  { ar: 'موقع دقيق', en: 'Exact location' },
    'map.precision.street':  { ar: 'الشارع تقريبًا', en: 'Approximate street' },
    'map.precision.area':    { ar: 'المنطقة تقريبًا', en: 'Approximate area' },
    'map.precision.hidden':  { ar: 'الموقع مخفيّ', en: 'Location hidden' },

    'events.empty': { ar: 'لا فعاليات منشورة بعد.', en: 'No events published yet.' },
    'decade.2020':  { ar: 'العشرينيات', en: '2020s' },   // and THIS is the twenties

    // ── Admin: overview (M3) ────────────────────────────────
    'ov.decadesCovered': { ar: 'العقود المغطّاة', en: 'Decades covered' },
    'ov.decadesNote':    { ar: 'من الأرشيف المنشور', en: 'across the published archive' },
    'ov.openReports':    { ar: 'بلاغات مفتوحة', en: 'Open reports' },
    'ov.reportsNote':    { ar: 'بانتظار قرار', en: 'awaiting a decision' },
    'ov.gapsRange':      { ar: 'حسب الأرشيف المنشور', en: 'across the published archive' },
    'ov.noActivity':     { ar: 'لا قرارات مسجّلة بعد.', en: 'No decisions recorded yet.' },
    // moderation_actions writes these names; anything unmapped renders as its own name,
    // which is a legible fallback rather than a blank row.
    'action.post.status.approved':      { ar: 'نُشرت ذكرى', en: 'A memory was published' },
    'action.post.status.approved.self': { ar: 'نُشرت ذكرى (المحرّر نفسه)', en: 'A memory was published (by its own author)' },
    'action.post.status.rejected':      { ar: 'رُفضت ذكرى', en: 'A memory was rejected' },
    'action.post.status.withdrawn':     { ar: 'سُحبت ذكرى', en: 'A memory was withdrawn' },
    'action.post.takedown':             { ar: 'أُزيلت ذكرى', en: 'A memory was taken down' },
    'action.post.restore':              { ar: 'أُعيدت ذكرى', en: 'A memory was restored' },

    // ── Admin: archive register and takedown (M3) ───────────
    'ar.colKind':    { ar: 'النوع', en: 'Kind' },
    'ar.colLicense': { ar: 'الرخصة', en: 'Licence' },
    'ar.noLicense':  { ar: '—', en: '—' },
    'ar.empty':      { ar: 'لا شيء منشور بعد.', en: 'Nothing published yet.' },
    'ar.takedown':   { ar: 'إزالة', en: 'Take down' },
    'ar.takedownTitle': { ar: 'إزالة هذه الذكرى', en: 'Take this memory down' },
    // §8 and 0036: the master goes too. Said plainly, because "we still hold it privately"
    // is not what a contributor asking for removal has agreed to.
    'ar.takedownBlurb': { ar: 'تُحذف الملفات فورًا — المشتقّات والنسخة الأصلية معًا — ويُسجَّل القرار. لا رجعة.',
                          en: 'The files are deleted immediately — derivatives and the archival master alike — and the decision is logged. This cannot be undone.' },
    'ar.takedownNote':   { ar: 'سبب الإزالة', en: 'Reason for removal' },
    /* M5's report kinds (migration 0053). Two different obligations, and a queue that
       rendered both as "report" would invite the second to be triaged at the speed of
       the first. */
    'rp.kind.abuse':   { ar: 'بلاغ', en: 'Report' },
    'rp.kind.removal': { ar: 'طلب إزالة', en: 'Removal request' },
    /* The same two words on the contributor's side of the dialog, plus what each one
       actually does — because "report" and "removal request" are not self-explanatory to
       somebody who has just found a photograph of themselves. */
    'report.kind': { ar: 'نوع الطلب', en: 'What are you asking for?' },
    'report.kindNote.abuse': {
      ar: 'يراجع المشرفون المادة ويقرّرون ما إذا كانت تخالف قواعد الأرشيف.',
      en: 'A moderator will review the material and decide whether it breaks the archive’s rules.' },
    'report.kindNote.removal': {
      ar: 'لطلب إزالة مادّة تخصّك — كأن تكون أنت في الصورة. يصل الطلب إلى مسؤول محدّد ويُسجَّل في السجلّ الدائم، دون نصّ طلبك.',
      en: 'For material that concerns you — if you are in the photograph, for instance. It reaches a named person and is entered in the permanent record; what you write here is not.' },
    'ar.takedownNotePh': { ar: 'يُسجَّل في سجلّ الإدارة', en: 'Recorded in the moderation log' },
    'ar.takedownNoteRequired': { ar: 'اكتب سبب الإزالة.', en: 'Give a reason.' },
    'ar.takedownConfirm': { ar: 'إزالة نهائية', en: 'Remove permanently' },
    'ar.takenDown':       { ar: 'أُزيلت «{t}» ولم تعد الملفات موجودة.',
                            en: '"{t}" is removed and the files are gone.' },
    // 207: marked and hidden, and part of the removal did not complete. A separate message
    // because telling a moderator "done" while a cached copy is still served is worse than
    // an error — the next thing they do is tell a contributor their photograph is gone.
    'ar.takenDownPartial': { ar: 'أُزيلت من الأرشيف، لكن جزءًا من الحذف لم يكتمل ({r}). راجع السجلّ.',
                             en: 'Removed from the archive, but part of the deletion did not complete ({r}). Check the log.' },

    // ── Admin: events, places, members (M3) ─────────────────
    'ae.inQueue': { ar: 'في قائمة المراجعة: {n}', en: '{n} in the review queue' },
    'ae.view':    { ar: 'عرض', en: 'View' },
    // ── Admin: the gazetteer, writable (M4) ─────────────────
    'pl.editNote': { ar: 'الأسماء هنا هي كل ما تكتبه الخريطة. الأماكن المؤكَّدة وحدها تُنشر.',
                     en: 'These names are the map\u2019s entire text. Only confirmed places are published.' },
    'pl.add':      { ar: 'أضف مكانًا', en: 'Add a place' },
    'pl.addTitle': { ar: 'مكان جديد', en: 'New place' },
    'pl.editTitle': { ar: 'تعديل المكان', en: 'Edit place' },
    'pl.blurb':    { ar: 'الاسم بالعربية والإنجليزية، والبدائل الإملائية، ثم الموقع على الخريطة.',
                     en: 'The name in Arabic and English, the spellings people use, then the spot on the map.' },
    'pl.name':     { ar: 'الاسم', en: 'Name' },
    'pl.aliases':  { ar: 'أسماء بديلة', en: 'Also known as' },
    'pl.aliasesPh': { ar: 'المنارة، دوار المنارة', en: 'Manara, Manara Square' },
    'pl.aliasesWhy': { ar: 'البحث يطابق النصّ كما هو — أضف الإملاءات الأخرى هنا ليجدها الناس.',
                       en: 'Search matches the text as written — add the other spellings so people find it.' },
    'pl.point':    { ar: 'الموقع', en: 'The spot' },
    'pl.pinPick':  { ar: 'حدِّد على الخريطة', en: 'Set it on the map' },
    'pl.pinSet':   { ar: 'محدَّد: {n}', en: 'Set: {n}' },
    'pl.pinNone':  { ar: 'بلا إحداثيات بعد.', en: 'No coordinates yet.' },
    'pl.pinTitle': { ar: 'أين هذا المكان؟', en: 'Where is this place?' },
    'pl.pinBlurb': { ar: 'اسحب الدبّوس أو انقر على المكان.', en: 'Drag the pin, or tap the spot.' },
    'pl.pinConfirm': { ar: 'أكِّد الموقع', en: 'Confirm the spot' },
    'pl.pinNoMap': { ar: 'خريطة المدينة غير متاحة، ولا تُقبل إحداثيات مكتوبة يدويًا.',
                     en: 'The city map is unavailable, and typed coordinates are not accepted.' },
    'pl.unconfirmedLabel': { ar: 'الإحداثيات غير مؤكّدة بعد', en: 'Coordinates not confirmed yet' },
    'pl.save':     { ar: 'احفظ المكان', en: 'Save place' },
    'pl.saved':    { ar: 'حُفظ المكان.', en: 'Place saved.' },
    'pl.err.name_required': { ar: 'المكان يحتاج اسمًا بإحدى اللغتين.', en: 'A place needs a name in one language.' },
    'pl.err.confirmed_needs_location': { ar: 'المكان المؤكَّد يحتاج موقعًا على الخريطة.',
                                         en: 'A confirmed place needs a spot on the map.' },
    'pl.err.incomplete_coordinates': { ar: 'الإحداثيات ناقصة.', en: 'The coordinates are incomplete.' },
    'pl.err.coordinates_out_of_range': { ar: 'الإحداثيات خارج المدى.', en: 'Those coordinates are out of range.' },
    'pl.err.not_found_or_refused': { ar: 'تعذّر الحفظ — إمّا أن المكان لم يعد موجودًا أو أن صلاحيتك لا تسمح.',
                                     en: 'Could not save — the place is gone, or your role does not allow it.' },
    'pl.err.generic': { ar: 'تعذّر حفظ المكان.', en: 'The place could not be saved.' },
    'pl.unconfirmed':    { ar: 'إحداثيات غير مؤكّدة', en: 'coordinates unconfirmed' },
    'pl.unconfirmedWhy': { ar: 'لم يؤكّد أحد موقع هذا المكان بعد', en: 'Nobody has confirmed where this place is' },
    'pl.empty':   { ar: 'لا أماكن في الفهرس بعد.', en: 'No places in the gazetteer yet.' },
    'mb.readOnly': { ar: 'للعرض فقط. تغيير الأدوار يجري خارج المتصفّح — لا صلاحية لأي صفحة عليه (§٤).',
                     en: 'Read-only. Roles are changed outside the browser — no page holds that capability (§4).' },
    'mb.colHandle': { ar: 'الاسم المستعار', en: 'Handle' },
    'mb.colName':   { ar: 'الاسم المعروض', en: 'Display name' },
    'mb.colBadge':  { ar: 'الشارة', en: 'Badge' },
    'mb.empty':     { ar: 'لا حسابات بعد.', en: 'No accounts yet.' },

    // ── Admin: reports (M3) ─────────────────────────────────
    'rp.on.post':    { ar: 'على ذكرى', en: 'On a memory' },
    'rp.on.comment': { ar: 'على تعليق', en: 'On a comment' },
    'rp.on.profile': { ar: 'على حساب', en: 'On an account' },
    'rp.target':     { ar: 'المحتوى المُبلَّغ عنه', en: 'Reported content' },
    'rp.filed':      { ar: 'تاريخ البلاغ', en: 'Filed' },
    'rp.viewContent':{ ar: 'فتح المحتوى', en: 'Open the content' },
    'rp.closeNote':  { ar: 'إغلاق البلاغ لا يزيل المحتوى — استخدم «إزالة» من سجلّ الأرشيف.',
                       en: 'Closing a report does not remove content — use Take down in the archive register.' },

    // ── Admin: site copy (M3) ───────────────────────────────
    'admin.copy':    { ar: 'نصوص الموقع', en: 'Site copy' },
    'cp.title':      { ar: 'نصوص الموقع', en: 'Site copy' },
    'cp.sub':        { ar: 'كل نصّ تحريري على الموقع — بالعربية والإنجليزية معًا',
                       en: 'Every editorial string on the site — Arabic and English together' },
    'cp.blurb':      { ar: '«حفظ» يحفظ مسوّدة لا يراها الزوّار. «نشر» هو ما يغيّر ما يقرؤه الناس.',
                       en: '"Save" keeps a draft nobody sees. "Publish" is what changes what people read.' },
    'cp.save':       { ar: 'حفظ المسوّدة', en: 'Save draft' },
    'cp.publish':    { ar: 'نشر', en: 'Publish' },
    'cp.saved':      { ar: 'حُفظت المسوّدة.', en: 'Draft saved.' },
    'cp.published':  { ar: 'نُشر النصّ.', en: 'Published.' },
    'cp.live':       { ar: 'منشور', en: 'live' },
    'cp.draftPending': { ar: 'مسوّدة غير منشورة', en: 'unpublished draft' },
    'cp.unsaved':    { ar: 'تعديلات غير محفوظة', en: 'unsaved changes' },
    'cp.empty':      { ar: 'لا نصوص — أو ليست لديك صلاحية تحريرها (§٤).',
                       en: 'No copy — or you may not edit it (§4).' }
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
