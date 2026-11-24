// Боковая панель: карточка открытой вкладки → разделы справочника сразу (поиск в браузере) → решение модели
// по каждому атрибуту с резолюцией и пунктом правил (модель видит все фото карточки) → рамки на карточке
// вокруг ✓/✗ и нужной причины отклонения. Сама панель и content.js ничего не нажимают.

const API = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};
const DEFAULT_MODEL = { gemini: 'gemini-3.1-flash-lite', openrouter: 'z-ai/glm-5.3-flash' };
const CARD_CHARS = 12000;          // текста страницы в запрос — не больше
const MAX_PHOTOS = 60;             // даже «все фото» — не больше стольких

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

function setText(el, text, cls) {
  el.textContent = text;
  el.className = cls ? `answer ${cls}` : 'answer';
}

async function loadSettings() {
  settings = await chrome.storage.local.get(['rules', 'provider', 'key', 'key2', 'model', 'auto', 'budget', 'photos',
                                           'photoSize']);
  book = settings.rules ? new RulesBook(settings.rules) : null;
  resolutionsByAttr = book ? buildResolutions(book) : new Map();
  const provider = settings.provider || 'gemini';
  $('provider').value = provider;
  $('key').value = settings.key || '';
  $('model').value = settings.model || '';
  $('model').placeholder = DEFAULT_MODEL[provider];
  $('auto').checked = settings.auto !== false;
  $('budget').value = settings.budget || 40000;
  $('photos').value = settings.photos || 'all';
  $('key2').value = settings.key2 || '';
  $('photo-size').value = String(settings.photoSize || 1000);
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

function ozonImage(url) {
  // ir.ozone.ru/s3/<корзина>/<файл> — фото в исходном размере; wc1000 — до 1000 px, мелкие надписи читаются;
  // меньше (настройка «Размер фото») — меньше токенов: бесплатный Gemini не упирается в минутный лимит
  const size = [500, 700, 1000].includes(Number(settings.photoSize)) ? Number(settings.photoSize) : 1000;
  return url.replace(/^(https:\/\/ir[^/]*\.ozone\.ru\/s3\/[^/]+\/)(?!wc\d+\/)([^/?#]+\.(?:jpe?g|png|webp))$/i, `$1wc${size}/$2`);
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
const queryOf = (t) => (t.card ? cardQuery(t.card, rich) : t.text);

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
// ключи: основной и запасной (Gemini — другой проект Google, у него свои лимиты); после отказа «429»
// запрос сразу уходит с другим ключом, и следующие — тоже с ним, пока он не упрётся в лимит
let keyIndex = 0;
const keysOf = (provider) => [settings.key, provider === 'gemini' ? settings.key2 : ''].filter(Boolean);

async function post(body, provider) {
  const keys = keysOf(provider);
  if (keyIndex >= keys.length) keyIndex = 0;
  const once = () => fetch(API[provider], {
    method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + keys[keyIndex],
               ...(provider === 'openrouter' ? { 'X-Title': 'Moderation helper' } : {}) },
    body: JSON.stringify(body),
  });
  // связь рвётся («Failed to fetch», 5xx у поставщика модели) — ещё попытка через 2 с, потом ошибка в панели
  try {
    const res = await once();
    if (res.status === 429 && keys.length > 1) {
      keyIndex = (keyIndex + 1) % keys.length;      // лимит ключа — сразу с запасным
      return once();
    }
    if (res.status < 500) return res;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  await new Promise((ok) => setTimeout(ok, 2000));
  return once();
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
  const budget = Number(settings.budget) || 40000;
  const started = performance.now();
  try {
    let body;
    let photos = [];
    let facts = [];
    if (t.card && !question) {
      photos = cardPhotos(t.card);
      facts = scanCard(t.card, book);            // точные находки скрипта — до модели
      const content = [{ type: 'text', text: book.excerpts(queryOf(t), budget, excerptSkip(t.card), excerptPin(t.card))
        + '\n\n' + cardText(t.card, photos, resolutionsByAttr, rich) + factsText(facts) }];
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
                     verdicts: t.card && !question
                       ? finalize(parseVerdicts(content), t.card, book, resolutionsByAttr, facts) : null,
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
  for (const note of [...(r.verdicts.notes || []), ...(r.verdicts.warnings || [])]) {   // что поправил скрипт
    const line = document.createElement('div');
    line.className = 'note';
    line.textContent = note;
    box.append(line);
  }
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
    auto: $('auto').checked, budget: Number($('budget').value) || 40000, photos: $('photos').value,
    key2: $('key2').value.trim(), photoSize: Number($('photo-size').value) || 1000,
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

// Firefox выдаёт доступ к сайтам не при установке, а по просьбе — кнопка в панели (в Chrome доступ уже есть)
const ORIGINS = { origins: chrome.runtime.getManifest().host_permissions || [] };
async function checkAccess() {
  try {
    $('perm').hidden = await chrome.permissions.contains(ORIGINS);
  } catch (e) {
    $('perm').hidden = true;
  }
}
$('perm-btn').addEventListener('click', async () => {
  try {
    if (await chrome.permissions.request(ORIGINS)) {
      $('perm').hidden = true;
      $('status').textContent = 'Доступ выдан — обновите вкладку с заданием (F5).';
    }
  } catch (e) {
    $('status').textContent = 'Доступ не выдан: ' + e.message;
  }
});

checkAccess();
loadSettings().then(loadTask);
