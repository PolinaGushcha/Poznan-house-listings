// Health check for the container and the reverse proxy. Not cached.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', service: 'web' });
}
