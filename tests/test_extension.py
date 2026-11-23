"""Расширение «Помощник модератора» (extension/): поиск по правилам в браузере совпадает с rules.py,
страница только читается (видео не трогается), панель показывает разделы и ответ модели.
Расширение целиком в фирменный Chrome тест загрузить не может (Chrome 137+ не принимает
--load-extension) — части проверяются на обычной странице с заглушкой API расширения."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from playwright.async_api import async_playwright

from rules import RulesBook
from tests.helpers import launch_options, run
from tests.test_rules import _book

EXT = Path(__file__).resolve().parents[1] / "extension"


def _data() -> dict:
    book = _book()
    return {"source": book.source, "sections": [{"path": s.path, "title": s.title, "text": s.text}
                                                 for s in book.sections]}


@pytest.mark.skipif(shutil.which("node") is None, reason="нет Node.js")
def test_js_search_matches_python(tmp_path):
    """extension/rules.js — тот же поиск, что rules.py: те же разделы в том же порядке, те же выдержки."""
    data = tmp_path / "rules.json"
    data.write_text(json.dumps(_data(), ensure_ascii=False), encoding="utf-8")
    queries = ["Нож складной туристический, клинок 12 см", "Энергетический напиток без признака 18",
               "Главное фото: иероглифы на упаковке"]
    script = tmp_path / "run.js"
    script.write_text(
        "const { RulesBook } = require(" + json.dumps(str(EXT / "rules.js")) + ");\n"
        "const fs = require('fs');\n"
        "const book = new RulesBook(JSON.parse(fs.readFileSync(" + json.dumps(str(data)) + ", 'utf8')));\n"
        "const queries = " + json.dumps(queries, ensure_ascii=False) + ";\n"
        "console.log(JSON.stringify(queries.map((q) => ({ titles: book.search(q, 5).map((x) => x[1].title),"
        " excerpts: book.excerpts(q, 400) }))));\n", encoding="utf-8")
    out = subprocess.run(["node", str(script)], capture_output=True, text=True, encoding="utf-8", check=True)
    js = json.loads(out.stdout)
    book = RulesBook.load(data)
    for q, got in zip(queries, js):
        assert got["titles"] == [s.title for _, s in book.search(q, 5)]
        assert got["excerpts"] == book.excerpts(q, 400)


PAGE = """<html><body><h2>Модерация</h2><p>Название: Нож туристический, клинок 15 см</p>
<video width="320" height="180" preload="none"></video>
<button>Принять</button><button>Отклонить</button></body></html>"""


def test_content_script_only_reads_the_page():
    """content.js отдаёт панели текст задания и число роликов; видео не запускается, страница не меняется."""
    stub = "window.__sent = []; window.chrome = { runtime: { sendMessage: (m) => { window.__sent.push(m); return Promise.resolve(); } } };"

    async def scenario():
        async with async_playwright() as p:
            browser = await p.chromium.launch(**launch_options())
            page = await browser.new_page()
            await page.set_content(PAGE)
            await page.evaluate(stub)
            await page.add_script_tag(path=str(EXT / "content.js"))
            await page.wait_for_function("window.__sent.length > 0")
            await page.evaluate("document.querySelector('p').textContent = 'Название: Энергетик 0,45 л'")
            await page.wait_for_function("window.__sent.length > 1")
            sent = await page.evaluate("window.__sent")
            video = await page.evaluate("[document.querySelector('video').paused, document.querySelector('video').currentTime]")
            html_after = await page.evaluate("document.body.outerHTML")
            await browser.close()
            return sent, video, html_after

    sent, video, after = run(scenario())
    assert sent[0]["type"] == "task" and "Нож туристический" in sent[0]["text"] and sent[0]["videos"] == 1
    assert "Энергетик 0,45 л" in sent[-1]["text"]                         # задание сменилось — прочитано заново
    assert video == [True, 0]
    assert "data-" not in after                                           # страницу не размечает


CHROME_STUB = """
(() => {
  const store = { local: %(local)s, session: %(session)s };
  const listeners = [];
  const area = (name) => ({
    get: async (keys) => { const out = {}; for (const k of [].concat(keys || Object.keys(store[name])))
                             if (k in store[name]) out[k] = store[name][k]; return out; },
    set: async (obj) => { const changes = {}; for (const [k, v] of Object.entries(obj)) {
                            changes[k] = { newValue: v }; store[name][k] = v; }
                          listeners.forEach((f) => f(changes, name)); },
    remove: async () => {},
  });
  const ev = () => ({ addListener: () => {} });
  window.chrome = {
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: (f) => listeners.push(f) } },
    tabs: { query: async () => [{ id: 1 }], onActivated: ev(), onUpdated: ev(),
            sendMessage: async (id, m) => { (window.__hints = window.__hints || []).push(m); } },
    runtime: { onMessage: ev() },
  };
})();
"""


def test_side_panel_shows_sections_at_once_and_the_model_answer():
    """Панель: задание вкладки → разделы справочника сразу (поиск в браузере), заметка «видео — сами»,
    ответ модели с ценой; в запросе — выдержки правил, карточка и ключ из настроек."""
    local = {"rules": _data(), "provider": "openrouter", "key": "test-key-not-real", "auto": True}
    session = {"task:1": {"type": "task", "title": "Карточка", "url": "https://task.ozon.ru/x",
                          "text": "Осталось 00:59. Название: Нож туристический, клинок 15 см", "videos": 1}}
    asked: list[dict] = []

    async def scenario():
        async with async_playwright() as p:
            browser = await p.chromium.launch(**launch_options())
            page = await browser.new_page()
            await page.add_init_script(CHROME_STUB % {"local": json.dumps(local, ensure_ascii=False),
                                                      "session": json.dumps(session, ensure_ascii=False)})
            cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS"}

            async def model(route):
                if route.request.method == "OPTIONS":
                    await route.fulfill(status=204, headers=cors)
                    return
                asked.append({"body": json.loads(route.request.post_data),
                              "auth": route.request.headers.get("authorization")})
                await route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps({
                    "choices": [{"message": {"content": "ОТКЛОНИТЬ — Название: «Холодное оружие»"}}],
                    "usage": {"cost": 0.0007}}, ensure_ascii=False))

            await page.route("https://openrouter.ai/**", model)
            await page.goto((EXT / "sidepanel.html").as_uri())
            await page.wait_for_function("document.querySelector('#answer').textContent.includes('ОТКЛОНИТЬ')")
            # тикает таймер (меняются только цифры) — тот же запрос, модель не спрашивается снова
            for left in ("00:58", "00:57", "00:56"):
                task = dict(session["task:1"], text=session["task:1"]["text"].replace("00:59", left))
                await page.evaluate("(t) => chrome.storage.session.set({'task:1': t})", task)
                await page.wait_for_timeout(400)
            await page.wait_for_timeout(800)
            ticks = len(asked)
            sections = await page.locator("details.rule summary").all_inner_texts()
            note = await page.locator("#video-note").is_visible()
            meta = await page.locator("#answer-meta").inner_text()
            new_card = dict(session["task:1"], text="Название: Энергетический напиток 0,45 л")
            await page.evaluate("(t) => chrome.storage.session.set({'task:1': t})", new_card)
            await page.wait_for_timeout(2000)
            await browser.close()
            return sections, note, meta, ticks

    sections, note, meta, ticks = run(scenario())
    assert ticks == 1                                                     # таймер — не новое задание
    assert sections and "Холодное оружие" in sections[0]
    assert note and "$0.0007" in meta
    body = asked[0]["body"]
    assert asked[0]["auth"] == "Bearer test-key-not-real" and body["model"] == "z-ai/glm-5.3-flash"
    assert "ТОЛЬКО по правилам" in body["messages"][0]["content"]
    assert "Ножи с длиной клинка" in body["messages"][1]["content"] and body["reasoning"] == {"effort": "minimal"}
    assert len(asked) == 2 and "Энергетический" in asked[1]["body"]["messages"][1]["content"]   # новая карточка


MODERATION = Path(__file__).resolve().parent / "fixtures" / "ozon_moderation.html"
RUNTIME_STUB = ("window.__sent = []; window.chrome = { runtime: { sendMessage: (m) => { window.__sent.push(m); "
                "return Promise.resolve(); }, onMessage: { addListener: (f) => { window.__listener = f; } } } };")


def test_content_script_reads_the_moderation_card_and_marks_the_hint():
    """Карточка модерации (устройство — из записи 23.11): шапка, атрибуты с пометками «не проверяется» и
    «изменено», новое и старое фото, подсвеченные Ozon слова, открытые причины отклонения, видео. Подсказка
    панели — рамки вокруг ✓/✗ и нужной причины, видео не запускается."""
    async def scenario():
        async with async_playwright() as p:
            browser = await p.chromium.launch(**launch_options())
            page = await browser.new_page()
            await page.goto(MODERATION.as_uri())
            await page.evaluate(RUNTIME_STUB)
            await page.add_script_tag(path=str(EXT / "content.js"))
            await page.wait_for_function("window.__sent.length > 0")
            sent = await page.evaluate("window.__sent[0]")
            await page.evaluate("""() => window.__listener({ type: 'hints', key: 'x', hints: [
                { attribute: 'Бренд', decision: 'принять', resolution: '' },
                { attribute: 'Изображение', decision: 'отклонить',
                  resolution: 'На главном фото изображена алкогольная или табачная продукция' }] })""")
            marks = await page.evaluate("""() => [...document.querySelectorAll('[data-ai-hint]')].map((el) =>
                [el.closest('[class*="_attribute_"]').querySelector('[class*="_topLeft_"]').innerText,
                 el.getAttribute('data-ai-hint'), el.innerText.trim()])""")
            video = await page.evaluate(
                "[document.querySelector('video').paused, document.querySelector('video').currentTime]")
            await browser.close()
            return sent, marks, video

    sent, marks, video = run(scenario())
    card = sent["card"]
    assert card["name"] == "Тестовая кружка «Пример» 300 мл" and card["seller"] == "Магазин Пример 1234567"
    assert card["category"] == "Кружка" and card["group"] == "Посуда" and card["badges"] == ["Зарубежный продавец"]
    attrs = {a["title"]: a for a in card["attributes"]}
    assert list(attrs) == ["Бренд", "Название", "Аннотация", "Изображение", "Изображения", "Озон.Видео",
                           "Общие недочеты"]
    assert attrs["Бренд"]["active"] and attrs["Бренд"]["value"] == "Нет бренда" and not attrs["Название"]["checkable"]
    assert attrs["Аннотация"]["highlights"] == ["мобил"] and "автомобильных" in attrs["Аннотация"]["value"]
    image = attrs["Изображение"]
    assert image["changed"] and len(image["images"]) == 2 and len(image["reasons"]) == 2
    assert "Причины отклонения" not in image["value"]                    # список причин — отдельно
    assert len(attrs["Изображения"]["images"]) == 2 and attrs["Озон.Видео"]["video"]
    assert sorted(m[:2] for m in marks) == [["Бренд", "approve"], ["Изображение", "decline"],
                                             ["Изображение", "reason"]]
    assert any("табачная продукция" in m[2] for m in marks if m[1] == "reason")
    assert video == [True, 0]


def _attr(title, value="", **extra):
    base = {"title": title, "status": "", "value": value, "old": "", "checkable": True, "changed": False,
            "active": False, "images": [], "video": False, "highlights": [], "reasons": []}
    base.update(extra)
    return base


def test_side_panel_checks_every_attribute_with_photos_and_rules():
    """Панель в режиме карточки: в запросе — выдержки правил, карточка по атрибутам с резолюциями этого
    атрибута из справочника, подсвеченные слова, все фото (в 1000 px) с подписями; видео — человеку. Ответ —
    решение по каждому атрибуту; подсказка уходит на страницу."""
    rules = _data()
    rules["sections"].append({"path": ["Общая инструкция"],
                              "title": "На главном фото изображена алкогольная или табачная продукция",
                              "text": "Применяется к: Атрибут: «Главное фото»\nАкт курения без признака 18."})
    pic = "https://ir-20.ozone.ru/s3/multimedia-1-{}/100000000{}.jpg"
    card = {"name": "Тестовая кружка", "seller": "Магазин Пример 1234567", "category": "Кружка", "group": "Посуда",
            "badges": [], "attributes": [
                _attr("Бренд", "Нет бренда", active=True),
                _attr("Аннотация", "Кружка для автомобильных поездок", highlights=["мобил"]),
                _attr("Изображение", "новое старое", status="Изменено", changed=True,
                      images=[pic.format("a", 1), pic.format("b", 2)]),
                _attr("Изображения", images=[pic.format("c", 3), pic.format("d", 4)]),
                _attr("Озон.Видео", video=True)]}
    local = {"rules": rules, "provider": "openrouter", "key": "test-key-not-real", "auto": True, "photos": "all"}
    session = {"task:1": {"type": "task", "tabId": 1, "key": "card-1", "title": card["name"], "card": card,
                          "url": "https://moderation.ozon.ru/", "text": "", "videos": 1}}
    asked: list[dict] = []
    photos: list[str] = []
    answer = {"attributes": [
        {"name": "Бренд", "decision": "принять", "resolution": "", "reason": "критического бренда нет", "section": ""},
        {"name": "Изображение", "decision": "отклонить",
         "resolution": "На главном фото изображена алкогольная или табачная продукция", "reason": "ФОТО 1: сигарета",
         "section": "На главном фото изображена алкогольная или табачная продукция"},
        {"name": "Озон.Видео", "decision": "смотрите сами", "resolution": "", "reason": "", "section": ""}],
        "summary": "Отклонить главное фото"}

    async def scenario():
        async with async_playwright() as p:
            browser = await p.chromium.launch(**launch_options())
            page = await browser.new_page()
            await page.add_init_script(CHROME_STUB % {"local": json.dumps(local, ensure_ascii=False),
                                                      "session": json.dumps(session, ensure_ascii=False)})
            cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}

            async def image(route):
                photos.append(route.request.url)
                await route.fulfill(status=200, headers=cors, content_type="image/jpeg", body=b"\xff\xd8\xff\xd9")

            async def model(route):
                if route.request.method == "OPTIONS":
                    await route.fulfill(status=204, headers=cors)
                    return
                asked.append(json.loads(route.request.post_data))
                await route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps({
                    "choices": [{"message": {"content": json.dumps(answer, ensure_ascii=False)}}],
                    "usage": {"cost": 0.0013}}, ensure_ascii=False))

            await page.route("https://ir-20.ozone.ru/**", image)
            await page.route("https://openrouter.ai/**", model)
            await page.goto((EXT / "sidepanel.html").as_uri())
            await page.wait_for_function("document.querySelectorAll('.verdict').length === 3")
            rows = await page.locator(".verdict").all_inner_texts()
            hints = await page.evaluate("window.__hints")
            await browser.close()
            return rows, hints

    rows, hints = run(scenario())
    content = asked[0]["messages"][1]["content"]
    text = content[0]["text"]
    assert "АТРИБУТ «Бренд» — проверить, открыт сейчас" in text and "Подсвечено Ozon: мобил" in text
    assert "Резолюции этого атрибута: На главном фото изображена алкогольная или табачная продукция" in text
    assert "Видео — его смотрит человек" in text and "Фото: ФОТО 1–2" in text
    pictures = [c for c in content if c["type"] == "image_url"]
    assert len(pictures) == 4 and all(c["image_url"]["url"].startswith("data:image/jpeg;base64,") for c in pictures)
    labels = [c["text"] for c in content if c["type"] == "text"][1:]
    assert labels[0] == "ФОТО 1 — «Изображение» (новое)" and labels[1] == "ФОТО 2 — «Изображение» (старое)"
    assert all("/wc1000/" in u for u in photos) and asked[0]["response_format"] == {"type": "json_object"}
    assert rows[1].startswith("ОТКЛОНИТЬ — Изображение") and "сигарета" in rows[1]
    assert hints[0]["key"] == "card-1" and hints[0]["hints"][1]["decision"] == "отклонить"
