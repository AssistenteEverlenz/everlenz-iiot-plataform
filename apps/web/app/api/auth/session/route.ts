import { NextRequest, NextResponse } from 'next/server';
import {
  apiUrl,
  clientAddressHeaders,
  persistentSessionCookieOptions,
  sessionCookie,
} from '../../../../lib/session';

export async function GET(request: NextRequest) {
  const token = request.cookies.get(sessionCookie)?.value;
  if (!token) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const result = await fetch(apiUrl('auth/session'), {
    headers: { authorization: `Bearer ${token}`, ...clientAddressHeaders(request) },
    cache: 'no-store',
  });
  const text = await result.text();
  const response = new NextResponse(text, {
    status: result.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  if (result.status === 401 || result.status === 403) response.cookies.delete(sessionCookie);
  // A "Manter conectado" session renews its cookie whenever the platform is opened, so it
  // follows the server-side session that is also pushed forward while in use.
  if (result.ok) {
    try {
      if ((JSON.parse(text) as { persistent?: boolean }).persistent)
        response.cookies.set(sessionCookie, token, persistentSessionCookieOptions);
    } catch {
      // Not JSON: leave the cookie as it is.
    }
  }
  return response;
}
