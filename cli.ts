#!/usr/bin/env node
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from "path";
import { crawlTripAdvisorUrls, extractRestaurantWebsites, fetchRestaurantDetailsByAreaNameManual, fetchRestaurantDetailsByPolygon, fetchRestaurantDetailsFromArea, fetchRestaurantDetailsInCountry, getAllRestaurantsInCountry, getAreaCandidates, getCountryPolygon, getRestaurantsInfoFromWebsite, parseOsmMenus, searchGooglePlaces } from "./utils";
import { scrapeMultiplePages } from "./web-scraping";

dotenv.config();

// Geocode a city to get bounding box viewport for subdivision
async function geocodeCity(city: string): Promise<{ latMin: number; latMax: number; lonMin: number; lonMax: number }> {
  const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(city)}&key=${process.env.GOOGLE_API_KEY!}`;
  const res = await fetch(geocodeUrl);
  const data = await res.json();
  if (data.status === 'OK' && data.results?.length) {
    const v = data.results[0].geometry.viewport;
    return { latMin: v.southwest.lat, latMax: v.northeast.lat, lonMin: v.southwest.lng, lonMax: v.northeast.lng };
  }
  throw new Error(`Could not geocode city: ${city}`);
}

async function main() {
  const args = process.argv.slice(2);
  // Crawl TripAdvisor URLs
  if (args[0] === '--crawl-tripadvisor') {
    const slugOrUrl = args[1];
    const limit = args[2] ? parseInt(args[2], 10) : 1000;
    const pageLimit = args[3] ? parseInt(args[3], 10) : 50;
    console.log(`Crawling TripAdvisor URLs for: ${slugOrUrl} (limit ${limit}, pages ${pageLimit})`);
    const urls = await crawlTripAdvisorUrls(slugOrUrl, limit, pageLimit);
    console.log(`Collected ${urls.length} URLs`);
    return;
  }
  // Quick TripAdvisor scraping mode
  if (args[0] === '--tripadvisor') {
    const slugOrUrl = args[1];
    const limit = args[2] ? parseInt(args[2], 10) : 20;
    console.log(`Scraping TripAdvisor: ${slugOrUrl} (limit ${limit})`);
    return;
  }
  // Extract official websites from cached TripAdvisor URLs
  if (args[0] === '--extract-websites') {
    const slug = args[1];
    const fileName = slug.replace(/[^a-z0-9]/gi, '_') + '.json';
    const filePath = path.join('cache', 'tripadvisor', fileName);
    if (!fs.existsSync(filePath)) {
      console.error(`Cache file not found: ${filePath}`);
      process.exit(1);
    }
    const taUrls: string[] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`Extracting websites from ${taUrls.length} URLs...`);
    const siteResults = await extractRestaurantWebsites(taUrls);
    console.log(JSON.stringify(siteResults, null, 2));
    return;
  }
  if (args[0] === '--osm-country') {
    const countryName = args[1] || 'Spain';
    console.log(`Geocoding country: ${countryName}`);
    const { latMin, latMax, lonMin, lonMax } = await geocodeCity(countryName);
    console.log(`Bounding box: [${latMin}, ${lonMin}] -> [${latMax}, ${lonMax}]`);
    console.log(`Fetching all restaurants in ${countryName} via OSM...`);
    const restos = await getAllRestaurantsInCountry(latMin, lonMin, latMax, lonMax);
    const outDir = path.join('cache', 'osm');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const safeName = countryName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filePath = path.join(outDir, `restaurants_${safeName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(restos, null, 2), 'utf8');
    console.log(`Saved ${restos.length} restaurants for ${countryName} to ${filePath}`);
    return;
  }
  if (args[0] === '--osm-polygon') {
    // args: list of pairs lat lon -> polygon
    if (args.length < 3 || args.length % 2 === 0) {
      console.error('Usage: --osm-polygon lat1 lon1 lat2 lon2 ...');
      process.exit(1);
    }
    const coords: [number, number][] = [];
    for (let i = 1; i < args.length; i += 2) {
      const lat = parseFloat(args[i]);
      const lon = parseFloat(args[i + 1]);
      if (isNaN(lat) || isNaN(lon)) {
        console.error('Invalid coordinate pair:', args[i], args[i + 1]);
        process.exit(1);
      }
      coords.push([lat, lon]);
    }
    console.log(`Fetching restaurants within polygon (${coords.length} points)...`);
    const details = await fetchRestaurantDetailsByPolygon(coords);
    // Save output as JSON file for later analysis
    const outDir = path.join('cache', 'osm', 'polygon');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const fileName = `polygon_${coords.map(c => c.join('_')).join('-')}.json`;
    const filePath = path.join(outDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(details, null, 2), 'utf8');
    console.log(`Saved ${details.length} elements to ${filePath}`);
    return;
  }
  if (args[0] === '--osm-admin-country') {
    const countryName = args[1] || 'Spain';
    console.log(`Fetching restaurants within administrative boundary of ${countryName}...`);
    const elements = await fetchRestaurantDetailsInCountry(countryName);
    const safeName = countryName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const countryDir = path.join('cache', 'osm', 'admin', safeName);
    if (!fs.existsSync(countryDir)) fs.mkdirSync(countryDir, { recursive: true });
    const filePath = path.join(countryDir, `admin_${safeName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(elements, null, 2), 'utf8');
    console.log(`Saved ${elements.length} elements for ${countryName} to ${filePath}`);
    return;
  }
  if (args[0] === '--osm-area') {
    const areaName = args[1] || 'Asturias';
    console.log(`Fetching polygon for area: ${areaName}...`);
    const geojson = await getCountryPolygon(areaName);
    const safeName = areaName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const areaDir = path.join('cache', 'osm', 'area', safeName);
    if (!fs.existsSync(areaDir)) fs.mkdirSync(areaDir, { recursive: true });
    const polyPath = path.join(areaDir, `polygon_${safeName}.json`);
    fs.writeFileSync(polyPath, JSON.stringify(geojson, null, 2), 'utf8');
    console.log(`Saved GeoJSON polygon to ${polyPath}`);
    return;
  }
  // if (args[0] === '--osm-area-manual') {
  //   const areaName = args[1] || 'Asturias';
  //   const adminLevel = args[2] ? parseInt(args[2], 10) : 2;
  //   console.log(`Fetching restaurants manually by area ID for area: ${areaName}...`);
  //   const rest = await fetchRestaurantDetailsByAreaNameManual(areaName, adminLevel, ['bar', 'cafe', 'fast_food', 'restaurant', 'pub', 'ice_cream', 'biergarten', 'food_court']);
  //   const safeName = areaName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  //   const manualDir = path.join('cache', 'osm', 'manual', safeName);
  //   if (!fs.existsSync(manualDir)) fs.mkdirSync(manualDir, { recursive: true });
  //   const manualPath = path.join(manualDir, `restaurants_${safeName}.json`);
  //   fs.writeFileSync(manualPath, JSON.stringify(rest, null, 2), 'utf8');
  //   console.log(`Saved ${rest.length} restaurants to ${manualPath}`);
  //   return;
  // }
  if (args[0] === '--osm-area-manual') {
    const areaName = args[1] || 'Asturias';
    const adminLevel = args[2] ? parseInt(args[2], 10) : 2;
    const countryContext = args[3] || undefined; // Optional country context parameter
    console.log(`Fetching restaurants manually by area ID for area: ${areaName}${countryContext ? ` within ${countryContext}` : ''}...`);
    const rest = await fetchRestaurantDetailsByAreaNameManual(
      areaName,
      adminLevel,
      ['bar', 'cafe', 'fast_food', 'restaurant', 'pub', 'ice_cream', 'biergarten', 'food_court'],
      countryContext
    );
    const safeName = areaName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const manualDir = path.join('cache', 'osm', 'manual', safeName);
    if (!fs.existsSync(manualDir)) fs.mkdirSync(manualDir, { recursive: true });
    const manualPath = path.join(manualDir, `restaurants_${safeName}.json`);
    fs.writeFileSync(manualPath, JSON.stringify(rest, null, 2), 'utf8');
    console.log(`Saved ${rest.length} restaurants to ${manualPath}`);
    return;
  }

  if (args[0] === '--osm-area-candidates') {
    const areaName = args[1] || '';
    const adminLevel = args[2] ? parseInt(args[2], 10) : undefined;
    console.log(`Listing area candidates for: ${areaName}` + (adminLevel ? ` (level ${adminLevel})` : ''));
    const candidates = await getAreaCandidates(areaName, adminLevel);
    console.log(JSON.stringify(candidates, null, 2));
    return;
  }
  if (args[0] === '--osm-scrape-websites') {
    const areaArg = args[1];
    const baseDir = path.join('cache', 'osm', 'manual');
    const areas = areaArg
      ? [areaArg]
      : fs.readdirSync(baseDir).filter(d => fs.statSync(path.join(baseDir, d)).isDirectory());
    for (const area of areas) {
      const filePath = path.join(baseDir, area, `restaurants_${area}.json`);
      if (!fs.existsSync(filePath)) {
        console.warn(`Skipping ${area}: no JSON file`);
        continue;
      }
      const elements: any[] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const urls: string[] = elements
        .map(e => e.tags?.website)
        .filter(u => typeof u === 'string');
      console.log(`Scraping ${urls.length} websites for area ${area}...`);
      const { pages } = await scrapeMultiplePages(urls);
      const outDir = path.join('cache', 'osm', 'menus', area);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, 'scraped_pages.json'),
        JSON.stringify(pages, null, 2),
        'utf8'
      );
      console.log(`Saved scraped pages for ${area} to ${outDir}`);
    }
    return;
  }
  if (args[0] === '--osm-parse-menus') {
    const areaArg = args[1];
    console.log(`Parsing menus for area: ${areaArg || 'all'}`);
    await parseOsmMenus(areaArg);
    return;
  }
  if (args[0] === '--osm-details') {
    // Fetch full OSM elements with tags, center, metadata
    let [minLat, minLon, maxLat, maxLon] = args.slice(1).map(v => parseFloat(v));
    if (args.length < 5 || [minLat, minLon, maxLat, maxLon].some(isNaN)) {
      console.log('Using default area [37.0,-9.3] -> [38.0,-8.3]');
      minLat = 37.0; minLon = -9.3; maxLat = 38.0; maxLon = -8.3;
    }
    console.log(`Fetching detailed OSM data for area [${minLat},${minLon}] -> [${maxLat},${maxLon}]`);
    const details = await fetchRestaurantDetailsFromArea(minLat, minLon, maxLat, maxLon);
    // Save output as JSON file for later analysis
    const outDir = path.join('cache', 'osm', 'details');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const fileName = `details_${minLat}_${minLon}_${maxLat}_${maxLon}.json`;
    const filePath = path.join(outDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(details, null, 2), 'utf8');
    console.log(`Saved detailed OSM data (${details.length} elements) to ${filePath}`);
    return;
  }
}

async function scratchGoogleMaps() {

  // Prepare cache directories
  const cacheDir = 'cache';
  const cityCacheDir = path.join(cacheDir, 'cities');
  const gridCacheDir = path.join(cacheDir, 'grid');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
  if (!fs.existsSync(cityCacheDir)) fs.mkdirSync(cityCacheDir);
  if (!fs.existsSync(gridCacheDir)) fs.mkdirSync(gridCacheDir);
  // Prepare final output cache

  // Derive zone key from cities list
  const safeZone = ["Oviedo, Spain"].map(c => c.replace(/[^a-z0-9]/gi, '_').toLowerCase()).join('-');

  // Hybrid collection: by cities and grid to cover Spain
  // const cities = ["Madrid, Spain", "Barcelona, Spain", "Valencia, Spain", "Seville, Spain", "Zaragoza, Spain"];
  const cities = ["Oviedo, Spain"];
  const perCityLimit = process.env.TEST_MODE ? 5 : 500;
  const idMap = new Map<string, any>();
  console.log("Collecting restaurants by city...");
  for (const city of cities) {
    const safeCity = city.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const cityFile = path.join(cityCacheDir, `${safeCity}.json`);
    let cityResults: any[];
    if (fs.existsSync(cityFile)) {
      console.log(`Loading cached city results for ${city} from ${cityFile}`);
      cityResults = JSON.parse(fs.readFileSync(cityFile, 'utf8'));
    } else {
      console.log(`Searching in ${city}...`);
      cityResults = await searchGooglePlaces({ location: city, limit: perCityLimit, apiKey: process.env.GOOGLE_API_KEY! });
      const PLACE_API_MAX = 60;
      if (cityResults.length >= PLACE_API_MAX) {
        console.log(`${city} returned ${cityResults.length} (API limit). Subdividing area...`);
        const bounds = await geocodeCity(city);
        const stepCity = 0.05;
        let subdivRes: any[] = [];
        for (let lat = bounds.latMin; lat <= bounds.latMax; lat += stepCity) {
          for (let lon = bounds.lonMin; lon <= bounds.lonMax; lon += stepCity) {
            console.log(`Sub-search at ${lat.toFixed(4)},${lon.toFixed(4)}...`);
            const sub = await searchGooglePlaces({ location: `${lat},${lon}`, limit: perCityLimit, apiKey: process.env.GOOGLE_API_KEY! });
            console.log(`Sub-search returned ${sub.length} restaurants`);
            subdivRes.push(...sub);
          }
        }
        const tmp = new Map<string, any>();
        for (const r of [...cityResults, ...subdivRes]) tmp.set(r.id, r);
        cityResults = Array.from(tmp.values());
        console.log(`After subdivision, ${cityResults.length} unique restaurants in ${city}`);
      }
      fs.writeFileSync(cityFile, JSON.stringify(cityResults, null, 2));
      console.log(`Saved city cache to ${cityFile}`);
    }
    for (const r of cityResults) idMap.set(r.id, r);
    console.log(`Unique restaurants so far: ${idMap.size}`);
  }
  console.log("Collecting restaurants by grid (test region around Oviedo)...");
  // Test region: only Oviedo area
  const latMin = 43.34, latMax = 43.44, lonMin = -5.96, lonMax = -5.86;
  const step = 0.05;
  // National region (uncomment for full run)
  // const latMin = 36.0, latMax = 43.8, lonMin = -9.3, lonMax = 3.3;
  // const step = 1.0;
  let coordCount = 0;
  for (let lat = latMin; lat <= latMax; lat += step) {
    for (let lon = lonMin; lon <= lonMax; lon += step) {
      coordCount++;
      const loc = `${lat},${lon}`;
      const coordKey = `${lat.toFixed(4)}_${lon.toFixed(4)}`;
      const gridFile = path.join(gridCacheDir, `${coordKey}.json`);
      let gridResults: any[];
      if (fs.existsSync(gridFile)) {
        console.log(`Loading cached grid results for ${coordKey} from ${gridFile}`);
        gridResults = JSON.parse(fs.readFileSync(gridFile, 'utf8'));
      } else {
        console.log(`Searching at ${loc}...`);
        const gridLimit = process.env.TEST_MODE ? 5 : 100;
        gridResults = await searchGooglePlaces({ location: loc, limit: gridLimit, apiKey: process.env.GOOGLE_API_KEY! });
        fs.writeFileSync(gridFile, JSON.stringify(gridResults, null, 2));
        console.log(`Saved grid cache to ${gridFile}`);
      }
      for (const r of gridResults) {
        idMap.set(r.id, r);
      }
    }
  }
  console.log(`Grid points searched: ${coordCount}, total unique: ${idMap.size}`);
  const allRestaurants = Array.from(idMap.values());
  // Test mode: limit total restaurants to 10
  const restaurants = allRestaurants.slice(0, 10);
  console.log(`Test mode: limited to ${restaurants.length} restaurants out of ${allRestaurants.length}`);

  console.log(`Total restaurants to crawl: ${restaurants.length}. Starting crawl...`);

  const results = await getRestaurantsInfoFromWebsite(restaurants, -1);

}

main().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
