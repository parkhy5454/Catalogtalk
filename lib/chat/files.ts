// Private bucket for chat photos and PDFs. Never public: downloads go through /api/chat/file.
export const CHAT_FILE_BUCKET = 'chat-files'

const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/webp': (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  'application/pdf': (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
}

/** True when the first bytes of the file match the declared type (a renamed .exe is refused). */
export async function hasMatchingSignature(file: Blob, type: string): Promise<boolean> {
  const check = SIGNATURES[type]
  if (!check) return false
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  return check(head)
}

/** Files a member can send per hour and total stored bytes per member. */
export const CHAT_FILES_PER_HOUR = 60
export const CHAT_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024 // 1GB per member
