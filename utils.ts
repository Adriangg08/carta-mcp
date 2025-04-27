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
import * as fs from 'fs';
import * as path from 'path';
import { listDomainUrls } from './web-scraping';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
dotenv.config();
import axios from 'axios';
import { Buffer } from 'buffer';

// Configure stealth plugin once
puppeteerExtra.use(StealthPlugin());

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
async function getWebsiteFromOSM(name: string, city: string): Promise<string|undefined> {
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
 * @param polygon Array of [lat,lon] pairs defining the polygon vertices (in order).
 */
export async function fetchRestaurantDetailsByPolygon(
  polygon: [number, number][]
): Promise<any[]> {
  const polyStr = polygon.map(([lat, lon]) => `${lat} ${lon}`).join(' ');
  // Fetch nodes, ways, relations with amenity=restaurant within polygon
  const query = `[out:json][timeout:900];
  nwr["amenity"="restaurant"](poly:"${polyStr}");
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
  countryName: string
): Promise<any[]> {
  const query = `[out:json][timeout:900];
area["name"="${countryName}"]->.searchArea;
(
  node["amenity"="restaurant"](area.searchArea);
  way["amenity"="restaurant"](area.searchArea);
  relation["amenity"="restaurant"](area.searchArea);
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
  areaName: string
): Promise<any[]> {
  // Step 1: resolve area ID via Overpass
  const areaIdQuery = `[out:json][timeout:25];
area["boundary"="administrative"]["admin_level"="2"]["name"="${areaName}"];
out ids;`;
  console.log(areaIdQuery);
  const areaIdResp = await axios.post(
    'https://overpass-api.de/api/interpreter',
    areaIdQuery,
    { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
  );
  const areaElements = areaIdResp.data.elements as any[];
  if (!areaElements || areaElements.length === 0) {
    throw new Error(`No area found for: ${areaName}`);
  }
  const areaId = areaElements[0].id;
  // Step 2: fetch restaurants within that area
  const query = `[out:json][timeout:900];
area(id:${areaId})->.searchArea;
nwr["amenity"="restaurant"](area.searchArea);
out center;`;
  console.log(query);
  const resp = await axios.post(
    'https://overpass-api.de/api/interpreter',
    query,
    { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'carta-mcp' } }
  );
  return resp.data.elements as any[];
}

// --- Fetch polygon of a country by name using Nominatim ---
/**
 * Retrieve polygon coords for a country's boundary via Nominatim search.php
 */
export async function getCountryPolygon(
  countryName: string
): Promise<[number, number][]> {
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
  let coords: number[][];
  if (geojson.type === 'Polygon') {
    coords = geojson.coordinates[0];
  } else if (geojson.type === 'MultiPolygon') {
    coords = geojson.coordinates[0][0];
  } else {
    throw new Error(`Unsupported GeoJSON type: ${geojson.type}`);
  }
  // Convert [lon,lat] -> [lat,lon]
  return coords.map(([lon, lat]) => [lat, lon]);
}

// Example usage:
// (async () => {
//   const details = await fetchRestaurantDetailsFromArea(37.0, -9.3, 38.0, -8.3);
//   console.log(JSON.stringify(details, null, 2));
// })();