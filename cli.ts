#!/usr/bin/env node
import { Buffer } from "buffer";
import dotenv from 'dotenv';
import * as fs from 'fs';
import OpenAI from "openai";
import * as path from "path";
import pdfParse from "pdf-parse";
import puppeteer from "puppeteer";
import { ParsedMenu, crawlTripAdvisorUrls, extractRestaurantWebsites, parsePdfTextLines, searchGooglePlaces, getAllRestaurantsInCountry, fetchRestaurantDetailsFromArea, fetchRestaurantDetailsByPolygon, fetchRestaurantDetailsInCountry, fetchRestaurantDetailsByAreaName, getCountryPolygon } from "./utils";
import { listDomainUrls, scrapeMultiplePages } from "./web-scraping";

dotenv.config();

// Deduplicate URLs by language-agnostic path, preferring '/es' versions
function dedupeLanguageUrls(urls: string[]): string[] {
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

// Geocode a city to get bounding box viewport for subdivision
async function geocodeCity(city: string): Promise<{latMin:number; latMax:number; lonMin:number; lonMax:number}> {
  const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(city)}&key=${process.env.GOOGLE_API_KEY!}`;
  const res = await fetch(geocodeUrl);
  const data = await res.json();
  if (data.status === 'OK' && data.results?.length) {
    const v = data.results[0].geometry.viewport;
    return { latMin: v.southwest.lat, latMax: v.northeast.lat, lonMin: v.southwest.lng, lonMax: v.northeast.lng };
  }
  throw new Error(`Could not geocode city: ${city}`);
}

// Helper: screenshot PDF pages and return image buffers
async function screenshotPdfPages(url: string): Promise<Buffer[]> {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });
  const img = await page.screenshot({ fullPage: true });
  const screenshot = Buffer.from(img as Uint8Array);
  await browser.close();
  return [screenshot];
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
      const lon = parseFloat(args[i+1]);
      if (isNaN(lat) || isNaN(lon)) {
        console.error('Invalid coordinate pair:', args[i], args[i+1]);
        process.exit(1);
      }
      coords.push([lat, lon]);
    }
    console.log(`Fetching restaurants within polygon (${coords.length} points)...`);
    const details = await fetchRestaurantDetailsByPolygon(coords);
    // Save output as JSON file for later analysis
    const outDir = path.join('cache', 'osm', 'polygon');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const fileName = `polygon_${coords.map(c=>c.join('_')).join('-')}.json`;
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
  if (args[0] === '--osm-country-polygon') {
    // Retrieve country polygon and fetch restaurants within it
    const countryName = args[1] || 'Spain';
    console.log(`Retrieving polygon coords for ${countryName} via Nominatim...`);
    const polygon = await getCountryPolygon(countryName);
    const safeName = countryName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const countryDir = path.join('cache', 'osm', 'polygon', safeName);
    if (!fs.existsSync(countryDir)) fs.mkdirSync(countryDir, { recursive: true });
    // Save polygon coords
    const polyPath = path.join(countryDir, `polygon_${safeName}.json`);
    fs.writeFileSync(polyPath, JSON.stringify(polygon, null, 2), 'utf8');
    console.log(`Saved polygon (${polygon.length} coords) to ${polyPath}`);
    // Fetch restaurants within polygon
    console.log(`Fetching restaurants within polygon for ${countryName}...`);
    const restos = await fetchRestaurantDetailsByPolygon(polygon);
    const restosPath = path.join(countryDir, `restaurants_${safeName}.json`);
    fs.writeFileSync(restosPath, JSON.stringify(restos, null, 2), 'utf8');
    console.log(`Saved ${restos.length} restaurants to ${restosPath}`);
    return;
  }
  if (args[0] === '--osm-area') {
    const areaName = args[1] || 'Asturias';
    console.log(`Fetching restaurants in area: ${areaName}...`);
    const elems = await fetchRestaurantDetailsByAreaName(areaName);
    const safeName = areaName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const areaDir = path.join('cache', 'osm', 'area', safeName);
    if (!fs.existsSync(areaDir)) fs.mkdirSync(areaDir, { recursive: true });
    const filePath = path.join(areaDir, `area_${safeName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(elems, null, 2), 'utf8');
    console.log(`Saved ${elems.length} restaurants to ${filePath}`);
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

  const startTime = Date.now();

  // Prepare cache directories
  const cacheDir = 'cache';
  const cityCacheDir = path.join(cacheDir, 'cities');
  const gridCacheDir = path.join(cacheDir, 'grid');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
  if (!fs.existsSync(cityCacheDir)) fs.mkdirSync(cityCacheDir);
  if (!fs.existsSync(gridCacheDir)) fs.mkdirSync(gridCacheDir);
  // Prepare final output cache
  const outputCacheDir = path.join(cacheDir, 'results');
  if (!fs.existsSync(outputCacheDir)) fs.mkdirSync(outputCacheDir);
  // Derive zone key from cities list
  const safeZone = ["Oviedo, Spain"].map(c => c.replace(/[^a-z0-9]/gi, '_').toLowerCase()).join('-');

  // Hybrid collection: by cities and grid to cover Spain
  // const cities = ["Madrid, Spain", "Barcelona, Spain", "Valencia, Spain", "Seville, Spain", "Zaragoza, Spain"];
  const cities = ["Oviedo, Spain"];
  const TEST_MODE = true;
  const perCityLimit = TEST_MODE ? 5 : 500;
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
        const gridLimit = TEST_MODE ? 5 : 100;
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
  const MAX_CONCURRENCY = 5;
  const totalBatches = Math.ceil(restaurants.length / MAX_CONCURRENCY);
  const results: any[] = [];
  async function crawlRestaurant(r: any): Promise<any> {
    const urlsToScrape: string[] = [];
    let resources: string[] = [];
    if (r.web) {
      console.log(`Crawling ${r.web}...`);
      try {
        const data = await listDomainUrls(r.web, {
          filterMode: 'menu',
          includeExternalLinks: true,
          adaptiveSearch: true,
          maxDepth: TEST_MODE ? 1 : 4,
          maxUrls: TEST_MODE ? 10 : 50
        });
        // Collect image/PDF resources
        const allDataUrls = [...(data.urls || []), ...(data.externalUrls || [])];
        const resourcePatterns = /\.(jpe?g|png|gif|svg|webp|ico|pdf)$/i;
        resources = Array.from(new Set(allDataUrls.filter(u => resourcePatterns.test(u))));
        // DEBUG: inspect URLs returned by crawler
        console.log(`listDomainUrls for ${r.nombre} (${r.web}):`);
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
        console.error(`Error crawling ${r.web}: ${err.message}`);
      }
    }
    return { ...r, urlsToScrape, resources };
  }
  for (let i = 0; i < restaurants.length; i += MAX_CONCURRENCY) {
    const batch = restaurants.slice(i, i + MAX_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(crawlRestaurant));
    results.push(...batchResults);
    const batchNum = Math.floor(i / MAX_CONCURRENCY) + 1;
    console.log(`Processed batch ${batchNum}/${totalBatches} (${results.length}/${restaurants.length})`);
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
        const { pages } = await scrapeMultiplePages(r.urlsToScrape);
        const combinedText = pages.map(p => p.text).join("\n");
        // Use official OpenAI SDK
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
                      { role: "user", content: [ { type: "text", text: "Extract menu JSON from this image" }, { type: "image_url", image_url: { url: imageUrl } } ] }
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
  const cacheOutputFile = path.join(outputCacheDir, `${safeZone}.json`);
  fs.writeFileSync(cacheOutputFile, JSON.stringify({ restaurants: results }, null, 2));
  console.log(`Saved final results to ${cacheOutputFile}`);
  const elapsedMs = Date.now() - startTime;
  console.log(`Total execution time: ${(elapsedMs/1000).toFixed(2)}s`);

  // Save parsed PDF menus for review
  if (ENABLE_PDF_TEXT) {
    const pdfParsedOutput = results.map(r => ({ nombre: r.nombre, cartas: r.cartas }));
    const pdfFile = 'pdf_parsed.json';
    fs.writeFileSync(pdfFile, JSON.stringify(pdfParsedOutput, null, 2));
    console.log(`Parsed PDF data saved to ${pdfFile}`);
  }
}

main().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
