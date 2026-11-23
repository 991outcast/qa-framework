"""Правила площадки из PDF: разбор на разделы, поиск под задание, выдержки в запросе (без сети)."""

from __future__ import annotations

import json

import openrouter_connector as oc
from knowledge import KnowledgeBase
from models import ElementKind, PageState, ParsedElement
from rules import RulesBook, Section, load_rules, parse_pdf, rules_path
from tests.helpers import run
from tests.test_connector import completion, fake_openai, make_connector, use_model


def _pdf(lines: list[tuple[int, str]]) -> bytes:
    """Простой PDF: строки (размер шрифта, текст) сверху вниз, страница за страницей по 40 строк."""
    pages = [lines[i:i + 40] for i in range(0, len(lines), 40)]
    objects: list[bytes] = [b"", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for page in pages:
        y, ops = 800, []
        for size, text in page:
            safe = text.replace("(", "[").replace(")", "]")
            ops.append(f"BT /F1 {size} Tf 50 {y} Td ({safe}) Tj ET")
            y -= size + 6
        stream = "\n".join(ops).encode("latin-1")
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        content = len(objects)
        objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 850] /Contents %d 0 R "
                       b"/Resources << /Font << /F1 3 0 R >> >> >>" % content)
        kids.append(len(objects))
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = (b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % k for k in kids)
                  + b"] /Count %d >>" % len(kids))
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def test_pdf_is_split_into_sections_by_headings(tmp_path):
    """Заголовки — строки крупнее основного текста: крупнее — статья (путь раздела), самый мелкий из
    заголовков — раздел. Заголовок на двух строках — один раздел; оглавление пропускается."""
    body = "Sample rule text for the moderator, long enough to be the main font of the document."
    pdf = tmp_path / "rules.pdf"
    pdf.write_bytes(_pdf([
        (16, "Moderator handbook"), (10, body),
        (13, "Contents"), (10, "Poisons ... 2"), (10, "Alcohol ... 3"),
        (13, "Prohibited goods"),
        (11, "Product cannot be sold. Poisons and"), (11, "toxic substances"),
        (10, body), (10, "Poisons and their precursors are banned."), (10, body),
        (11, "Product cannot be sold. Alcohol"), (10, body), (10, "Beer and wine are banned."),
    ] + [(10, body)] * 45))
    book = parse_pdf(pdf)
    titles = [s.title for s in book.sections]
    assert "Product cannot be sold. Poisons and toxic substances" in titles      # две строки — один заголовок
    assert "toxic substances" not in titles and "Contents" not in titles
    poisons = next(s for s in book.sections if s.title.endswith("toxic substances"))
    assert poisons.path[-1] == "Prohibited goods" and "precursors are banned" in poisons.text
    alcohol = next(s for s in book.sections if s.title.endswith("Alcohol"))
    assert "Beer and wine" in alcohol.text and "Poisons ... 2" not in " ".join(s.text for s in book.sections)


def _book() -> RulesBook:
    return RulesBook("справочник.pdf", [
        Section(["Базовые материалы"], "Как выполнять задания", "Нет подходящего запрета — атрибут верный."),
        Section(["Ограничения"], "«Товар нельзя продавать». Холодное оружие",
                "Ножи с длиной клинка больше 9 см, кастеты и ножи-бабочки продавать нельзя."),
        Section(["Ограничения"], "«Не указан признак 18». Энергетики",
                "Энергетические напитки — только с признаком 18+."),
        Section(["Общие недочеты"], "В аннотации указаны ключевые слова",
                "Перечень поисковых запросов вместо описания товара — отклонить."),
        Section(["Фото"], "Иероглифы на главном фото", "Иероглифы на значительной части главного фото — отклонить."),
    ], "2026-11-19")


def test_rules_search_finds_the_section_for_the_card():
    """Поиск по основам слов: «нож»/«ножи», «энергетический»/«энергетики»; заголовок раздела весит больше."""
    book = _book()
    assert book.search("Нож складной туристический, клинок 12 см")[0][1].title.endswith("Холодное оружие")
    assert book.search("Энергетический напиток 0,45 л")[0][1].title.endswith("Энергетики")
    assert book.search("ой") == []                                       # служебное слово — ничего


def test_excerpts_keep_core_rules_matches_and_names_of_the_rest():
    """В запросе: «как выполнять задания», подходящие разделы целиком, названия остальных (резолюции —
    модель назовёт нужную, даже если её текст поиск не нашёл); лимит символов соблюдается."""
    book = _book()
    text = book.excerpts("Энергетический напиток без признака 18", budget=400)
    assert text.index("Как выполнять задания") < text.index("Энергетики")
    assert "Энергетические напитки — только с признаком 18+" in text
    rest = text.split("Остальные разделы справочника")[1]
    assert "Иероглифы на главном фото" in rest and "Холодное оружие" in rest
    assert "Ножи с длиной клинка" not in text                           # не подходит — только название


def test_rules_reach_the_prompt_of_the_platform(tmp_path):
    """Правила площадки (knowledge/_rules-<площадка>.json) — в знаниях запроса, разделы — под задание."""
    _book().save(rules_path(tmp_path, "twork"))
    assert load_rules(tmp_path, "twork").sections[1].title.endswith("Холодное оружие")
    assert load_rules(tmp_path, "ozon") is None                          # другой площадки правила не трогают
    kb = KnowledgeBase(str(tmp_path))
    state = PageState(task_text="Проверьте карточку: Нож туристический, клинок 15 см", elements=[
        ParsedElement(index=0, uid="1-0", key="o||1", text="Принять", kind=ElementKind.OPTION, choice_type="radio")])
    text = kb.rules_text(state)
    assert "Ножи с длиной клинка больше 9 см" in text and "ПРАВИЛА ПЛОЩАДКИ" in text
    saved = json.loads(rules_path(tmp_path, "twork").read_text(encoding="utf-8"))
    assert saved["source"] == "справочник.pdf" and len(saved["sections"]) == 5


def test_answer_by_rules_sends_rules_and_card(monkeypatch):
    """--ask: системная роль — решать только по правилам; в запросе — выдержки и карточка."""
    use_model(monkeypatch, "z-ai/glm-5.3-flash")
    with fake_openai([completion("ОТКЛОНИТЬ — Название: «Холодное оружие»")]) as (url, requests):
        connector = make_connector(monkeypatch, url)
        answer = run(connector.answer_by_rules("Нож 15 см", _book().excerpts("Нож 15 см"), "z-ai/glm-5.3-flash"))
    assert answer == "ОТКЛОНИТЬ — Название: «Холодное оружие»"
    system, user = requests[0]["messages"]
    assert system["content"] == oc._RULES_PROMPT and "ТОЛЬКО по правилам" in system["content"]
    assert "Ножи с длиной клинка" in user["content"] and user["content"].endswith("Нож 15 см")
