(() => {
  const languages = ['zh-CN', 'zh-TW', 'en'];
  const valid = value => languages.includes(value);
  let saved;
  try { saved = localStorage.getItem('co2.language'); } catch { /* Storage may be unavailable in private browsers. */ }
  let language = valid(window.co2Language) ? window.co2Language : valid(saved) ? saved : 'zh-CN';
  let messages = window.Co2Messages || {};
  const listeners = new Set();
  const t = (source, values = {}) => (messages[language]?.[source] || source).replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
  function apply(root = document) {
    document.documentElement.lang = language;
    document.documentElement.dataset.language = language;
    for (const node of root.querySelectorAll('[data-i18n]')) {
      const source = node.getAttribute('data-i18n');
      if (source) node.textContent = t(source);
    }
    for (const attribute of ['placeholder', 'aria-label', 'title']) {
      for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
        const source = node.getAttribute(`data-i18n-${attribute}`);
        if (source) node.setAttribute(attribute, t(source));
      }
    }
  }
  function setLanguage(value) {
    if (!valid(value)) return false;
    language = value;
    try { localStorage.setItem('co2.language', value); } catch { /* Native preferences still persist independently. */ }
    apply(); for (const listener of listeners) listener();
    return true;
  }
  const ready = window.Co2Messages ? Promise.resolve() : fetch('/locales.json').then(response => {
    if (!response.ok) throw new Error('Language resources unavailable');
    return response.json();
  }).then(data => { messages = data; apply(); for (const listener of listeners) listener(); }).catch(() => { /* The Simplified Chinese source remains usable. */ });
  window.Co2I18n = { languages, t, apply, setLanguage, get language() { return language; }, onChange: listener => listeners.add(listener), ready };
})();
