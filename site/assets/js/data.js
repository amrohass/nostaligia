/* Seed content for the Atlas.
   Every record below is the placeholder material written into the design doc —
   it stands in for the real archive until a backend is attached. Titles carry
   both languages because the site shows one as the heading and the other as a gloss.

   `tone` names a gradient pair; the media wells render as hatched gradients
   rather than pretending a digitised photograph exists. */

(function (global) {
  'use strict';

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

  var PLACES = [
    { id: 'manara',  name: { ar: 'ميدان المنارة', en: 'Al-Manara Square' },       lat: 31.9038, lng: 35.2034, memories: 412, earliest: 1953 },
    { id: 'rukab',   name: { ar: 'شارع ركب', en: 'Rukab Street' },                lat: 31.9021, lng: 35.2001, memories: 308, earliest: 1961 },
    { id: 'oldcity', name: { ar: 'البلدة القديمة', en: 'Old City' },              lat: 31.8996, lng: 35.2043, memories: 276, earliest: 1955 },
    { id: 'tireh',   name: { ar: 'حيّ الطيرة', en: 'Al-Tireh' },                  lat: 31.8952, lng: 35.1893, memories: 84,  earliest: 1968 },
    { id: 'friends', name: { ar: 'مدرسة الفرندز', en: 'Friends School' },         lat: 31.9074, lng: 35.2072, memories: 131, earliest: 1957 },
    { id: 'palace',  name: { ar: 'قصر رام الله الثقافي', en: 'Ramallah Cultural Palace' }, lat: 31.8907, lng: 35.1976, memories: 97, earliest: 2004, unconfirmed: true },
    { id: 'baladia', name: { ar: 'بلدية رام الله', en: 'Ramallah Municipality' }, lat: 31.9052, lng: 35.2060, memories: 154, earliest: 1958 }
  ];

  var COMMENTS = {
    manara65: [
      { initial: { ar: 'س', en: 'S' }, name: { ar: 'سلمى ك.', en: 'Salma K.' }, when: { ar: 'قبل يومين', en: '2 days ago' },
        body: { ar: '«كان جدّي يقول: ما زرت رام الله حتى تقف تحت الأسود.»',
                en: "My grandfather used to say: you haven't visited Ramallah until you've stood under the lions." } },
      { initial: { ar: 'ج', en: 'G' }, name: { ar: 'جورج ح.', en: 'George H.' }, when: { ar: 'قبل أسبوع', en: '1 week ago' },
        body: { ar: '«عمّتي في ديترويت عندها نسخة ملوّنة من الصورة نفسها — سأرفعها قريبًا.»',
                en: "My aunt in Detroit has a colorized print of this exact photo — I'll upload it soon." } }
    ],
    wedding67: [
      { initial: { ar: 'أ', en: 'A' }, name: { ar: 'أم خالد', en: 'Umm Khaled' }, when: { ar: 'قبل ٤ أيام', en: '4 days ago' },
        body: { ar: '«الزفّة كانت تمرّ من هنا كل خميس. أعرف الأهزوجة كلمة كلمة.»',
                en: 'The procession came through here every Thursday. I know the song word for word.' } }
    ],
    market94: [
      { initial: { ar: 'ر', en: 'R' }, name: { ar: 'رامي ن.', en: 'Rami N.' }, when: { ar: 'قبل يومين', en: '2 days ago' },
        body: { ar: '«أذكر أن السوق انتقل إلى موقعه الحالي سنة ١٩٨٧، وكانت البسطات تمتد حتى نهاية الشارع.»',
                en: 'I remember the market moved to its current spot in 1987, and the stalls ran to the end of the street.' } }
    ]
  };

  /* The archive feed. `weight` sets the plate height so the columns stagger
     the way the design's masonry does. */
  var MEMORIES = [
    { id: 'wedding67', kind: 'photo', decade: 1960, place: 'oldcity', tone: 'sand', weight: 260, likes: 88,
      title: { ar: 'زفّة في حواري البلدة القديمة، ١٩٦٧', en: 'A wedding procession in the Old City lanes, 1967' },
      plate: 'photo · wedding, 1967', comments: COMMENTS.wedding67 },

    { id: 'municipality58', kind: 'photo', decade: 1950, place: 'baladia', tone: 'dust', weight: 210, likes: 54,
      title: { ar: 'مبنى بلدية رام الله القديم، ١٩٥٨', en: 'The old Municipality building, 1958' },
      plate: 'photo · municipality, 1958', comments: [] },

    { id: 'tuesdayMarket', kind: 'voice', decade: 1960, place: 'oldcity', tone: 'olive', duration: '2:41', likes: 141,
      title: { ar: 'جدّتي تروي سوق الثلاثاء', en: 'Grandmother recalls the Tuesday market' },
      comments: [] },

    { id: 'manara65', kind: 'photo', decade: 1960, place: 'manara', tone: 'sand', weight: 250, likes: 124,
      title: { ar: 'ميدان المنارة وأسوده، منتصف الستينيات', en: 'Al-Manara Square and its lions, mid-1960s' },
      plate: 'photo · al-manara, 1965', comments: COMMENTS.manara65 },

    { id: 'stairway80', kind: 'photo', decade: 1980, place: 'oldcity', tone: 'olive', weight: 300, likes: 76,
      title: { ar: 'درج حجريّ في البلدة القديمة، الثمانينيات', en: 'A stone stairway in the Old City, 1980s' },
      plate: 'photo · old city stairway', comments: [] },

    { id: 'birzeitRoad94', kind: 'video', decade: 1990, place: 'baladia', tone: 'olive', weight: 200, duration: '0:48', likes: 63,
      title: { ar: 'طريق رام الله – بيرزيت، ١٩٩٤', en: 'The Ramallah–Birzeit road, 1994' },
      plate: 'video still · birzeit road', comments: [] },

    { id: 'rukab72', kind: 'photo', decade: 1970, place: 'rukab', tone: 'clay', weight: 240, likes: 209,
      title: { ar: 'بوظة ركب في يوم صيفي، ١٩٧٢', en: "Rukab's ice cream on a summer day, 1972" },
      plate: 'photo · rukab st., 1972', comments: [] },

    { id: 'manaraRain89', kind: 'photo', decade: 1980, place: 'manara', tone: 'amber', weight: 230, likes: 97,
      title: { ar: 'المنارة في المطر، ١٩٨٩', en: 'Al-Manara in the rain, 1989' },
      plate: 'photo · al-manara, 1989', comments: [] },

    { id: 'friends62', kind: 'photo', decade: 1960, place: 'friends', tone: 'wheat', weight: 220, likes: 118,
      title: { ar: 'مدرسة الفرندز، صف ١٩٦٢', en: 'Friends School, class of 1962' },
      plate: 'photo · friends school, 1962', comments: [] },

    { id: 'tirehWeddings', kind: 'voice', decade: 1970, place: 'tireh', tone: 'stone', duration: '1:58', likes: 44,
      title: { ar: 'أهزوجة من أعراس الطيرة', en: 'A wedding song from al-Tireh' },
      comments: [] },

    { id: 'market94', kind: 'photo', decade: 1990, place: 'oldcity', tone: 'stone', weight: 210, likes: 60,
      title: { ar: 'سوق الثلاثاء، ١٩٩٤', en: 'The Tuesday market, 1994' },
      plate: 'photo · tuesday market, 1994', comments: COMMENTS.market94 },

    { id: 'palaceOpening', kind: 'photo', decade: 2000, place: 'palace', tone: 'parchment', weight: 240, likes: 51,
      title: { ar: 'افتتاح قصر رام الله الثقافي', en: 'The opening of the Ramallah Cultural Palace' },
      plate: 'photo · cultural palace', comments: [] }
  ];

  var EVENTS = [
    { id: 'ev-1960s', tone: 'dust', publisher: 'municipality', date: { ar: 'الخميس ١٢ آذار', en: 'Thursday 12 March' },
      plate: 'event photo · exhibition',
      title: { ar: 'معرض: رام الله في الستينيات', en: 'Exhibition: Ramallah in the 1960s' },
      where: { ar: 'قاعة المعارض — بلدية رام الله · ٦ مساءً', en: 'Exhibition hall — Ramallah Municipality · 6pm' } },

    { id: 'ev-storynight', tone: 'stone', publisher: 'community', date: { ar: 'السبت ٢١ آذار', en: 'Saturday 21 March' },
      plate: 'event photo · story night',
      title: { ar: 'أمسية حكايا: ليالي البلدة القديمة', en: 'Story night: Old City evenings' },
      where: { ar: 'المركز الثقافي خليل السكاكيني · ٧ مساءً', en: 'Khalil Sakakini Cultural Centre · 7pm' } },

    { id: 'ev-digitising', tone: 'ochre', publisher: 'team', date: { ar: 'الأربعاء ١ نيسان', en: 'Wednesday 1 April' },
      plate: 'event photo · workshop',
      title: { ar: 'ورشة: رقمنة صور العائلة', en: 'Workshop: digitising family photographs' },
      where: { ar: 'مكتبة بلدية رام الله · ٤ عصرًا', en: 'Ramallah Municipal Library · 4pm' } },

    { id: 'ev-walk', tone: 'clay', publisher: 'community', date: { ar: 'الجمعة ١٠ نيسان', en: 'Friday 10 April' },
      plate: 'event photo · walking tour',
      title: { ar: 'جولة مشي: شارع ركب وذاكرته', en: 'Walking tour: Rukab Street remembered' },
      where: { ar: 'نقطة اللقاء: ميدان المنارة · ١٠ صباحًا', en: 'Meet at Al-Manara Square · 10am' } },

    { id: 'ev-screening', tone: 'olive', publisher: 'municipality', date: { ar: 'الثلاثاء ٢١ نيسان', en: 'Tuesday 21 April' },
      plate: 'event photo · screening',
      title: { ar: 'عرض فيلم: رام الله ١٩٦٧', en: 'Film screening: Ramallah 1967' },
      where: { ar: 'قصر رام الله الثقافي · ٨ مساءً', en: 'Ramallah Cultural Palace · 8pm' } },

    { id: 'ev-listening', tone: 'olive', publisher: 'team', voice: true, date: { ar: 'الأحد ٣ أيار', en: 'Sunday 3 May' },
      title: { ar: 'ليلة استماع: أصوات من الشتات', en: 'Listening night: voices from the diaspora' },
      where: { ar: 'عبر الإنترنت · ٩ مساءً بتوقيت القدس', en: 'Online · 9pm Jerusalem time' } }
  ];

  /* ── Back office ────────────────────────────────────────── */

  var QUEUE = [
    { id: 'q1', kind: 'photo', hoursLeft: 9, arrivedHours: 39, tone: 'dust', imageCount: 3,
      title: { ar: 'عرس في البلدة القديمة', en: 'A wedding in the Old City' },
      by: { ar: 'سميرة خ.', en: 'Samira Kh.' }, byInitial: { ar: 'س', en: 'S' },
      memberSince: 2024, published: 7,
      plate: 'submitted photo · 2400×1600 · 4.1 MB',
      story: { ar: '«زفّة خالي في حارة النصارى. الصورة من ألبوم جدّتي، وأظنها التقطت قبل العيد بأيام.»',
               en: "My uncle's procession in Haret al-Nasara. The photo is from my grandmother's album; I think it was taken a few days before the feast." },
      place: { ar: 'البلدة القديمة — حارة النصارى', en: 'Old City — Haret al-Nasara' },
      decade: { ar: 'الستينيات · ١٩٦٧', en: '1960s · 1967' },
      tags: [{ ar: 'أعراس', en: 'Weddings' }, { ar: 'عائلة', en: 'Family' }],
      thumbs: ['stone', 'clay', 'ochre'] },

    { id: 'q2', kind: 'voice', hoursLeft: 21, arrivedHours: 27, tone: 'olive', duration: '4:12',
      title: { ar: 'جدّي يحكي عن سوق الثلاثاء', en: 'My grandfather on the Tuesday market' },
      by: { ar: 'رامي ن.', en: 'Rami N.' }, byInitial: { ar: 'ر', en: 'R' },
      memberSince: 2026, published: 2,
      plate: 'submitted audio · 4:12 · 9.8 MB',
      story: { ar: '«سجّلته على هاتفي في زيارتي الأخيرة. يحكي عن البسطات وأسماء التجّار.»',
               en: 'I recorded this on my phone on my last visit. He talks about the stalls and the traders by name.' },
      place: { ar: 'السوق التحتا', en: 'The lower market' },
      decade: { ar: 'الستينيات', en: '1960s' },
      tags: [{ ar: 'سوق', en: 'Market' }, { ar: 'رواية شفوية', en: 'Oral history' }],
      thumbs: ['olive'] },

    { id: 'q3', kind: 'photo', hoursLeft: 31, arrivedHours: 17, tone: 'amber', imageCount: 1,
      title: { ar: 'المنارة قبل التوسعة', en: 'Al-Manara before the widening' },
      by: { ar: 'ليلى ح.', en: 'Layla H.' }, byInitial: { ar: 'ل', en: 'L' },
      memberSince: 2025, published: 4,
      plate: 'submitted photo · 1800×1200 · 2.6 MB',
      story: { ar: '«من ألبوم والدي. الميدان قبل أن يتغيّر شكله بالكامل.»',
               en: "From my father's album. The square before its shape changed completely." },
      place: { ar: 'ميدان المنارة', en: 'Al-Manara Square' },
      decade: { ar: 'الخمسينيات', en: '1950s' },
      tags: [{ ar: 'المنارة', en: 'Al-Manara' }],
      thumbs: ['amber'] },

    { id: 'q4', kind: 'event', hoursLeft: 34, arrivedHours: 14, tone: 'ochre',
      title: { ar: 'ورشة: ترميم الصور العائلية', en: 'Workshop: restoring family photographs' },
      by: { ar: 'مركز السكاكيني', en: 'Sakakini Centre' }, byInitial: { ar: 'م', en: 'S' },
      memberSince: 2024, published: 4,
      plate: 'event poster · 1600×1000',
      story: { ar: 'ورشة عملية لأربع ساعات في مسح الصور العائلية وترميمها رقميًا، بإشراف فريق الأرشيف. عشرون مقعدًا، والتسجيل مجاني.',
               en: 'A four-hour hands-on workshop in scanning and digitally restoring family photographs, led by the archive team. Twenty seats, free to register.' },
      place: { ar: 'مركز خليل السكاكيني الثقافي', en: 'Khalil Sakakini Cultural Centre' },
      decade: { ar: '—', en: '—' },
      tags: [{ ar: 'ورشة', en: 'Workshop' }],
      thumbs: ['ochre'] },

    { id: 'q5', kind: 'photo', hoursLeft: 41, arrivedHours: 7, tone: 'clay', imageCount: 2,
      title: { ar: 'شارع ركب في الثمانينيات', en: 'Rukab Street in the 1980s' },
      by: { ar: 'نادر ص.', en: 'Nader S.' }, byInitial: { ar: 'ن', en: 'N' },
      memberSince: 2024, published: 18,
      plate: 'submitted photo · 2200×1400 · 3.4 MB',
      story: { ar: '«الشارع قبل أن تُرصف من جديد. البوظة كانت في المحل نفسه.»',
               en: 'The street before it was repaved. The ice cream shop was in the same spot.' },
      place: { ar: 'شارع ركب', en: 'Rukab Street' },
      decade: { ar: 'الثمانينيات', en: '1980s' },
      tags: [{ ar: 'شوارع', en: 'Streets' }],
      thumbs: ['clay', 'dust'] },

    { id: 'q6', kind: 'voice', hoursLeft: 44, arrivedHours: 4, tone: 'stone', duration: '1:58',
      title: { ar: 'أهزوجة من عرس ١٩٧٤', en: 'A wedding song from 1974' },
      by: { ar: 'أم خالد', en: 'Umm Khaled' }, byInitial: { ar: 'أ', en: 'U' },
      memberSince: 2025, published: 6,
      plate: 'submitted audio · 1:58 · 4.2 MB',
      story: { ar: '«أهزوجة كانت تُقال في أعراس الطيرة. حفظتها عن أمّي.»',
               en: 'A song sung at weddings in al-Tireh. I learned it from my mother.' },
      place: { ar: 'حيّ الطيرة', en: 'Al-Tireh' },
      decade: { ar: 'السبعينيات', en: '1970s' },
      tags: [{ ar: 'أعراس', en: 'Weddings' }, { ar: 'أغانٍ', en: 'Songs' }],
      thumbs: ['stone'] },

    { id: 'q7', kind: 'photo', hoursLeft: 46, arrivedHours: 2, tone: 'wheat', imageCount: 1,
      title: { ar: 'مدرسة الفرندز، صف ١٩٦٢', en: 'Friends School, class of 1962' },
      by: { ar: 'جورج ب.', en: 'George B.' }, byInitial: { ar: 'ج', en: 'G' },
      memberSince: 2025, published: 3,
      plate: 'submitted photo · 2000×1300 · 3.0 MB',
      story: { ar: '«صورة الصف كما علّقت في بيتنا خمسين سنة.»',
               en: 'The class photograph, exactly as it hung in our house for fifty years.' },
      place: { ar: 'مدرسة الفرندز', en: 'Friends School' },
      decade: { ar: 'الستينيات · ١٩٦٢', en: '1960s · 1962' },
      tags: [{ ar: 'مدارس', en: 'Schools' }],
      thumbs: ['wheat'] }
  ];

  var PUBLISHED = [
    { tone: 'amber',     title: { ar: 'المنارة في المطر، ١٩٨٩', en: 'Al-Manara in the rain, 1989' },
      by: { ar: 'هناء ع.', en: 'Hana A.' },   place: 'manara',  decade: 1980, on: { ar: '٨ آذار ٢٠٢٦', en: '8 March 2026' }, views: 1240 },
    { tone: 'stone',     title: { ar: 'زفّة في البلدة القديمة، ١٩٦٧', en: 'A procession in the Old City, 1967' },
      by: { ar: 'سميرة خ.', en: 'Samira Kh.' }, place: 'oldcity', decade: 1960, on: { ar: '٧ آذار ٢٠٢٦', en: '7 March 2026' }, views: 986 },
    { tone: 'clay',      title: { ar: 'بوظة ركب، صيف ١٩٧٨', en: "Rukab's ice cream, summer 1978" },
      by: { ar: 'نادر ص.', en: 'Nader S.' },  place: 'rukab',   decade: 1970, on: { ar: '٦ آذار ٢٠٢٦', en: '6 March 2026' }, views: 2115 },
    { tone: 'olive',     title: { ar: 'صوت: أعراس الطيرة', en: 'Voice: weddings in al-Tireh' },
      by: { ar: 'أم خالد', en: 'Umm Khaled' }, place: 'tireh',  decade: 1970, on: { ar: '٥ آذار ٢٠٢٦', en: '5 March 2026' }, views: 443 },
    { tone: 'dust',      title: { ar: 'مدرسة الفرندز، صف ١٩٦٢', en: 'Friends School, class of 1962' },
      by: { ar: 'جورج ب.', en: 'George B.' }, place: 'friends', decade: 1960, on: { ar: '٤ آذار ٢٠٢٦', en: '4 March 2026' }, views: 770 },
    { tone: 'stone',     title: { ar: 'سوق الثلاثاء، ١٩٩٤', en: 'The Tuesday market, 1994' },
      by: { ar: 'رامي ن.', en: 'Rami N.' },   place: 'oldcity', decade: 1990, on: { ar: '٣ آذار ٢٠٢٦', en: '3 March 2026' }, views: 602 },
    { tone: 'parchment', title: { ar: 'افتتاح قصر رام الله الثقافي', en: 'Opening of the Ramallah Cultural Palace' },
      by: { ar: 'فريق الأرشيف', en: 'Archive team' }, place: 'palace', decade: 2000, on: { ar: '٢ آذار ٢٠٢٦', en: '2 March 2026' }, views: 518 }
  ];

  var MEMBERS = [
    { id: 'm1', tone: '#A98D66', initial: { ar: 'س', en: 'S' }, name: { ar: 'سميرة خ.', en: 'Samira Kh.' },
      email: 'samira.kh@mail.ps', role: 'contributor', contributions: 7, pending: 1, lastActiveHours: 39,
      city: { ar: 'رام الله', en: 'Ramallah' }, joined: 2024, status: 'active', feminine: true },
    { id: 'm2', tone: '#D9A441', initial: { ar: 'ه', en: 'H' }, name: { ar: 'هناء ع.', en: 'Hana A.' },
      email: 'hana@ramallahmemory.ps', role: 'editor', contributions: 142, pending: 0, lastActiveHours: 1,
      city: { ar: 'رام الله', en: 'Ramallah' }, joined: 2023, status: 'active', feminine: true },
    { id: 'm3', tone: '#8A9268', initial: { ar: 'م', en: 'M' }, name: { ar: 'مروان د.', en: 'Marwan D.' },
      email: 'marwan@sakakini.org', role: 'partner', partnerOf: { ar: 'السكاكيني', en: 'Sakakini' },
      contributions: 9, pending: 0, lastActiveHours: 3,
      city: { ar: 'رام الله', en: 'Ramallah' }, joined: 2024, status: 'active' },
    { id: 'm4', tone: '#B37E5F', initial: { ar: 'ج', en: 'G' }, name: { ar: 'جورج ب.', en: 'George B.' },
      email: 'george.b@mail.com', role: 'contributor', contributions: 3, pending: 1, lastActiveHours: 2,
      city: { ar: 'عمّان', en: 'Amman' }, joined: 2025, status: 'active' },
    { id: 'm5', tone: '#9E8663', initial: { ar: 'ن', en: 'N' }, name: { ar: 'نادر ص.', en: 'Nader S.' },
      email: 'nader@mail.ps', role: 'contributor', contributions: 18, pending: 1, lastActiveHours: 7,
      city: { ar: 'رام الله', en: 'Ramallah' }, joined: 2024, status: 'active' },
    { id: 'm6', tone: '#8F956E', initial: { ar: 'أ', en: 'U' }, name: { ar: 'أم خالد', en: 'Umm Khaled' },
      email: '—', role: 'narrator', contributions: 6, pending: 1, lastActiveHours: 4,
      city: { ar: 'البيرة', en: 'Al-Bireh' }, joined: 2025, status: 'active', feminine: true },
    { id: 'm7', tone: '#C09A66', initial: { ar: 'ر', en: 'R' }, name: { ar: 'رامي ن.', en: 'Rami N.' },
      email: 'rami.n@mail.com', role: 'contributor', contributions: 2, pending: 1, lastActiveHours: 27,
      city: { ar: 'سانتياغو', en: 'Santiago' }, joined: 2026, status: 'suspended' }
  ];

  var REPORTS = [
    { id: 'r1', reason: 'false', reportedHours: 1, count: 1,
      subject: { ar: 'تعليق على «سوق الثلاثاء»', en: 'A comment on "The Tuesday market"' },
      reporter: { ar: 'ليلى ح.', en: 'Layla H.' },
      claim: { ar: '«التاريخ المذكور في التعليق غير صحيح، السوق انتقل سنة ١٩٩١ لا ١٩٨٧. جدّي كان من تجّاره.»',
               en: 'The date in the comment is wrong — the market moved in 1991, not 1987. My grandfather traded there.' },
      author: { ar: 'رامي ن.', en: 'Rami N.' }, authorInitial: { ar: 'ر', en: 'R' }, authorTone: '#9E8663',
      authorWhen: { ar: 'قبل يومين', en: '2 days ago' },
      content: { ar: '«أذكر أن السوق انتقل إلى موقعه الحالي سنة ١٩٨٧، وكانت البسطات تمتد حتى نهاية الشارع.»',
                 en: 'I remember the market moved to its current spot in 1987, and the stalls ran to the end of the street.' },
      onMemory: { ar: 'سوق الثلاثاء، ١٩٩٤', en: 'The Tuesday market, 1994' }, onTone: 'stone' },

    { id: 'r2', reason: 'privacy', reportedHours: 6, count: 2,
      subject: { ar: 'صورة: «عائلة في الطيرة»', en: 'Photo: "A family in al-Tireh"' },
      reporter: { ar: 'مجهول', en: 'Anonymous' },
      claim: { ar: '«في الصورة أفراد من عائلتي لم يوافقوا على النشر. نطلب حجبها حتى نتحدث معهم.»',
               en: 'The photo shows members of my family who did not agree to publication. Please hide it until we can speak with them.' },
      author: { ar: 'ليلى ح.', en: 'Layla H.' }, authorInitial: { ar: 'ل', en: 'L' }, authorTone: '#B37E5F',
      authorWhen: { ar: 'قبل أسبوع', en: '1 week ago' },
      content: { ar: '«صورة العائلة في باحة البيت، الطيرة، أواخر السبعينيات.»',
                 en: 'The family in the courtyard of the house, al-Tireh, late 1970s.' },
      onMemory: { ar: 'عائلة في الطيرة', en: 'A family in al-Tireh' }, onTone: 'olive' }
  ];

  /* Monthly intake for the overview chart — last 12 months, most recent last. */
  var INTAKE = [
    { month: 'Sep', value: 26 }, { month: 'Oct', value: 34 }, { month: 'Nov', value: 30 },
    { month: 'Dec', value: 45 }, { month: 'Jan', value: 41 }, { month: 'Feb', value: 52 },
    { month: 'Mar', value: 60 }, { month: 'Apr', value: 57 }, { month: 'May', value: 72 },
    { month: 'Jun', value: 68 }, { month: 'Jul', value: 84 }, { month: 'Aug', value: 96 }
  ];

  var COVERAGE = [
    { decade: 1950, pct: 18, count: 61,  level: 'low' },
    { decade: 1960, pct: 44, count: 148, level: 'ok' },
    { decade: 1970, pct: 30, count: 102, level: 'mid' },
    { decade: 1980, pct: 66, count: 221, level: 'ok' },
    { decade: 1990, pct: 88, count: 296, level: 'ok' }
  ];

  var ACTIVITY = [
    { level: 'ok',    text: { ar: 'نشرت <b>هناء ع.</b> «المنارة في المطر، ١٩٨٩» — قبل ١٢ دقيقة',
                              en: '<b>Hana A.</b> published "Al-Manara in the rain, 1989" — 12 minutes ago' } },
    { level: 'warn',  text: { ar: 'بلاغ جديد على تعليق في «سوق الثلاثاء» — قبل ساعة',
                              en: 'A new report on a comment in "The Tuesday market" — 1 hour ago' } },
    { level: 'ok',    text: { ar: 'وافق <b>مروان د.</b> على فعالية «جولة شارع ركب» — قبل ٣ ساعات',
                              en: '<b>Marwan D.</b> approved the event "Rukab Street walking tour" — 3 hours ago' } },
    { level: 'alert', text: { ar: 'أعيدت مساهمة إلى صاحبها لطلب تفاصيل المكان — قبل ٥ ساعات',
                              en: 'A contribution went back to its author for place details — 5 hours ago' } },
    { level: 'muted', text: { ar: '١٤ عضوًا جديدًا انضموا أمس', en: '14 new members joined yesterday' } }
  ];

  var DECADES = [1950, 1960, 1970, 1980, 1990, 2000];

  global.DATA = {
    TONES: TONES,
    PLACES: PLACES,
    MEMORIES: MEMORIES,
    EVENTS: EVENTS,
    QUEUE: QUEUE,
    PUBLISHED: PUBLISHED,
    MEMBERS: MEMBERS,
    REPORTS: REPORTS,
    INTAKE: INTAKE,
    COVERAGE: COVERAGE,
    ACTIVITY: ACTIVITY,
    DECADES: DECADES,
    place: function (id) {
      for (var i = 0; i < PLACES.length; i++) if (PLACES[i].id === id) return PLACES[i];
      return null;
    },
    tone: function (name) { return TONES[name] || TONES.sand; }
  };
})(window);
