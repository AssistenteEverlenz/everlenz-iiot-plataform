import { NextRequest, NextResponse } from 'next/server';
import { sessionCookie } from './lib/session';

export function proxy(request: NextRequest) {
  const hasSession = Boolean(request.cookies.get(sessionCookie)?.value);
  if (!hasSession && request.nextUrl.pathname !== '/login') {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  if (hasSession && request.nextUrl.pathname === '/login')
    return NextResponse.redirect(new URL('/', request.url));
  return NextResponse.next();
}

// The tab and touch icons load before any login, including on the login page itself: without
// these exclusions they were redirected to /login and the tab showed no logo.
export const config = {
  matcher: ['/((?!api|health|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png).*)'],
};
