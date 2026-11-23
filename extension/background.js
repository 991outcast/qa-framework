// Последнее задание каждой вкладки и рич-контент к нему — в памяти сессии браузера: панель, открытая позже,
// сразу их видит. Рич-контент приходит из своего фрейма (rich-content.ozon.ru) и относится к текущей карточке.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || !sender.tab) return;
  const id = sender.tab.id;
  if (message.type === 'task' && sender.frameId === 0) {
    chrome.storage.session.get('task:' + id).then((got) => {
      const before = got['task:' + id];
      const update = { ['task:' + id]: { ...message, tabId: id, at: Date.now() } };
      if (before && before.key !== message.key) chrome.storage.session.remove('rich:' + id);   // другая карточка
      chrome.storage.session.set(update);
    });
  } else if (message.type === 'rich') {
    chrome.storage.session.set({ ['rich:' + id]: { ...message, at: Date.now() } });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(['task:' + tabId, 'rich:' + tabId]));
