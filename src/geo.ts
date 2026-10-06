export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Straight-line distance in metres. */
export function distance(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const POINTS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compass = (deg: number) => POINTS[Math.round(deg / 45) % 8];

export function roundDistance(m: number): string {
  if (m < 100) return `${Math.round(m / 10) * 10} m`;
  if (m < 1000) return `${Math.round(m / 50) * 50} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/**
 * A bounding box snapped outward to a 0.01° grid (~1.1 km). This is the only
 * thing about your location that ever leaves the phone: the map server learns
 * which grid squares you asked about, never the point you're standing on.
 */
export function snappedBbox(c: LatLng, radiusM: number): [number, number, number, number] {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(rad(c.lat)));
  const g = 0.01;
  const down = (v: number) => +(Math.floor(v / g) * g).toFixed(2);
  const up = (v: number) => +(Math.ceil(v / g) * g).toFixed(2);
  return [down(c.lat - dLat), down(c.lng - dLng), up(c.lat + dLat), up(c.lng + dLng)];
}

export function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This browser has no location access.'));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 30000,
    });
  });
}
