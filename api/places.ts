import { fetchOverpass, type Bbox } from '../src/overpass.js';

// A thin, cached relay to OpenStreetMap. It exists because the public Overpass
// servers reject anonymous browser requests; from here we can identify the app.
// It only ever sees the ~1 km grid box the browser already snapped, and it keeps
// no logs or state of its own.

const GRID = 0.01;
const MAX_SPAN = 0.08; // ~9 km: more than any 60-minute walk needs

const onGrid = (v: number) => Math.abs(v / GRID - Math.round(v / GRID)) < 1e-6;

export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('bbox') ?? '';
  const bbox = raw.split(',').map(Number) as Bbox;
  const [s, w, n, e] = bbox;
  const valid =
    bbox.length === 4 &&
    bbox.every((v) => Number.isFinite(v) && onGrid(v)) &&
    s >= -90 && n <= 90 && w >= -180 && e <= 180 &&
    n > s && e > w && n - s <= MAX_SPAN && e - w <= MAX_SPAN;
  if (!valid) return json({ error: 'bbox must be four 0.01°-grid numbers: s,w,n,e' }, 400);

  try {
    const body = await fetchOverpass(bbox, {
      budgetMs: 25000,
      staggerMs: 3000,
      headers: { 'User-Agent': 'SideQuest/1.0 (+https://github.com/Yash11778/Hacktoberfest-26)' },
    });
    // Parks don't move: let Vercel's CDN answer repeat boxes for a week. An empty
    // box is more likely a hiccup than an empty map, so that only sticks for an hour.
    const empty = body.includes('"elements":[]') || /"elements"\s*:\s*\[\s*\]/.test(body);
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': empty ? 'public, s-maxage=3600' : 'public, s-maxage=604800, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'OpenStreetMap unavailable' }, 502);
  }
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
