// Боковая панель: карточка открытой вкладки → разделы справочника сразу (поиск в браузере) → решение модели
// по каждому атрибуту с резолюцией и пунктом правил (модель видит все фото карточки); основная модель сомневается —
// второе мнение сильной модели. Решение — только в панели: ни панель, ни content.js страницу не меняют и не нажимают.

const API = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};
const DEFAULT_MODEL = { gemini: 'gemini-3.5-flash-lite', openrouter: 'z-ai/glm-5.3-flash' };
// запасная модель Gemini при перегрузке (503): по очереди, кроме той, что уже спросили
const SPARE_GEMINI = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
// сильная модель для второго мнения (бесплатно — 20 запросов в день на проект, 5 в минуту)
const STRONG_GEMINI = 'gemini-3.8-flash';
const STRONG_TIMEOUT = 40000;      // дольше сильную модель не ждать: решение основной уже есть
// чем решения двух моделей отличаются: отклонения, которые есть только в одном
function rejectDiff(a, b) {
  const keys = (v) => new Set(((v && v.list) || []).filter((x) => x.decision === 'отклонить').map((x) => `«${x.attribute}»: ${x.resolution}`));
  const was = keys(a); const now = keys(b);
  return [...[...now].filter((k) => !was.has(k)).map((k) => '+ ' + k), ...[...was].filter((k) => !now.has(k)).map((k) => '− ' + k)];
}
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
  settings = await chrome.storage.local.get(['rules', 'provider', 'key', 'key2', 'key3', 'strong', 'strongModel', 'strongTimeout', 'model', 'auto', 'budget', 'photos',
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
  $('key3').value = settings.key3 || '';
  $('strong').checked = settings.strong !== false;
  $('strong-model').value = settings.strongModel || '';
  $('strong-model').placeholder = STRONG_GEMINI;
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
  // на moderation.ozon.ru спрашивать модель сразу — только по карточке товара: список товаров, «Список пуст»,
  // обновление страницы — не задание, запрос впустую тратил бы лимит (по кнопке — можно)
  const notCard = !t.card && /moderation\.ozon\.ru/.test(t.url || '');
  if (notCard) {
    clearTimeout(askTimer);
    if (controller) controller.abort();          // ответ по прошлой карточке больше не нужен
    $('verdicts').replaceChildren();
    $('answer-meta').textContent = '';
    setText($('answer'), 'Карточка не открыта — ИИ не спрашиваю. Откройте товар, и ответ появится сам.', 'muted');
    return;
  }
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
const keysOf = (provider) => [settings.key, ...(provider === 'gemini' ? [settings.key2, settings.key3] : [])].filter(Boolean);

// opts.strong — запрос к сильной модели: ждать не дольше opts.timeout, при перегрузке (503) и сбое связи — не
// повторять и не подменять запасной моделью (решение основной модели уже есть)
async function post(body, provider, opts = {}) {
  const keys = keysOf(provider);
  if (keyIndex >= keys.length) keyIndex = 0;
  const signal = opts.timeout && AbortSignal.any && AbortSignal.timeout
    ? AbortSignal.any([controller.signal, AbortSignal.timeout(opts.timeout)]) : controller.signal;
  const once = () => fetch(API[provider], {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + keys[keyIndex],
               ...(provider === 'openrouter' ? { 'X-Title': 'Moderation helper' } : {}) },
    body: JSON.stringify(body),
  });
  // связь рвётся («Failed to fetch», 5xx у поставщика модели) — ещё попытка через 2 с, потом ошибка в панели
  try {
    const res = await once();
    if (res.status === 429 && keys.length > 1) {
      // лимит ключа — сразу со следующим запасным, по кругу, каждый ключ по разу
      let next = res;
      for (let n = 1; n < keys.length && next.status === 429; n++) {
        keyIndex = (keyIndex + 1) % keys.length;
        next = await once();
      }
      return next;
    }
    if (res.status === 503 && !opts.strong) {       // Gemini «high demand» — перегрузка: ещё две попытки
      for (const wait of [5000, 10000]) {
        await new Promise((ok) => setTimeout(ok, wait));
        const again = await once();
        if (again.status !== 503) return again;
      }
      // перегрузка держится — запасная модель Gemini (свои мощности и лимиты): ответ слабее лучше, чем никакого
      const spare = provider === 'gemini' && SPARE_GEMINI.find((m) => m !== body.model);
      if (spare) {
        body.model = spare;
        const other = await once();
        if (other.ok) other.usedModel = spare;
        return other;
      }
      return once();
    }
    if (res.status < 500 || opts.strong) return res;
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError' || opts.strong) throw e;
  }
  await new Promise((ok) => setTimeout(ok, 2000));
  return once();
}

function explain(status, message) {
  if (status === 401 || status === 403 && /key|auth/i.test(message)) return 'Ключ API не подходит — проверьте его в настройках.';
  if (status === 403) return 'Сервис не пускает запрос (403). Из России нужен VPN в браузере.';
  if (status === 429) return 'Лимит запросов исчерпан (429) — подождите минуту или смените модель.';
  if (status === 402) return 'На балансе OpenRouter нет денег (402).';
  if (status === 'ответ') return message.charAt(0).toUpperCase() + message.slice(1) + '.';
  if (status === 503) return 'Сервис модели перегружен (503) — через несколько секунд нажмите «Спросить ИИ ещё раз».';
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
      body = { model, temperature: 0, max_tokens: 6000, response_format: { type: 'json_object' },
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
    const isCard = Boolean(t.card && !question);
    const readOf = (d) => (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '').trim();
    const parsedOf = (c) => { const p = parseVerdicts(c); return p && p.list.length ? p : null; };
    const errText = res.ok ? '' : await res.text();
    // ключ не подходит, нет доступа, нет денег — сразу ошибка; перегрузка и лимит по карточке — дальше, к сильной модели
    if (!res.ok && (!isCard || [400, 401, 402, 403].includes(res.status))) throw Object.assign(new Error(errText), { status: res.status });
    let data = null; let content = ''; let usedModel = res.usedModel || model;
    if (res.ok) {
      data = await res.json();
      content = readOf(data);
      // ответ по карточке не разобрался (оборван, не JSON) — ещё раз; фильтр Google не повторяем
      const finish = data.choices && data.choices[0] && data.choices[0].finish_reason;
      if (isCard && !parsedOf(content) && !/filter|safety|prohibited/i.test(String(finish))) {
        const again = await post(body, provider);
        if (again.ok) { data = await again.json(); content = readOf(data); }
      }
    }
    const labels = photos.map((p) => p.label);
    let parsed = isCard ? parsedOf(content) : null;
    let verdicts = parsed ? finalize(parsed, t.card, book, resolutionsByAttr, facts, labels) : null;
    // второе мнение: основная модель сомневается по фото, ответила «смотрите сами» не по видео или не ответила —
    // тот же запрос сильной модели (Gemini 3.8 Flash), её решение после скрипта — итоговое
    let second = null;
    if (isCard && provider === 'gemini' && settings.strong !== false) {
      const why = secondOpinionReasons(parsed, verdicts, t.card);
      if (why.length) {
        const strongModel = settings.strongModel || STRONG_GEMINI;
        $('answer').textContent = `Основная модель сомневается — спрашиваю ${strongModel}…`;
        let r2 = null;
        const strongTimeout = Number(settings.strongTimeout) || STRONG_TIMEOUT;   // в настройках не показывается (тесты)
        try {
          r2 = await post({ ...body, model: strongModel }, provider, { strong: true, timeout: strongTimeout });
        } catch (e) {
          if (controller.signal.aborted) throw e;         // открылось следующее задание — этот ответ уже не нужен
          r2 = { ok: false, status: e.name === 'TimeoutError' ? `не ответила за ${strongTimeout / 1000} с` : 'нет связи' };
        }
        if (r2.ok) {
          const d2 = await r2.json();
          const p2 = parsedOf(readOf(d2));
          if (p2) {
            const v2 = finalize(p2, t.card, book, resolutionsByAttr, facts, labels);
            second = { model: strongModel, why, changed: rejectDiff(verdicts, v2) };
            verdicts = v2; parsed = p2; content = readOf(d2); data = data || d2;
            usedModel = `${usedModel} → ${strongModel}`;
          } else second = { model: strongModel, why, failed: 'ответ не разобран' };
        } else {
          second = { model: strongModel, why, failed: r2.status === 429 ? 'лимит на сегодня исчерпан на всех ключах'
            : r2.status === 503 ? 'перегружена' : typeof r2.status === 'string' ? r2.status : `ошибка ${r2.status}` };
        }
      }
    }
    if (isCard && !verdicts) {
      // не ответила ни одна модель — только точные находки скрипта, с явным предупреждением
      verdicts = finalize({ list: [], photos: [] }, t.card, book, resolutionsByAttr, facts, labels);
      verdicts.warnings.unshift('МОДЕЛЬ НЕ ОТВЕТИЛА' + (errText ? ` (${errText.slice(0, 80)})` : '')
        + ' — показаны только точные находки скрипта, остальные атрибуты проверьте сами по разделам справочника');
    }
    if (second) {
      verdicts.notes.unshift(second.failed
        ? `${second.model} не помогла (${second.failed}) — решение основной модели; причина: ${second.why.join('; ')}`
        : `Второе мнение ${second.model}: ${second.why.join('; ')}`
          + (second.changed.length ? ` — изменила: ${second.changed.join('; ')}` : ' — решение то же'));
    }
    const result = { text: content || 'Модель вернула пустой ответ.', model: usedModel, photos: photos.length, verdicts,
                     seconds: (performance.now() - started) / 1000,
                     cost: data && data.usage && typeof data.usage.cost === 'number' ? data.usage.cost : null };
    answers.set(key, result);
    const current = question ? $('question').value.trim() === question : task && keyOf(task) === key;
    if (current) render(result);
  } catch (e) {
    if (e.name === 'AbortError') return;       // открылось следующее задание
    setText($('answer'), e.status ? explain(e.status, e.message) : 'Нет связи с сервисом модели: ' + e.message, 'error');
  } finally {
    if (inflight === key) inflight = null;
  }
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
    key2: $('key2').value.trim(), key3: $('key3').value.trim(), strong: $('strong').checked, strongModel: $('strong-model').value.trim(), photoSize: Number($('photo-size').value) || 1000,
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
