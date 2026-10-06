import { distance, snappedBbox, type LatLng } from './geo';

export interface Place extends LatLng {
  id: string;
  name?: string;
  /** Plain-English kind, e.g. "temple", "park", "mural". */
  kind: string;
  /** Broad family used to keep a quest varied. */
  family: 'green' | 'sacred' | 'food' | 'history' | 'art' | 'water' | 'culture' | 'play';
  /** Extra OSM facts handed to the model as riddle material. */
  facts: string[];
}

// Public Overpass servers are free and keyless, and regularly overloaded. Try each in turn.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const PER_SERVER_MS = 9000;
/** Total time given to OpenStreetMap before planning with whatever else came back. */
const OSM_BUDGET_MS = 15000;
/** Parks and temples don't move. A week-old map is fine, and it makes repeat quests work offline. */
const CACHE_MS = 7 * 24 * 3600 * 1000;

function query([s, w, n, e]: number[]): string {
  const b = `(${s},${w},${n},${e})`;
  return `[out:json][timeout:25];
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

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const RELIGION: Record<string, string> = {
  hindu: 'temple',
  muslim: 'mosque',
  christian: 'church',
  sikh: 'gurdwara',
  buddhist: 'Buddhist temple',
  jain: 'Jain temple',
  jewish: 'synagogue',
};

function classify(t: Record<string, string>): Pick<Place, 'kind' | 'family'> | null {
  if (t.amenity === 'place_of_worship') return { kind: RELIGION[t.religion] ?? 'place of worship', family: 'sacred' };
  if (t.leisure === 'park') return { kind: 'park', family: 'green' };
  if (t.leisure === 'garden') return { kind: 'garden', family: 'green' };
  if (t.leisure === 'nature_reserve') return { kind: 'nature reserve', family: 'green' };
  if (t.leisure === 'playground') return { kind: 'playground', family: 'play' };
  if (t.natural === 'tree' || t.natural === 'tree_row') return { kind: 'old tree', family: 'green' };
  if (t.natural === 'peak') return { kind: 'hilltop', family: 'green' };
  if (t.natural === 'water' || t.water) return { kind: t.water ?? 'pond', family: 'water' };
  if (t.amenity === 'fountain') return { kind: 'fountain', family: 'water' };
  if (t.historic) return { kind: t.historic === 'yes' ? 'historic site' : `historic ${t.historic.replace(/_/g, ' ')}`, family: 'history' };
  if (t.tourism === 'artwork') return { kind: t.artwork_type === 'mural' ? 'mural' : t.artwork_type ?? 'public artwork', family: 'art' };
  if (t.tourism === 'viewpoint') return { kind: 'viewpoint', family: 'green' };
  if (t.tourism === 'museum' || t.tourism === 'gallery') return { kind: t.tourism, family: 'culture' };
  if (t.tourism === 'attraction') return { kind: 'local landmark', family: 'history' };
  if (t.amenity === 'library') return { kind: 'library', family: 'culture' };
  if (t.amenity === 'marketplace') return { kind: 'market', family: 'food' };
  if (t.amenity === 'community_centre') return { kind: 'community centre', family: 'culture' };
  if (t.amenity === 'cafe') return { kind: 'café', family: 'food' };
  if (t.shop === 'tea') return { kind: 'tea shop', family: 'food' };
  if (t.shop === 'bakery') return { kind: 'bakery', family: 'food' };
  if (t.shop === 'books') return { kind: 'bookshop', family: 'culture' };
  if (t.shop === 'florist') return { kind: 'flower shop', family: 'green' };
  return null;
}

const FACT_KEYS: Record<string, string> = {
  'start_date': 'built',
  'denomination': 'denomination',
  'species': 'species',
  'species:en': 'species',
  'genus': 'genus',
  'cuisine': 'serves',
  'description': 'description',
  'inscription': 'inscription',
  'artist_name': 'artist',
  'material': 'made of',
  'heritage': 'heritage level',
  'opening_hours': 'open',
  'sport': 'sport',
  'name:en': 'English name',
};

function facts(t: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, label] of Object.entries(FACT_KEYS)) {
    if (t[k] && t[k].length < 140) out.push(`${label}: ${t[k]}`);
  }
  return out;
}

/**
 * Everything interesting in the snapped grid squares around `c`, from two free,
 * keyless sources queried in parallel: OpenStreetMap (parks, temples, murals…)
 * and Wikipedia (named landmarks, with a line of description). Either one alone
 * is enough to plan a walk, because public Overpass servers are often overloaded.
 */
export async function fetchPlaces(c: LatLng, radiusM: number): Promise<Place[]> {
  const bbox = snappedBbox(c, radiusM);
  const key = `sq-places-${bbox.join(',')}`;
  const cached = readCache(key);
  if (cached) return cached;

  const [osm, wiki] = await Promise.allSettled([fetchOsm(bbox), fetchWiki(bbox)]);
  if (osm.status === 'rejected') console.warn('OpenStreetMap lookup failed', osm.reason);
  if (wiki.status === 'rejected') console.warn('Wikipedia lookup failed', wiki.reason);
  const places = merge(osm.status === 'fulfilled' ? osm.value : [], wiki.status === 'fulfilled' ? wiki.value : []);

  if (places.length) {
    // A partial answer is only cached briefly, so the next quest retries the missing source.
    writeCache(key, places, osm.status === 'fulfilled' && wiki.status === 'fulfilled');
    return places;
  }
  const stale = readCache(key, Infinity);
  if (stale) return stale;
  throw new Error('The free map servers are busy right now. Give it a minute and try again.');
}

async function fetchOsm(bbox: number[]): Promise<Place[]> {
  const body = 'data=' + encodeURIComponent(query(bbox));
  const budget = AbortSignal.timeout(OSM_BUDGET_MS);
  let lastError: unknown;
  for (const url of ENDPOINTS) {
    if (budget.aborted) break;
    try {
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        signal: AbortSignal.any([budget, AbortSignal.timeout(PER_SERVER_MS)]),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = (await res.json()) as { elements: OsmElement[] };
      return toPlaces(json.elements);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('OpenStreetMap timed out');
}

interface WikiPage {
  pageid: number;
  title: string;
  description?: string;
  extract?: string;
  coordinates?: { lat: number; lon: number }[];
}

/** Articles that are areas, events or institutions you can't (or shouldn't) walk up to. */
const NOT_A_DESTINATION =
  /\b(district|division|suburb|neighbou?rhood|locality|village|town|city|taluka|tehsil|ward|constituency|battle|war|siege|hospital|school|clinic|company|organi[sz]ation|metro station|airport|mall|apartment|housing|hotel|software|bank|gram panchayat)\b|^place$/i;

async function fetchWiki([s, w, n, e]: number[]): Promise<Place[]> {
  // Ask about the centre of the snapped box, so this request carries no more than the map one does.
  const lat = ((s + n) / 2).toFixed(3);
  const lng = ((w + e) / 2).toFixed(3);
  const radius = Math.min(10000, Math.round(distance({ lat: s, lng: w }, { lat: n, lng: e }) / 2));
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&generator=geosearch' +
    `&ggscoord=${lat}%7C${lng}&ggsradius=${radius}&ggslimit=80` +
    '&prop=coordinates%7Cextracts%7Cdescription&exintro=1&explaintext=1&exsentences=2&exlimit=max&colimit=max' +
    '&format=json&formatversion=2&origin=*';
  const res = await fetch(url, { signal: AbortSignal.timeout(PER_SERVER_MS) });
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  const json = (await res.json()) as { query?: { pages: WikiPage[] } };
  const out: Place[] = [];
  for (const p of json.query?.pages ?? []) {
    const c = p.coordinates?.[0];
    if (!c || c.lat < s || c.lat > n || c.lon < w || c.lon > e) continue;
    const desc = p.description ?? '';
    if (!desc) continue;
    const cls = wikiKind(desc);
    // Test only the "what it is" part: "Hindu temple in Mumbai city" is still a temple.
    if (NOT_A_DESTINATION.test(cls.kind)) continue;
    out.push({
      id: `wiki/${p.pageid}`,
      lat: c.lat,
      lng: c.lon,
      name: p.title.replace(/,\s.*$|\s\(.*\)$/, ''),
      ...cls,
      facts: [desc, p.extract?.replace(/\s+/g, ' ').slice(0, 280)].filter(Boolean) as string[],
    });
  }
  return out;
}

function wikiKind(desc: string): Pick<Place, 'kind' | 'family'> {
  const d = desc.toLowerCase();
  // "Hindu cave temple in Pune, Maharashtra" → "Hindu cave temple"
  const kind = desc.split(/\s+(?:in|at|near|of|on)\s+/)[0].replace(/^(a|an|the)\s+/i, '').toLowerCase();
  const family: Place['family'] = /temple|mosque|church|gurdwara|dargah|shrine|cathedral|basilica|math\b/.test(d)
    ? 'sacred'
    : /park|garden|lake|hill|forest|tree|river|reserve|zoo/.test(d)
      ? /lake|river|pond|tank|ghat/.test(d) ? 'water' : 'green'
      : /museum|library|theatre|theater|auditorium|gallery|college|university/.test(d)
        ? 'culture'
        : /statue|sculpture|mural|art/.test(d)
          ? 'art'
          : /market|bazaar|restaurant|café|cafe/.test(d)
            ? 'food'
            : 'history';
  return { kind, family };
}

/** OSM and Wikipedia often describe the same place; keep one, preferring Wikipedia's richer facts. */
function merge(osm: Place[], wiki: Place[]): Place[] {
  const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const kept = osm.filter(
    (o) =>
      !wiki.some(
        (w) => distance(o, w) < 150 && !!o.name && (norm(w.name).includes(norm(o.name)) || norm(o.name).includes(norm(w.name))),
      ),
  );
  return [...kept, ...wiki];
}

function readCache(key: string, maxAge = CACHE_MS): Place[] | null {
  try {
    const hit = JSON.parse(localStorage.getItem(key) ?? 'null') as { at: number; places: Place[] } | null;
    return hit && Date.now() - hit.at < maxAge ? hit.places : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, places: Place[], complete: boolean) {
  try {
    // Backdating a partial result makes it expire in about an hour instead of a week.
    const at = complete ? Date.now() : Date.now() - CACHE_MS + 3600 * 1000;
    localStorage.setItem(key, JSON.stringify({ at, places }));
  } catch {
    /* storage full or blocked: just refetch next time */
  }
}

function toPlaces(elements: OsmElement[]): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    if (t.access === 'private' || t.access === 'no') continue;
    const cls = classify(t);
    if (!cls) continue;
    // An unnamed café or a chain outlet is not a destination.
    if (cls.family === 'food' && (!t.name || t.brand)) continue;
    const key = `${t.name ?? cls.kind}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `${el.type}/${el.id}`, lat, lng, name: t['name:en'] ?? t.name, ...cls, facts: facts(t) });
  }
  return out;
}
