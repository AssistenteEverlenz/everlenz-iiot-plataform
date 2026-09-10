import type { NextConfig } from 'next';

// Content-Security-Policy notes:
// - 'unsafe-inline' on script-src is still required: Next injects an inline bootstrap
//   script per page. Removing it needs a per-request nonce emitted from the middleware.
//   Tracked in SECURITY.md item 5b. 'unsafe-eval' is deliberately NOT granted.
// - img-src allows https: so tenant_branding.logo_url can point at a customer CDN.
// - frame-ancestors 'none' blocks clickjacking of the admin screens. If a customer ever
//   needs to embed a dashboard, replace 'none' with that specific origin, never with *.
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  // Two years plus preload: only enable after confirming every subdomain serves HTTPS.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(), camera=(), microphone=(), payment=()' },
];

const config: NextConfig = {
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: process.cwd().replace(/[\\/]apps[\\/]web$/, ''),
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
export default config;
