import { distance, type LatLng } from './geo';
import type { Place } from './places';

/** Metres per minute at an unhurried walk. */
const WALK = 70;
/** Streets aren't straight lines. */
const DETOUR = 1.3;
/** Minutes spent looking around at each stop. */
const LINGER = 3;
/** Closer than this and the next stop isn't worth a clue. */
const MIN_HOP = 120;

const walkMin = (a: LatLng, b: LatLng) => (distance(a, b) * DETOUR) / WALK;

export function stopsFor(minutes: number): number {
  if (minutes <= 20) return 2;
  if (minutes <= 40) return 3;
  return 4;
}

/** How far out to look for places for a walk of this length. */
export const searchRadius = (minutes: number) => Math.min(2500, (minutes * WALK) / (DETOUR * 2.2));

/**
 * A loop from home through a few varied stops and back, inside the time budget.
 * Plain randomised search: try many greedy loops, keep the best one.
 */
export function planLoop(home: LatLng, places: Place[], minutes: number): Place[] {
  const want = stopsFor(minutes);
  const pool = places.filter((p) => distance(home, p) >= MIN_HOP && walkMin(home, p) <= minutes / 2);
  let best: Place[] = [];
  let bestScore = -Infinity;

  for (let attempt = 0; attempt < 400; attempt++) {
    const route: Place[] = [];
    let at: LatLng = home;
    let used = 0;
    while (route.length < want) {
      const options = pool.filter((p) => {
        if (route.includes(p)) return false;
        if (distance(at, p) < MIN_HOP) return false;
        const cost = walkMin(at, p) + LINGER + walkMin(p, home);
        return used + cost <= minutes;
      });
      if (!options.length) break;
      const pick = weightedPick(options, (p) => {
        let w = p.name ? 3 : 1;
        if (p.facts.length) w += 1;
        if (route.some((r) => r.family === p.family)) w *= 0.2;
        return w;
      });
      used += walkMin(at, pick) + LINGER;
      at = pick;
      route.push(pick);
    }
    const total = used + walkMin(at, home);
    const families = new Set(route.map((r) => r.family)).size;
    // More stops first, then variety, then using the time the walker asked for.
    const score = route.length * 100 + families * 10 - Math.abs(minutes - total) / 2;
    if (score > bestScore) {
      bestScore = score;
      best = route;
    }
  }
  return best;
}

export function loopMinutes(home: LatLng, stops: LatLng[]): number {
  let t = 0;
  let at = home;
  for (const s of stops) {
    t += walkMin(at, s) + LINGER;
    at = s;
  }
  return Math.round(t + walkMin(at, home));
}

function weightedPick<T>(items: T[], weight: (t: T) => number): T {
  const ws = items.map(weight);
  let r = Math.random() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) {
    r -= ws[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
