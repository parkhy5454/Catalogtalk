// Directory categories. The same names are allowed by the database check (v38). Pure constants.
export const DIRECTORY_CATEGORIES = ['산업용품', '식품', '패션', '전자', '생활', '기타'] as const
export type DirectoryCategory = (typeof DIRECTORY_CATEGORIES)[number]
export const SUMMARY_MAX = 200
