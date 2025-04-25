#!/usr/bin/env node
import { searchGooglePlaces } from "./utils";
import { listDomainUrls, scrapeMultiplePages } from "./web-scraping";
import { googleApiKey, openApiKey } from "./keys";
import * as fs from 'fs';
import OpenAI from "openai";

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
  const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(city)}&key=${googleApiKey}`;
  const res = await fetch(geocodeUrl);
  const data = await res.json();
  if (data.status === 'OK' && data.results?.length) {
    const v = data.results[0].geometry.viewport;
    return { latMin: v.southwest.lat, latMax: v.northeast.lat, lonMin: v.southwest.lng, lonMax: v.northeast.lng };
  }
  throw new Error(`Could not geocode city: ${city}`);
}

async function main() {
  const startTime = Date.now();

  // Hybrid collection: by cities and grid to cover Spain
  // const cities = ["Madrid, Spain", "Barcelona, Spain", "Valencia, Spain", "Seville, Spain", "Zaragoza, Spain"];
  const cities = ["Oviedo, Spain"];
  const TEST_MODE = true;
  const perCityLimit = TEST_MODE ? 5 : 500;
  const idMap = new Map<string, any>();
  console.log("Collecting restaurants by city...");
  for (const city of cities) {
    console.log(`Searching in ${city}...`);
    let cityResults = await searchGooglePlaces({ location: city, limit: perCityLimit, apiKey: googleApiKey });
    // Subdivide if at API max
    const PLACE_API_MAX = 60;
    if (cityResults.length >= PLACE_API_MAX) {
      console.log(`${city} returned ${cityResults.length} (API limit). Subdividing area...`);
      const bounds = await geocodeCity(city);
      const stepCity = 0.05;
      let subdivRes: any[] = [];
      for (let lat = bounds.latMin; lat <= bounds.latMax; lat += stepCity) {
        for (let lon = bounds.lonMin; lon <= bounds.lonMax; lon += stepCity) {
          console.log(`Sub-search at ${lat.toFixed(4)},${lon.toFixed(4)}...`);
          const sub = await searchGooglePlaces({ location: `${lat},${lon}`, limit: perCityLimit, apiKey: googleApiKey });
          console.log(`Sub-search returned ${sub.length} restaurants`);
          subdivRes.push(...sub);
        }
      }
      // Merge and dedupe
      const tmp = new Map<string, any>();
      for (const r of [...cityResults, ...subdivRes]) tmp.set(r.id, r);
      cityResults = Array.from(tmp.values());
      console.log(`After subdivision, ${cityResults.length} unique restaurants in ${city}`);
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
      console.log(`Searching at ${loc}...`);
      const gridLimit = TEST_MODE ? 5 : 100;
      const gridResults = await searchGooglePlaces({ location: loc, limit: gridLimit, apiKey: googleApiKey });
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
  const openaiModel = TEST_MODE ? "gpt-4.1-nano" : (process.env.OPENAI_MODEL || "gpt-4");
  const openai = new OpenAI({ apiKey: openApiKey });
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
        cartasArray = cartasArray.map(menu => ({
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
        const normalizedMenus = cartasArray;
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
  // Write full output to JSON file to avoid console cutoff
  const output = { restaurants: results };
  const filePath = 'output.json';
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
  console.log(`Output saved to ${filePath}`);
  const elapsedMs = Date.now() - startTime;
  console.log(`Total execution time: ${(elapsedMs/1000).toFixed(2)}s`);
}

main().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
