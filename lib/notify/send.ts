import 'server-only'
// Sends emails through Resend's batch endpoint (100 per call).
// `accepted[i]` is true when the chunk containing item i was accepted by Resend.
export async function sendEmails(
  items: { to: string; subject: string; html: string }[]
): Promise<{ ok: number; failed: number; accepted: boolean[] }> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.NOTIFY_FROM_EMAIL
  const accepted: boolean[] = items.map(() => false)
  if (!apiKey || !from || items.length === 0) return { ok: 0, failed: items.length, accepted }
  let ok = 0
  let failed = 0
  for (let i = 0; i < items.length; i += 100) {
    const slice = items.slice(i, i + 100)
    const chunk = slice.map((m) => ({ from, to: [m.to], subject: m.subject, html: m.html }))
    let good = false
    try {
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      })
      good = res.ok
    } catch {
      good = false
    }
    slice.forEach((_, j) => { accepted[i + j] = good })
    if (good) ok += slice.length
    else failed += slice.length
  }
  return { ok, failed, accepted }
}
