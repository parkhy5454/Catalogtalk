/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
    ]
    return [
      { source: '/:path*', headers: security },
      // The service worker must be re-checked on every load so updates reach phones.
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ]
  },
}

module.exports = nextConfig
