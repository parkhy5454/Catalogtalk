// CatalogTalk offline support for the viewer only.
// - Viewer pages (/b/<slug>): network first, last copy kept for offline.
// - Built JS/CSS (/_next/static): cache first (file names are content hashes).
// - Page images from storage: cache first.
// Dashboard and login pages are never cached.
const VERSION = 'ct-offline-v1'
const SHELL = VERSION + '-shell'
const IMAGES = VERSION + '-images'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ct-offline-') && !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  const sameOrigin = url.origin === self.location.origin

  if (sameOrigin && req.mode === 'navigate' && /^\/b\/[^/]+$/.test(url.pathname)) {
    event.respondWith(networkFirst(req, SHELL))
    return
  }
  if (sameOrigin && url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(req, SHELL))
    return
  }
  if (req.destination === 'image' && url.pathname.includes('/storage/v1/object/public/')) {
    event.respondWith(cacheFirst(req, IMAGES))
  }
})

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const res = await fetch(req)
    if (res.ok) cache.put(req, res.clone())
    return res
  } catch {
    const hit = await cache.match(req)
    if (hit) return hit
    return new Response('이 플립북은 오프라인 상태에서 열 수 없어요. 인터넷에 연결한 뒤 한 번 열어 주세요.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone())
  return res
}
