/**
 * ListEarthquakes RPC -- reads seeded earthquake data from Railway seed cache.
 * Upstream USGS and NRCan fetches happen in seed-earthquakes.mjs on Railway.
 *
 * Self-hosted fallback: the seed cache is only populated on Railway. When it
 * is empty (self-hosted sandboxes) the RPC now fetches the USGS realtime feed
 * directly (keyless, world-readable) with an in-memory TTL cache, so the map
 * keeps real earthquake markers instead of none at all.
 */

import type {
  SeismologyServiceHandler,
  ServerContext,
  ListEarthquakesRequest,
  ListEarthquakesResponse,
} from '../../../../src/generated/server/worldmonitor/seismology/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'seismology:earthquakes:v1';

type EarthquakeCache = { earthquakes: ListEarthquakesResponse['earthquakes'] };

/** USGS "all day" summary: every M1+ event in the last 24h (~300 events). */
const USGS_ALL_DAY_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const USGS_TTL_MS = 10 * 60_000;
let usgsCache: { at: number; earthquakes: ListEarthquakesResponse['earthquakes'] } | null = null;

interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null;
    place: string | null;
    time: number | null;
    url: string | null;
    type: string | null;
  };
  geometry: { coordinates: [number, number, number] | null };
}

async function fetchUsgsEarthquakes(): Promise<ListEarthquakesResponse['earthquakes']> {
  if (usgsCache && Date.now() - usgsCache.at < USGS_TTL_MS) return usgsCache.earthquakes;
  const res = await fetch(USGS_ALL_DAY_URL, {
    signal: AbortSignal.timeout(12_000),
    headers: { accept: 'application/geo+json' },
  });
  if (!res.ok) throw new Error(`USGS ${res.status}`);
  const geo = (await res.json()) as { features?: UsgsFeature[] };
  const earthquakes = (geo.features ?? [])
    .filter((f) => typeof f.properties?.mag === 'number' && f.geometry?.coordinates)
    .map((f) => {
      const [lon, lat, depthKm] = f.geometry!.coordinates!;
      return {
        id: String(f.id),
        place: f.properties.place ?? 'Unknown',
        magnitude: f.properties.mag ?? 0,
        depthKm: typeof depthKm === 'number' ? depthKm : 0,
        location: { latitude: lat, longitude: lon },
        occurredAt: f.properties.time ?? Date.now(),
        sourceUrl: f.properties.url ?? 'https://earthquake.usgs.gov/',
        source: 'USGS',
        category: f.properties.type ?? 'earthquake',
      };
    })
    .sort((a, b) => b.occurredAt - a.occurredAt);
  usgsCache = { at: Date.now(), earthquakes };
  return earthquakes;
}

export const listEarthquakes: SeismologyServiceHandler['listEarthquakes'] = async (
  _ctx: ServerContext,
  req: ListEarthquakesRequest,
): Promise<ListEarthquakesResponse> => {
  const pageSize = req.pageSize || 500;
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as EarthquakeCache | null;
    const earthquakes = seedData?.earthquakes || [];
    if (earthquakes.length > 0) {
      return { earthquakes: earthquakes.slice(0, pageSize), pagination: undefined };
    }
  } catch {
    // Seed cache unavailable (self-hosted: no Redis/Railway seeder) — fall through.
  }
  try {
    const earthquakes = await fetchUsgsEarthquakes();
    return { earthquakes: earthquakes.slice(0, pageSize), pagination: undefined };
  } catch (error) {
    console.warn('[seismology] USGS fallback failed:', error);
    return { earthquakes: [], pagination: undefined };
  }
};
