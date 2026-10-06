// Shared by the browser (local dev) and the Vercel function in /api (production).

export type Bbox = [south: number, west: number, north: number, east: number];

// Public Overpass servers are free and keyless, and regularly overloaded. Try each in turn.
export const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export function overpassQuery([s, w, n, e]: Bbox): string {
  const b = `(${s},${w},${n},${e})`;
  return `[out:json][timeout:20];
(
  nwr["leisure"~"^(park|garden|nature_reserve|playground)$"]${b};
  nwr["amenity"~"^(place_of_worship|cafe|fountain|library|marketplace|community_centre)$"]${b};
  nwr["historic"]${b};
  nwr["tourism"~"^(artwork|viewpoint|attraction|museum|gallery)$"]${b};
  nwr["natural"="tree"]["denotation"~"^(landmark|natural_monument)$"]${b};
  nwr["natural"~"^(water|peak|tree_row)$"]["name"]${b};
  nwr["water"~"^(lake|pond|river|reservoir)$"]${b};
  nwr["shop"~"^(tea|bakery|books|florist)$"]${b};
);
out center tags 400;`;
}

/** Overpass sometimes answers 200 with no elements and a "remark" saying it gave up. */
function assertComplete(text: string, host: string) {
  const json = JSON.parse(text) as { elements?: unknown[]; remark?: string };
  if (!Array.isArray(json.elements)) throw new Error(`${host} sent no elements`);
  if (json.remark && /error|timed out|timeout|out of memory/i.test(json.remark))
    throw new Error(`${host}: ${json.remark.slice(0, 120)}`);
}

/**
 * Raw Overpass JSON for the box. Servers are asked in turn, `staggerMs` apart, and
 * the first complete answer wins (a hedged request): a slow primary no longer
 * costs the whole budget. `headers` lets the server-side caller identify itself,
 * which Overpass asks for and which a browser isn't allowed to do.
 */
export async function fetchOverpass(
  bbox: Bbox,
  { budgetMs, staggerMs, headers = {} }: { budgetMs: number; staggerMs: number; headers?: Record<string, string> },
): Promise<string> {
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
  const done = new AbortController();
  const signal = AbortSignal.any([done.signal, AbortSignal.timeout(budgetMs)]);

  const attempt = async (url: string, delay: number): Promise<string> => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (signal.aborted) throw new Error('not needed');
    const host = new URL(url).host;
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
      signal,
    });
    const text = await res.text();
    if (!res.ok || !text.startsWith('{')) throw new Error(`${host} answered ${res.status}`);
    assertComplete(text, host);
    return text;
  };

  try {
    return await Promise.any(ENDPOINTS.map((url, i) => attempt(url, i * staggerMs)));
  } catch (e) {
    const reasons = e instanceof AggregateError ? e.errors.map((x) => (x instanceof Error ? x.message : String(x))) : [String(e)];
    throw new Error(`OpenStreetMap unavailable (${reasons.join('; ')})`);
  } finally {
    done.abort(); // cancel the losers
  }
}
