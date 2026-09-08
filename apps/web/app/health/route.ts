export function GET() {
  return Response.json({ service: 'web', status: 'ok', live: true });
}
