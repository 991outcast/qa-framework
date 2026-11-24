// Карточка модерации → запрос модели и разбор ответа. Общий код боковой панели (sidepanel.js) и проверки
// на эталонных карточках (eval_cards.js): проверяется ровно то, что работает в браузере.

// в панели tokens() даёт rules.js (подключён раньше), в Node — require
if (typeof module !== 'undefined' && typeof tokens === 'undefined') {
  var { tokens } = require('./rules.js');   // eslint-disable-line no-var
}

// ответ текстом (вопрос по правилам, страница без карточки) — тот же текст, что _RULES_PROMPT в openrouter_connector.py
const PROMPT = 'Ты помогаешь модератору карточек товаров. Тебе даны выдержки из справочника правил площадки и '
  + 'карточка (или вопрос). Решай ТОЛЬКО по правилам из выдержек; если подходящего запрета нет — атрибут верный '
  + '(принять). Ответ по-русски, коротко:\n'
  + '• по каждому атрибуту карточки, где есть нарушение: «ОТКЛОНИТЬ — <атрибут>: <точное название резолюции '
  + 'или раздела>» и одна строка почему, с цитатой нарушения из карточки;\n'
  + '• остальные атрибуты — одной строкой «ПРИНЯТЬ: …»;\n'
  + '• если правило есть только в списке названий разделов, а его текста нет — скажи об этом и что проверить;\n'
  + '• если данных не хватает (нужно фото) — скажи, что именно посмотреть самому;\n'
  + '• видео и видеообложку не оценивай — их смотрит человек: напиши «Видео — смотрите сами».\n'
  + 'Не придумывай правил и резолюций, которых нет в справочнике. На вопрос о правилах — ответь по выдержкам '
  + 'и назови раздел.';

// карточка модерации: решение по каждому проверяемому атрибуту — JSON
const CARD_PROMPT = 'Ты помогаешь модератору карточек товаров Ozon. Даны: выдержки из справочника правил, карточка по '
  + 'атрибутам и фото карточки (ФОТО n — подпись, к какому атрибуту относится). Проверь КАЖДЫЙ атрибут с пометкой '
  + '«проверить»: прочитай значение целиком, рассмотри каждое его фото (надписи, логотипы маркетплейсов, контакты, '
  + 'QR-коды, иероглифы, сигареты и алкоголь, шок-контент, символика) и сверь с правилами.\n'
  + 'Принцип справочника: инструкции построены по принципу «что нельзя» — нет подходящего запрета, атрибут верный.\n'
  + 'Перед тем как отклонить, найди в разделе «Исключения (принимаем)» — подходит исключение, значит принять. Отклоняй, '
  + 'только если можешь процитировать нарушение из карточки или назвать фото. Одно нарушение — одна резолюция у одного '
  + 'атрибута: не дублируй его у других атрибутов.\n'
  + 'Бренд: отклоняй «В описании и/или названии информация о другом бренде», ТОЛЬКО если бренд из названия или '
  + 'аннотации есть в «Таблице критических брендов» (она в выдержках) и не совпадает с атрибутом «Бренд». Бренда '
  + 'нет в таблице — при «Нет бренда» принять. «Для <бренда>», «совместим с <брендом>» — товар не этого бренда: '
  + 'принять.\n'
  + 'Фото: «Изображение» (главное) и «Изображения» (дополнительные) решай отдельно — нарушение на главном фото '
  + 'часто повторяется на дополнительных, проверь каждое. Водяной знак с названием магазина или продавца без ссылки '
  + 'на сайт — допустимо (запрещены ссылки, телефоны, соцсети, логотипы других маркетплейсов).\n'
  + 'Сравни название (даже «не проверяется»), аннотацию и категорию: разные тип товара, бренд, цвет, размер, модель — '
  + '«Общие недочеты»: «Информация в карточке товара противоречит друг другу».\n'
  + 'Товар в категории, которую правило называет разрешённой для него (например, энергетик в «Энергетический '
  + 'напиток»), — это не нарушение.\n'
  + '«Общие недочеты» проверяй всегда и отдельно: сам товар (что продаётся, из названия и аннотации) сверь с '
  + 'разделами «Товар нельзя продавать на Ozon», «Товар должен находиться в ограниченной категории…», '
  + '«…в неверной категории», «признак «18»» из выдержек — запрещённый товар отклоняется, даже если описан '
  + 'спокойно, без подсветки. Каждая строка после «Что нельзя:» — отдельный запрещённый товар (в разделе «Капканы» '
  + 'запрещены и сами капканы, и «подрези»); оговорки «если…» относятся только к своей строке.\n'
  + 'Слова, подсвеченные Ozon, — только подсказка: реши по смыслу (например, «мобил» внутри «автомобильной» — '
  + 'не бренд Mobil).\n'
  + 'Резолюцию бери ТОЛЬКО из списка резолюций этого атрибута, точно как написано; если открыт список «Причины '
  + 'отклонения» на странице — из него. Нарушение, найденное в тексте (название, аннотация), отклоняй у того атрибута, '
  + 'в списке которого есть подходящая резолюция: контакты, ссылки, акции, запрещённые товары, неверная категория, '
  + 'копии, ассортимент, уценка, признак «18» — это «Общие недочеты»; критический бренд в названии или аннотации — '
  + '«Бренд»; у «Аннотации» по справочнику — ключевые слова; а сам атрибут с текстом принимай. Видео и видеообложку '
  + 'не оценивай: decision «смотрите сами». Рич-контент '
  + 'без текста и фото (не открыт) — «смотрите сами» и попроси открыть и пролистать.\n'
  + 'Ответ — только JSON: {"attributes": [{"name": "<название атрибута как в карточке>", "decision": '
  + '"принять" | "отклонить" | "смотрите сами", "resolution": "<для отклонить — точная резолюция, иначе пусто>", '
  + '"reason": "<коротко почему, с цитатой из карточки или номером фото>", "section": "<раздел справочника>"}], '
  + '"summary": "<одна строка итога>"}. Все тексты — по-русски.';

// атрибут на странице → как он называется в справочнике («Применяется к: Атрибут: «…»»)
const ATTR_ALIASES = {
  'изображение': ['главное фото'], 'изображения': ['дополнительное фото'], 'rich-контент': ['рич-контент'],
  'озон.видео': ['озон.видео'], 'озон.видеообложка': ['озон.видеообложка'], 'бренд в одежде и обуви': ['бренд'],
};

const lower = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();


// резолюции по атрибутам — из разделов справочника, где написано, к какому атрибуту они применяются
function buildResolutions(b) {
  const map = new Map();
  const add = (attr, title) => {
    const key = lower(attr).replace(/[:\s]*\d+$/, '').trim();
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(title);
  };
  for (const s of b.sections) {
    const head = s.text.slice(0, 400);
    const names = [...head.matchAll(/Атрибут\w*\s*[:\-]?\s*[«"]([^»"]{2,40})[»"]/g)].map((m) => m[1]);
    // «Товар нельзя продавать на Ozon». Яды — резолюция — часть в кавычках
    const quoted = s.title.match(/^«([^»]+(?:«[^»]*»[^»]*)?)»/);
    const title = quoted ? quoted[1] : s.title;
    for (const n of names) add(n, title);
    if (quoted && !names.length) add('общие недочеты', title);
  }
  return map;
}

function resolutionsFor(map, title) {
  const key = lower(title);
  const out = new Set();
  for (const name of [key, ...(ATTR_ALIASES[key] || [])]) {
    for (const r of map.get(name) || []) out.add(r);
  }
  return [...out];
}

function cardText(card, photos, resolutions, rich) {
  const lines = [`КАРТОЧКА: ${card.name}`, `Продавец: ${card.seller}`, `Категория: ${card.category}`,
                 `Группа товаров: ${card.group}`];
  if (card.badges.length) lines.push(`Плашки: ${card.badges.join(', ')}`);
  for (const a of card.attributes) {
    const marks = [a.checkable ? 'проверить' : 'не проверяется', a.changed && 'изменено', a.active && 'открыт сейчас']
      .filter(Boolean).join(', ');
    lines.push('', `АТРИБУТ «${a.title}» — ${marks}`);
    if (!a.checkable) { lines.push(`Значение: ${a.value.slice(0, 300)}`); continue; }
    if (a.video) { lines.push('Видео — его смотрит человек, не оценивай.'); continue; }
    if (a.value) lines.push(`Значение: ${a.value}`);
    if (a.old) lines.push(`Было до изменения: ${a.old}`);
    const nums = photos.map((p, i) => (p.label.startsWith(`«${a.title}»`) ? i + 1 : 0)).filter(Boolean);
    if (nums.length) lines.push(`Фото: ${nums.length === 1 ? 'ФОТО ' + nums[0] : `ФОТО ${nums[0]}–${nums[nums.length - 1]}`}`);
    if (a.highlights.length) lines.push(`Подсвечено Ozon: ${a.highlights.join(', ')}`);
    const reasons = a.reasons.length ? a.reasons : resolutionsFor(resolutions, a.title);
    if (reasons.length) {
      lines.push((a.reasons.length ? 'Причины отклонения на странице: ' : 'Резолюции этого атрибута: ') + reasons.join(' | '));
    }
    if (/rich/i.test(a.title)) {
      lines.push(rich ? `Текст рич-контента: ${rich.text.slice(0, 4000)}` : 'Рич-контент ещё не открыт — текста и фото нет.');
    }
  }
  return lines.join('\n');
}

// признаки в тексте карточки → слова, которыми о них говорит справочник: по словам «телеграм @ник» и
// «контакты соц. сетей» поиск друг друга не находит
const SIGNALS = [
  [/(\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}|@[a-z0-9_]{3,}|https?:\/\/|www\.|\.(ru|com|su|me)\b|телеграм|telegram|t\.me|whats ?app|ватсап|вконтакте|\bvk\b|viber|вайбер/i,
   'Ссылки контакты призывы номера телефонов контакты соц сетей никнеймы ссылки на сторонние сайты'],
  [/скидк|акци|кешб[эе]к|розыгрыш|%|отзыв|верн[её]м|₽|руб\.|балл|бонус/i,
   'Акции скидка условия акций рекламная информация отзыв получишь деньги'],
  [/wildberries|вайлдберриз|\bwb\b|aliexpress|алиэкспресс|яндекс ?маркет|avito|авито|мегамаркет|lamoda|ламода|joom|kazanexpress|магнит маркет/i,
   'Бренды маркетплейсы упоминания других маркетплейсов торговых сетей'],
  [/\b(18|21)\s*\+|для взрослых|эротик|возрастн/i, 'признак 18 возрастное ограничение признак «18» не указан'],
];

// разделы справочника про медиа-атрибуты (видео, видеообложка, рич-контент) — только если такой атрибут есть
// в карточке: эти разделы длинные и повторяют друг друга, без отбора они вытесняют нужные правила
const MEDIA = [[/видеообложк/i, /видеообложк/i], [/(^|[^а-я])видео(?!обложк)/i, /видео(?!обложк)/i], [/рич-контент/i, /rich|рич/i]];
function excerptSkip(card) {
  const titles = card.attributes.map((a) => a.title).join(' | ');
  const absent = MEDIA.filter(([, attr]) => !attr.test(titles)).map(([section]) => section);
  return (s) => absent.some((re) => re.test(s.title));
}

// проверяется бренд — таблица критических брендов в запросе всегда: бренд отклоняют, только если он в таблице
// (без неё модели отклоняли «Нет бренда» при любом бренде в названии — Flash Up, «чехол для Samsung»)
// и разделы, нужные почти в каждой карточке: честная конкуренция (контакты, акции, маркетплейсы) и противоречие
// названия и аннотации — по словам их часто не найти (второй набор эталонных карточек: «вернём 300 ₽ за отзыв»,
// «также на Wildberries», «красная» в названии и «синий» в аннотации)
const ALWAYS_RE = /^(информация в карточке нарушает принципы честной конкуренции|информация в карточке товара противоречит друг другу)$/i;
function excerptPin(card) {
  const brand = card.attributes.some((a) => a.checkable && /^бренд/i.test(a.title));
  return (s) => ALWAYS_RE.test(s.title)
    || (brand && /^(таблица критических брендов|критические бренды: как проверять)/i.test(s.title));
}

function cardQuery(c, rich) {
  // и непроверяемые атрибуты: «Год выпуска 1975», «Признак 18+ Нет» решают, нужна ли «Букинистика» и признак 18
  const text = [c.name, c.category, c.group, ...c.attributes
    .map((a) => `${a.title} ${a.value} ${a.old} ${a.highlights.join(' ')}`), rich ? rich.text : ''].join('\n');
  return [text, ...SIGNALS.filter(([re]) => re.test(text)).map(([, words]) => words)].join('\n');
}

function parseVerdicts(content) {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[0]);
    const list = (data.attributes || []).map((a) => ({
      attribute: String(a.name || ''), decision: lower(a.decision), resolution: String(a.resolution || ''),
      reason: String(a.reason || ''), section: String(a.section || ''),
    })).filter((a) => a.attribute);
    return { list, summary: String(data.summary || '') };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Скрипт до модели: нарушения, которые находятся точно, без ИИ. enforce — находка надёжна: если модель её
// пропустила, решение исправляется (телефон в аннотации — всегда «честная конкуренция»); без enforce — подсказка
// модели и предупреждение в панели (бренд из таблицы может быть именем: «Русалочка Ариэль»).
const R_HONEST = 'Информация в карточке нарушает принципы честной конкуренции';
const R_KEYWORDS = 'В аннотации указаны ключевые слова';
const R_META = 'В карточке товара присутствует символика либо упоминания организаций Meta';
const R_AGE = 'В карточке товара не указан признак «18»';
const R_BRAND = 'В описании и/или названии информация о другом бренде';

const PHONE_RE = /(?:\+7|(?<!\d)8)[\s(-]*(\d{3})[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi;
const NICK_RE = /(?:^|[\s(«"])@[a-z0-9_.]{3,}/gi;
const URL_RE = /(?:https?:\/\/|www\.)[^\s,;)»"]+|\b[a-z0-9-]{2,}\.(?:ru|com|su|me|net|org|shop|store|рф)\b/gi;
const MESSENGER_RE = /телеграм|telegram|\bt\.me\b|whats ?app|ватсап|вотсап|viber|вайбер|вконтакте|vk\.com/i;
const MARKETPLACE_RE = /wildberries|вайлдберриз|вайлдбериз|aliexpress|алиэкспресс|яндекс[ .]?маркет|avito|авито|мегамаркет|lamoda|ламода|\bjoom\b|kazanexpress|магнит маркет/i;
const META_RE = /instagram|инстаграм|facebook|фейсбук/i;
const OZON_LINK_RE = /ozon\.ru/i;

// таблица критических брендов: «Samsung Самсунг», «Belles Lettres Бель Летр Проверяем только в книгах»
function criticalBrands(book) {
  if (!book) return [];
  const table = book.sections.find((s) => /^таблица критических брендов/i.test(s.title));
  if (!table) return [];
  const out = [];
  for (const line of table.text.split('\n')) {
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9'&.+\- ]{1,40}?)\s+([А-ЯЁа-яё].*)$/);
    if (!m) continue;
    const latin = m[1].trim();
    if (latin.length < 3 || /^\d+$/.test(latin)) continue;
    const note = (m[2].match(/(Проверяем только[^,]*|Не проверяем[^,]*)$/i) || [])[1] || '';
    const variants = m[2].replace(note, '').split(',').map((v) => v.trim()).filter((v) => v.length >= 3);
    out.push({ latin, variants, note });
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scanCard(card, book) {
  const facts = [];
  const attr = (re) => card.attributes.find((a) => re.test(a.title));
  const annotation = attr(/^аннотация/i);
  const nameText = card.name || (attr(/^название/i) || {}).value || '';
  const text = [nameText, annotation ? annotation.value : ''].join('\n');
  const add = (attribute, resolution, evidence, enforce = true) => {
    if (!facts.some((f) => f.attribute === attribute && f.resolution === resolution)) {
      facts.push({ attribute, resolution, evidence, enforce });
    }
  };
  // контакты, ссылки, мессенджеры; 8 800 и help@ozon.ru — можно
  const phones = [...text.matchAll(PHONE_RE)].filter((m) => m[1] !== '800').map((m) => m[0].trim());
  const emails = (text.match(EMAIL_RE) || []).filter((e) => !OZON_LINK_RE.test(e));
  const nicks = (text.replace(EMAIL_RE, '').match(NICK_RE) || []).map((n) => n.trim());
  const urls = (text.replace(EMAIL_RE, '').match(URL_RE) || []).filter((u) => !OZON_LINK_RE.test(u));
  const messenger = text.match(MESSENGER_RE);
  const contacts = [...phones, ...emails, ...nicks, ...urls, ...(messenger ? [messenger[0]] : [])];
  if (contacts.length) add('Общие недочеты', R_HONEST, 'контакты/ссылки: ' + contacts.slice(0, 3).join(', '));
  const market = text.match(MARKETPLACE_RE);
  if (market) add('Общие недочеты', R_HONEST, 'упомянут маркетплейс: ' + market[0]);
  // акция за отзыв: «оставьте отзыв — вернём 300 ₽», «баллы за отзыв»
  const review = text.match(/отзыв[^.!?\n]{0,60}(верн|получ|начисл|кешб[эе]к|балл|₽|руб|деньг|скидк|подар)|(верн|получ|начисл|кешб[эе]к|балл|₽|руб|деньг|скидк)[^.!?\n]{0,60}отзыв/i);
  if (review) add('Общие недочеты', R_HONEST, `акция за отзыв: «${review[0].slice(0, 60)}»`);
  // ключевые слова: 5+ хештегов или «Ключевые слова: …»
  if (annotation) {
    const tags = annotation.value.match(/#[\wа-яё]+/gi) || [];
    const label = annotation.value.match(/(ключевые слова|поисковые слова|теги|нас ищут|с этим товаром ищут)\s*:/i);
    if (tags.length >= 5 || label) add('Аннотация', R_KEYWORDS, label ? `«${label[0]}»` : `${tags.length} хештегов`);
  }
  // Meta (Instagram, Facebook) без дисклеймера «… признана экстремистской …»
  const meta = text.match(META_RE);
  if (meta && !/признан\w*\s+экстремистск/i.test(text)) add('Общие недочеты', R_META, 'упоминание ' + meta[0]);
  // книги: «18+», «21+» при «Признак 18» не «да»
  const age = text.match(/(?<!\d)(18|21)\s*\+/);
  const flag = attr(/признак\s*18/i);
  const isBook = /книг/i.test(`${card.category} ${card.group}`);
  if (age && isBook && !(flag && /^(да|true)/i.test(flag.value.trim()))) add('Общие недочеты', R_AGE, `«${age[0]}»`);
  // однозначно запрещённые товары (раздел «Товар нельзя продавать на Ozon»), с исключениями своих разделов:
  // модель их иногда пропускает (ашваганда в БАД — в одном прогоне нашла, в другом нет)
  const where = `${card.category} ${card.group}`;
  const forbidden = [
    [/ашваганд|витани[яи] сонн|якорц\w* стелющ|tribulus|кава-кава|\bмухомор|amanita/i,
     () => /бад|добавк|витамин|питани|продукт|напит|чай|аптек|спорт\w* питан/i.test(where) && !/лекарственное средство/i.test(where),
     'Ашваганда и другие запрещенные растения'],
    [/ртутн\w* термометр|термометр\w*[^.]{0,40}ртутн/i, () => true, 'Ртутные термометры'],
    [/электронн\w* сигарет|\bвейп|\bvape\b|\bснюс|\bнасвай|никотинов\w* жидкост|одноразов\w* (под|электронк)/i,
     () => !/для чистки|чехол|чехл|зарядн|пепельниц/i.test(text), 'Устройства для потребления никотиносодержащей продукции'],
    [/электрошокер|электрошоков\w* устройств|искров\w* разрядник/i,
     () => !/мухобойк|прикол|отпугив|электропастух|погонял|ошейник/i.test(text), 'Электрошокеры'],
    [/\bкапкан/i, () => !/гуманн|проходн|кротолов|крысолов|мышелов|живолов/i.test(text), 'Капканы'],
  ];
  for (const [re, ok, rule] of forbidden) {
    const hit = text.match(re);
    if (hit && ok()) add('Общие недочеты', 'Товар нельзя продавать на Ozon', `«${hit[0]}» — раздел «${rule}»`);
  }
  // кальян в сборе: сам товар — кальян (не отдельная чаша, шахта, колба, мундштук)
  if (/^кальян/i.test(nameText.trim()) || /кальян\w* в сборе/i.test(text)) {
    add('Общие недочеты', 'Товар нельзя продавать на Ozon', '«кальян» — раздел «Кальяны в сборе»');
  }
  // критический бренд в названии/аннотации — подсказка (решает модель по смыслу)
  const brandAttr = attr(/^бренд/i);
  if (brandAttr && brandAttr.checkable) {
    for (const b of criticalBrands(book)) {
      const names = [b.latin, ...b.variants];
      const hit = names.find((n) => new RegExp(`(^|[^A-Za-zА-Яа-яЁё0-9])${escapeRe(n)}($|[^A-Za-zА-Яа-яЁё0-9])`, 'i').test(text));
      if (!hit || names.some((n) => lower(brandAttr.value).includes(lower(n)))) continue;
      const near = text.match(new RegExp(`(для|совместим\\w*\\s+с|подходит\\s+(для|к)|к|на)\\s+${escapeRe(hit)}`, 'i'));
      add('Бренд', R_BRAND, `критический бренд «${b.latin}» (${hit})${b.note ? ' — ' + b.note : ''}${near ? `; формулировка «${near[0]}» — вероятно, исключение` : ''}`, false);
    }
  }
  return facts;
}

function factsText(facts) {
  if (!facts.length) return '';
  return '\nНАЙДЕНО СКРИПТОМ (точные совпадения, проверь и учти):\n'
    + facts.map((f) => `• «${f.attribute}»: ${f.resolution} — ${f.evidence}`).join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// Скрипт после модели: решение приводится к правилам справочника
const GENERIC = new Set(['если', 'карточк', 'товар', 'товара', 'указан', 'указано', 'такое', 'принима', 'допусти',
  'это', 'есть', 'что', 'при', 'том', 'или', 'для', 'также', 'категори', 'исключе', 'пример', 'подлеж', 'отклон']);

function sameResolution(a, b) {
  const x = lower(a).replace(/[«»"'.]/g, ''); const y = lower(b).replace(/[«»"'.]/g, '');
  return Boolean(x && y && (x === y || (x.length > 12 && y.includes(x)) || (y.length > 12 && x.includes(y))));
}

// исключение раздела, все значимые слова которого есть в карточке («Мухобойки с электрошоком»)
function matchingException(book, verdict, cardTokens, cardText_) {
  if (!book) return '';
  const want = lower(verdict.section || verdict.resolution);
  const section = book.sections.find((s) => want && lower(s.title).includes(want))
    || book.sections.find((s) => want && want.includes(lower(s.title)) && s.title.length > 15);
  if (!section) return '';
  const at = section.text.search(/Исключени/i);
  if (at < 0) return '';
  for (const line of section.text.slice(at).split('\n').slice(1)) {
    // основы — без повторов: «электрошоком, электростимуляцией» → одна основа «электро», не две
    const words = [...new Set(tokens(line).filter((t) => !GENERIC.has(t)))];
    if (!(words.length >= 2 && words.length <= 6 && words.every((w) => cardTokens.has(w)))) continue;
    // слово в кавычках («Указание состояния: «Новое»») — буквально, не по основе: «как новые» — это не «Новое»
    const quoted = [...line.matchAll(/«([^»]{2,40})»/g)].map((m) => lower(m[1]));
    if (quoted.length && !quoted.every((q) => new RegExp(`(^|[^а-яa-z])${escapeRe(q)}($|[^а-яa-z])`, 'i').test(cardText_))) continue;
    return line.trim();
  }
  return '';
}

function finalize(verdicts, card, book, resolutions, facts) {
  const list = (verdicts && verdicts.list ? verdicts.list : []).map((v) => ({ ...v }));
  const notes = [];
  const byTitle = (t) => list.find((v) => lower(v.attribute) === lower(t));
  const checkable = card.attributes.filter((a) => a.checkable && !a.video);
  // 1. резолюция — на свой атрибут: «честная конкуренция» не у «Аннотации», а у «Общих недочетов»
  for (const v of list.filter((x) => x.decision === 'отклонить' && x.resolution)) {
    const owners = checkable.filter((a) => resolutionsFor(resolutions, a.title).some((r) => sameResolution(r, v.resolution)));
    if (!owners.length || owners.some((a) => lower(a.title) === lower(v.attribute))) continue;
    const target = owners[0].title;
    const moved = { ...v, attribute: target, reason: v.reason };
    Object.assign(v, { decision: 'принять', resolution: '', reason: `нарушение перенесено в «${target}»`, section: '' });
    const existing = byTitle(target);
    if (existing && existing.decision !== 'отклонить') Object.assign(existing, moved);
    else if (!existing) list.push(moved);
    notes.push(`«${moved.resolution}» перенесено на атрибут «${target}»`);
  }
  // 2. «ключевые слова» без признаков ключевых слов (скрипт их не нашёл, в объяснении о них ни слова) — снять
  const keywordsFound = facts.some((f) => f.resolution === R_KEYWORDS);
  for (const v of list) {
    if (v.decision === 'отклонить' && sameResolution(v.resolution, R_KEYWORDS) && !keywordsFound
        && !/ключев|хеште|хэште|#|тег|синоним|перечисл|поисков/i.test(v.reason)) {
      Object.assign(v, { decision: 'принять', resolution: '', reason: 'ключевых слов нет (проверено скриптом)' });
    }
  }
  // 2а. «честная конкуренция» без её признаков: в тексте это контакты, ссылки, акции, отзывы за деньги, маркетплейсы,
  // сравнение с брендом, благотворительность, аукционы — скрипт их не нашёл, в объяснении их нет, про фото ни слова
  // («Остерегайтесь подделок» модель принимала за нарушение) — «смотрите сами»
  const honestFound = facts.some((f) => f.resolution === R_HONEST);
  for (const v of list) {
    if (v.decision === 'отклонить' && sameResolution(v.resolution, R_HONEST) && !honestFound
        && !/фото|qr|телефон|ссылк|сайт|контакт|акци|скидк|процент|%|кешб|розыгрыш|благотвор|пожертв|краудфанд|аукцион|лотер|лучше|не хуже|конкурент|маркетплейс|торгов|\bwb\b|отзыв|балл|подписк|соцсет|ник/i.test(v.reason)) {
      Object.assign(v, { decision: 'смотрите сами',
                         reason: `${v.reason} — признаков «честной конкуренции» (контакты, ссылки, акции, маркетплейсы) скрипт не нашёл` });
      notes.push('«честная конкуренция» без её признаков — проверьте');
    }
  }
  // 2в. фото: нарушение с фото, у которого своя резолюция в «Общих недочетах», не дублируется «не имеет отношения»
  // у атрибута фото: заглушка («Нет фото», эскиз) — «противоречит друг другу»; контакты, QR, логотип маркетплейса
  // на фото — «честная конкуренция»
  const R_CONTRA = 'Информация в карточке товара противоречит друг другу';
  const general = card.attributes.find((a) => a.checkable && /^общие недочеты/i.test(a.title));
  for (const v of list) {
    if (v.decision !== 'отклонить' || !/^изображени/i.test(v.attribute)) continue;
    let resolution = '';
    if (/не имеет никакого отношения/i.test(v.resolution) && /заглушк|нет фото|в фотостуди|эскиз/i.test(v.reason)) resolution = R_CONTRA;
    else if (/instagram|инстаграм|facebook|фейсбук/i.test(v.reason)) resolution = R_META;
    else if (/телефон|telegram|телеграм|контакт|qr|ссылк|сайт|wildberries|маркетплейс|логотип/i.test(v.reason)) resolution = R_HONEST;
    if (!resolution || !general) continue;
    const reason = v.reason;
    Object.assign(v, { decision: 'принять', resolution: '', reason: `нарушение с фото — в «${general.title}»` });
    if (!list.some((x) => x.decision === 'отклонить' && lower(x.attribute) === lower(general.title) && sameResolution(x.resolution, resolution))) {
      const g = byTitle(general.title);
      const add = { attribute: general.title, decision: 'отклонить', resolution, reason, section: resolution };
      if (g && g.decision !== 'отклонить') Object.assign(g, add); else list.push(add);
    }
    notes.push(`нарушение с фото перенесено в «${general.title}»: ${resolution}`);
  }
  // 2г. бренд отклоняют только по таблице критических брендов: скрипт её проверил — бренда из таблицы в названии и
  // аннотации нет (Flash Up модель приняла за критический бренд по списку энергетиков) — принять
  const brandFound = facts.some((f) => f.resolution === R_BRAND);
  if (criticalBrands(book).length) {
    for (const v of list) {
      if (v.decision === 'отклонить' && /^бренд/i.test(v.attribute) && sameResolution(v.resolution, R_BRAND) && !brandFound) {
        Object.assign(v, { decision: 'принять', resolution: '',
                           reason: 'бренда из таблицы критических брендов в названии и аннотации нет (проверено скриптом)' });
        notes.push('отклонение бренда снято: в таблице критических брендов такого нет');
      }
    }
  }
  // 2з. «не создана новая карточка» — только при повторной модерации с изменённым главным фото; иначе это не она:
  // заглушка в объяснении — «противоречит друг другу» в «Общих недочетах», в остальном — «смотрите сами»
  const replacedPhoto = (card.badges || []).some((b) => /повторн/i.test(b))
    && card.attributes.some((a) => /^изображение$/i.test(a.title) && a.changed);
  for (const v of list) {
    if (v.decision !== 'отклонить' || !/не была создана новая карточка/i.test(v.resolution) || replacedPhoto) continue;
    const generalAttr = card.attributes.find((a) => a.checkable && /^общие недочеты/i.test(a.title));
    if (/заглушк|нет фото|в фотостуди|эскиз/i.test(v.reason) && generalAttr) {
      const reason = v.reason;
      Object.assign(v, { decision: 'принять', resolution: '', reason: `нарушение с фото — в «${generalAttr.title}»` });
      if (!list.some((x) => x.decision === 'отклонить' && lower(x.attribute) === lower(generalAttr.title) && sameResolution(x.resolution, R_CONTRA))) {
        const g = byTitle(generalAttr.title);
        const add = { attribute: generalAttr.title, decision: 'отклонить', resolution: R_CONTRA, reason, section: R_CONTRA };
        if (g && g.decision !== 'отклонить') Object.assign(g, add); else list.push(add);
      }
      notes.push('фотозаглушка — «противоречит друг другу» (новая карточка — только при замене фото)');
    } else {
      Object.assign(v, { decision: 'смотрите сами',
                         reason: `${v.reason} — «не создана новая карточка» бывает только при повторной модерации с заменённым фото` });
    }
  }
  // 2и. Instagram/Facebook без контактов — не «честная конкуренция», а упоминание организаций Meta
  for (const v of list) {
    if (v.decision === 'отклонить' && sameResolution(v.resolution, R_HONEST) && /instagram|инстаграм|facebook|фейсбук/i.test(v.reason)
        && !/телефон|@|ссылк|сайт|http|www|qr|скидк|акци|wildberries|маркетплейс/i.test(v.reason)
        && !facts.some((f) => f.enforce && f.resolution === R_HONEST)) {
      v.resolution = R_META;
      v.section = R_META;
      notes.push('Instagram/Facebook — резолюция «упоминания организаций Meta»');
    }
  }
  // 2ж. мат на фото: у фото своя резолюция («На главном/дополнительном фото есть нецензурная лексика…»), а «На товаре
  // присутствует нецензурная лексика» в «Общих недочетах» — для текста (справочник прямо исключает из неё фото)
  for (const v of list) {
    if (v.decision !== 'отклонить' || !/^общие недочеты/i.test(v.attribute) || !/нецензурн/i.test(v.resolution)) continue;
    if (!/фото/i.test(v.reason) || /аннотац|названи/i.test(v.reason)) continue;
    const extra = /доп|фото\s*[2-9]|дополнит/i.test(v.reason);
    const photoAttr = card.attributes.find((a) => a.checkable && (extra ? /^изображения$/i : /^изображение$/i).test(a.title));
    if (!photoAttr) continue;
    const resolution = extra ? 'На дополнительном фото есть нецензурная лексика без указания признака «18»'
                             : 'На главном фото есть нецензурная лексика без указания признака «18»';
    const moved = { ...v, attribute: photoAttr.title, resolution, section: resolution };
    Object.assign(v, { decision: 'принять', resolution: '', reason: `нарушение с фото — в «${photoAttr.title}»` });
    const target = byTitle(photoAttr.title);
    if (target && target.decision !== 'отклонить') Object.assign(target, moved); else if (!target) list.push(moved);
    notes.push(`мат на фото — резолюция фото у «${photoAttr.title}»`);
  }
  // 2е. главное фото «Изменено» при повторной модерации и новое фото — другой товар: по справочнику это не «не имеет
  // отношения», а «Для добавления нового товара не была создана новая карточка» (продавец заменил товар в старой)
  const mainPhoto = card.attributes.find((a) => /^изображение$/i.test(a.title));
  const remoderation = (card.badges || []).some((b) => /повторн/i.test(b));
  if (mainPhoto && mainPhoto.changed && remoderation) {
    for (const v of list) {
      if (v.decision === 'отклонить' && /^изображение$/i.test(v.attribute) && /не имеет никакого отношения/i.test(v.resolution)) {
        v.resolution = 'Для добавления нового товара не была создана новая карточка';
        v.section = v.resolution;
        notes.push('главное фото изменено при повторной модерации — «не создана новая карточка»');
      }
    }
  }
  // 2д. главное фото «не имеет отношения к товару» — одно нарушение: «противоречие» в «Общих недочетах» о том же
  // фото не дублировать (мотоцикл вместо ноутбука модель отклоняла дважды)
  if (list.some((x) => x.decision === 'отклонить' && /^изображение$/i.test(x.attribute) && /не имеет никакого отношения/i.test(x.resolution))) {
    for (const v of list) {
      if (v.decision === 'отклонить' && /^общие недочеты/i.test(v.attribute) && sameResolution(v.resolution, R_CONTRA)
          && /фото|изображен/i.test(v.reason) && !facts.some((f) => f.enforce && sameResolution(f.resolution, R_CONTRA))) {
        Object.assign(v, { decision: 'принять', resolution: '', reason: 'то же нарушение — уже у «Изображение»' });
      }
    }
  }
  // 2б. книга и «ограниченная категория» по году (Букинистика, Антикварное издание): год смотрят только в атрибуте
  // «Год выпуска»; его нет — «верим продавцу» (запись 23.11: «Руководство DKW 1943» без атрибута года)
  const yearAttr = card.attributes.find((a) => /год\s+(выпуска|издания)/i.test(a.title) && /\d{4}/.test(a.value));
  if (/книг/i.test(`${card.category} ${card.group}`) && !yearAttr) {
    for (const v of list) {
      if (v.decision === 'отклонить' && /ограниченной категории/i.test(v.resolution)
          && /год|букинист|антиквар|19\d\d|20[01]\d/i.test(`${v.reason} ${v.section}`)) {
        Object.assign(v, { decision: 'принять', resolution: '',
                           reason: 'атрибута «Год выпуска» нет — по правилу год на книге не смотрят, верим продавцу' });
        notes.push('«Букинистика» снята: нет атрибута «Год выпуска»');
      }
    }
  }
  // 3. исключение раздела подходит к карточке — «смотрите сами» вместо отклонения
  const plain = lower([card.name, ...card.attributes.map((a) => a.value)].join(' '));
  const cardTokens = new Set(tokens(plain));
  for (const v of list.filter((x) => x.decision === 'отклонить')) {
    if (facts.some((f) => f.enforce && f.attribute === v.attribute && sameResolution(f.resolution, v.resolution))) continue;
    const exception = matchingException(book, v, cardTokens, plain);
    if (exception) {
      Object.assign(v, { decision: 'смотрите сами', reason: `${v.reason} — но в разделе есть исключение: «${exception}»` });
      notes.push(`«${v.attribute}»: подходит исключение «${exception}» — проверьте`);
    }
  }
  // 4. точные находки скрипта, пропущенные моделью, — в решение
  for (const f of facts.filter((x) => x.enforce)) {
    if (list.some((v) => v.decision === 'отклонить' && lower(v.attribute) === lower(f.attribute)
                         && sameResolution(v.resolution, f.resolution))) continue;
    const v = byTitle(f.attribute);
    const add = { attribute: f.attribute, decision: 'отклонить', resolution: f.resolution,
                  reason: `скрипт: ${f.evidence}`, section: f.resolution, script: true };
    if (v && v.decision !== 'отклонить') Object.assign(v, add);
    else list.push(add);
    notes.push(`скрипт добавил: «${f.attribute}» — ${f.resolution} (${f.evidence})`);
  }
  const warnings = facts.filter((f) => !f.enforce).map((f) => `«${f.attribute}»: ${f.evidence} — проверьте`);
  return { list, summary: verdicts && verdicts.summary ? verdicts.summary : '', notes, warnings };
}

if (typeof module !== 'undefined') {
  module.exports = { PROMPT, CARD_PROMPT, buildResolutions, resolutionsFor, cardText, cardQuery, excerptSkip, excerptPin,
                     parseVerdicts, scanCard, factsText, finalize, criticalBrands };
}
