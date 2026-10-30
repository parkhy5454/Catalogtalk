// Languages a catalog can be translated into, and the free allowance per account.
// Pure constants: usable on the server and in the browser.
export const TRANSLATE_LANGS = {
  en: { label: 'English', name: 'English' },
  zh: { label: '中文(简体)', name: 'Simplified Chinese' },
  ja: { label: '日本語', name: 'Japanese' },
  vi: { label: 'Tiếng Việt', name: 'Vietnamese' },
} as const

export type TranslateLang = keyof typeof TRANSLATE_LANGS

export function isTranslateLang(v: unknown): v is TranslateLang {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TRANSLATE_LANGS, v)
}

// Placeholder: pages each account may translate for free. Paid credits come with payments.
export const FREE_TRANSLATE_PAGES = 20
