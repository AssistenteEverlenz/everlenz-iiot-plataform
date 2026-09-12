import { NextRequest, NextResponse } from 'next/server';
import { clientAddressHeaders, sessionCookie } from '../../../lib/session';
import { originAllowed } from '../../../lib/origin';

const allowed =
  /^(?:health|overview|tenants|sites(?:\/[0-9a-f-]+\/shifts)?|devices(?:\/[0-9a-f-]+(?:\/(?:tags(?:\/[0-9a-f-]+\/(?:history|hmi-check))?|latest|signals|statistics|mqtt-credential|production-context|production-settings|production-overview|hidden-products|legacy-attempts|legacy-allow|production-config|production-detail|shift-board|shift-reports(?:\/(?:snapshot|recalculate))?))?)?|telemetry|mqtt\/(?:raw|topics)|dashboards(?:\/[0-9a-f-]+(?:\/(?:layout|statistics|counters|widgets(?:\/[0-9a-f-]+(?:\/reset-counter)?)?))?)?|export\/telemetry\.csv|users(?:\/[0-9a-f-]+(?:\/reset-password)?)?|branding(?:\/public)?)$/;

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
          ...clientAddressHeaders(request),
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

export const GET = (request: NextRequest, context: { params: Promise<{ path: string[] }> }) =>
  forward(request, context.params);
export const POST = (request: NextRequest, context: { params: Promise<{ path: string[] }> }) =>
  forward(request, context.params);
export const PATCH = (request: NextRequest, context: { params: Promise<{ path: string[] }> }) =>
  forward(request, context.params);
// Replacing a plant's whole shift calendar (sites/:id/shifts).
export const PUT = (request: NextRequest, context: { params: Promise<{ path: string[] }> }) =>
  forward(request, context.params);
export const DELETE = (request: NextRequest, context: { params: Promise<{ path: string[] }> }) =>
  forward(request, context.params);
