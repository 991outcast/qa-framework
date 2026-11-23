// Читает задание на странице и отдаёт его панели расширения. Ничего не нажимает, видео не запускает.
// На moderation.ozon.ru карточка читается по атрибутам (шапка, значения, старые значения, фото, подсвеченные
// Ozon слова, открытый список «Причины отклонения»); в окне рич-контента (rich-content.ozon.ru) — его текст и
// фото; на остальных страницах — текст страницы целиком. Подсказка панели — рамка вокруг кнопки ✓/✗ и
// нужной причины отклонения (атрибут data-ai-hint), больше страница не меняется.
(() => {
  const RICH = location.hostname === 'rich-content.ozon.ru';
  let last = '';
  let timer = null;
  let hints = null;            // подсказка панели для текущей карточки
  let hintCard = '';

  const text = (el) => (el ? (el.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '');
  const q = (root, sel) => (root ? root.querySelector(sel) : null);
  const imgs = (root) => [...root.querySelectorAll('img')]
    .map((i) => i.currentSrc || i.src || '')
    .filter((src) => /^https?:\/\/[^/]*ozone\.ru\//.test(src) || /^https?:\/\/[^/]*ozon\.ru\//.test(src));
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'.,:;!?()]/g, ' ')
    .replace(/\s+/g, ' ').trim();

  // текст значения: подсвеченные Ozon слова — блоки внутри слова («авто|мобил|ьных»), их вклеиваем обратно;
  // список причин отклонения и старое значение — отдельно
  function valueText(content) {
    const clone = content.cloneNode(true);
    clone.querySelectorAll('[data-testid="product-attribute-highlight-word"]')
      .forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
    clone.querySelectorAll('[class*="_declinesPick_"], [class*="_textOld_"], button, svg, video')
      .forEach((n) => n.remove());
    clone.querySelectorAll('br').forEach((n) => n.replaceWith(document.createTextNode('\n')));
    clone.querySelectorAll('div, p, li, label, h1, h2, h3, h4, h5, h6')
      .forEach((n) => n.append(document.createTextNode('\n')));
    return clone.textContent.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  }

  function readAttribute(el) {
    const title = text(q(el, '[class*="_topLeft_"]'));
    const status = text(q(el, '[class*="_topRight_"]'));
    const content = q(el, '[class*="_content_"]') || el;
    const reasonsBox = q(el, '[class*="_declinesPick_"]');
    const value = valueText(content);
    const oldBox = q(el, '[class*="_textOld_"]');
    const old = oldBox ? valueText(oldBox) : '';
    return {
      title, status, value: value.slice(0, 6000), old,
      checkable: !/не проверяется/i.test(status),
      changed: /изменено/i.test(status),
      active: el.getAttribute('data-testid') === 'product-attribute-active',
      images: imgs(content),
      video: el.querySelectorAll('video').length > 0 || /видео/i.test(title),
      highlights: [...new Set([...el.querySelectorAll('[data-testid="product-attribute-highlight-word"]')]
        .map((h) => text(h)).filter(Boolean))],
      reasons: reasonsBox ? [...reasonsBox.querySelectorAll('label')].map((l) => text(l)).filter(Boolean) : [],
    };
  }

  function readCard() {
    const root = document.querySelector('[data-testid="moderation-product-card"]');
    if (!root) return null;
    const head = q(root, '[class*="_detailHead_"]');
    const info = text(q(root, '[data-testid="product-category-info"]'));
    return {
      name: text(q(head, '[class*="_name_"]')),
      seller: text(q(head, '[class*="_info_"]')),
      category: (info.match(/Категория:\s*(.+)/) || [])[1] || '',
      group: (info.match(/Группа товаров:\s*(.+)/) || [])[1] || '',
      badges: text(q(head, '[class*="_badges_"]')).split('\n').filter(Boolean),
      attributes: [...root.querySelectorAll('[class*="_attribute_"][class*="_frame_"]')].map(readAttribute)
        .filter((a) => a.title),
    };
  }

  // то, что определяет карточку: смена атрибута, открытые причины и таймер — не новая карточка
  const cardKey = (c) => JSON.stringify([c.name, c.seller, c.attributes.map((a) => [a.title, a.value, a.old, a.images])]);

  function send(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});   // панель закрыта — не страшно
    } catch (e) { /* расширение обновили — старый скрипт на странице больше не работает */ }
  }

  function read() {
    if (!document.body) return;
    if (RICH) {
      const body = text(document.body).slice(0, 8000);
      const key = 'rich|' + body + imgs(document.body).join();
      if (key !== last && (body || imgs(document.body).length)) {
        last = key;
        send({ type: 'rich', text: body, images: imgs(document.body).slice(0, 30) });
      }
      return;
    }
    const card = readCard();
    const videos = document.querySelectorAll('video').length;
    if (card) {
      const key = 'card|' + cardKey(card) + '|' + card.attributes.map((a) => a.reasons.join('/')).join('|');
      if (key !== last) {
        last = key;
        if (hintCard && hintCard !== cardKey(card)) hints = null;    // другая карточка — старая подсказка не нужна
        send({ type: 'task', url: location.href, title: card.name || document.title, card, key: cardKey(card),
               text: text(document.body).slice(0, 20000), videos });
      }
      applyHints();
      return;
    }
    const body = text(document.body).replace(/\n{3,}/g, '\n\n').slice(0, 20000);
    const key = videos + '|' + body;
    if (!body || key === last) return;
    last = key;
    send({ type: 'task', url: location.href, title: document.title, text: body, videos });
  }

  // ---------------- подсказка на карточке: рамки, без кликов
  function ensureStyle() {
    if (document.getElementById('ai-hint-style')) return;
    const style = document.createElement('style');
    style.id = 'ai-hint-style';
    style.textContent = '[data-ai-hint="approve"]{outline:3px solid #1a7f37!important;outline-offset:2px}'
      + '[data-ai-hint="decline"]{outline:3px solid #cf222e!important;outline-offset:2px}'
      + '[data-ai-hint="reason"]{outline:3px solid #cf222e!important;border-radius:6px;background:rgba(207,34,46,.08)!important}';
    document.head.append(style);
  }

  function applyHints() {
    const root = document.querySelector('[data-testid="moderation-product-card"]');
    document.querySelectorAll('[data-ai-hint]').forEach((el) => el.removeAttribute('data-ai-hint'));
    if (!root || !hints) return;
    ensureStyle();
    for (const el of root.querySelectorAll('[class*="_attribute_"][class*="_frame_"]')) {
      const title = norm(text(q(el, '[class*="_topLeft_"]')));
      const hint = hints.find((h) => norm(h.attribute) === title);
      if (!hint) continue;
      const button = q(el, hint.decision === 'отклонить' ? '[class*="_declineButton_"]' : '[class*="_approveButton_"]');
      if (button && (hint.decision === 'принять' || hint.decision === 'отклонить')) {
        button.setAttribute('data-ai-hint', hint.decision === 'отклонить' ? 'decline' : 'approve');
      }
      if (hint.decision !== 'отклонить' || !hint.resolution) continue;
      const want = norm(hint.resolution);
      for (const label of el.querySelectorAll('[class*="_declinesPick_"] label')) {
        const have = norm(text(label));
        if (have && (have === want || have.includes(want) || want.includes(have))) label.setAttribute('data-ai-hint', 'reason');
      }
    }
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'hints') {
        hints = message.hints || null;
        hintCard = message.key || '';
        applyHints();
      }
    });
  } catch (e) { /* не в расширении (тест) */ }

  // задание сменилось или догрузилось — перечитать через четверть секунды после последнего изменения
  const schedule = () => { clearTimeout(timer); timer = setTimeout(read, 250); };
  new MutationObserver((records) => {
    // свои рамки не считаются изменением страницы
    if (records.every((r) => r.type === 'attributes' && r.attributeName === 'data-ai-hint')) return;
    schedule();
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  schedule();
})();
