// Проверка помощника на эталонных карточках: тот же запрос, что в боковой панели (card.js, rules.js), ответ
// модели сверяется с правильным решением (какой атрибут отклонить и по какой резолюции).
//   node extension/eval_cards.js knowledge/_rules-ozon.json tests/fixtures/moderation_cards.json [модель]
// Ключ — из переменной OPENROUTER_API_KEY (или GEMINI_API_KEY с EVAL_PROVIDER=gemini). Фото в эталонных
// карточках нет — проверяется чтение текста карточки и выбор пункта правил. EVAL_BUDGET — потолок в долларах.
const fs = require('fs');
const { RulesBook } = require('./rules.js');
const C = require('./card.js');

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'.,:;!?()]/g, ' ')
  .replace(/\s+/g, ' ').trim();
const similar = (a, b) => {
  const x = norm(a); const y = norm(b);
  return Boolean(x && y && (x.includes(y) || (y.includes(x) && x.length > 10)));
};

// верно ли решена карточка: каждое ожидаемое отклонение найдено с той же резолюцией, лишних отклонений нет
function score(item, verdicts) {
  const list = (verdicts && verdicts.list) || [];
  const rejected = list.filter((v) => v.decision === 'отклонить');
  const expected = item.expect.reject;
  const found = expected.map((e) => rejected.find((v) => (item.expect.any_attribute || norm(v.attribute) === norm(e.attribute))
    && similar(v.resolution, e.resolution)));
  const extra = rejected.filter((v) => !found.includes(v));
  const ruleNamed = expected.every((e, i) => found[i] && norm(`${found[i].section} ${found[i].reason}`).includes(norm(e.rule)));
  return { ok: found.every(Boolean) && !extra.length, found: found.filter(Boolean).length, extra, ruleNamed };
}

// POST без предела ожидания соединения: fetch в Node обрывает соединение через 10 с (UND_ERR_CONNECT_TIMEOUT),
// а до OpenRouter соединение бывает дольше; браузер ждёт дольше — расширению это не мешает
function request(url, data, headers) {
  const lib = url.startsWith('https:') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    // family 4: у пользователя путь по IPv6 до OpenRouter не работает (соединение висит), curl и браузер идут по IPv4
    const req = lib.request(url, { method: 'POST', family: 4, headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, ok: res.statusCode < 300, text: async () => text,
                    json: async () => JSON.parse(text) });
        });
      });
    req.setTimeout(120000, () => req.destroy(new Error('нет ответа 120 с')));
    req.on('error', reject);
    req.end(data);
  });
}

// фото карточки — как в панели (cardPhotos): проверяемые атрибуты без видео, у «Изменено» — новое и старое.
// Адрес ir.ozone.ru — скачать (wc1000, как в панели), иначе — файл рядом с файлом карточек
function cardPhotos(card) {
  const photos = [];
  for (const a of card.attributes) {
    if (!a.checkable || a.video) continue;
    a.images.forEach((src, i) => {
      const label = a.changed && a.images.length === 2 ? (i === 0 ? ' (новое)' : ' (старое)') : '';
      photos.push({ src, label: `«${a.title}»${label}` });
    });
  }
  return photos;
}

// размер фото: EVAL_PHOTO_SIZE (как настройка панели) — ozone.ru отдаёт уменьшенную копию по адресу …/wc700/…,
// локальные фото — из папки <папка>_<размер> (заранее уменьшенные копии), если она есть
const PHOTO_SIZE = Number(process.env.EVAL_PHOTO_SIZE || 1000);

function download(url) {
  const wc = url.replace(/^(https:\/\/ir[^/]*\.ozone\.ru\/s3\/[^/]+\/)(?!wc\d+\/)([^/?#]+\.(?:jpe?g|png|webp))$/i, `$1wc${PHOTO_SIZE}/$2`);
  return new Promise((resolve, reject) => {
    require('https').get(wc, { family: 4, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error('фото ' + res.statusCode))));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('фото: нет ответа')); });
  });
}

async function photoData(src, baseDir) {
  const path = require('path');
  let local = path.resolve(baseDir, src);
  const small = path.join(path.dirname(local) + '_' + PHOTO_SIZE, path.basename(local));
  if (PHOTO_SIZE < 1000 && fs.existsSync(small)) local = small;
  const data = /^https?:/.test(src) ? await download(src) : fs.readFileSync(local);
  const ext = (src.match(/\.(png|webp|jpe?g)(?:$|\?)/i) || [, 'jpeg'])[1].toLowerCase().replace('jpg', 'jpeg');
  return `data:image/${ext};base64,${data.toString('base64')}`;
}

async function ask(item, book, resolutions, opts) {
  const photos = cardPhotos(item.card);
  const facts = C.scanCard(item.card, book);
  const text = book.excerpts(C.cardQuery(item.card, null), opts.budget, C.excerptSkip(item.card), C.excerptPin(item.card)) + '\n\n'
    + C.cardText(item.card, photos, resolutions, null) + C.factsText(facts);
  const content = [{ type: 'text', text }];
  for (const [i, p] of photos.entries()) {
    const url = await photoData(p.src, opts.baseDir).catch(() => null);
    content.push({ type: 'text', text: `ФОТО ${i + 1} — ${p.label}` + (url ? '' : ' (не загрузилось)') });
    if (url) content.push({ type: 'image_url', image_url: { url } });
  }
  const body = { model: opts.model, temperature: 0, max_tokens: 6000, response_format: { type: 'json_object' },
                 messages: [{ role: 'system', content: C.CARD_PROMPT }, { role: 'user', content }] };
  if (opts.provider === 'openrouter') {
    body.usage = { include: true };
    body.reasoning = { effort: process.env.EVAL_REASONING || 'minimal' };   // как в панели; low — модель «думает»
  }
  // связь с сервисом рвётся («fetch failed», 5xx) — повторить, с паузой 2, 4, 8 с
  const post = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await request(opts.url, JSON.stringify(body),
          { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.keys[opts.keyIndex] });
        // лимит ключа (429): есть запасной — сразу на него, иначе подождать (минутный лимит)
        if (r.status === 429 && attempt < 3) {
          if (opts.keys.length > 1) { opts.keyIndex = (opts.keyIndex + 1) % opts.keys.length; continue; }
          await new Promise((ok) => setTimeout(ok, 30000)); continue;
        }
        // 503 «high demand» у Gemini — как в панели: ещё две попытки через 5 и 10 с, потом запасная модель (ниже)
        if (r.status === 503) {
          if (attempt >= 2) return r;
          await new Promise((ok) => setTimeout(ok, 5000 * (attempt + 1))); continue;
        }
        if (r.status < 500 || attempt >= 3) return r;
      } catch (e) {
        if (attempt >= 3) throw e;
      }
      await new Promise((ok) => setTimeout(ok, 2000 * 2 ** attempt));
    }
  };
  let res = await post();
  if (res.status === 400 && body.reasoning) { delete body.reasoning; res = await post(); }
  let spare = '';
  if (res.status === 503 && opts.provider === 'gemini') {      // перегрузка держится — запасная модель, как в панели
    spare = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'].find((m) => m !== body.model);
    body.model = spare;
    res = await post();
  }
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  let data = await res.json();
  let reply = (data.choices && data.choices[0] && data.choices[0].message.content) || '';
  // ответ не разобрался (оборван, не JSON) — как в панели: ещё раз; молча «всё принять» нельзя
  const unreadable = (r) => { const p = C.parseVerdicts(r); return !p || !p.list.length; };
  if (unreadable(reply)) {
    const ch = data.choices && data.choices[0];
    console.error(`#${item.id}: ответ не разобран (finish_reason ${ch && ch.finish_reason}, ${reply.length} символов): ${reply.slice(0, 150)} … ${reply.slice(-150)}`);
    const again = await post();
    if (again.ok) { data = await again.json(); reply = (data.choices && data.choices[0] && data.choices[0].message.content) || ''; }
    if (unreadable(reply)) throw new Error('ответ модели не разобран дважды');
  }
  return { verdicts: C.finalize(C.parseVerdicts(reply), item.card, book, resolutions, facts, photos.map((p) => p.label)),
           spare, cost: data.usage && data.usage.cost || 0,
           tokens: data.usage ? (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0) : 0 };
}

async function main() {
  const [rulesPath, cardsPath, modelArg] = process.argv.slice(2);
  const provider = process.env.EVAL_PROVIDER || 'openrouter';
  const opts = {
    provider, budget: Number(process.env.EVAL_RULES_CHARS || 40000), baseDir: require('path').dirname(cardsPath),
    model: modelArg || (provider === 'gemini' ? 'gemini-3.5-flash-lite' : 'z-ai/glm-5.3-flash'),
    // запасной ключ Gemini (другой проект Google — свои лимиты): GEMINI_API_KEY_2
    keys: (provider === 'gemini' ? [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2]
      : [process.env.OPENROUTER_API_KEY]).filter(Boolean),
    keyIndex: 0,
    url: process.env.EVAL_API_URL || (provider === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions'),
  };
  if (!opts.keys.length) throw new Error('нет ключа: переменная OPENROUTER_API_KEY или GEMINI_API_KEY');
  const book = new RulesBook(JSON.parse(fs.readFileSync(rulesPath, 'utf8')));
  const resolutions = C.buildResolutions(book);
  const cards = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));
  const limit = Number(process.env.EVAL_BUDGET || 0.1);
  let spent = 0; let ok = 0; let ruleNamed = 0; let tokens = 0; const rows = [];
  const par = Number(process.env.EVAL_PAR || 2);       // карточек одновременно (Gemini бесплатно — 1)
  for (let i = 0; i < cards.length; i += par) {
    if (spent >= limit) { console.log(`СТОП: потрачено $${spent.toFixed(4)} из $${limit}`); break; }
    const batch = cards.slice(i, i + par);
    const answers = await Promise.all(batch.map((item) => ask(item, book, resolutions, opts)
      .catch((e) => ({ error: e.message }))));
    batch.forEach((item, k) => {
      const a = answers[k];
      if (a.error) { rows.push({ item, error: a.error }); return; }
      spent += a.cost; tokens += a.tokens;
      const s = score(item, a.verdicts);
      ok += s.ok; ruleNamed += s.ok && s.ruleNamed;
      rows.push({ item, s, verdicts: a.verdicts, spare: a.spare });
    });
  }
  for (const r of rows) {
    const exp = r.item.expect.reject.map((e) => `${e.attribute}: ${e.resolution}`).join('; ') || 'всё принять';
    if (r.error) { console.log(`#${r.item.id} ОШИБКА ${r.error}`); continue; }
    const got = (r.verdicts ? r.verdicts.list : []).filter((v) => v.decision === 'отклонить')
      .map((v) => `${v.attribute}: ${v.resolution}`).join('; ') || 'всё принять';
    console.log(`#${r.item.id} ${r.s.ok ? 'ВЕРНО ' : 'ОШИБКА'} ${r.item.case}${r.spare ? ` (503 — ответила запасная ${r.spare})` : ''}\n    эталон: ${exp}\n    модель: ${got}`);
    if (!r.s.ok && r.verdicts) {          // почему модель так решила
      for (const v of r.verdicts.list.filter((x) => x.decision === 'отклонить' || x.reason)) {
        console.log(`      ${v.attribute} → ${v.decision}: ${String(v.reason).slice(0, 160)}`);
      }
      for (const ph of r.verdicts.photos || []) {   // опись фото — что модель увидела
        console.log(`      ФОТО ${ph.n}: «${String(ph.text).slice(0, 60)}» / ${String(ph.seen).slice(0, 120)}`);
      }
    }
  }
  console.log(`\nИТОГ: верно ${ok} из ${rows.length}; из них пункт правил назван — ${ruleNamed}. Модель ${opts.model}, `
    + `потрачено $${spent.toFixed(4)}, токенов на карточку в среднем ${Math.round(tokens / Math.max(1, rows.length))}`
    + `, фото ${PHOTO_SIZE} px`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { score, similar };
