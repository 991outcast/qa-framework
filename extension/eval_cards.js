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

async function ask(item, book, resolutions, opts) {
  const text = book.excerpts(C.cardQuery(item.card, null), opts.budget, C.excerptSkip(item.card), C.excerptPin(item.card)) + '\n\n'
    + C.cardText(item.card, [], resolutions, null);
  const body = { model: opts.model, temperature: 0, max_tokens: 3000, response_format: { type: 'json_object' },
                 messages: [{ role: 'system', content: C.CARD_PROMPT }, { role: 'user', content: [{ type: 'text', text }] }] };
  if (opts.provider === 'openrouter') {
    body.usage = { include: true };
    body.reasoning = { effort: process.env.EVAL_REASONING || 'minimal' };   // как в панели; low — модель «думает»
  }
  // связь с сервисом рвётся («fetch failed», 5xx) — повторить, с паузой 2, 4, 8 с
  const post = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await request(opts.url, JSON.stringify(body),
          { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.key });
        if (r.status < 500 || attempt >= 3) return r;
      } catch (e) {
        if (attempt >= 3) throw e;
      }
      await new Promise((ok) => setTimeout(ok, 2000 * 2 ** attempt));
    }
  };
  let res = await post();
  if (res.status === 400 && body.reasoning) { delete body.reasoning; res = await post(); }
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = (data.choices && data.choices[0] && data.choices[0].message.content) || '';
  return { verdicts: C.parseVerdicts(content), cost: data.usage && data.usage.cost || 0 };
}

async function main() {
  const [rulesPath, cardsPath, modelArg] = process.argv.slice(2);
  const provider = process.env.EVAL_PROVIDER || 'openrouter';
  const opts = {
    provider, budget: Number(process.env.EVAL_RULES_CHARS || 40000),
    model: modelArg || (provider === 'gemini' ? 'gemini-3.1-flash-lite' : 'z-ai/glm-5.3-flash'),
    key: provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENROUTER_API_KEY,
    url: process.env.EVAL_API_URL || (provider === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions'),
  };
  if (!opts.key) throw new Error('нет ключа: переменная OPENROUTER_API_KEY или GEMINI_API_KEY');
  const book = new RulesBook(JSON.parse(fs.readFileSync(rulesPath, 'utf8')));
  const resolutions = C.buildResolutions(book);
  const cards = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));
  const limit = Number(process.env.EVAL_BUDGET || 0.1);
  let spent = 0; let ok = 0; let ruleNamed = 0; const rows = [];
  for (let i = 0; i < cards.length; i += 2) {           // по 2 карточки одновременно
    if (spent >= limit) { console.log(`СТОП: потрачено $${spent.toFixed(4)} из $${limit}`); break; }
    const batch = cards.slice(i, i + 2);
    const answers = await Promise.all(batch.map((item) => ask(item, book, resolutions, opts)
      .catch((e) => ({ error: e.message }))));
    batch.forEach((item, k) => {
      const a = answers[k];
      if (a.error) { rows.push({ item, error: a.error }); return; }
      spent += a.cost;
      const s = score(item, a.verdicts);
      ok += s.ok; ruleNamed += s.ok && s.ruleNamed;
      rows.push({ item, s, verdicts: a.verdicts });
    });
  }
  for (const r of rows) {
    const exp = r.item.expect.reject.map((e) => `${e.attribute}: ${e.resolution}`).join('; ') || 'всё принять';
    if (r.error) { console.log(`#${r.item.id} ОШИБКА ${r.error}`); continue; }
    const got = (r.verdicts ? r.verdicts.list : []).filter((v) => v.decision === 'отклонить')
      .map((v) => `${v.attribute}: ${v.resolution}`).join('; ') || 'всё принять';
    console.log(`#${r.item.id} ${r.s.ok ? 'ВЕРНО ' : 'ОШИБКА'} ${r.item.case}\n    эталон: ${exp}\n    модель: ${got}`);
    if (!r.s.ok && r.verdicts) {          // почему модель так решила
      for (const v of r.verdicts.list.filter((x) => x.decision === 'отклонить' || x.reason)) {
        console.log(`      ${v.attribute} → ${v.decision}: ${String(v.reason).slice(0, 160)}`);
      }
    }
  }
  console.log(`\nИТОГ: верно ${ok} из ${rows.length}; из них пункт правил назван — ${ruleNamed}. Модель ${opts.model}, `
    + `потрачено $${spent.toFixed(4)}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { score, similar };
