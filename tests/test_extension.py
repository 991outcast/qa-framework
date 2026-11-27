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
    runtime: { onMessage: ev(), getManifest: () => ({ host_permissions: ['https://*.ozon.ru/*'] }) },
    permissions: { contains: async () => %(access)s, request: async () => true },
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
            await page.add_init_script(CHROME_STUB % {"access": "true", "local": json.dumps(local, ensure_ascii=False),
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
            await page.add_init_script(CHROME_STUB % {"access": "true", "local": json.dumps(local, ensure_ascii=False),
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


def test_firefox_build_uses_sidebar_and_the_same_code(tmp_path):
    """Firefox: тот же код, другой манифест — боковая панель sidebar_action, фоновый скрипт background.scripts,
    id дополнения; доступ к сайтам и содержимое (скрипты, разрешения, версия) — как у Chrome."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("build_firefox", EXT / "build_firefox.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    out = module.build(tmp_path / "extension-firefox")
    ff = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    chrome = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    assert ff["background"] == {"scripts": ["background.js"]} and ff["sidebar_action"]["default_panel"] == "sidepanel.html"
    assert ff["browser_specific_settings"]["gecko"]["id"] and "sidePanel" not in ff["permissions"]
    for key in ("version", "host_permissions", "content_scripts"):
        assert ff[key] == chrome[key], key
    names = {f.name for f in out.iterdir()}
    assert {"content.js", "rules.js", "sidepanel.html", "sidepanel.js", "sidepanel.css", "background.js"} <= names
    assert "build_firefox.py" not in names and "manifest.firefox.json" not in names
    assert (tmp_path / "extension-firefox.zip").exists()


@pytest.mark.skipif(shutil.which("node") is None, reason="нет Node.js")
def test_background_opens_firefox_sidebar_on_icon_click(tmp_path):
    """Фоновый скрипт без sidePanel (Firefox): значок расширения открывает и закрывает sidebar."""
    script = tmp_path / "bg.js"
    lines = [
        "let clicked = null; let toggled = 0;",
        "const ev = () => ({ addListener: () => {} });",
        "globalThis.browser = { sidebarAction: { toggle: () => { toggled++; } } };",
        "globalThis.chrome = { action: { onClicked: { addListener: (f) => { clicked = f; } } },",
        "  runtime: { onMessage: ev() }, tabs: { onRemoved: ev() }, storage: { session: {} } };",
        "require(" + json.dumps(str(EXT / "background.js")) + ");",
        "clicked(); console.log(toggled);",
    ]
    script.write_text(chr(10).join(lines), encoding="utf-8")
    out = subprocess.run(["node", str(script)], capture_output=True, text=True, encoding="utf-8", check=True)
    assert out.stdout.strip() == "1"


def test_side_panel_asks_for_site_access_in_firefox():
    """Firefox выдаёт доступ к сайтам по просьбе: панель показывает кнопку «Разрешить доступ»."""
    async def scenario():
        async with async_playwright() as p:
            browser = await p.chromium.launch(**launch_options())
            page = await browser.new_page()
            await page.add_init_script(CHROME_STUB % {"access": "false", "local": "{}", "session": "{}"})
            await page.goto((EXT / "sidepanel.html").as_uri())
            await page.wait_for_function("!document.querySelector('#perm').hidden")
            await page.click("#perm-btn")
            await page.wait_for_function("document.querySelector('#perm').hidden")
            status = await page.locator("#status").inner_text()
            await browser.close()
            return status

    assert "Доступ выдан" in run(scenario())


@pytest.mark.skipif(shutil.which("node") is None, reason="нет Node.js")
def test_reference_cards_and_scoring(tmp_path):
    """Эталонные карточки (tests/fixtures/moderation_cards.json, вымышленные): у каждой ожидаемый атрибут есть
    среди проверяемых; подсчёт засчитывает только точный ответ — ложное отклонение ловушки и не та резолюция
    не засчитываются. Запрос: правила видео не берутся в карточку без видео, таблица критических брендов —
    всегда, когда проверяется бренд."""
    cards = json.loads((Path(__file__).resolve().parent / "fixtures" / "moderation_cards.json").read_text(encoding="utf-8"))
    assert len(cards) == 20 and sum(1 for c in cards if not c["expect"]["reject"]) == 6
    for c in cards:
        checkable = {a["title"] for a in c["card"]["attributes"] if a["checkable"]}
        assert all(c["expect"]["any_attribute"] or e["attribute"] in checkable for e in c["expect"]["reject"]), c["id"]
    rules = _data()
    rules["sections"] += [
        {"path": [], "title": "Таблица критических брендов", "text": "Samsung Самсунг Philips Филипс"},
        {"path": [], "title": "На видео есть рекламная информация", "text": "контакты телефоны ссылки " * 40}]
    data = tmp_path / "rules.json"
    data.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")
    script = tmp_path / "score.js"
    script.write_text(chr(10).join([
        "const fs = require('fs');",
        "const ext = " + json.dumps(str(EXT)) + ";",
        "const { score } = require(ext + '/eval_cards.js'); const C = require(ext + '/card.js');",
        "const { RulesBook } = require(ext + '/rules.js');",
        "const cards = JSON.parse(fs.readFileSync(" + json.dumps(str(Path(__file__).resolve().parent / 'fixtures' / 'moderation_cards.json')) + ", 'utf8'));",
        "const good = (c) => ({ list: c.expect.reject.map((e) => ({ attribute: e.attribute, decision: 'отклонить', resolution: e.resolution })) });",
        "const book = new RulesBook(JSON.parse(fs.readFileSync(" + json.dumps(str(data)) + ", 'utf8')));",
        "const phone = cards[4].card;",
        "const ex = book.excerpts(C.cardQuery(phone, null), 24000, C.excerptSkip(phone), C.excerptPin(phone));",
        "console.log(JSON.stringify({",
        "  perfect: cards.filter((c) => score(c, good(c)).ok).length,",
        "  trap: score(cards[14], { list: [{ attribute: 'Общие недочеты', decision: 'отклонить', resolution: 'В карточке есть указание на продажу копии и/или реплики' }] }).ok,",
        "  wrong: score(cards[0], { list: [{ attribute: 'Общие недочеты', decision: 'отклонить', resolution: 'В карточке есть указание на продажу уцененного товара' }] }).ok,",
        "  table: ex.includes('### Таблица критических брендов'), video: ex.includes('### На видео есть рекламная информация'),",
        "  contacts: C.cardQuery(phone, null).includes('контакты соц сетей') }));",
    ]), encoding="utf-8")
    out = json.loads(subprocess.run(["node", str(script)], capture_output=True, text=True, encoding="utf-8",
                                    check=True).stdout)
    assert out == {"perfect": 20, "trap": False, "wrong": False, "table": True, "video": False, "contacts": True}


@pytest.mark.skipif(shutil.which("node") is None, reason="нет Node.js")
def test_script_checks_and_fixes_the_model_answer(tmp_path):
    """Скрипт до модели находит точные нарушения (контакты, ключевые слова, маркетплейс, Meta, «18+» у книги,
    однозначно запрещённые товары) и ничего не находит в ловушках; после модели — переносит резолюцию на свой
    атрибут, снимает «ключевые слова» без признаков, ставит «смотрите сами», если подходит исключение раздела,
    и добавляет пропущенные точные находки. Ответы модели — из настоящих прогонов, где она ошиблась."""
    fixtures = Path(__file__).resolve().parent / "fixtures"
    rules = _data()
    rules["sections"] += [
        {"path": [], "title": "Информация в карточке нарушает принципы честной конкуренции",
         "text": "Применяется к: Атрибут: «Общие недочеты»\nКонтакты, ссылки, акции, маркетплейсы."},
        {"path": [], "title": "В аннотации указаны ключевые слова", "text": "Применяется к: Атрибут: «Аннотация»\nТеги."},
        {"path": [], "title": "«Товар нельзя продавать на Ozon». Электрошокеры",
         "text": "Что нельзя:\nЭлектрошоковые устройства\nИсключение (принимаем):\nМухобойки с электрошоком"}]
    data = tmp_path / "rules.json"
    data.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")
    script = tmp_path / "check.js"
    script.write_text(chr(10).join([
        "const fs = require('fs'); const ext = " + json.dumps(str(EXT)) + ";",
        "const C = require(ext + '/card.js'); const { RulesBook } = require(ext + '/rules.js');",
        "const { score } = require(ext + '/eval_cards.js');",
        "const book = new RulesBook(JSON.parse(fs.readFileSync(" + json.dumps(str(data)) + ", 'utf8')));",
        "const res = C.buildResolutions(book);",
        "const load = (f) => JSON.parse(fs.readFileSync(" + json.dumps(str(fixtures)) + " + '/' + f, 'utf8'));",
        "const all = [...load('moderation_cards.json'), ...load('moderation_cards_2.json').map((c) => ({ ...c, id: c.id + 20 }))];",
        "const byId = (id) => all.find((c) => c.id === id);",
        "const enforced = (c) => C.scanCard(c.card, book).filter((f) => f.enforce).map((f) => f.resolution);",
        "const fin = (c, list) => C.finalize({ list }, c.card, book, res, C.scanCard(c.card, book));",
        "const H = 'Информация в карточке нарушает принципы честной конкуренции';",
        "console.log(JSON.stringify({",
        "  contacts: enforced(byId(5)), keywords: enforced(byId(7)), market: enforced(byId(32)), meta: enforced(byId(11)),",
        "  age: enforced(byId(8)), shocker: enforced(byId(28)), trapsClean: all.filter((c) => !c.expect.reject.length && enforced(c).length).map((c) => c.id),",
        "  hotline: enforced(byId(16)),",
        "  remap: score(byId(5), fin(byId(5), [{ attribute: 'Аннотация', decision: 'отклонить', resolution: 'В аннотации указаны ключевые слова', reason: 'контакты в тексте' }])).ok,",
        "  exception: score(byId(40), fin(byId(40), [{ attribute: 'Общие недочеты', decision: 'отклонить', resolution: 'Товар нельзя продавать на Ozon', reason: 'электрошок', section: '«Товар нельзя продавать на Ozon». Электрошокеры' }])).ok,",
        "  honestNoSigns: fin(byId(15), [{ attribute: 'Общие недочеты', decision: 'отклонить', resolution: H, reason: 'оригинальная продукция' }]).list[0].decision,",
        "  missed: score(byId(1), fin(byId(1), [])).ok }));",
    ]), encoding="utf-8")
    out = json.loads(subprocess.run(["node", str(script)], capture_output=True, text=True, encoding="utf-8",
                                    check=True).stdout)
    honest = "Информация в карточке нарушает принципы честной конкуренции"
    assert out["contacts"] == [honest] and out["market"] == [honest] and out["hotline"] == []
    assert out["keywords"] == ["В аннотации указаны ключевые слова"]
    assert out["meta"] == ["В карточке товара присутствует символика либо упоминания организаций Meta"]
    assert out["age"] == ["В карточке товара не указан признак «18»"]
    assert out["shocker"] == ["Товар нельзя продавать на Ozon"] and out["trapsClean"] == []
    assert out["remap"] and out["exception"] and out["honestNoSigns"] == "смотрите сами" and out["missed"]


@pytest.mark.skipif(shutil.which("node") is None, reason="нет Node.js")
def test_replaced_main_photo_needs_a_new_card(tmp_path):
    """Повторная модерация, главное фото «Изменено» и на нём другой товар: модель пишет «не имеет отношения»,
    а по справочнику это «Для добавления нового товара не была создана новая карточка». Без повторной модерации
    «не имеет отношения» остаётся."""
    def card(changed, badges):
        return {"name": "Рюкзак 20 л", "seller": "Пример", "category": "Рюкзак", "group": "Галантерея", "badges": badges,
                "attributes": [{"title": "Изображение", "status": "Изменено" if changed else "", "value": "",
                                "old": "", "checkable": True, "changed": changed, "active": False, "images": ["a", "b"],
                                "video": False, "highlights": [], "reasons": []}]}
    script = tmp_path / "photo.js"
    script.write_text(chr(10).join([
        "const C = require(" + json.dumps(str(EXT / "card.js")) + ");",
        "const v = () => ({ list: [{ attribute: 'Изображение', decision: 'отклонить', reason: 'перчатки вместо рюкзака',",
        "  resolution: 'Изображение на главном фото не имеет никакого отношения к товару/продавцу' }] });",
        "const a = C.finalize(v(), " + json.dumps(card(True, ["Повторная модерация"]), ensure_ascii=False) + ", null, new Map(), []);",
        "const b = C.finalize(v(), " + json.dumps(card(False, []), ensure_ascii=False) + ", null, new Map(), []);",
        "console.log(JSON.stringify([a.list[0].resolution, b.list[0].resolution]));",
    ]), encoding="utf-8")
    out = json.loads(subprocess.run(["node", str(script)], capture_output=True, text=True, encoding="utf-8",
                                    check=True).stdout)
    assert out == ["Для добавления нового товара не была создана новая карточка",
                   "Изображение на главном фото не имеет никакого отношения к товару/продавцу"]


@pytest.mark.skipif(shutil.which("node") is None, reason="нет Node.js")
def test_placeholder_photo_and_instagram_get_their_own_resolutions(tmp_path):
    """Ошибки Gemini на фото-эталоне: заглушку «Нет фото» модель отклоняет как «не создана новая карточка» (это только
    при повторной модерации с заменённым фото) — скрипт переносит в «противоречит друг другу» у «Общих недочетов»;
    «Мы в Instagram» без контактов — не «честная конкуренция», а упоминание организаций Meta; с телефоном —
    честная конкуренция остаётся."""
    def attr(title, images=()):
        return {"title": title, "status": "", "value": "", "old": "", "checkable": True, "changed": False,
                "active": False, "images": list(images), "video": False, "highlights": [], "reasons": []}
    card = {"name": "Рюкзак 20 л", "seller": "Пример", "category": "Рюкзак", "group": "Галантерея", "badges": [],
            "attributes": [attr("Изображение", ["a"]), attr("Общие недочеты")]}
    H = "Информация в карточке нарушает принципы честной конкуренции"
    script = tmp_path / "photo.js"
    script.write_text(chr(10).join([
        "const C = require(" + json.dumps(str(EXT / "card.js")) + ");",
        "const card = " + json.dumps(card, ensure_ascii=False) + ";",
        "const run = (v) => C.finalize({ list: [v] }, card, null, new Map(), []).list",
        "  .filter((x) => x.decision === 'отклонить').map((x) => x.attribute + ': ' + x.resolution);",
        "console.log(JSON.stringify({",
        "  stub: run({ attribute: 'Изображение', decision: 'отклонить', reason: 'ФОТО 1 — заглушка «НЕТ ФОТО»',",
        "              resolution: 'Для добавления нового товара не была создана новая карточка' }),",
        "  insta: run({ attribute: 'Общие недочеты', decision: 'отклонить', reason: 'ФОТО 2: баннер «Мы в Instagram!»',",
        "               resolution: " + json.dumps(H, ensure_ascii=False) + " }),",
        "  phone: run({ attribute: 'Общие недочеты', decision: 'отклонить', reason: 'ФОТО 2: Instagram и телефон +7 900',",
        "               resolution: " + json.dumps(H, ensure_ascii=False) + " }) }));",
    ]), encoding="utf-8")
    out = json.loads(subprocess.run(["node", str(script)], capture_output=True, text=True, encoding="utf-8",
                                    check=True).stdout)
    assert out["stub"] == ["Общие недочеты: Информация в карточке товара противоречит друг другу"]
    assert out["insta"] == ["Общие недочеты: В карточке товара присутствует символика либо упоминания организаций Meta"]
    assert out["phone"] == ["Общие недочеты: " + H]


@pytest.mark.skipif(shutil.which("node") is None, reason="нет Node.js")
def test_photo_inventory_becomes_exact_findings(tmp_path):
    """Модель сначала описывает каждое фото (надписи дословно, что видно), скрипт решает по описи: QR, акция, мат,
    Instagram, маркетплейс, заглушка, курение на картине. Ловушки молчат: отрицания в описи («сигарет нет»), подарок,
    водяной знак магазина, автомат (не «мат»), «Курить запрещено», старое фото атрибута «Изменено», книга."""
    card = {"name": "Рюкзак", "category": "Рюкзак", "group": "Галантерея", "badges": [], "attributes": [
        {"title": t, "checkable": True, "images": ["a"]} for t in ("Изображение", "Изображения", "Общие недочеты")]}
    cases = {
        "qr": [2, "Сканируй QR", "рюкзак; QR-код в углу"], "sale": [2, "СКИДКА 50%", "рюкзак"],
        "swear": [2, "Х*Й ПРОЙДЁШЬ", "баннер"], "insta": [2, "Мы в Instagram!", "рюкзак"],
        "wb": [2, "", "логотип Wildberries"], "stub": [1, "НЕТ ФОТО", "серый фон"],
        "smoke": [1, "", "картина: мужчина курит сигарету"],
        "neg": [1, "", "рюкзак; QR-кода нет; сигарет и алкоголя нет"], "gift": [2, "Маска для лица — в подарок!", "набор"],
        "mark": [1, "RYUKZAKI SHOP", "водяной знак магазина"], "gun": [2, "", "человек держит автомат"],
        "sign": [2, "Курить запрещено", "табличка с перечёркнутой сигаретой"], "size": [2, "Объём 20 л, 45×30 см", "рюкзак"],
        "cjk": [1, "防水背包", "рюкзак; крупные иероглифы посередине"], "cjk_small": [1, "防水", "рюкзак; мелкие иероглифы в углу"],
        "beer": [2, "Идеален для вечера с пивом", "инфографика"], "orig": [2, "100% ОРИГИНАЛ", "печать"],
        "design": [2, "Оригинальный дизайн", "рюкзак"],
        "label": [2, "Изготовитель: Пример Co., Ltd. 4 607 012 345 678", "этикетка со штрихкодом и QR-кодом"],
    }
    script = tmp_path / "inv.js"
    script.write_text(chr(10).join([
        "const C = require(" + json.dumps(str(EXT / "card.js")) + ");",
        "const card = " + json.dumps(card, ensure_ascii=False) + ";",
        "const cases = " + json.dumps(cases, ensure_ascii=False) + ";",
        "const L = ['«Изображение»', '«Изображения»'];",
        "const out = {};",
        "for (const [k, [n, text, seen]] of Object.entries(cases)) out[k] = C.photoFacts([{ n, text, seen }], L, card).map((f) => f.attribute + ': ' + f.resolution);",
        "out.labelEnforced = C.photoFacts([{ n: 2, text: cases.label[1], seen: cases.label[2] }], L, card).filter((f) => f.enforce).length;",
        "out.near = C.finalize({ list: [{ attribute: 'Общие недочеты', decision: 'отклонить', resolution: 'Информация в карточке товара нарушает принципы честной конкуренции', reason: 'телефон' }], photos: [] }, card, null, new Map(), [], L).list[0].resolution;",
        # «почти JSON» от модели: ключи без кавычек, запятая перед }, кавычки внутри строки
        "const q = String.fromCharCode(34);",
        "out.loose1 = (C.parseVerdicts('{' + q + 'photos' + q + ': [{n: 1, related: ' + q + 'нет' + q + ',}], ' + q + 'attributes' + q + ': [{name: ' + q + 'Бренд' + q + ', decision: ' + q + 'принять' + q + '}]}') || {}).photos;",
        "out.loose2 = (C.parseVerdicts(['{', '  ' + q + 'attributes' + q + ': [', '    {', '      ' + q + 'name' + q + ': ' + q + 'Общие недочеты' + q + ',', '      ' + q + 'reason' + q + ': ' + q + 'Пишите в ' + q + 'WhatsApp' + q + q, '    }', '  ]', '}'].join(String.fromCharCode(10))) || { list: [] }).list.map((x) => x.reason);",
        # реклама товара того же продавца того же типа — подсказка; чужой товар — отклонение
        "const flag = { ...card, name: 'Флаг БПЛА 90х135' };",
        "out.sellerAd = C.photoFacts([{ n: 2, text: 'Закажите флаг на капот, арт 3720452127', seen: 'реклама флага на капот', related: 'нет' }], L, flag).map((f) => f.enforce);",
        "out.foreign = C.photoFacts([{ n: 2, text: 'Начните игру', seen: 'игровой компьютер', related: 'нет' }], L, flag).map((f) => f.enforce);",
        "out.old = C.photoFacts([{ n: 2, text: 'СКИДКА 50%', seen: '' }], ['«Изображение» (новое)', '«Изображение» (старое)'], card).length;",
        "out.book = C.photoFacts([{ n: 1, text: '', seen: 'на обложке человек курит' }], L, { ...card, category: 'Книга' }).length;",
        "const v = C.parseVerdicts(JSON.stringify({ photos: [{ n: 2, text: 'СКИДКА 50%', seen: 'рюкзак' }], attributes: [] }));",
        "out.final = C.finalize(v, card, null, new Map(), [], L).list.map((x) => x.attribute + ': ' + x.decision);",
        # противоречие по доп. фото не считается; по главному — да; «не имеет отношения» за маркетплейс — честная конкуренция
        "const K = 'Информация в карточке товара противоречит друг другу';",
        "const fin = (list) => C.finalize({ list, photos: [] }, card, null, new Map(), [], L).list;",
        "out.contra = fin([{ attribute: 'Общие недочеты', decision: 'отклонить', resolution: K, reason: 'в названии 16 ГБ, а на фото 2 — 32 ГБ' }])[0].decision;",
        "out.contraMain = fin([{ attribute: 'Общие недочеты', decision: 'отклонить', resolution: K, reason: 'на главном фото перчатки, а в названии рюкзак' }])[0].decision;",
        "out.market = fin([{ attribute: 'Изображения', decision: 'отклонить', resolution: 'Изображение на дополнительном фото не имеет никакого отношения к товару/продавцу', reason: 'на фото 2 «Есть на Яндекс Маркете»' }]).filter((x) => x.decision === 'отклонить').map((x) => x.attribute + ': ' + x.resolution);",
        "console.log(JSON.stringify(out));",
    ]), encoding="utf-8")
    out = json.loads(subprocess.run(["node", str(script)], capture_output=True, text=True, encoding="utf-8",
                                    check=True).stdout)
    honest = "Общие недочеты: Информация в карточке нарушает принципы честной конкуренции"
    assert out["qr"] == [honest] and out["sale"] == [honest] and out["wb"] == [honest]
    assert out["swear"] == ["Изображения: На дополнительном фото есть нецензурная лексика без указания признака «18»"]
    assert out["insta"] == ["Общие недочеты: В карточке товара присутствует символика либо упоминания организаций Meta"]
    assert out["stub"] == ["Общие недочеты: Информация в карточке товара противоречит друг другу"]
    assert out["smoke"] == ["Изображение: На главном фото изображена алкогольная или табачная продукция"]
    assert out["cjk"] == ["Изображение: На главном фото товара есть иероглифы, занимающие значительную часть изображения"]
    assert out["beer"] == ["Изображения: На дополнительном фото изображена алкогольная или табачная продукция"]
    assert out["orig"] == [honest]
    assert all(out[k] == [] for k in ("neg", "gift", "mark", "gun", "sign", "size", "cjk_small", "design"))
    assert out["contra"] == "принять" and out["contraMain"] == "отклонить" and out["market"] == [honest]
    assert out["label"] == [honest] and out["labelEnforced"] == 0      # QR на этикетке — подсказка, не отклонение
    assert out["near"] == "Информация в карточке нарушает принципы честной конкуренции"
    assert out["loose1"][0]["related"] == "нет" and out["loose2"] == ['Пишите в "WhatsApp"']
    assert out["sellerAd"] == [False] and out["foreign"] == [True]
    assert out["old"] == 0 and out["book"] == 0
    assert out["final"] == ["Общие недочеты: отклонить"]


def test_overloaded_gemini_falls_back_to_spare_model():
    """503 «high demand» у Gemini: панель повторяет запрос через 5 и 10 с, перегрузка держится — спрашивает запасную
    модель (по умолчанию модель — gemini-3.5-flash-lite, запасная — gemini-3.1-flash-lite) и показывает её ответ."""
    local = {"rules": _data(), "provider": "gemini", "key": "main-key-not-real", "auto": True, "photos": "none"}
    card = {"name": "Тестовая кружка", "seller": "Пример", "category": "Кружка", "group": "Посуда", "badges": [],
            "attributes": [_attr("Бренд", "Нет бренда")]}
    session = {"task:1": {"type": "task", "tabId": 1, "key": "card-8", "title": card["name"], "card": card,
                          "url": "https://moderation.ozon.ru/", "text": "", "videos": 0}}
    models: list[str] = []
    answer = {"attributes": [{"name": "Бренд", "decision": "принять", "resolution": "", "reason": "", "section": ""}],
              "summary": "Всё принять"}

    async def scenario():
        async with async_playwright() as p:
            browser = await p.chromium.launch(**launch_options())
            page = await browser.new_page()
            await page.add_init_script(CHROME_STUB % {"access": "true", "local": json.dumps(local, ensure_ascii=False),
                                                      "session": json.dumps(session, ensure_ascii=False)})
            cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}

            async def model(route):
                if route.request.method == "OPTIONS":
                    await route.fulfill(status=204, headers=cors)
                    return
                name = json.loads(route.request.post_data)["model"]
                models.append(name)
                if name == "gemini-3.5-flash-lite":
                    await route.fulfill(status=503, headers=cors, content_type="application/json",
                                        body='{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}')
                    return
                await route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps({
                    "choices": [{"message": {"content": json.dumps(answer, ensure_ascii=False)}}]}, ensure_ascii=False))

            await page.route("https://generativelanguage.googleapis.com/**", model)
            await page.goto((EXT / "sidepanel.html").as_uri())
            await page.wait_for_function("document.querySelectorAll('.verdict').length === 1", timeout=40000)
            meta = await page.inner_text("#answer-meta")
            await browser.close()
            return meta

    meta = run(scenario())
    assert models == ["gemini-3.5-flash-lite"] * 3 + ["gemini-3.1-flash-lite"]
    assert "gemini-3.1-flash-lite" in meta


def test_spare_gemini_key_takes_over_on_rate_limit():
    """Бесплатный Gemini: основной ключ упёрся в лимит (429) — панель сразу повторяет запрос с запасным ключом
    (другой проект Google) и показывает ответ; фото берутся в размере из настройки (wc700)."""
    local = {"rules": _data(), "provider": "gemini", "key": "main-key-not-real", "key2": "spare-key-not-real",
             "auto": True, "photoSize": 700}
    card = {"name": "Тестовая кружка", "seller": "Пример", "category": "Кружка", "group": "Посуда", "badges": [],
            "attributes": [_attr("Бренд", "Нет бренда"),
                           _attr("Изображение", images=["https://ir-20.ozone.ru/s3/multimedia-1-a/1000000001.jpg"])]}
    session = {"task:1": {"type": "task", "tabId": 1, "key": "card-7", "title": card["name"], "card": card,
                          "url": "https://moderation.ozon.ru/", "text": "", "videos": 0}}
    keys: list[str] = []
    photos: list[str] = []
    answer = {"attributes": [{"name": "Бренд", "decision": "принять", "resolution": "", "reason": "", "section": ""},
                             {"name": "Изображение", "decision": "принять", "resolution": "", "reason": "", "section": ""}],
              "summary": "Всё принять"}

    async def scenario():
        async with async_playwright() as p:
            browser = await p.chromium.launch(**launch_options())
            page = await browser.new_page()
            await page.add_init_script(CHROME_STUB % {"access": "true", "local": json.dumps(local, ensure_ascii=False),
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
                key = route.request.headers.get("authorization", "")
                keys.append(key)
                if "main-key" in key:
                    await route.fulfill(status=429, headers=cors, content_type="application/json",
                                        body='{"error":{"code":429,"message":"Resource exhausted"}}')
                    return
                await route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps({
                    "choices": [{"message": {"content": json.dumps(answer, ensure_ascii=False)}}]}, ensure_ascii=False))

            await page.route("https://ir-20.ozone.ru/**", image)
            await page.route("https://generativelanguage.googleapis.com/**", model)
            await page.goto((EXT / "sidepanel.html").as_uri())
            await page.wait_for_function("document.querySelectorAll('.verdict').length === 2")
            await browser.close()

    run(scenario())
    assert keys == ["Bearer main-key-not-real", "Bearer spare-key-not-real"]
    assert photos and all("/wc700/" in u for u in photos)
