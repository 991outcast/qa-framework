"""Правила площадки из PDF (например, справочник модератора Ozon на 80+ страниц).

Документ целиком в каждый запрос не помещается (сотни тысяч символов), поэтому он один раз
разбирается на разделы по заголовкам (`python main.py --rules файл.pdf`) и хранится в
knowledge/_rules-<площадка>.json. Под каждое задание выбираются разделы, слова которых есть в
тексте задания (BM25 по основам слов), — модель получает их дословно и ссылается на них в ответе.
Текст правил — в knowledge/ (не в git): документ принадлежит площадке.
"""

from __future__ import annotations

import json
import logging
import math
import re
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

logger = logging.getLogger("twork.rules")

_WORD_RE = re.compile(r"[а-яёa-z0-9]+", re.IGNORECASE)
# значки шрифта (частная область Unicode): в тексте PDF это не буквы
_ICONS_RE = re.compile("[-]")
# служебные слова — ни задание, ни правило по ним не найти
_STOP = frozenset("""
и в во не на с со по за к ко от до из у о об а но же ли бы что как это так для при или его ее её их
то все всё был была были быть есть нет да если чтобы когда где кто чем они она оно мы вы ты я
также только уже еще ещё может можно нужно надо этот эта эти тот та те такой который которая
которые товар товара товаре товары товаров карточке карточки карточка ozon озон
""".split())
# разделы, нужные почти в любом задании модерации: как принимать решение
_CORE_RE = re.compile(r"^(как выполнять задания|основные принципы)", re.IGNORECASE)


# окончания русских слов, от длинных к коротким: «ножей», «ножи», «нож» → «нож»
_ENDINGS = tuple(sorted("""
иями ями ами ией иях ях ах ей ой ий ый ая яя ое ее ые ие ую юю ого его ому ему ым им ом ем ов ев
ам ям ою ею ию ья ье ьи ью а я ы и у ю е о ь
""".split(), key=len, reverse=True))


def _stem(word: str) -> str:
    """Основа слова: окончание срезается, если остаётся хотя бы 3 буквы, потом — не длиннее 6 букв
    (алкогольная / алкоголь → алкого, ножей / ножи → нож)."""
    word = word.lower().replace("ё", "е")
    for end in _ENDINGS:
        if word.endswith(end) and len(word) - len(end) >= 3:
            word = word[: -len(end)]
            break
    return word[:6]


def tokens(text: str) -> list[str]:
    return [_stem(w) for w in _WORD_RE.findall(text or "") if len(w) > 2 and w.lower() not in _STOP]


@dataclass
class Section:
    path: list[str]                 # заголовки над разделом: глава, статья
    title: str
    text: str

    def render(self) -> str:
        where = " › ".join(p for p in self.path if p and p != self.title)
        return f"### {self.title}" + (f"  ({where})" if where else "") + f"\n{self.text.strip()}"


@dataclass
class RulesBook:
    source: str
    sections: list[Section]
    imported: str = ""
    _df: Counter = field(default_factory=Counter, repr=False)
    _docs: list[Counter] = field(default_factory=list, repr=False)
    _avg: float = 1.0

    def __post_init__(self) -> None:
        for s in self.sections:
            # заголовок раздела — название резолюции или правила: его слова весят втрое
            doc = Counter(tokens(s.text)) + Counter({t: 3 for t in tokens(s.title)})
            self._docs.append(doc)
            self._df.update(doc.keys())
        self._avg = (sum(sum(d.values()) for d in self._docs) / len(self._docs)) if self._docs else 1.0

    @property
    def chars(self) -> int:
        return sum(len(s.text) for s in self.sections)

    def search(self, query: str, limit: int = 8) -> list[tuple[float, Section]]:
        """Разделы по убыванию совпадения с текстом задания (BM25)."""
        q = Counter(tokens(query))
        if not q:
            return []
        n = len(self._docs)
        scored = []
        for doc, section in zip(self._docs, self.sections):
            length = sum(doc.values()) or 1
            score = 0.0
            for term, qtf in q.items():
                tf = doc.get(term, 0)
                if not tf:
                    continue
                idf = math.log(1 + (n - self._df[term] + 0.5) / (self._df[term] + 0.5))
                score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / self._avg)) * min(qtf, 3)
            if score > 0:
                scored.append((score, section))
        scored.sort(key=lambda x: -x[0])
        return scored[:limit]

    def excerpts(self, query: str, budget: int = 24000) -> str:
        """Выдержки для запроса модели: разделы «как принимать решение» и самые подходящие к заданию
        разделы целиком, пока помещаются в budget символов; в конце — названия остальных разделов
        (резолюций), чтобы модель знала, какие правила ещё есть."""
        chosen: list[Section] = [s for s in self.sections if _CORE_RE.match(s.title)][:2]
        used = sum(len(s.render()) for s in chosen)
        for _, section in self.search(query, limit=30):
            if section in chosen:
                continue
            size = len(section.render())
            if used + size > budget:
                continue
            chosen.append(section)
            used += size
        if not chosen:
            return ""
        # названия остальных разделов — это и есть резолюции: модель назовёт нужную, даже если поиск
        # по словам её текст не нашёл («пишите в телеграм» — в справочнике это «контакты»)
        titles = list(OrderedDict.fromkeys(s.title for s in self.sections if s not in chosen))
        rest = ("\n\nОстальные разделы справочника (текст не приложен): " + " · ".join(titles)) if titles else ""
        return (f"ПРАВИЛА ПЛОЩАДКИ ({Path(self.source).name}) — разделы, подходящие к этому заданию. "
                "Решай по ним и в объяснении называй раздел, по которому решил:\n\n"
                + "\n\n".join(s.render() for s in chosen) + rest)

    # ------------------------------------------------------------------
    # Хранение
    # ------------------------------------------------------------------

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {"source": self.source, "imported": self.imported,
                "sections": [{"path": s.path, "title": s.title, "text": s.text} for s in self.sections]}
        path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> Optional["RulesBook"]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        sections = [Section(list(s.get("path", [])), s.get("title", ""), s.get("text", ""))
                    for s in data.get("sections", []) if s.get("text", "").strip()]
        return cls(data.get("source", path.name), sections, data.get("imported", "")) if sections else None


def rules_path(knowledge_dir: str | Path, platform: str) -> Path:
    return Path(knowledge_dir) / f"_rules-{platform}.json"


# ---------------------------------------------------------------------------
# Разбор PDF
# ---------------------------------------------------------------------------

def _pdf_lines(path: str | Path) -> list[tuple[float, str]]:
    """Строки PDF с размером шрифта (по символам строки — самый частый размер)."""
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    lines: list[tuple[float, str]] = []
    for page in reader.pages:
        rows: "OrderedDict[float, list[tuple[float, str]]]" = OrderedDict()

        def visit(text, cm, tm, font, size, rows=rows):
            if not text:
                return
            y = round((tm[5] if tm else 0) + (cm[5] if cm else 0))
            rows.setdefault(y, []).append((round(size * (tm[0] if tm else 1), 1), text))

        try:
            page.extract_text(visitor_text=visit)
        except Exception as exc:  # noqa: BLE001 — битая страница не должна ронять весь документ
            logger.warning("Страница PDF не прочитана: %s", exc)
            continue
        for parts in rows.values():
            text = re.sub(r"\s+", " ", _ICONS_RE.sub("", "".join(t for _, t in parts))).strip()
            if not text:
                continue
            weight: Counter = Counter()
            for size, t in parts:
                weight[size] += len(t.strip())
            lines.append((weight.most_common(1)[0][0], text))
    return lines


_TOC_TITLES = ("оглавление", "содержание", "contents", "table of contents")


def parse_pdf(path: str | Path) -> RulesBook:
    """Разделы документа по заголовкам: строки крупнее основного текста. Самый мелкий из размеров
    заголовков — заголовок раздела, крупнее — статья и глава (путь раздела). Оглавление пропускается.
    Заголовков нет — раздел на каждую страницу не делится, а режется кусками по ~3000 символов."""
    lines = _pdf_lines(path)
    if not lines:
        raise ValueError("в PDF нет текста (похоже на скан) — такой документ нужно сначала распознать")
    body = Counter()
    for size, text in lines:
        body[size] += len(text)
    body_size = body.most_common(1)[0][0]
    # размеры заголовков: крупнее основного текста и встречаются как отдельные короткие строки
    heads = sorted({s for s, t in lines if s > body_size + 0.4 and len(t) <= 160}, reverse=True)
    level = {s: i for i, s in enumerate(heads)}
    sections: list[Section] = []
    path_now: list[str] = [""] * len(heads)
    title, buf, skip = "", [], False

    def flush() -> None:
        text = "\n".join(buf).strip()
        if text and not skip:
            sections.append(Section([p for p in path_now[:-1] if p], title or "Без заголовка", text))

    prev_head: Optional[float] = None
    for size, text in lines:
        if size in level and len(text) <= 160:
            depth = level[size]
            if prev_head == size and not buf and title:
                # заголовок на двух строках: «… ограниченной категории или группе» + «товаров»
                title = f"{title} {text}"
                path_now[depth] = title
                skip = title.strip().lower() in _TOC_TITLES
                continue
            prev_head = size
            flush()
            buf = []
            path_now[depth] = text
            for i in range(depth + 1, len(path_now)):
                path_now[i] = ""
            title = text
            skip = text.strip().lower() in _TOC_TITLES
            continue
        prev_head = None
        if buf and text == title:        # заголовок, повторённый строкой текста
            continue
        buf.append(text)
    flush()
    if not heads:                         # без заголовков — кусками
        whole = "\n".join(t for _, t in lines)
        sections = [Section([], f"Фрагмент {i + 1}", whole[i * 3000:(i + 1) * 3000])
                    for i in range(math.ceil(len(whole) / 3000))]
    return RulesBook(str(path), sections, datetime.now().strftime("%Y-%m-%d %H:%M"))


def import_pdf(pdf: str | Path, knowledge_dir: str | Path, platform: str) -> RulesBook:
    book = parse_pdf(pdf)
    book.save(rules_path(knowledge_dir, platform))
    return book


_CACHE: dict[str, tuple[float, Optional[RulesBook]]] = {}


def load_rules(knowledge_dir: str | Path, platform: str) -> Optional[RulesBook]:
    """Правила площадки (перечитываются, если файл обновили новым --rules)."""
    path = rules_path(knowledge_dir, platform)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    cached = _CACHE.get(str(path))
    if cached is None or cached[0] != mtime:
        cached = (mtime, RulesBook.load(path))
        _CACHE[str(path)] = cached
    return cached[1]


# ---------------------------------------------------------------------------
# Команды: python main.py --rules файл.pdf  и  python main.py --ask
# ---------------------------------------------------------------------------

def import_command(pdf: str) -> int:
    from config import KNOWLEDGE_DIR, PLATFORM

    try:
        book = import_pdf(pdf, KNOWLEDGE_DIR, PLATFORM.key)
    except FileNotFoundError:
        logger.error("Файл не найден: %s", pdf)
        return 2
    except Exception as exc:  # noqa: BLE001 — понятное сообщение вместо трассировки
        logger.error("PDF не прочитан: %s", exc)
        return 2
    logger.info("📕 Правила для площадки %s сохранены: %d разделов, %d тыс. символов — %s. Помощник и агент "
                "берут из них разделы под каждое задание; спросить по правилам — python main.py --ask",
                PLATFORM.title, len(book.sections), book.chars // 1000, rules_path(KNOWLEDGE_DIR, PLATFORM.key))
    return 0


def _read_question() -> Optional[str]:
    """Текст карточки или вопрос: несколько строк, конец — пустая строка; «выход» — закончить."""
    print("\nВставьте текст карточки или задайте вопрос (закончить ввод — пустая строка, выйти — «выход»):")
    lines: list[str] = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if not line.strip():
            if lines:
                break
            continue
        if not lines and line.strip().lower() in ("выход", "exit", "quit", "q"):
            return None
        lines.append(line)
    return "\n".join(lines) if lines else None


async def ask(text: str = "") -> None:
    """Вопросы по правилам в терминале: разделы справочника под карточку и ответ модели со ссылками."""
    import asyncio

    from config import ASSIST_MODEL, GEMINI_API_KEY, GEMINI_MODEL, KNOWLEDGE_DIR, PLATFORM, RULES_PROMPT_CHARS
    from openrouter_connector import LLMConnector

    book = load_rules(KNOWLEDGE_DIR, PLATFORM.key)
    if book is None:
        logger.error("Правил для площадки %s нет. Сначала загрузите справочник: python main.py --rules файл.pdf "
                     "(площадка — PLATFORM в .env или --platform)", PLATFORM.title)
        return
    llm = LLMConnector(provider="gemini") if GEMINI_API_KEY else LLMConnector()
    model = GEMINI_MODEL if GEMINI_API_KEY else ASSIST_MODEL
    logger.info("Правила: %s — %d разделов. Модель: %s", Path(book.source).name, len(book.sections), model)
    while True:
        question = text or await asyncio.to_thread(_read_question)
        if not question:
            return
        found = [s.title for _, s in book.search(question, 6)]
        print("\nПодходящие разделы: "
              + ("; ".join(found) if found else "по словам не нашлось — модель видит названия всех разделов"))
        before = llm.usage.cost
        answer = await llm.answer_by_rules(question, book.excerpts(question, RULES_PROMPT_CHARS), model)
        print("\n" + (answer or "Модель не ответила — см. сообщение выше."))
        spent = llm.usage.cost - before
        if spent:
            print(f"(≈ ${spent:.4f})")
        if text:
            return
