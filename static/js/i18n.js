// Tiny i18n: English source strings, looked up in locales/<lang>.js.
// t('Delete {name}?', { name }) · tn('{n} device', '{n} devices', n)
import tr from './locales/tr.js';

const CATALOGS = { tr };
export const LANGS = [['en', 'English'], ['tr', 'Türkçe']];

function detect() {
  try {
    const saved = localStorage.getItem('oxmgr-lang');
    if (saved && (saved === 'en' || CATALOGS[saved])) return saved;
  } catch (e) { /* storage blocked */ }
  return (navigator.language || 'en').toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

let lang = detect();
document.documentElement.lang = lang;
document.cookie = `oxmgr_lang=${lang}; path=/; SameSite=Lax; max-age=31536000`;

export const getLang = () => lang;
export const locale = () => (lang === 'tr' ? 'tr-TR' : 'en-GB');

export function setLang(l) {
  try { localStorage.setItem('oxmgr-lang', l); } catch (e) { /* storage blocked */ }
  document.cookie = `oxmgr_lang=${l}; path=/; SameSite=Lax; max-age=31536000`;
  location.reload();
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s);

// Marks a string for extraction without translating it (translated later with t(variable))
export const N_ = (s) => s;

export function t(s, vars) {
  const cat = CATALOGS[lang];
  return fill(cat ? (cat[s] ?? s) : s, vars);
}

// Plural: English picks one/other; languages without plural forms (Turkish) translate "other".
export function tn(one, other, n, vars = {}) {
  const v = { n, ...vars };
  if (lang === 'en') return fill(n === 1 ? one : other, v);
  return t(other, v);
}
