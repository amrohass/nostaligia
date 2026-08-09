/* The Atlas content store — the one place views read content from.
   `data.js` is now seed material only: the store copies it on first run, keeps the
   working set in localStorage, and hands every view the same records the dashboard
   edits. Swapping this for a backend means reimplementing the API below and nothing
   else — no view touches DATA or localStorage directly.

   Records are language pairs ({ar, en}), not strings, so everything stays bilingual.
   UI chrome (nav, buttons, field labels) stays in i18n.js; only editorial copy —
   headings, paragraphs, page sections — lives here where an editor can reach it. */

(function (global) {
  'use strict';

  var KEY = 'rma.store.v3';
  var COLLECTIONS = ['users', 'memories', 'comments', 'events', 'copy', 'pages'];

  var state = null;
  var listeners = [];

  /* ── Seed ────────────────────────────────────────────────── */

  /* Two commenters in the seed are not archive members; they get records here so
     every comment can link back to a profile. */
  var EXTRA_USERS = [
    { id: 'u-salma', tone: '#B29470', initial: { ar: 'س', en: 'S' }, name: { ar: 'سلمى ك.', en: 'Salma K.' },
      email: 'salma.k@mail.com', role: 'contributor', contributions: 0, pending: 0, lastActiveHours: 48,
      city: { ar: 'ديترويت', en: 'Detroit' }, joined: 2025, status: 'active', feminine: true },
    { id: 'u-georgeh', tone: '#8F956E', initial: { ar: 'ج', en: 'G' }, name: { ar: 'جورج ح.', en: 'George H.' },
      email: 'george.h@mail.com', role: 'contributor', contributions: 0, pending: 0, lastActiveHours: 168,
      city: { ar: 'ديترويت', en: 'Detroit' }, joined: 2024, status: 'active' }
  ];

  var BIOS = {
    m1: { ar: 'من حارة النصارى في البلدة القديمة. أرفع ما تحفظه ألبومات جدّتي، وأحاول أن أضبط التاريخ قدر ما أستطيع.',
          en: 'From Haret al-Nasara in the Old City. I upload what my grandmother’s albums keep, and try to get the dates as right as I can.' },
    m2: { ar: 'محرّرة في الأرشيف منذ ٢٠٢٣. أراجع المساهمات وأتحقّق من الأماكن والعقود قبل النشر.',
          en: 'An archive editor since 2023. I review contributions and check places and decades before they go out.' },
    m3: { ar: 'منسّق البرامج في مركز خليل السكاكيني الثقافي. أنشر فعاليات المركز هنا.',
          en: 'Programme coordinator at the Khalil Sakakini Cultural Centre. I publish the centre’s events here.' },
    m4: { ar: 'من مواليد رام الله، مقيم في عمّان. صور المدرسة والطريق إلى بيرزيت من ألبوم العائلة.',
          en: 'Born in Ramallah, living in Amman. School photographs and the Birzeit road, from the family album.' },
    m5: { ar: 'أصوّر شوارع المدينة منذ الثمانينيات. شارع ركب أكثر ما صوّرته.',
          en: 'I have photographed the city’s streets since the 1980s. Rukab Street more than any other.' },
    m6: { ar: 'أروي ما أذكره من أعراس الطيرة وأهازيجها. التسجيلات بصوتي.',
          en: 'I narrate what I remember of weddings in al-Tireh and their songs. The recordings are my own voice.' },
    m7: { ar: 'من الشتات في سانتياغو. أسجّل ما يرويه جدّي عن السوق وأرفعه إلى الأرشيف.',
          en: 'From the diaspora in Santiago. I record what my grandfather tells of the market and upload it here.' },
    'u-salma': { ar: 'حفيدة رام الله من ديترويت. أعلّق حيث أعرف الحكاية.',
                 en: 'A granddaughter of Ramallah, in Detroit. I comment where I know the story.' },
    'u-georgeh': { ar: 'أجمع نسخًا ملوّنة من صور المدينة القديمة.',
                   en: 'I collect colorized prints of old photographs of the city.' }
  };

  /* Every field a profile can gate. Display name, avatar and role badge are never
     listed here — they are always visible, so attribution never breaks. */
  var VISIBILITY_FIELDS = ['bio', 'personalInfo', 'contributions', 'comments'];

  function defaultVisibility(overrides) {
    var map = {};
    VISIBILITY_FIELDS.forEach(function (field) { map[field] = 'public'; });
    if (overrides) Object.keys(overrides).forEach(function (k) { map[k] = overrides[k]; });
    return map;
  }

  /* Which member contributed which memory. The seed carried these as loose names
     on the admin tables; here they become real references. */
  var MEMORY_AUTHORS = {
    wedding67: 'm1', municipality58: 'm1', tuesdayMarket: 'm7', manara65: 'm2',
    stairway80: 'm1', birzeitRoad94: 'm4', rukab72: 'm5', manaraRain89: 'm2',
    friends62: 'm4', tirehWeddings: 'm6', market94: 'm7', palaceOpening: 'm2'
  };

  /* Comments the seed does not carry, added so more than one profile has a
     populated "Comments made" section. */
  var EXTRA_COMMENTS = [
    { id: 'c-rukab72-1', memoryId: 'rukab72', authorId: 'm1', status: 'published',
      when: { ar: 'قبل ٣ أيام', en: '3 days ago' },
      body: { ar: '«كنّا نقف في الطابور بعد المدرسة. البوظة بالفستق كانت بقرشين.»',
              en: 'We used to queue here after school. Pistachio ice cream cost two piastres.' } },
    { id: 'c-friends62-1', memoryId: 'friends62', authorId: 'm1', status: 'published',
      when: { ar: 'قبل أسبوعين', en: '2 weeks ago' },
      body: { ar: '«الصفّ الثالث من اليمين — أظنه عمّي. سأسأل والدتي وأؤكّد.»',
              en: 'Third row from the right — I think that is my uncle. I will ask my mother and confirm.' } },
    { id: 'c-manaraRain89-1', memoryId: 'manaraRain89', authorId: 'm5', status: 'published',
      when: { ar: 'قبل ٥ أيام', en: '5 days ago' },
      body: { ar: '«المطر في المنارة له رائحة لا تُنسى — حجر مبلول وقهوة.»',
              en: 'Rain at Al-Manara has a smell you do not forget — wet stone and coffee.' } }
  ];

  var COMMENT_AUTHORS = {
    'سلمى ك.': 'u-salma', 'جورج ح.': 'u-georgeh', 'أم خالد': 'm6', 'رامي ن.': 'm7'
  };

  function seedUsers() {
    return DATA.MEMBERS.concat(EXTRA_USERS).map(function (member) {
      var user = JSON.parse(JSON.stringify(member));
      user.bio = BIOS[user.id] || { ar: '', en: '' };
      // Two members start partly private so the difference between #/me and
      // #/u/{id} is visible without editing anything first.
      user.visibility = defaultVisibility(
        user.id === 'm7' ? { personalInfo: 'private', comments: 'private' } :
        user.id === 'm4' ? { bio: 'private' } : null
      );
      return user;
    });
  }

  function seedMemories() {
    return DATA.MEMORIES.map(function (memory) {
      var record = JSON.parse(JSON.stringify(memory));
      delete record.comments;               // comments are their own collection now
      record.authorId = MEMORY_AUTHORS[record.id] || 'm2';
      record.status = 'published';
      return record;
    });
  }

  function seedComments() {
    var rows = [];
    DATA.MEMORIES.forEach(function (memory) {
      (memory.comments || []).forEach(function (comment, i) {
        rows.push({
          id: 'c-' + memory.id + '-' + (i + 1),
          memoryId: memory.id,
          authorId: COMMENT_AUTHORS[comment.name.ar] || 'm1',
          body: comment.body,
          when: comment.when,
          status: 'published'               // published | hidden
        });
      });
    });
    return rows.concat(JSON.parse(JSON.stringify(EXTRA_COMMENTS)));
  }

  /* Editorial copy. `where` is the admin-facing hint for which screen it lands on. */
  function seedCopy() {
    return [
      { id: 'hero.line', where: { ar: 'الصفحة الرئيسية', en: 'Landing' }, kind: 'line',
        label: { ar: 'عنوان الواجهة', en: 'Hero headline' },
        value: { ar: 'هنا تُروى رام الله — صورةً وصوتًا وحكاية.',
                 en: 'Here, Ramallah is told — in pictures, voices, and stories.' } },
      { id: 'hero.blurb', where: { ar: 'الصفحة الرئيسية', en: 'Landing' }, kind: 'paragraph',
        label: { ar: 'فقرة الواجهة', en: 'Hero paragraph' },
        value: { ar: 'أرشيف مجتمعيّ يجمع ما تحفظه العائلات — في المدينة وفي الشتات — منذ الخمسينيات حتى اليوم.',
                 en: 'A community archive of what families keep — in the city and across the diaspora — from the 1950s to today.' } },
      { id: 'events.title', where: { ar: 'الفعاليات', en: 'Events' }, kind: 'line',
        label: { ar: 'عنوان الفعاليات', en: 'Events heading' },
        value: { ar: 'فعاليات حول الذاكرة', en: 'Events around the memory' } },
      { id: 'events.blurb', where: { ar: 'الفعاليات', en: 'Events' }, kind: 'paragraph',
        label: { ar: 'فقرة الفعاليات', en: 'Events paragraph' },
        value: { ar: 'معارض وجولات وورشات ينظّمها الأرشيف وأهل المدينة — في رام الله وعبر الإنترنت.',
                 en: 'Exhibitions, tours and workshops run by the archive and by the city — in Ramallah and online.' } },
      { id: 'footer.blurb', where: { ar: 'التذييل', en: 'Footer' }, kind: 'paragraph',
        label: { ar: 'تعريف التذييل', en: 'Footer blurb' },
        value: { ar: 'أرشيف مجتمعيّ مستقل لذاكرة رام الله وأهلها — تُدار مواده بعناية تحريرية وتُتاح للجميع.',
                 en: 'An independent community archive of Ramallah’s memory — carefully curated, open to all.' } },
      { id: 'donate.title', where: { ar: 'التذييل', en: 'Footer' }, kind: 'line',
        label: { ar: 'عنوان التبرّع', en: 'Donate heading' },
        value: { ar: 'ادعم الذاكرة', en: 'Support the memory' } },
      { id: 'donate.blurb', where: { ar: 'التذييل', en: 'Footer' }, kind: 'paragraph',
        label: { ar: 'فقرة التبرّع', en: 'Donate paragraph' },
        value: { ar: 'مشروع أهليّ غير ربحيّ، تموّله المنح الثقافية ومساهمات الأفراد. تبرّعك يحفظ صورة أخرى من الضياع.',
                 en: 'A non-profit civic project, funded by cultural grants and individual gifts. Your donation keeps another photograph from being lost.' } }
    ];
  }

  /* The #/page sections. `slug` is the deep link: #/page/about … */
  function seedPages() {
    return [
      { id: 'about', slug: 'about', order: 1,
        title: { ar: 'من نحن', en: 'About us' },
        body: {
          ar: 'ذاكرة رام الله أرشيف مجتمعيّ مستقل، بدأ من ألبومات العائلات وأدراج البيوت. نجمع الصور والتسجيلات والحكايات التي تحفظ شكل المدينة منذ الخمسينيات، ونتيحها للجميع.\n\nكل ما يصلنا يمرّ بمراجعة تحريرية: نتحقّق من المكان والعقد وننسب المادة إلى أصحابها قدر المستطاع. لا ننشر ما لم يوافق صاحبه على عرضه، ونصحّح ما يثبت خطؤه.\n\nالمشروع يديره فريق صغير في رام الله، ويكبر بما يضيفه الناس إليه — من المدينة ومن الشتات.',
          en: 'The Ramallah Memory Atlas is an independent community archive that began in family albums and household drawers. We gather the photographs, recordings and stories that hold the shape of the city from the 1950s onward, and we open them to everyone.\n\nEverything we receive passes an editorial review: we check the place and the decade, and attribute material to its owners as accurately as we can. We do not publish what its owner has not agreed to show, and we correct what is shown to be wrong.\n\nA small team in Ramallah runs the project, and it grows by what people add to it — from the city and from the diaspora.'
        } },
      { id: 'contact', slug: 'contact', order: 2,
        title: { ar: 'تواصل معنا', en: 'Contact' },
        body: {
          ar: 'نقرأ كل رسالة. إن كانت لديك صورة أو تسجيل أو تصحيح لمعلومة منشورة، اكتب لنا وسنردّ خلال ٤٨ ساعة.\n\nللمساهمات: أرسل ما لديك عبر زر «شارك ذكرى» بعد تسجيل الدخول، أو راسلنا مباشرة إن كانت المادة كبيرة.\n\nللصحافة والشراكات: راسلنا على البريد نفسه واذكر «صحافة» أو «شراكة» في العنوان.',
          en: 'We read every message. If you have a photograph, a recording, or a correction to something published, write to us and we will reply within 48 hours.\n\nFor contributions: send what you have through the “Share a memory” button once signed in, or write to us directly if the material is large.\n\nFor press and partnerships: use the same address and put “press” or “partnership” in the subject line.'
        } },
      { id: 'support', slug: 'support', order: 3,
        title: { ar: 'المساعدة والدعم', en: 'Help & support' },
        body: {
          ar: 'كيف أشارك ذكرى؟ أنشئ حسابًا، ثم اضغط «شارك ذكرى» واختر صورة أو تسجيلًا صوتيًا أو فعالية. أضف المكان والعقد وما تذكره من الحكاية.\n\nمتى تُنشر مساهمتي؟ نتعهّد بالردّ خلال ٤٨ ساعة. إن نقص تفصيل صغير أعدناها إليك مع ملاحظة بدل رفضها.\n\nمن يملك المادة؟ صاحبها. نعرضها في الأرشيف بإذنه، ويمكنه طلب سحبها في أي وقت.\n\nوجدت خطأ في تاريخ أو مكان؟ استخدم زر الإبلاغ على الذكرى. نصحّح السجلّ ونبقي الذكرى.',
          en: 'How do I share a memory? Create an account, press “Share a memory”, and choose a photo, a voice recording, or an event. Add the place, the decade, and what you remember of the story.\n\nWhen is my contribution published? We promise a reply within 48 hours. If a small detail is missing we send it back with a note rather than rejecting it.\n\nWho owns the material? Its owner. We show it in the archive with their permission, and they can ask for it to be withdrawn at any time.\n\nFound a wrong date or place? Use the report control on the memory. We correct the record and keep the memory.'
        } },
      { id: 'donate', slug: 'donate', order: 4,
        title: { ar: 'ادعم الذاكرة', en: 'Support the memory' },
        body: {
          ar: 'ذاكرة رام الله مشروع أهليّ غير ربحيّ. تموّله المنح الثقافية ومساهمات الأفراد، ولا يعرض إعلانات ولا يبيع بيانات مستخدميه.\n\nإلى أين يذهب تبرّعك: مسح الصور وترميمها رقميًا، وتسجيل الروايات الشفوية مع كبار السنّ، وتخزين المواد ونسخها احتياطيًا، وأجر فريق المراجعة الصغير.\n\nشروط التبرّع: التبرّعات غير مستردّة، ولا تمنح المتبرّع أي حقّ في مواد الأرشيف ولا تأثيرًا على قرارات النشر. نصدر إيصالًا لكل تبرّع عند الطلب، وننشر ملخّصًا ماليًا سنويًا. للتبرّعات المؤسسية أو المخصّصة لبرنامج بعينه، راسلنا أولًا لنتّفق على الشروط كتابةً.',
          en: 'The Ramallah Memory Atlas is a non-profit civic project. It is funded by cultural grants and individual gifts; it runs no advertising and does not sell its users’ data.\n\nWhere your gift goes: scanning and digitally restoring photographs, recording oral histories with older narrators, storage and backup of the material, and the wage of a small review team.\n\nDonation terms: donations are non-refundable, and grant the donor no right over archive material and no influence on publishing decisions. We issue a receipt for any donation on request, and publish an annual financial summary. For institutional gifts, or gifts earmarked for a specific programme, write to us first so the terms can be agreed in writing.'
        },
        // Fill these two in and they propagate to the page, no code change needed.
        contact: { email: 'PLACEHOLDER_EMAIL', whatsapp: 'PLACEHOLDER_WHATSAPP' } }
    ];
  }

  function seed() {
    return {
      version: 3,
      users: seedUsers(),
      memories: seedMemories(),
      comments: seedComments(),
      events: JSON.parse(JSON.stringify(DATA.EVENTS)),
      copy: seedCopy(),
      pages: seedPages()
    };
  }

  /* ── Persistence ─────────────────────────────────────────── */

  function load() {
    try {
      var raw = global.localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        // Any collection missing from an older save falls back to seed.
        var fresh = seed();
        COLLECTIONS.forEach(function (name) {
          if (!Array.isArray(parsed[name])) parsed[name] = fresh[name];
        });
        return parsed;
      }
    } catch (e) { /* corrupt or unavailable — fall through to a clean seed */ }
    return seed();
  }

  function save() {
    try { global.localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { /* quota or private mode — the session keeps working in memory */ }
  }

  function notify(change) {
    listeners.forEach(function (fn) {
      try { fn(change); } catch (e) { /* a bad listener must not break a write */ }
    });
  }

  function commit(change) {
    save();
    notify(change);
  }

  function collection(name) {
    if (COLLECTIONS.indexOf(name) === -1) throw new Error('unknown collection: ' + name);
    return state[name];
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function nextId(name, prefix) {
    var n = collection(name).length + 1;
    var id;
    do { id = prefix + '-' + n; n++; } while (get(name, id));
    return id;
  }

  /* ── API ─────────────────────────────────────────────────── */

  /** Every record in a collection, optionally filtered. Returns copies. */
  function list(name, filter) {
    var rows = collection(name).map(clone);
    return typeof filter === 'function' ? rows.filter(filter) : rows;
  }

  /** One record by id, or null. Returns a copy. */
  function get(name, id) {
    var rows = collection(name);
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return clone(rows[i]);
    return null;
  }

  /** Shallow-merge a patch into a record. Returns the updated copy, or null. */
  function set(name, id, patch) {
    var rows = collection(name);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id !== id) continue;
      Object.keys(patch).forEach(function (key) { rows[i][key] = patch[key]; });
      commit({ collection: name, id: id, action: 'set' });
      return clone(rows[i]);
    }
    return null;
  }

  /** Append a record, assigning an id when one is not supplied. */
  function add(name, record, idPrefix) {
    var row = clone(record) || {};
    if (!row.id) row.id = nextId(name, idPrefix || name.slice(0, 1));
    collection(name).push(row);
    commit({ collection: name, id: row.id, action: 'add' });
    return clone(row);
  }

  function remove(name, id) {
    var rows = collection(name);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id !== id) continue;
      rows.splice(i, 1);
      commit({ collection: name, id: id, action: 'remove' });
      return true;
    }
    return false;
  }

  /** Move a record within its collection — used for ordering page sections. */
  function move(name, id, delta) {
    var rows = collection(name);
    var from = -1;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) { from = i; break; }
    if (from === -1) return false;
    var to = Math.max(0, Math.min(rows.length - 1, from + delta));
    if (to === from) return false;
    rows.splice(to, 0, rows.splice(from, 1)[0]);
    commit({ collection: name, id: id, action: 'move' });
    return true;
  }

  /** Editorial copy block by id — returns the {ar, en} pair, or an empty pair. */
  function copy(id) {
    var row = get('copy', id);
    return row ? row.value : { ar: '', en: '' };
  }

  function setCopy(id, value) {
    return set('copy', id, { value: value });
  }

  /** A page section by its deep-link slug. */
  function page(slug) {
    var rows = collection('pages');
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) return clone(rows[i]);
    return null;
  }

  function reset() {
    state = seed();
    commit({ collection: null, action: 'reset' });
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      var i = listeners.indexOf(fn);
      if (i > -1) listeners.splice(i, 1);
    };
  }

  state = load();

  // An edit in the dashboard tab reaches an open public tab without a reload.
  global.addEventListener('storage', function (event) {
    if (event.key !== KEY) return;
    state = load();
    notify({ collection: null, action: 'external' });
  });

  global.Store = {
    VISIBILITY_FIELDS: VISIBILITY_FIELDS,
    list: list,
    get: get,
    set: set,
    add: add,
    remove: remove,
    move: move,
    copy: copy,
    setCopy: setCopy,
    page: page,
    reset: reset,
    subscribe: subscribe,

    /* Convenience readers used across views — all built on list/get above. */
    memoriesFor: function (userId) {
      return list('memories', function (m) { return m.authorId === userId && m.status === 'published'; });
    },
    commentsFor: function (userId) {
      return list('comments', function (c) { return c.authorId === userId && c.status === 'published'; });
    },
    commentsOn: function (memoryId) {
      return list('comments', function (c) { return c.memoryId === memoryId && c.status === 'published'; });
    },
    author: function (record) {
      return record && record.authorId ? get('users', record.authorId) : null;
    }
  };
})(window);
