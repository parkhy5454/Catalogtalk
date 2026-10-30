/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Turbopack (default in Next 16): same canvas stub as the webpack setting below.
  turbopack: {
    resolveAlias: { canvas: './lib/stubs/empty-canvas.js' },
  },
  // pdf.js has an optional Node-only dependency (`canvas`) that the browser build never uses.
  // Stub it so the client bundle compiles.
  webpack: (config) => {
    config.resolve.alias = { ...(config.resolve.alias || {}), canvas: false }
    return config
  },
  async headers() {
    const security = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      // Catalog pages must not be framed by other sites (clickjacking).
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      // Content Security Policy. Scripts come only from this site and the pdf.js CDN.
      // 'unsafe-inline' scripts are needed by Next.js's inline bootstrap (no nonce yet).
      {
        key: 'Content-Security-Policy',
        value: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://t1.kakaocdn.net",
          "worker-src 'self' blob: https://cdnjs.cloudflare.com",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com data:",
          "img-src 'self' data: blob: https://*.supabase.co",
          "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://cdnjs.cloudflare.com https://*.kakao.com",
          "frame-ancestors 'none'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '),
      },
    ]
    return [
      { source: '/:path*', headers: security },
      // The service worker must be re-checked on every load so updates reach phones.
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ]
  },
}

module.exports = nextConfig
