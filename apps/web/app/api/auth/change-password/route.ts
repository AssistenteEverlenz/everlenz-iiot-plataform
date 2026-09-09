import { NextRequest, NextResponse } from 'next/server';
import { apiUrl, sessionCookie, sessionCookieOptions } from '../../../../lib/session';

export async function POST(request: NextRequest) {
  const token = request.cookies.get(sessionCookie)?.value;
  if (!token) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const result = await fetch(apiUrl('auth/change-password'), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: await request.text(),
    cache: 'no-store',
  });
  const body = (await result.json()) as { token?: string; user?: unknown; error?: string };
  if (!result.ok || !body.token)
    return NextResponse.json(
      { error: body.error ?? 'Não foi possível alterar a senha' },
      { status: result.status },
    );
  const response = NextResponse.json({ user: body.user });
  response.cookies.set(sessionCookie, body.token, sessionCookieOptions);
  return response;
}
