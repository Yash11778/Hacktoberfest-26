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

/**
 * Raw Overpass JSON for the box, from the first server that answers inside the budget.
 * `headers` lets the server-side caller identify itself, which Overpass asks for and
 * which a browser isn't allowed to do.
 */
export async function fetchOverpass(
  bbox: Bbox,
  { budgetMs, perServerMs, headers = {} }: { budgetMs: number; perServerMs: number; headers?: Record<string, string> },
): Promise<string> {
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
  const budget = AbortSignal.timeout(budgetMs);
  let lastError: unknown;
  for (const url of ENDPOINTS) {
    if (budget.aborted) break;
    try {
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
        signal: AbortSignal.any([budget, AbortSignal.timeout(perServerMs)]),
      });
      const text = await res.text();
      if (!res.ok || !text.startsWith('{')) throw new Error(`${new URL(url).host} answered ${res.status}`);
      return text;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('OpenStreetMap timed out');
}
