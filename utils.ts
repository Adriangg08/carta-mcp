import * as fs from 'fs';
import OpenAI from 'openai';
import * as path from 'path';
import pdfParse from 'pdf-parse';

// Function to search for restaurants using Google Maps API
export async function searchGooglePlaces(params: { location: string; limit?: number; apiKey: string }): Promise<any[]> {
  const { location, limit = 20, apiKey } = params;

  if (!apiKey) {
    throw new Error('Missing API Key');
  }

  if (!location) {
    throw new Error('Location parameter is required');
  }

  try {
    // Resolve coordinates: if location is lat,lng skip geocoding
    let lat: number; let lng: number;
    const coordMatch = location.trim().match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
      lat = parseFloat(coordMatch[1]);
      lng = parseFloat(coordMatch[2]);
    } else {
      // PASO 1: Geocoding (Location -> Coordinates)
      const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;
      const geocodeResponse = await fetch(geocodeUrl);
      if (!geocodeResponse.ok) {
        throw new Error(`Geocoding API request failed: ${geocodeResponse.statusText}`);
      }
      const geocodeData = await geocodeResponse.json();
      if (geocodeData.status !== 'OK' || !geocodeData.results || geocodeData.results.length === 0) {
        throw new Error(`Could not geocode location: ${location}. Status: ${geocodeData.status}`);
      }
      ({ lat, lng } = geocodeData.results[0].geometry.location);
    }

    // PASO 2: Nearby Search (Coordinates -> Places) with pagination
    const allResults: any[] = [];
    let pageToken: string | undefined;
    do {
      const url = pageToken
        ? `https://maps.googleapis.com/maps/api/place/nearbysearch/json?pagetoken=${pageToken}&key=${apiKey}`
        : `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&rankby=distance&type=restaurant&key=${apiKey}`;
      if (pageToken) await new Promise(res => setTimeout(res, 2000));
      const responsePage = await fetch(url);
      if (!responsePage.ok) {
        throw new Error(`Nearby Search API request failed: ${responsePage.statusText}`);
      }
      const dataPage = await responsePage.json();
      if (dataPage.status !== 'OK' && dataPage.status !== 'ZERO_RESULTS') {
        throw new Error(`Nearby Search failed. Status: ${dataPage.status}`);
      }
      allResults.push(...(dataPage.results || []));
      pageToken = dataPage.next_page_token;
    } while (pageToken && allResults.length < limit);
    // Limitar resultados antes de obtener detalles
    const limitedResults = allResults.slice(0, limit);

    // PASO 3: Place Details (Place ID -> Details)
    const detailedResults: any[] = [];

    for (const place of limitedResults) {
      if (!place.place_id) continue;

      const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_address,website,formatted_phone_number,place_id&key=${apiKey}`;

      try {
        const detailsResponse = await fetch(detailsUrl);

        if (!detailsResponse.ok) {
          continue;
        }

        const detailsData = await detailsResponse.json();

        if (detailsData.status === 'OK' && detailsData.result) {
          const result = detailsData.result;
          detailedResults.push({
            id: result.place_id,
            nombre: result.name,
            direccion: result.formatted_address,
            telefono: result.formatted_phone_number,
            web: result.website,
          });
        }
      } catch (detailsError) {
        // Skip this restaurant if there's an error
      }
    }

    return detailedResults;

  } catch (error: any) {
    throw new Error(error.message || 'Failed to process place search');
  }
}

// Interfaces for PDF parsing
export interface Dish { nombre: string; precio: string; }
// Updated to support optional categorization
export interface Category { nombre: string; platos: Dish[]; }
export interface ParsedMenu { nombre: string; platos?: Dish[]; categorias?: Category[]; }

/**
 * Parse cleaned PDF text lines into menu sections.
 */
export function parsePdfTextLines(lines: string[], defaultTitle?: string): ParsedMenu[] {
  // Temporary internal type where platos is always defined
  type RawMenu = { nombre: string; platos: Dish[] };
  const rawMenus: RawMenu[] = [];
  let current: RawMenu | null = null;
  const priceRe = /^\d+([.,]\d+)?$/;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    // New category header (uppercase)
    if (/^[A-ZÁÉÍÓÚÑ ]{2,}$/.test(L)) {
      current = { nombre: L, platos: [] };
      rawMenus.push(current);
    } else if (current && priceRe.test(L)) {
      // Price line → previous line is dish name
      const nameLine = lines[i - 1] || '';
      current.platos.push({ nombre: nameLine.trim(), precio: L.trim() });
    }
  }
  // Filter categories with at least one dish
  const validCategories = rawMenus.filter(m => m.platos.length > 0);
  // Group into single Carta de Vinos if multiple categories and none include 'menu' or 'carta'
  if (validCategories.length > 1 && validCategories.every(m => !/menu/i.test(m.nombre) && !/carta/i.test(m.nombre))) {
    const categorias: Category[] = validCategories.map(m => ({ nombre: m.nombre, platos: m.platos }));
    // Use provided title or fallback
    return [{ nombre: defaultTitle ?? 'Carta de Vinos', categorias }];
  }
  // Otherwise return each category as separate menu
  return validCategories.map(m => ({ nombre: m.nombre, platos: m.platos }));
}

// --- New: TripAdvisor scraping approach ---
import axios from 'axios';
import { Buffer } from 'buffer';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer';
import { listDomainUrls, scrapeMultiplePages } from './web-scraping';
dotenv.config();

// Configure stealth plugin once

// Advanced scraping helpers: rotate UA and auto-scroll dynamic pages
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.134 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1'
];

async function autoScroll(page: any) {
  await page.evaluate(async () => {
    await new Promise<void>(resolve => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

// Helper: sleep
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: retry logic
async function withRetries<T>(fn: () => Promise<T>, retries: number = 3, delayMs: number = 1000): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

// CAPTCHA solver: convert image to base64 and solve via 2Captcha
async function getBase64FromUrl(imageUrl: string): Promise<string> {
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data, 'binary');
  return buffer.toString('base64');
}

async function solveCaptcha(imageUrl: string): Promise<string> {
  const apiKey = process.env.TWO_CAPTCHA_API_KEY;
  if (!apiKey) throw new Error('Missing 2Captcha API key');
  const base64 = await getBase64FromUrl(imageUrl);

  const form = new URLSearchParams();
  form.append('method', 'base64');
  form.append('key', apiKey);
  form.append('body', base64);
  form.append('json', '1');

  const inRes = await axios.post('https://2captcha.com/in.php', form);
  if (inRes.data.status !== 1) throw new Error(`2Captcha in.php error: ${inRes.data.request}`);
  const requestId = inRes.data.request;

  // poll for result
  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    const res = await axios.get('https://2captcha.com/res.php', {
      params: { key: apiKey, action: 'get', id: requestId, json: 1 }
    });
    if (res.data.status === 1) return res.data.request;
    if (res.data.request !== 'CAPCHA_NOT_READY') throw new Error(`2Captcha solve error: ${res.data.request}`);
  }
  throw new Error('2Captcha solve timeout');
}

async function handleCaptcha(page: any): Promise<void> {
  const captchaImage = await page.$('img[src*=\"captcha\"]');
  if (captchaImage) {
    const src = await captchaImage.evaluate(el => (el as HTMLImageElement).src);
    const solution = await solveCaptcha(src);
    await page.type('input[name=\"captcha\"]', solution);
    await page.click('button[type=\"submit\"]');
    await page.waitForNavigation({ waitUntil: 'networkidle0' });
  }
}

// --- New: Crawl TripAdvisor restaurant URLs ---
/**
 * Crawl TripAdvisor listing pages to collect restaurant URLs and save them.
 */
export async function crawlTripAdvisorUrls(
  citySlugOrUrl: string,
  limit: number = 1000,
  pageLimit: number = 50
): Promise<string[]> {
  const listUrl = citySlugOrUrl.startsWith('http')
    ? citySlugOrUrl
    : `https://www.tripadvisor.es/Restaurants-${citySlugOrUrl}.html`;

  // Paginate listing pages (30 resultados por página)
  const perPage = 30;
  const id = citySlugOrUrl.split('-')[0];
  const cityName = citySlugOrUrl.substring(citySlugOrUrl.indexOf('-') + 1);
  const pagesNeeded = Math.min(pageLimit, Math.ceil(limit / perPage));
  const urlsSet = new Set<string>();
  for (let i = 0; i < pagesNeeded && urlsSet.size < limit; i++) {
    const offset = i * perPage;
    const pageSlug = offset === 0 ? citySlugOrUrl : `${id}-oa${offset}-${cityName}`;
    const pageUrl = `https://www.tripadvisor.es/Restaurants-${pageSlug}.html`;
    console.log(`Fetching page ${i + 1}/${pagesNeeded}: ${pageUrl}`);
    const { filteredUrls } = await listDomainUrls(pageUrl, {
      maxDepth: 1,
      maxUrls: limit,
      filterMode: 'custom',
      customIncludePatterns: ['/Restaurant_Review-']
    });
    filteredUrls.forEach(u => {
      const base = u.split('#')[0];
      // Skip pagination variants (-orXX)
      if (/-Reviews-or\d+-/.test(base)) return;
      urlsSet.add(base);
    });
  }
  const list = Array.from(urlsSet).slice(0, limit);
  const outDir = path.join('cache', 'tripadvisor');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const fileName = citySlugOrUrl.replace(/[^a-z0-9]/gi, '_') + '.json';
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf8');
  console.log(`Saved ${list.length} TripAdvisor URLs to ${filePath}`);
  return list;
}

// --- New: OSM website lookup (free) ---
async function getWebsiteFromOSM(name: string, city: string): Promise<string | undefined> {
  const resp = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { format: 'json', extratags: 1, q: `${name} ${city}`.trim() },
    headers: { 'User-Agent': 'carta-mcp' }
  });
  const items = resp.data as any[];
  for (const i of items) {
    if (i.extratags?.website) return i.extratags.website;
  }
  return undefined;
}

// Replace extractRestaurantWebsites with OSM-based implementation
export async function extractRestaurantWebsites(
  taUrls: string[]
): Promise<RestaurantWebsite[]> {
  const results: RestaurantWebsite[] = [];
  for (const url of taUrls) {
    // parse name and city from TripAdvisor slug
    const slug = url.split('Reviews-')[1]?.split('.html')[0] || '';
    const parts = slug.split('-');
    const city = parts.length > 1 ? parts.pop()! : '';
    const name = parts.join(' ').replace(/_/g, ' ');
    try {
      const site = await getWebsiteFromOSM(name, city);
      results.push({ tripAdvisorUrl: url, website: site, externalUrls: site ? [site] : [] });
    } catch (err) {
      console.error(`OSM lookup failed for ${name} (${city}):`, err);
      results.push({ tripAdvisorUrl: url, website: undefined, externalUrls: [] });
    }
  }
  return results;
}

export interface RestaurantWebsite {
  tripAdvisorUrl: string;
  website?: string;
  externalUrls: string[];
}

// --- New: Fetch all restaurants in an area via Overpass (OSM) ---
export interface OSMRestaurant {
  osmId: number;
  name: string;
  website?: string;
  latitude: number;
  longitude: number;
}

/**
 * Fetch restaurants tagged as amenity=restaurant within a bounding box.
 */
export async function getRestaurantsFromOSMArea(
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number
): Promise<OSMRestaurant[]> {
  // Overpass QL query
  const query = `[out:json][timeout:25];node["amenity"="restaurant"](${minLat},${minLon},${maxLat},${maxLon});out tags center;`;
  const resp = await axios.post(
    'https://overpass-api.de/api/interpreter',
    query,
    { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
  );
  const elems = resp.data.elements as any[];
  return elems.map(e => ({
    osmId: e.id,
    name: e.tags?.name,
    website: e.tags?.website,
    latitude: e.lat,
    longitude: e.lon,
  }));
}

// --- New: Fetch all restaurants in a country via gridded Overpass queries ---
export async function getAllRestaurantsInCountry(
  minLat: number = 36.0,
  minLon: number = -9.3,
  maxLat: number = 43.8,
  maxLon: number = 3.3,
  stepLat: number = 1.0,
  stepLon: number = 1.0
): Promise<any[]> {
  const seen = new Map<number, any>();
  const gridDir = path.join('cache', 'osm', 'grid_details');
  if (!fs.existsSync(gridDir)) fs.mkdirSync(gridDir, { recursive: true });
  const latSteps = Math.ceil((maxLat - minLat) / stepLat);
  const lonSteps = Math.ceil((maxLon - minLon) / stepLon);
  const totalCells = latSteps * lonSteps;
  let cellIndex = 0;
  for (let lat = minLat; lat < maxLat; lat += stepLat) {
    for (let lon = minLon; lon < maxLon; lon += stepLon) {
      cellIndex++;
      const lat2 = Math.min(lat + stepLat, maxLat);
      const lon2 = Math.min(lon + stepLon, maxLon);
      const cellName = `${lat.toFixed(4)}_${lon.toFixed(4)}_${lat2.toFixed(4)}_${lon2.toFixed(4)}`;
      const cellFile = path.join(gridDir, `${cellName}.json`);
      let areaItems: any[];
      if (fs.existsSync(cellFile)) {
        console.log(`Cell ${cellIndex}/${totalCells} cached: ${cellName}`);
        areaItems = JSON.parse(fs.readFileSync(cellFile, 'utf8'));
      } else {
        console.log(`Cell ${cellIndex}/${totalCells} fetching details: [${lat},${lon}] -> [${lat2},${lon2}]`);
        try {
          areaItems = await fetchRestaurantDetailsFromArea(lat, lon, lat2, lon2);
          fs.writeFileSync(cellFile, JSON.stringify(areaItems, null, 2), 'utf8');
          console.log(`Saved ${areaItems.length} elements to ${cellFile}`);
        } catch (err) {
          console.error(`Error fetching cell ${cellName} details:`, err);
          areaItems = [];
        }
      }
      for (const e of areaItems) {
        if (!seen.has(e.id)) seen.set(e.id, e);
      }
      await sleep(1000);
    }
  }
  console.log(`Completed ${totalCells} cells, total elements: ${seen.size}`);
  return Array.from(seen.values());
}

// --- New: Test fetch all restaurant data with tags, center, and metadata ---
/**
 * Fetch raw OSM elements (nodes, ways, relations) with full tags, center coords, and metadata for a bounding box.
 */
export async function fetchRestaurantDetailsFromArea(
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number
): Promise<any[]> {
  // Overpass QL query
  const query = `[out:json][timeout:25];
(
  node["amenity"="restaurant"](${minLat},${minLon},${maxLat},${maxLon});
  way["amenity"="restaurant"](${minLat},${minLon},${maxLat},${maxLon});
  relation["amenity"="restaurant"](${minLat},${minLon},${maxLat},${maxLon});
);
out tags center meta;`;
  const resp = await axios.post(
    'https://overpass-api.de/api/interpreter',
    query,
    { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
  );
  return resp.data.elements;
}

// --- New: Fetch restaurant details inside a polygon ---
/**
 * Fetch raw OSM elements (nodes, ways, relations) with full tags, center coords, and metadata within a polygon.
 * @param coordinates Array of [lat,lon] pairs defining the polygon vertices (in order).
 */
export async function fetchRestaurantDetailsByPolygon(
  coordinates: [number, number][],
  amenities: string[] = ['restaurant']
): Promise<any[]> {
  console.log(`Fetching restaurants within polygon: ${JSON.stringify(coordinates, null, 2)} vertices; amenities: ${amenities.join(',')}`);
  const polyStr = coordinates.map(([lat, lon]) => `${lat} ${lon}`).join(' ');
  const amenityFilter = amenities.length > 1
    ? `["amenity"~"^(${amenities.join('|')})$"]`
    : `["amenity"="${amenities[0]}"]`;
  const query = `[out:json][timeout:900];
nwr${amenityFilter}(poly:"${polyStr}");
out tags center meta;`;
  const resp = await axios.post(
    'https://overpass-api.de/api/interpreter',
    query,
    { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
  );
  return resp.data.elements as any[];
}

// --- New: Fetch restaurants inside a country admin area ---
/**
 * Fetch raw OSM elements (nodes, ways, relations) with full tags, center coords, and metadata within a country's administrative boundary.
 */
export async function fetchRestaurantDetailsInCountry(
  countryName: string,
  amenities: string[] = ['restaurant']
): Promise<any[]> {
  const amenityFilter = amenities.length > 1
    ? `["amenity"~"^(${amenities.join('|')})$"]`
    : `["amenity"="${amenities[0]}"]`;
  const query = `[out:json][timeout:900];
area["name"="${countryName}"]->.searchArea;
(
  node${amenityFilter}(area.searchArea);
  way${amenityFilter}(area.searchArea);
  relation${amenityFilter}(area.searchArea);
);
out tags center meta;`;
  const resp = await axios.post(
    'https://overpass-api.de/api/interpreter',
    query,
    { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
  );
  return resp.data.elements as any[];
}

// --- New: Fetch restaurant details by administrative area name ---
/**
 * Fetch OSM elements (nodes/ways/relations) tagged amenity=restaurant within a named area.
 * Uses Overpass area query chaining.
 * @param areaName Name of the administrative boundary (e.g., "Asturias").
 */
export async function fetchRestaurantDetailsByAreaName(
  areaName: string,
  adminLevel: number = 2,
  amenities: string[] = ['restaurant']
): Promise<any[]> {
  // Step 1: retrieve geojson polygon for area via Nominatim
  const geojson = await getCountryPolygon(areaName);
  // Step 2: extract linear ring coordinates
  const coords = (geojson.type === 'Polygon'
    ? geojson.coordinates[0]
    : geojson.coordinates[0][0]
  );
  // Convert [lon, lat] -> [lat, lon]
  const coordinates = coords.map(([lon, lat]) => [lat, lon] as [number, number]);
  // Step 3: fetch restaurants within polygon
  return fetchRestaurantDetailsByPolygon(coordinates, amenities);
}

export interface GeoJSONPolygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}

export interface GeoJSONMultiPolygon {
  type: 'MultiPolygon';
  coordinates: [number, number][][][];
}

export type GeoJSON = GeoJSONPolygon | GeoJSONMultiPolygon;

// --- Fetch polygon of a country by name using Nominatim ---
/**
 * Retrieve polygon coords for a country's boundary via Nominatim search.php
 */
export async function getCountryPolygon(
  countryName: string
): Promise<GeoJSON> {
  const searchUrl = `https://nominatim.openstreetmap.org/search.php?q=${encodeURIComponent(countryName)}&format=jsonv2`;
  const searchResp = await axios.get(searchUrl, { headers: { 'User-Agent': 'carta-mcp' } });
  const searchData = searchResp.data;
  if (!Array.isArray(searchData) || searchData.length === 0) {
    throw new Error(`No results for country: ${countryName}`);
  }
  const { osm_type, osm_id } = searchData[0];
  // Map osm_type to Nominatim type letter
  const typeLetter = osm_type === 'relation' ? 'R' : osm_type === 'way' ? 'W' : 'N';

  const detailsUrl = `https://nominatim.openstreetmap.org/details.php?osmtype=${typeLetter}&osmid=${osm_id}&format=json&polygon_geojson=1`;
  console.log(`Fetching details for ${countryName} via Nominatim...`);
  console.log(detailsUrl);
  const detailsResp = await axios.get(detailsUrl, { headers: { 'User-Agent': 'carta-mcp' } });
  const geojson = detailsResp.data.geometry;
  if (!geojson) {
    throw new Error(`No polygon found in details for: ${countryName}`);
  }
  // Convert [lon,lat] -> [lat,lon]
  return geojson;
}

// Example usage:
// (async () => {
//   const details = await fetchRestaurantDetailsFromArea(37.0, -9.3, 38.0, -8.3);
//   console.log(JSON.stringify(details, null, 2));
// })();

/**
 * Manually get the OSM area ID for an administrative boundary by name.
 */
// export async function getAreaId(
//   areaName: string,
//   adminLevel: number = 2
// ): Promise<number> {
//   const query = `[out:json][timeout:25];
// area["boundary"="administrative"]["admin_level"="${adminLevel}"]["name"="${areaName}"];
// out ids;`;
//   console.log(`Fetching area ID for ${areaName}...`);
//   console.log(query);
//   const resp = await axios.post(
//     'https://overpass-api.de/api/interpreter',
//     query,
//     { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
//   );
//   const elems = resp.data.elements as any[];
//   if (!elems?.length) {
//     throw new Error(`Area not found: ${areaName}`);
//   }
//   return elems[0].id;
// }

/**
 * Fetch restaurants using an OSM area ID.
 */
export async function fetchRestaurantDetailsByAreaId(
  areaId: number,
  amenities: string[] = ['restaurant']
): Promise<any[]> {
  const amenityFilter = amenities.length > 1
    ? `["amenity"~"^(${amenities.join('|')})$"]`
    : `["amenity"="${amenities[0]}"]`;
  const query = `[out:json][timeout:900];
area(id:${areaId})->.searchArea;
nwr${amenityFilter}(area.searchArea);
out tags center meta;`;
  const resp = await axios.post(
    'https://overpass-api.de/api/interpreter',
    query,
    { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
  );
  return resp.data.elements as any[];
}

// /**
//  * Convenience: fetch restaurants by area name in manual mode (uses getAreaId).
//  */
// export async function fetchRestaurantDetailsByAreaNameManual(
//   areaName: string,
//   adminLevel: number = 2,
//   amenities: string[] = ['restaurant']
// ): Promise<any[]> {
//   const areaId = await getAreaId(areaName, adminLevel);
//   return fetchRestaurantDetailsByAreaId(areaId, amenities);
// }

/**
 * List all administrative areas matching a name (optionally filtering by adminLevel).
 * Returns full elements (id, tags, meta) so you can choose.
 */
export async function getAreaCandidates(
  areaName: string,
  adminLevel?: number
): Promise<any[]> {
  const levelFilter = adminLevel != null ? `["admin_level"="${adminLevel}"]` : '';
  const query = `[out:json][timeout:25];
area["boundary"="administrative"]${levelFilter}["name"="${areaName}"];
out body tags meta;`;
  const resp = await axios.post(
    'https://overpass-api.de/api/interpreter',
    query,
    { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
  );
  const elems = resp.data.elements as any[];
  if (!elems.length) throw new Error(`No areas found for: ${areaName}`);
  return elems;
}

// Parse OSM menus (from scraped_pages.json) and save parsed menus
export async function parseOsmMenus(areaArg: string): Promise<boolean> {
  if (!areaArg) throw new Error('Area argument is required');
  // Paths and settings
  const baseMenusDir = path.join('cache', 'osm', 'manual');
  const areaDir = path.join(baseMenusDir, areaArg);
  const restaurantsPath = path.join(areaDir, `restaurants_${areaArg}.json`);
  const restaurants: any[] = JSON.parse(fs.readFileSync(restaurantsPath, 'utf8'));
  const safeName = areaArg.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const outputPath = path.join(areaDir, `cartas_${safeName}.json`);
  const progressPath = path.join(areaDir, `${safeName}.progress.json`);
  const logPath = path.join(areaDir, `${safeName}.log`);
  const batchSize = parseInt(process.env.MENU_BATCH_SIZE || '10', 10);
  // Initialize empty results, always reprocess all restaurants
  const results: any[] = [];
  const total = restaurants.length;
  console.log(`Total restaurants: ${total}, batchSize: ${batchSize}`);
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] Starting parseOsmMenus: ${total} restaurants, batchSize ${batchSize}\n`);
  // Track batch failures
  const failures: { batchStart: number; batchEnd: number; error: string }[] = [];
  // Batch processing
  for (let i = 0; i < total; i += batchSize) {
    const end = Math.min(i + batchSize, total);
    console.log(`Processing restaurants ${i}-${end - 1}`);
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] Processing restaurants ${i}-${end - 1}\n`);
    const batch = restaurants.slice(i, end);
    try {
      const batchResults = await getRestaurantsInfoFromWebsite(batch, batch.length);
      results.push(...batchResults);
      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf8');
      fs.writeFileSync(progressPath, JSON.stringify({ lastIndex: end - 1 }, null, 2), 'utf8');
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] Completed restaurants ${i}-${end - 1}\n`);
    } catch (e: any) {
      console.error(`Batch ${i}-${end - 1} failed:`, e);
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] Batch ${i}-${end - 1} failed: ${e.stack}\n`);
      failures.push({ batchStart: i, batchEnd: end - 1, error: e.message || e.toString() });
      // Update progress and continue
      fs.writeFileSync(progressPath, JSON.stringify({ lastIndex: end - 1 }, null, 2), 'utf8');
      continue;
    }
  }
  console.log('parseOsmMenus completed.');
  // After all batches, record any failures
  if (failures.length > 0) {
    const failuresPath = path.join(areaDir, `${safeName}.failures.json`);
    fs.writeFileSync(failuresPath, JSON.stringify(failures, null, 2), 'utf8');
    console.warn(`parseOsmMenus completed with ${failures.length} failed batches. See ${failuresPath}`);
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] parseOsmMenus completed with ${failures.length} failures\n`);
  }
  return true;
}


/**
* Convenience: fetch restaurants by area name or ID in manual mode.
* @param areaNameOrId The name of the area to search for or its OSM area ID
* @param adminLevel The admin_level to filter by (default: 2) - only used when areaNameOrId is a string name
* @param amenities Array of amenity types to search for (default: ['restaurant'])
* @param countryContext Optional country or region context to disambiguate (e.g., "Spain" or "Asturias, Spain") - only used when areaNameOrId is a string name
*/
export async function fetchRestaurantDetailsByAreaNameManual(
  areaNameOrId: string | number,
  adminLevel: number = 2,
  amenities: string[] = ['restaurant'],
  countryContext?: string
): Promise<any[]> {
  let areaId: number;

  if (typeof areaNameOrId === 'number') {
    // If an area ID is provided directly as a number, use it
    areaId = areaNameOrId;
    console.log(`Using provided area ID: ${areaId}`);
  } else if (!isNaN(Number(areaNameOrId)) && String(Number(areaNameOrId)) === areaNameOrId) {
    // If it's a string that can be converted to a number (e.g., "3600346397"), treat it as an area ID
    areaId = Number(areaNameOrId);
    console.log(`Using provided area ID (from string): ${areaId}`);
  } else {
    // If it's a string that is not a number, treat it as an area name and get the ID
    areaId = await getAreaId(areaNameOrId, adminLevel, countryContext);
  }

  return fetchRestaurantDetailsByAreaId(areaId, amenities);
}

/**
 * Manually get the OSM area ID for an administrative boundary by name.
 * @param areaName The name of the area to search for
 * @param adminLevel The admin_level to filter by (default: 2)
 * @param countryContext Optional country or region context to disambiguate (e.g., "Spain" or "Asturias, Spain")
 */
export async function getAreaId(
  areaName: string,
  adminLevel: number = 2,
  countryContext?: string
): Promise<number> {
  let query: string;

  if (countryContext) {
    // If country context is provided, use it to narrow down the search
    // First get the area ID for the country/region context
    const contextQuery = `[out:json][timeout:25];
area["boundary"="administrative"]["name"="${countryContext}"];
out ids;`;

    const contextResp = await axios.post(
      'https://overpass-api.de/api/interpreter',
      contextQuery,
      { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
    );

    const contextElems = contextResp.data.elements as any[];
    if (!contextElems?.length) {
      console.warn(`Context area not found: ${countryContext}, falling back to global search`);
    } else {
      const contextAreaId = contextElems[0].id;
      // Use the context area to narrow down the search for the target area
      query = `[out:json][timeout:25];
area(${contextAreaId})->.context;
area["boundary"="administrative"]["admin_level"="${adminLevel}"]["name"="${areaName}"](area.context);
out ids;`;

      console.log(`Fetching area ID for ${areaName} within ${countryContext}...`);
      console.log(query);

      const resp = await axios.post(
        'https://overpass-api.de/api/interpreter',
        query,
        { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
      );

      const elems = resp.data.elements as any[];
      if (elems?.length) {
        return elems[0].id;
      }

      console.warn(`Area not found within context, falling back to global search`);
    }
  }

  // Default query without context or fallback if context search fails
  query = `[out:json][timeout:25];
area["boundary"="administrative"]["admin_level"="${adminLevel}"]["name"="${areaName}"];
out ids;`;

  console.log(`Fetching area ID for ${areaName}...`);
  console.log(query);

  const resp = await axios.post(
    'https://overpass-api.de/api/interpreter',
    query,
    { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
  );

  const elems = resp.data.elements as any[];
  if (!elems?.length) {
    throw new Error(`Area not found: ${areaName}`);
  }

  return elems[0].id;
}

// Helper: screenshot PDF pages and return image buffers
export async function screenshotPdfPages(url: string): Promise<Buffer[]> {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });
  const img = await page.screenshot({ fullPage: true });
  const screenshot = Buffer.from(img as Uint8Array);
  await browser.close();
  return [screenshot];
}

// Deduplicate URLs by language-agnostic path, preferring '/es' versions
export function dedupeLanguageUrls(urls: string[]): string[] {
  const map = new Map<string, string>();
  for (const u of urls) {
    try {
      const segments = new URL(u).pathname.split('/').filter(Boolean);
      const lang = segments[0] && segments[0].length === 2 ? segments[0] : null;
      const key = lang ? segments.slice(1).join('/') : segments.join('/');
      if (!map.has(key) || lang === 'es') {
        map.set(key, u);
      }
    } catch {
      // ignore invalid URLs
    }
  }
  return Array.from(map.values());
}

import { JSDOM } from 'jsdom';

// Función para limpiar el HTML eliminando elementos no deseados como CSS y scripts
export function cleanHtml(html: string): string {
  // Eliminar bloques <style> y su contenido
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  // Eliminar bloques <script> y su contenido
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  // Eliminar comentarios HTML
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // Eliminar enlaces a hojas de estilo externas
  html = html.replace(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi, '');
  // Eliminar atributos css (ej. shortcodes VC)
  html = html.replace(/\s+css\s*=\s*(['"])[\s\S]*?\1/gi, '');
  // Eliminar atributos style inline
  html = html.replace(/\s+style\s*=\s*(['"])[\s\S]*?\1/gi, '');
  return html;
}

export async function crawlRestaurant(r: any): Promise<any> {
  const urlsToScrape: string[] = [];
  let resources: string[] = [];
  let website = r.web || r.tags.website;

  let possibleMail: string[] = [];
  let possiblePhone: string[] = [];

  if (website) {
    if (!website.startsWith('http')) {
      website = `https://${website}`;
    }
    console.log(`Crawling ${website}...`);

    try {
      const data = await listDomainUrls(website, {
        filterMode: 'menu',
        includeExternalLinks: true,
        adaptiveSearch: true,
        maxDepth: process.env.TEST_MODE ? 1 : 4,
        maxUrls: process.env.TEST_MODE ? 10 : 50
      });
      const allDataUrls = [...(data.urls || []), ...(data.externalUrls || [])];
      const resourcePatterns = /\.(jpe?g|png|gif|svg|webp|ico|pdf)$/i;
      resources.push(...Array.from(new Set(allDataUrls.filter(u => resourcePatterns.test(u)))));
      console.log(`listDomainUrls for ${r.name} (${website}):`);
      console.log(`  filteredUrls: ${data.filteredUrls?.length}`, data.filteredUrls);
      console.log(`  externalUrls: ${data.externalUrls?.length}`, data.externalUrls);
      let urls = [...(data.filteredUrls || [])];
      if (data.externalUrls) {
        const extra = data.externalUrls.filter(u => {
          const low = u.toLowerCase();
          return low.includes('carta') || low.includes('@');
        });
        urls.push(...extra);
      }
      urls = dedupeLanguageUrls(urls);
      urlsToScrape.push(...urls);
    } catch (err: any) {
      console.error(`Error crawling ${website}: ${err.message}`);
    }
  }
  // Extract images from each scraped page (e.g. menu pages)
  for (const pageUrl of urlsToScrape) {
    try {
      const resp = await fetch(pageUrl);
      if (resp.ok) {
        const html = await resp.text();
        const cleaned = cleanHtml(html);
        const dom = new JSDOM(cleaned);
        const candidates = new Set<string>();
        // gather from <img> attributes and srcset
        dom.window.document.querySelectorAll('img').forEach(img => {
          ['src','data-src','data-original','data-lazy-src'].forEach(attr => {
            const val = img.getAttribute(attr);
            if (val) {
              try { candidates.add(new URL(val, pageUrl).toString()); } catch {}
            }
          });
          const srcset = img.getAttribute('srcset');
          if (srcset) {
            srcset.split(',').map(p => p.trim().split(' ')[0]).forEach(urlStr => {
              try { candidates.add(new URL(urlStr, pageUrl).toString()); } catch {}
            });
          }
        });
        // gather direct links to image files
        dom.window.document.querySelectorAll('a[href]').forEach(a => {
          const href = a.getAttribute('href');
          if (href && /\.(jpe?g|png|gif|svg|webp|ico)$/i.test(href)) {
            try { candidates.add(new URL(href, pageUrl).toString()); } catch {}
          }
        });
        for (const u of candidates) resources.push(u);
      }
    } catch (err: any) {
      console.warn(`Error extracting images from ${pageUrl}:`, err.message || err);
    }
  }
  // Filter resources to only those whose filename contains 'carta' or 'menu'
  resources = resources.filter(u => {
    try {
      const filename = new URL(u).pathname.split('/').pop() || '';
      return /(carta|menu)/i.test(filename);
    } catch {
      return false;
    }
  });
  resources = Array.from(new Set(resources));
  possibleMail = Array.from(new Set(possibleMail));
  possiblePhone = Array.from(new Set(possiblePhone));
  return { ...r, urlsToScrape, resources, possibleMail, possiblePhone };
}

export async function getRestaurantsInfoFromWebsite(restaurants: any[], MAX_CONCURRENCY: number) {

  console.log(`Found ${restaurants.length} restaurants`);

  const startTime = Date.now();

  const cacheDir = 'cache';
  const outputCacheDir = path.join(cacheDir, 'results');
  if (!fs.existsSync(outputCacheDir)) fs.mkdirSync(outputCacheDir);

  let results: any[] = [];

  if (MAX_CONCURRENCY === -1) {
    MAX_CONCURRENCY = restaurants.length;
  }

  console.log(`Processing restaurants in batches of ${MAX_CONCURRENCY}...`);
  console.log(``);

  for (let i = 0; i < restaurants.length; i += MAX_CONCURRENCY) {
    const batch = restaurants.slice(i, i + MAX_CONCURRENCY);
    console.log(`Processing batch ${batch.length}...`);
    const batchResults = await Promise.all(batch.map(async r => await crawlRestaurant(r)));
    results.push(...batchResults);
  }

  // After crawling, scrape pages and parse menus via OpenAI
  console.log("Scraping pages and parsing menus via OpenAI...");
  const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-nano";
  const visionModel = process.env.OPENAI_IMAGE_MODEL || "gpt-4o-mini";
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const ENABLE_IMAGE_PROCESSING = process.env.ENABLE_IMAGE_PROCESSING === 'true';
  const ENABLE_PDF_SCREENSHOT = process.env.ENABLE_PDF_SCREENSHOT === 'true';
  const ENABLE_PDF_TEXT = process.env.ENABLE_PDF_TEXT === 'true';
  const ENABLE_OPENAI_PROCESSING = process.env.ENABLE_OPENAI_PROCESSING === 'true';

  // Conditional OpenAI processing
  if (!ENABLE_OPENAI_PROCESSING) {
    console.log("Skipping OpenAI processing (ENABLE_OPENAI_PROCESSING=false).");
    for (const r of results) {
      r.cartas = null;
      r.menus = null;
    }
  } else {
    for (const r of results) {
      if (!r.urlsToScrape || r.urlsToScrape.length === 0) {
        r.cartas = null;
        r.menus = null;
        continue;
      }
      // Scrape and parse via OpenAI
      try {
        console.log(`[DEBUG][${r.tags.name}] URLs to scrape:`, r.urlsToScrape);
        const { pages } = await scrapeMultiplePages(r.urlsToScrape);
        console.log(`[DEBUG][${r.tags.name}] pages returned: ${pages.length}`);
        const combinedText = pages.map(p => p.text).join("\n");
        console.log(`[DEBUG][${r.tags.name}] combinedText length: ${combinedText.length}`);
        console.log(`[DEBUG][${r.tags.name}] combinedText snippet: ${combinedText.slice(0,100).replace(/\n/g,' ')}`);
        console.log(`[DEBUG][${r.tags.name}] links: ${JSON.stringify(pages.map(p => p.links), null, 2)}`);
        // Extract PDF resources from scraped pages
        const pdfResources = pages
          .flatMap(p => p.links.map(l => l.url))
          .filter(url => /\.(pdf)$/i.test(url) && (url.toLowerCase().includes('carta') || url.toLowerCase().includes('menu') || url.toLowerCase().includes('vino')));
        if (pdfResources.length) {
          console.log(`[DEBUG][${r.tags.name}] PDF resources found:`, pdfResources);
          r.resources = Array.from(new Set([...(r.resources || []), ...pdfResources]));
        }
        // Use official OpenAI SDK
        console.log(`[DEBUG][${r.tags.name}] Sending text to OpenAI model: ${openaiModel}`);
        const completion = await openai.chat.completions.create({
          model: openaiModel,
          messages: [
            { role: "system", content: "You are an assistant that transforms raw restaurant menu text into a JSON array called 'cartas'. This array should contain one menu object per distinct scraped menu (e.g., 'Carta de platos', 'Carta de vinos'). Each menu object must have 'nombre' (string) and 'categorias' (array). Each category object must have 'nombre' (string) and 'platos' (array of objects with 'nombre' (string) and 'precios' (array of objects with key 'precio' and string value)). Output only valid JSON for the 'cartas' array—no markdown or extra keys." },
            { role: "user", content: "Extract menu JSON from this text:\n" + combinedText }
          ],
          temperature: 0
        });
        let contentStr = completion.choices?.[0]?.message?.content || "";
        // Strip markdown fences if present
        contentStr = contentStr.trim();
        if (contentStr.startsWith("```")) {
          contentStr = contentStr.replace(/^```(?:json)?\n?/, "").replace(/```$/, "").trim();
        }
        // Parse JSON safely
        try {
          const parsed = JSON.parse(contentStr);
          // Flatten if wrapped in an object with 'cartas'
          let cartasArray: any[] = [];
          if (Array.isArray(parsed)) {
            cartasArray = parsed;
          } else if (parsed.cartas && Array.isArray(parsed.cartas)) {
            cartasArray = parsed.cartas;
          }
          // Normalize 'precios' field for each dish
          let normalizedMenus = cartasArray.map(menu => ({
            ...menu,
            categorias: menu.categorias?.map((category: any) => ({
              ...category,
              platos: category.platos?.map((item: any) => ({
                nombre: item.nombre,
                precios: Array.isArray(item.precios)
                  ? item.precios.map((p: any) => typeof p === 'string' ? { precio: p } : p)
                  : item.precios && typeof item.precios === 'string'
                    ? [{ precio: item.precios }]
                    : Array.isArray(item.precio)
                      ? item.precio.map((p: any) => ({ precio: p }))
                      : item.precio && typeof item.precio === 'string'
                        ? [{ precio: item.precio }]
                        : []
              })) || []
            })) || []
          }));
          // Optional image processing
          if (ENABLE_IMAGE_PROCESSING) {
            const imageUrls = (r.resources || []).filter(u => /\.(jpe?g|png|gif|svg|webp|ico)$/i.test(u));
            if (imageUrls.length) {
              const imageMenus: any[] = [];
              for (const imageUrl of imageUrls) {
                try {
                  const imgCompletion = await openai.chat.completions.create({
                    model: visionModel,
                    messages: [
                      { role: "system", content: "Extract restaurant menu from this image and output a JSON array 'cartas' with the same structure: each object with 'nombre', 'categorias' and 'platos'. Only valid JSON." },
                      { role: "user", content: [{ type: "text", text: "Extract menu JSON from this image" }, { type: "image_url", image_url: { url: imageUrl } }] }
                    ],
                    temperature: 0
                  });
                  const imgText = imgCompletion.choices?.[0]?.message?.content;
                  let imgContentStr = imgText?.trim() || "";
                  if (imgContentStr.startsWith("```")) {
                    imgContentStr = imgContentStr.replace(/^```(?:json)?\n?/, "").replace(/```$/, "").trim();
                  }
                  const parsedImg = JSON.parse(imgContentStr);
                  const imgCartasArray = Array.isArray(parsedImg) ? parsedImg : (parsedImg.cartas || []);
                  imageMenus.push(...imgCartasArray);
                } catch (err: any) {
                  console.error(`Image parse error for ${r.nombre} at ${imageUrl}:`, err.message);
                }
              }
              normalizedMenus = normalizedMenus.concat(imageMenus);
            }
          }
          // Optional PDF screenshot processing
          if (ENABLE_PDF_SCREENSHOT) {
            const pdfUrls = (r.resources || []).filter(u => /\.pdf$/i.test(u));
            for (const pdfUrl of pdfUrls) {
              try {
                const buffers = await screenshotPdfPages(pdfUrl);
                const dir = "pdf_screenshots";
                if (!fs.existsSync(dir)) fs.mkdirSync(dir);
                buffers.forEach((buffer, idx) => {
                  const nameSafe = r.nombre.replace(/[^a-z0-9]/gi, "_").toLowerCase();
                  const fileName = `${nameSafe}_${idx}.png`;
                  const filePath = path.join(dir, fileName);
                  fs.writeFileSync(filePath, buffer);
                  console.log(`Saved PDF screenshot ${idx} for ${r.nombre} to ${filePath}`);
                });
              } catch (err: any) {
                console.error(`PDF screenshot error for ${r.nombre} at ${pdfUrl}:`, err.message);
              }
            }
          }
          const cartasList = normalizedMenus.filter(m => !m.nombre.toLowerCase().includes('menu'));
          const menusList = normalizedMenus.filter(m => m.nombre.toLowerCase().includes('menu'));
          r.cartas = cartasList;
          r.menus = menusList;
        } catch (parseErr: any) {
          console.error(`JSON parse error for ${r.nombre}:`, parseErr.message);
          console.error(`Response was: ${contentStr}`);
          r.cartas = null;
          r.menus = null;
        }
      } catch (err: any) {
        console.error(`Error fetching/parsing menu for ${r.nombre}:`, err.message || err);
        r.cartas = null;
        r.menus = null;
      }
    }
  } // End conditional OpenAI processing

  // Always extract and parse PDF text regardless of OpenAI processing toggle
  if (ENABLE_PDF_TEXT) {
    for (const r of results) {
      const pdfUrlsText = (r.resources || []).filter(u => /\.pdf$/i.test(u) && /^https?:\/\//i.test(u));
      console.log(`Extracting and parsing text from ${pdfUrlsText.length} PDFs for ${r.nombre}...`);
      const dirText = 'pdf_texts';
      if (!fs.existsSync(dirText)) fs.mkdirSync(dirText);
      const allParsed: ParsedMenu[] = [];
      for (const pdfUrl of pdfUrlsText) {
        try {
          const res = await fetch(pdfUrl);
          const arrayBuffer = await res.arrayBuffer();
          const pdfBuffer = Buffer.from(arrayBuffer);
          const { text: pdfText } = await pdfParse(pdfBuffer);
          // Clean extracted text
          const cleanedText = pdfText
            .split('\n')
            .map(line => line.replace(/\s+/g, ' ').trim())
            .filter(line => line.length > 0)
            .join('\n');
          const nameSafe = r.nombre.replace(/[^a-z0-9]/gi, "_").toLowerCase();
          const filePath = path.join(dirText, `${nameSafe}.txt`);
          fs.writeFileSync(filePath, cleanedText, 'utf8');
          console.log(`Saved cleaned PDF text for ${r.nombre} to ${filePath}`);
          // Derive default title from PDF filename
          const pathname = new URL(pdfUrl).pathname;
          const fileBase = path.basename(pathname, path.extname(pathname));
          const defaultTitle = fileBase.replace(/[-_]/g, ' ').trim();
          // Parse cleaned text lines into menus
          const parsed = parsePdfTextLines(cleanedText.split('\n'), defaultTitle);
          if (parsed.length) allParsed.push(...parsed);
        } catch (err: any) {
          console.error(`PDF text extraction error for ${r.nombre} at ${pdfUrl}:`, err.message);
        }
      }
      // Assign parsed menus to restaurant object
      r.cartas = allParsed.filter(m => !m.nombre.toLowerCase().includes('menu'));
      r.menus = allParsed.filter(m => m.nombre.toLowerCase().includes('menu'));
    }
  }

  // Write full output to JSON file to avoid console cutoff
  const elapsedMs = Date.now() - startTime;
  console.log(`Total execution time: ${(elapsedMs / 1000).toFixed(2)}s`);

  // Save parsed PDF menus for review
  if (ENABLE_PDF_TEXT) {
    const pdfParsedOutput = results.map(r => ({ nombre: r.nombre, cartas: r.cartas }));
    const pdfFile = 'pdf_parsed.json';
    fs.writeFileSync(pdfFile, JSON.stringify(pdfParsedOutput, null, 2));
    console.log(`Parsed PDF data saved to ${pdfFile}`);
  }

  return results;

}