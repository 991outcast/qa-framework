// Поиск по правилам площадки (тот же алгоритм, что rules.py): разделы справочника — из файла
// knowledge/_rules-<площадка>.json, который делает `python main.py --rules файл.pdf`.
// Работает внутри браузера, без сети: разделы под задание находятся за миллисекунды.

const WORD_RE = /[а-яёa-z0-9]+/gi;
const STOP = new Set(`
и в во не на с со по за к ко от до из у о об а но же ли бы что как это так для при или его ее её их
то все всё был была были быть есть нет да если чтобы когда где кто чем они она оно мы вы ты я
также только уже еще ещё может можно нужно надо этот эта эти тот та те такой который которая
которые товар товара товаре товары товаров карточке карточки карточка ozon озон
`.split(/\s+/).filter(Boolean));
const ENDINGS = `
иями ями ами ией иях ях ах ей ой ий ый ая яя ое ее ые ие ую юю ого его ому ему ым им ом ем ов ев
ам ям ою ею ию ья ье ьи ью а я ы и у ю е о ь
`.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
const CORE_RE = /^(как выполнять задания|основные принципы)/i;

function stem(word) {
  let w = word.toLowerCase().replace(/ё/g, 'е');
  for (const end of ENDINGS) {
    if (w.endsWith(end) && w.length - end.length >= 3) { w = w.slice(0, -end.length); break; }
  }
  return w.slice(0, 6);
}

function tokens(text) {
  return (String(text || '').match(WORD_RE) || [])
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()))
    .map(stem);
}

function count(list, weight = 1, into = new Map()) {
  for (const t of list) into.set(t, (into.get(t) || 0) + weight);
  return into;
}

class RulesBook {
  constructor(data) {
    this.source = data.source || 'правила';
    this.sections = (data.sections || []).filter((s) => (s.text || '').trim());
    this.docs = this.sections.map((s) => count(tokens(s.title), 3, count(tokens(s.text))));
    this.df = new Map();
    for (const doc of this.docs) for (const t of doc.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    const lengths = this.docs.map((d) => [...d.values()].reduce((a, b) => a + b, 0));
    this.lengths = lengths;
    this.avg = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 1;
  }

  // Разделы по убыванию совпадения с текстом задания (BM25)
  search(query, limit = 8) {
    const q = count(tokens(query));
    if (!q.size) return [];
    const n = this.docs.length;
    const scored = [];
    this.docs.forEach((doc, i) => {
      const length = this.lengths[i] || 1;
      let score = 0;
      for (const [term, qtf] of q) {
        const tf = doc.get(term) || 0;
        if (!tf) continue;
        const df = this.df.get(term);
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / this.avg)) * Math.min(qtf, 3);
      }
      if (score > 0) scored.push([score, this.sections[i]]);
    });
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit);
  }

  static render(s) {
    const where = (s.path || []).filter((p) => p && p !== s.title).join(' › ');
    return `### ${s.title}` + (where ? `  (${where})` : '') + `\n${s.text.trim()}`;
  }

  // Выдержки для модели: «как выполнять задания», подходящие разделы целиком (до budget символов)
  // и названия остальных разделов — это резолюции, модель назовёт нужную
  excerpts(query, budget = 24000) {
    const chosen = this.sections.filter((s) => CORE_RE.test(s.title)).slice(0, 2);
    let used = chosen.reduce((a, s) => a + RulesBook.render(s).length, 0);
    for (const [, s] of this.search(query, 30)) {
      if (chosen.includes(s)) continue;
      const size = RulesBook.render(s).length;
      if (used + size > budget) continue;
      chosen.push(s);
      used += size;
    }
    if (!chosen.length) return '';
    const titles = [...new Set(this.sections.filter((s) => !chosen.includes(s)).map((s) => s.title))];
    const rest = titles.length ? '\n\nОстальные разделы справочника (текст не приложен): ' + titles.join(' · ') : '';
    const name = String(this.source).split(/[\\/]/).pop();
    return `ПРАВИЛА ПЛОЩАДКИ (${name}) — разделы, подходящие к этому заданию. `
      + 'Решай по ним и в объяснении называй раздел, по которому решил:\n\n'
      + chosen.map(RulesBook.render).join('\n\n') + rest;
  }
}

if (typeof module !== 'undefined') module.exports = { RulesBook, tokens, stem };
