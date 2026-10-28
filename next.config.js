/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdf.js has an optional Node-only dependency (`canvas`) that the browser build never uses.
  // Stub it so the client bundle compiles.
  webpack: (config) => {
    config.resolve.alias = { ...(config.resolve.alias || {}), canvas: false }
    return config
  },
}

module.exports = nextConfig
