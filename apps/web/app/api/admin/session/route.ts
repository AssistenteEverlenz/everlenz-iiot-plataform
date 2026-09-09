import { NextRequest, NextResponse } from 'next/server';
import { adminCookie, adminToken, validAdminToken } from '../../../../lib/admin';

export async function GET(request: NextRequest) {
  return NextResponse.json({
    authenticated: validAdminToken(request.cookies.get(adminCookie)?.value),
  });
}

export async function POST(request: NextRequest) {
  const configured = process.env.IIOT_ADMIN_PASSWORD ?? '';
  const { password } = (await request.json()) as { password?: string };
  if (!configured || password !== configured)
    return NextResponse.json({ error: 'Senha administrativa inválida' }, { status: 401 });
  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(adminCookie, adminToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(adminCookie, '', {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  return response;
}
