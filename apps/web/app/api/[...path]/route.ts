import { NextRequest, NextResponse } from 'next/server';
import { sessionCookie } from '../../../lib/session';

const allowed =
  /^(?:health|overview|tenants|sites|devices(?:\/[0-9a-f-]+(?:\/(?:tags|latest|signals|statistics))?)?|telemetry|mqtt\/(?:raw|topics)|dashboards(?:\/[0-9a-f-]+(?:\/(?:layout|widgets(?:\/[0-9a-f-]+)?))?)?|export\/telemetry\.csv|users(?:\/[0-9a-f-]+(?:\/reset-password)?)?|branding(?:\/public)?)$/;

async function forward(request: NextRequest, params: Promise<{ path: string[] }>) {
  const path = (await params).path.join('/');
  if (!allowed.test(path)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (request.method !== 'GET' && !originAllowed(request))
    return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
  const body = request.method === 'GET' ? undefined : await request.text();
  const token = request.cookies.get(sessionCookie)?.value;
  try {
    const result = await fetch(
      `${base}/${path === 'health' ? 'health' : `api/${path}`}${request.nextUrl.search}`,
      {
        method: request.method,
        body,
        headers: {
          ...(body
            ? { 'content-type': request.headers.get('content-type') ?? 'application/json' }
            : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      },
    );
    if (result.status === 204) return new NextResponse(null, { status: 204 });
    const headers: Record<string, string> = {
      'content-type': result.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    };
    const disposition = result.headers.get('content-disposition');
    if (disposition) headers['content-disposition'] = disposition;
    return new NextResponse(await result.arrayBuffer(), { status: result.status, headers });
  } catch {
    return NextResponse.json({ error: 'API indisponível' }, { status: 502 });
  }
}

function originAllowed(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const candidates = [
    request.headers.get('x-forwarded-host'),
    request.headers.get('host'),
    process.env.IIOT_WEB_DOMAIN,
    process.env.SERVICE_FQDN_WEB,
    process.env.SERVICE_URL_WEB,
  ];
  return candidates.some((candidate) =>
    candidate
      ?.split(',')
      .map((value) => externalHost(value))
      .includes(originHost),
  );
}

function externalHost(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  try {
    return new URL(normalized.includes('://') ? normalized : `https://${normalized}`).host;
  } catch {
    return '';
  }
}

export const GET = (request: NextRequest, context: { params: Promise<{ path: string[] }> }) =>
  forward(request, context.params);
export const POST = (request: NextRequest, context: { params: Promise<{ path: string[] }> }) =>
  forward(request, context.params);
export const PATCH = (request: NextRequest, context: { params: Promise<{ path: string[] }> }) =>
  forward(request, context.params);
export const DELETE = (request: NextRequest, context: { params: Promise<{ path: string[] }> }) =>
  forward(request, context.params);
