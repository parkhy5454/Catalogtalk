// Where catalog files live. Pages and originals of new catalogs sit in a PRIVATE bucket and are
// reached only through short-lived signed URLs; thumbnails stay public because link-preview
// crawlers (KakaoTalk, Facebook) must fetch them without signing in.
export const PUBLIC_BUCKET = 'flipbook-files'
export const PRIVATE_BUCKET = 'flipbook-private'
// A stored reference that points into the private bucket looks like "private:<path>".
// Older catalogs store full public URLs, which keep working as before.
export const PRIVATE_PREFIX = 'private:'
export const SIGNED_PAGE_SECONDS = 60 * 60 // viewer pages: 1 hour
export const SIGNED_ORIGINAL_SECONDS = 60 * 10 // original download: 10 minutes

export function isPrivateRef(ref: string | null | undefined): ref is string {
  return !!ref && ref.startsWith(PRIVATE_PREFIX)
}

export function privatePathOf(ref: string): string {
  return ref.slice(PRIVATE_PREFIX.length)
}
