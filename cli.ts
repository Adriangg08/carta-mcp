#!/usr/bin/env node
import { searchGooglePlaces } from "./utils";
import { listDomainUrls } from "./web-scraping";
import { googleApiKey } from "./keys";
import * as fs from 'fs';

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

async function main() {
  const startTime = Date.now();

  // Hybrid collection: by cities and grid to cover Spain
  const cities = ["Madrid, Spain", "Barcelona, Spain", "Valencia, Spain", "Seville, Spain", "Zaragoza, Spain"];
  const perCityLimit = 500;
  const idMap = new Map<string, any>();
  console.log("Collecting restaurants by city...");
  for (const city of cities) {
    console.log(`Searching in ${city}...`);
    const cityResults = await searchGooglePlaces({ location: city, limit: perCityLimit, apiKey: googleApiKey });
    for (const r of cityResults) {
      idMap.set(r.id, r);
    }
    console.log(`Unique restaurants so far: ${idMap.size}`);
  }
  console.log("Collecting restaurants by grid...");
  const latMin = 36.0, latMax = 43.8, lonMin = -9.3, lonMax = 3.3;
  const step = 1.0;
  let coordCount = 0;
  for (let lat = latMin; lat <= latMax; lat += step) {
    for (let lon = lonMin; lon <= lonMax; lon += step) {
      coordCount++;
      const loc = `${lat},${lon}`;
      console.log(`Searching at ${loc}...`);
      const gridResults = await searchGooglePlaces({ location: loc, limit: 100, apiKey: googleApiKey });
      for (const r of gridResults) {
        idMap.set(r.id, r);
      }
    }
  }
  console.log(`Grid points searched: ${coordCount}, total unique: ${idMap.size}`);
  const restaurants = Array.from(idMap.values());

  console.log(`Total restaurants to crawl: ${restaurants.length}. Starting crawl...`);
  const MAX_CONCURRENCY = 5;
  const totalBatches = Math.ceil(restaurants.length / MAX_CONCURRENCY);
  const results: any[] = [];
  async function crawlRestaurant(r: any): Promise<any> {
    const urlsToScrape: string[] = [];
    if (r.web) {
      console.log(`Crawling ${r.web}...`);
      try {
        const data = await listDomainUrls(r.web, {
          filterMode: 'custom',
          customIncludePatterns: ['carta', 'menu', 'contact', 'contacto', '@'],
          includeExternalLinks: true,
          maxDepth: 2,
          maxUrls: 50
        });
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
    return { ...r, urlsToScrape };
  }
  for (let i = 0; i < restaurants.length; i += MAX_CONCURRENCY) {
    const batch = restaurants.slice(i, i + MAX_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(crawlRestaurant));
    results.push(...batchResults);
    const batchNum = Math.floor(i / MAX_CONCURRENCY) + 1;
    console.log(`Processed batch ${batchNum}/${totalBatches} (${results.length}/${restaurants.length})`);
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
