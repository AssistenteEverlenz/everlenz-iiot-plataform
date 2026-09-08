import { NextRequest, NextResponse } from 'next/server';
const allowed =
  /^(health|overview|tenants|sites|devices(?:\/[0-9a-f-]+(?:\/(?:tags|latest))?)?|telemetry|mqtt\/(?:raw|topics))$/;
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const path = (await params).path.join('/');
  if (!allowed.test(path)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
  try {
    const result = await fetch(
      `${base}/${path === 'health' ? 'health' : `api/${path}`}${request.nextUrl.search}`,
      { cache: 'no-store', signal: AbortSignal.timeout(8000) },
    );
    return new NextResponse(await result.text(), {
      status: result.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'API indisponível' }, { status: 502 });
  }
}
