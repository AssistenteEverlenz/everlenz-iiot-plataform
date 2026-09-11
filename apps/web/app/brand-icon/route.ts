import { NextRequest, NextResponse } from 'next/server';

// The browser tab and touch icon follow the white-label logo, so each customer sees their own
// brand. The logo is stored as a data URL; it is decoded and served as a real image, so the
// icon shows on the first paint and on the login page. Without a logo (or with the API down),
// the Everlenz icon is used. Route handlers are not cached by default, so a new logo shows up
// once the browser's short cache (below) expires.
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;

export async function GET(request: NextRequest) {
  const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
  try {
    const result = await fetch(`${base}/api/branding/public`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    const branding = result.ok ? ((await result.json()) as { logo_url?: string | null }) : null;
    const match = DATA_URL.exec(branding?.logo_url ?? '');
    if (match)
      return new NextResponse(Buffer.from(match[2], 'base64'), {
        headers: { 'content-type': match[1], 'cache-control': 'public, max-age=300' },
      });
  } catch {
    // Fall back to the Everlenz icon below.
  }
  return NextResponse.redirect(new URL('/everlenz-icon.png', request.url));
}
