// Боковая панель: карточка открытой вкладки → разделы справочника сразу (поиск в браузере) → решение модели
// по каждому атрибуту с резолюцией и пунктом правил (модель видит все фото карточки) → рамки на карточке
// вокруг ✓/✗ и нужной причины отклонения. Сама панель и content.js ничего не нажимают.

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
  + 'Слова, подсвеченные Ozon, — только подсказка: реши по смыслу (например, «мобил» внутри «автомобильной» — '
  + 'не бренд Mobil).\n'
  + 'Резолюцию бери ТОЛЬКО из списка резолюций этого атрибута, точно как написано; если открыт список «Причины '
  + 'отклонения» на странице — из него. Видео и видеообложку не оценивай: decision «смотрите сами». Рич-контент '
  + 'без текста и фото (не открыт) — «смотрите сами» и попроси открыть и пролистать.\n'
  + 'Ответ — только JSON: {"attributes": [{"name": "<название атрибута как в карточке>", "decision": '
  + '"принять" | "отклонить" | "смотрите сами", "resolution": "<для отклонить — точная резолюция, иначе пусто>", '
  + '"reason": "<коротко почему, с цитатой из карточки или номером фото>", "section": "<раздел справочника>"}], '
  + '"summary": "<одна строка итога>"}. Все тексты — по-русски.';

const API = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};
const DEFAULT_MODEL = { gemini: 'gemini-3.1-flash-lite', openrouter: 'z-ai/glm-5.3-flash' };
const CARD_CHARS = 12000;          // текста страницы в запрос — не больше
const MAX_PHOTOS = 60;             // даже «все фото» — не больше стольких

// атрибут на странице → как он называется в справочнике («Применяется к: Атрибут: «…»»)
const ATTR_ALIASES = {
  'изображение': ['главное фото'], 'изображения': ['дополнительное фото'], 'rich-контент': ['рич-контент'],
  'озон.видео': ['озон.видео'], 'озон.видеообложка': ['озон.видеообложка'], 'бренд в одежде и обуви': ['бренд'],
};

const $ = (id) => document.getElementById(id);
let settings = {};
let book = null;
let resolutionsByAttr = new Map();
let tabId = null;
let task = null;
let rich = null;
let controller = null;
let askTimer = null;
let inflight = null;
const answers = new Map();         // задание → ответ (повторно не спрашивать)

const lower = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

function setText(el, text, cls) {
  el.textContent = text;
  el.className = cls ? `answer ${cls}` : 'answer';
}

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

function resolutionsFor(title) {
  const key = lower(title);
  const out = new Set();
  for (const name of [key, ...(ATTR_ALIASES[key] || [])]) {
    for (const r of resolutionsByAttr.get(name) || []) out.add(r);
  }
  return [...out];
}

async function loadSettings() {
  settings = await chrome.storage.local.get(['rules', 'provider', 'key', 'model', 'auto', 'budget', 'photos']);
  book = settings.rules ? new RulesBook(settings.rules) : null;
  resolutionsByAttr = book ? buildResolutions(book) : new Map();
  const provider = settings.provider || 'gemini';
  $('provider').value = provider;
  $('key').value = settings.key || '';
  $('model').value = settings.model || '';
  $('model').placeholder = DEFAULT_MODEL[provider];
  $('auto').checked = settings.auto !== false;
  $('budget').value = settings.budget || 24000;
  $('photos').value = settings.photos || 'all';
  $('rules-info').textContent = book
    ? `Загружено: ${String(book.source).split(/[\\/]/).pop()} — ${book.sections.length} разделов`
    : 'Правила не загружены';
}

async function loadTask() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  const got = tabId === null ? {} : await chrome.storage.session.get(['task:' + tabId, 'rich:' + tabId]);
  rich = got['rich:' + tabId] || null;
  show(got['task:' + tabId] || null);
}

// ---------------- карточка → текст для модели и фото
function cardPhotos(card) {
  const photos = [];
  for (const a of card.attributes) {
    if (!a.checkable || a.video) continue;
    a.images.forEach((url, i) => {
      const label = a.changed && a.images.length === 2 ? (i === 0 ? ' (новое)' : ' (старое)') : '';
      photos.push({ url, label: `«${a.title}»${label}` });
    });
  }
  if (rich) rich.images.forEach((url) => photos.push({ url, label: '«Rich-контент»' }));
  const mode = settings.photos || 'all';
  if (mode === 'none') return [];
  if (mode === 'main8') {
    const main = photos.filter((p) => /«изображение»/i.test(p.label));
    const rest = photos.filter((p) => !/«изображение»/i.test(p.label)).slice(0, 8);
    return [...main, ...rest];
  }
  return photos.slice(0, MAX_PHOTOS);
}

function cardText(card, photos) {
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
    const reasons = a.reasons.length ? a.reasons : resolutionsFor(a.title);
    if (reasons.length) {
      lines.push((a.reasons.length ? 'Причины отклонения на странице: ' : 'Резолюции этого атрибута: ') + reasons.join(' | '));
    }
    if (/rich/i.test(a.title)) {
      lines.push(rich ? `Текст рич-контента: ${rich.text.slice(0, 4000)}` : 'Рич-контент ещё не открыт — текста и фото нет.');
    }
  }
  return lines.join('\n');
}

function ozonImage(url) {
  // ir.ozone.ru/s3/<корзина>/<файл> — фото в исходном размере; wc1000 — до 1000 px, мелкие надписи читаются
  return url.replace(/^(https:\/\/ir[^/]*\.ozone\.ru\/s3\/[^/]+\/)(?!wc\d+\/)([^/?#]+\.(?:jpe?g|png|webp))$/i, '$1wc1000/$2');
}

async function toDataUrl(url) {
  const res = await fetch(ozonImage(url), { signal: controller.signal });
  if (!res.ok) throw new Error('фото ' + res.status);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------------- показ
function show(t) {
  task = t;
  $('video-note').hidden = !(t && t.videos);
  if (!book) {
    $('status').textContent = 'Загрузите правила в настройках ниже (файл knowledge/_rules-ozon.json).';
    $('settings').open = true;
    return;
  }
  if (!t) {
    $('status').textContent = 'Откройте задание на ozon.ru — панель прочитает его сама.';
    return;
  }
  $('status').textContent = t.title || t.url;
  renderSections(queryOf(t));
  if (settings.auto !== false && settings.key) {
    clearTimeout(askTimer);
    askTimer = setTimeout(() => ask(t), 600);      // страница дорисовывается — не дёргать модель
  } else if (!settings.key) {
    setText($('answer'), 'Чтобы ИИ отвечал, впишите ключ API в настройках. Разделы справочника — ниже.', 'muted');
  }
}

function queryOf(t) {
  if (!t.card) return t.text;
  const c = t.card;
  return [c.name, c.category, c.group, ...c.attributes.filter((a) => a.checkable)
    .map((a) => `${a.title} ${a.value} ${a.old} ${a.highlights.join(' ')}`), rich ? rich.text : ''].join('\n');
}

function renderSections(text) {
  const started = performance.now();
  const found = book.search(text, 6);
  $('found-meta').textContent = `· ${found.length ? 'найдено за ' + Math.max(1, Math.round(performance.now() - started)) + ' мс' : 'по словам не нашлось'}`;
  const box = $('sections');
  box.replaceChildren();
  for (const [score, s] of found) {
    const d = document.createElement('details');
    d.className = 'rule';
    const sum = document.createElement('summary');
    sum.textContent = s.title;
    const sc = document.createElement('span');
    sc.className = 'score';
    sc.textContent = score.toFixed(1);
    sum.append(sc);
    const pre = document.createElement('pre');
    pre.textContent = s.text;
    d.append(sum, pre);
    box.append(d);
  }
}

// ---------------- запрос к модели
async function post(body, provider) {
  return fetch(API[provider], {
    method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.key,
               ...(provider === 'openrouter' ? { 'X-Title': 'Moderation helper' } : {}) },
    body: JSON.stringify(body),
  });
}

function explain(status, message) {
  if (status === 401 || status === 403 && /key|auth/i.test(message)) return 'Ключ API не подходит — проверьте его в настройках.';
  if (status === 403) return 'Сервис не пускает запрос (403). Из России нужен VPN в браузере.';
  if (status === 429) return 'Лимит запросов исчерпан (429) — подождите минуту или смените модель.';
  if (status === 402) return 'На балансе OpenRouter нет денег (402).';
  return `Ошибка ${status}: ${message.slice(0, 300)}`;
}

// то же задание, если изменились только цифры: таймер, счётчик карточек — новый запрос не нужен
// (иначе тикающий таймер каждую секунду отправлял бы запрос и обрывал предыдущий)
const taskKey = (text) => text.slice(0, CARD_CHARS).replace(/\d+/g, '#');
const keyOf = (t) => (t.card ? 'card|' + t.key + '|' + (rich ? rich.text.length + ':' + rich.images.length : '')
                             : taskKey(t.text));

async function ask(t, question = '') {
  if (!book || !settings.key || !t) return;
  const key = question ? 'q|' + question : keyOf(t);
  if (answers.has(key)) { render(answers.get(key)); return; }
  if (inflight === key) return;                // этот запрос уже отправлен — ждём ответ
  inflight = key;
  if (controller) controller.abort();
  controller = new AbortController();
  const provider = settings.provider || 'gemini';
  const model = settings.model || DEFAULT_MODEL[provider];
  setText($('answer'), 'Думаю…', 'muted');
  $('answer-meta').textContent = '';
  $('verdicts').replaceChildren();
  const budget = Number(settings.budget) || 24000;
  const started = performance.now();
  try {
    let body;
    let photos = [];
    if (t.card && !question) {
      photos = cardPhotos(t.card);
      const content = [{ type: 'text', text: book.excerpts(queryOf(t), budget) + '\n\n' + cardText(t.card, photos) }];
      const loaded = await Promise.all(photos.map((p) => toDataUrl(p.url).catch(() => null)));
      loaded.forEach((url, i) => {
        content.push({ type: 'text', text: `ФОТО ${i + 1} — ${photos[i].label}` + (url ? '' : ' (не загрузилось)') });
        if (url) content.push({ type: 'image_url', image_url: { url } });
      });
      body = { model, temperature: 0, max_tokens: 3000, response_format: { type: 'json_object' },
               messages: [{ role: 'system', content: CARD_PROMPT }, { role: 'user', content }] };
    } else {
      const card = (question || t.text).slice(0, CARD_CHARS);
      body = { model, temperature: 0, max_tokens: 2000,
               messages: [{ role: 'system', content: PROMPT },
                          { role: 'user', content: book.excerpts(card, budget) + '\n\nКАРТОЧКА ИЛИ ВОПРОС:\n' + card }] };
    }
    if (provider === 'openrouter') {
      body.usage = { include: true };            // цена ответа
      body.reasoning = { effort: 'minimal' };    // без долгого «обдумывания»: быстрее и дешевле
    }
    let res = await post(body, provider);
    if (res.status === 400) {
      const err = await res.text();
      if (body.reasoning && /reasoning/i.test(err)) delete body.reasoning;            // уровень не принят
      else if (body.response_format && /response_format|json/i.test(err)) delete body.response_format;
      else throw Object.assign(new Error(err), { status: 400 });
      res = await post(body, provider);
    }
    if (!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status });
    const data = await res.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
    const result = { text: content || 'Модель вернула пустой ответ.', model, photos: photos.length,
                     verdicts: t.card && !question ? parseVerdicts(content) : null,
                     seconds: (performance.now() - started) / 1000,
                     cost: data.usage && typeof data.usage.cost === 'number' ? data.usage.cost : null };
    answers.set(key, result);
    const current = question ? $('question').value.trim() === question : task && keyOf(task) === key;
    if (current) {
      render(result);
      if (result.verdicts && t.tabId !== undefined) sendHints(t, result.verdicts);
    }
  } catch (e) {
    if (e.name === 'AbortError') return;       // открылось следующее задание
    setText($('answer'), e.status ? explain(e.status, e.message) : 'Нет связи с сервисом модели: ' + e.message, 'error');
  } finally {
    if (inflight === key) inflight = null;
  }
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

function sendHints(t, verdicts) {
  try {
    chrome.tabs.sendMessage(t.tabId, { type: 'hints', key: t.key,
      hints: verdicts.list.map(({ attribute, decision, resolution }) => ({ attribute, decision, resolution })) })
      .catch(() => {});
  } catch (e) { /* вкладка закрыта */ }
}

function render(r) {
  $('answer-meta').textContent = `· ${r.model.split('/').pop()}, ${r.seconds.toFixed(1)} с`
    + (r.photos ? `, фото: ${r.photos}` : '') + (r.cost !== null ? `, $${r.cost.toFixed(4)}` : '');
  const box = $('verdicts');
  box.replaceChildren();
  if (!r.verdicts) { setText($('answer'), r.text); return; }
  setText($('answer'), r.verdicts.summary || 'Решение по атрибутам:');
  for (const v of r.verdicts.list) {
    const row = document.createElement('div');
    const cls = v.decision === 'отклонить' ? 'bad' : v.decision === 'принять' ? 'ok' : 'look';
    row.className = `verdict ${cls}`;
    const head = document.createElement('div');
    head.className = 'verdict-head';
    head.textContent = `${v.decision.toUpperCase()} — ${v.attribute}`;
    row.append(head);
    for (const [label, value] of [['Резолюция', v.resolution], ['Почему', v.reason], ['Правило', v.section]]) {
      if (!value) continue;
      const line = document.createElement('div');
      line.className = 'verdict-line';
      line.textContent = `${label}: ${value}`;
      row.append(line);
    }
    box.append(row);
  }
}

// ---------------- кнопки и настройки
$('ask-btn').addEventListener('click', () => {
  if (!task) return;
  answers.delete(keyOf(task));
  ask(task);
});

$('question-btn').addEventListener('click', () => {
  const q = $('question').value.trim();
  if (!q || !book) return;
  renderSections(q);
  if (!settings.key) { setText($('answer'), 'Впишите ключ API в настройках.', 'error'); return; }
  ask(task || { text: q }, q);
});

$('provider').addEventListener('change', () => { $('model').placeholder = DEFAULT_MODEL[$('provider').value]; });

$('rules-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.sections) || !data.sections.length) throw new Error('в файле нет разделов');
    await chrome.storage.local.set({ rules: data });
    $('rules-info').textContent = `Загружено: ${data.sections.length} разделов`;
  } catch (e) {
    $('rules-info').textContent = 'Это не файл правил: ' + e.message
      + '. Нужен knowledge/_rules-ozon.json (его делает python main.py --rules файл.pdf).';
  }
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    provider: $('provider').value, key: $('key').value.trim(), model: $('model').value.trim(),
    auto: $('auto').checked, budget: Number($('budget').value) || 24000, photos: $('photos').value,
  });
  $('saved').textContent = 'Сохранено';
  setTimeout(() => { $('saved').textContent = ''; }, 1500);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local') { await loadSettings(); show(task); return; }
  if (area !== 'session') return;
  if (changes['rich:' + tabId]) {
    rich = changes['rich:' + tabId].newValue || null;
    if (task && task.card) show(task);            // рич-контент открыли — спросить с его текстом и фото
  }
  if (changes['task:' + tabId]) show(changes['task:' + tabId].newValue || null);
});
chrome.tabs.onActivated.addListener(loadTask);
chrome.tabs.onUpdated.addListener((id, info) => { if (id === tabId && info.status === 'complete') loadTask(); });

loadSettings().then(loadTask);
