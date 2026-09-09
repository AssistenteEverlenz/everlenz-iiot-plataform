import { NextRequest, NextResponse } from 'next/server';
import { apiUrl, sessionCookie } from '../../../../lib/session';

export async function GET(request: NextRequest) {
  const token = request.cookies.get(sessionCookie)?.value;
  if (!token) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const result = await fetch(apiUrl('auth/session'), {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  const response = new NextResponse(await result.arrayBuffer(), {
    status: result.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  if (result.status === 401 || result.status === 403) response.cookies.delete(sessionCookie);
  return response;
}
