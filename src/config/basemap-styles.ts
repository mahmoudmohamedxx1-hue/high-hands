// maplibre-using parts of basemap.ts.
// Split out so `preferences-content.ts` (which only needs the preference
// getters/setters) does NOT pull maplibre into the main bundle. Only
// imported by `DeckGLMap.ts`, which is itself dynamically imported when
// the map panel mounts — so maplibre + deck.gl now load lazily. PMTiles and
// Protomaps stay behind provider-specific dynamic imports below so CARTO /
// OpenFreeMap users do not download the self-hosted basemap stack.
import maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import {
  R2_BASE,
  hasPMTilesUrl,
  isLightMapTheme,
  asPMTilesTheme,
  FALLBACK_DARK_STYLE,
  FALLBACK_LIGHT_STYLE,
  type PMTilesTheme,
  type MapProvider,
} from '@/config/basemap';

let registered = false;
let registerPromise: Promise<void> | null = null;

export async function registerPMTilesProtocol(): Promise<void> {
  if (registered) return;
  registerPromise ??= (async () => {
    try {
      const { Protocol } = await import('pmtiles');
      if (registered) return;
      const protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
      registered = true;
    } catch (err) {
      registerPromise = null;
      throw err;
    }
  })();
  await registerPromise;
}

export async function buildPMTilesStyle(flavor: PMTilesTheme): Promise<StyleSpecification | null> {
  if (!hasPMTilesUrl) return null;
  const { layers, namedFlavor } = await import('@protomaps/basemaps');
  const spriteName = ['light', 'white'].includes(flavor) ? 'light' : 'dark';
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${spriteName}`,
    sources: {
      basemap: {
        type: 'vector',
        url: `pmtiles://${R2_BASE}`,
        attribution: '<a href="https://protomaps.com">Protomaps</a> | <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: layers('basemap', namedFlavor(flavor), { lang: 'en' }) as StyleSpecification['layers'],
  };
}

const CARTO_DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const CARTO_VOYAGER = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
const CARTO_POSITRON = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

const CARTO_STYLES: Record<string, string> = {
  'dark-matter': CARTO_DARK,
  'voyager': CARTO_VOYAGER,
  'positron': CARTO_POSITRON,
};

/**
 * Real satellite imagery basemap (ESRI World Imagery raster tiles, keyless).
 * Returned as a StyleSpecification OBJECT so DeckGLMap's init branch does
 * not misclassify it as a remote fallback string style. MapLibre's {z}/{y}/{x}
 * tile scheme matches ESRI's path order.
 */
const ESRI_SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery © <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics',
    },
  },
  layers: [
    { id: 'esri-satellite', type: 'raster', source: 'esri' },
  ],
};

/** ESRI World Street Map — urban detail: roads, cities, labels (keyless raster). */
const ESRI_STREETS_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, HERE, Garmin, USGS, NGA',
    },
  },
  layers: [
    { id: 'esri-streets', type: 'raster', source: 'esri' },
  ],
};

/** ESRI World Topo Map — terrain contours, parks, boundaries (keyless raster). */
const ESRI_TOPO_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, USGS, NOAA',
    },
  },
  layers: [
    { id: 'esri-topo', type: 'raster', source: 'esri' },
  ],
};

const ESRI_STYLES: Record<string, StyleSpecification> = {
  satellite: ESRI_SATELLITE_STYLE,
  streets: ESRI_STREETS_STYLE,
  topo: ESRI_TOPO_STYLE,
};

async function tryBuildRegisteredPMTilesStyle(flavor: PMTilesTheme): Promise<StyleSpecification | null> {
  try {
    const style = await buildPMTilesStyle(flavor);
    if (!style) return null;
    await registerPMTilesProtocol();
    return style;
  } catch (err) {
    console.warn('[basemap] PMTiles style unavailable, using fallback:', (err as Error)?.message);
    return null;
  }
}

export async function getStyleForProvider(provider: MapProvider, mapTheme: string): Promise<StyleSpecification | string> {
  const lightFallback = isLightMapTheme(mapTheme);
  switch (provider) {
    case 'esri':
      return ESRI_STYLES[mapTheme] ?? ESRI_SATELLITE_STYLE;
    case 'pmtiles': {
      const style = await tryBuildRegisteredPMTilesStyle(asPMTilesTheme(mapTheme));
      if (style) return style;
      return lightFallback ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE;
    }
    case 'openfreemap':
      return mapTheme === 'positron' ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE;
    case 'carto':
      return CARTO_STYLES[mapTheme] ?? CARTO_DARK;
    default: {
      const pmtiles = await tryBuildRegisteredPMTilesStyle(asPMTilesTheme(mapTheme));
      return pmtiles ?? (lightFallback ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE);
    }
  }
}
