import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchGooglePlaces } from "./utils";
import { googleApiKey } from "./keys";
import { scrapeWebPage, scrapeMultiplePages, listDomainUrls } from "./web-scraping";

// Create an MCP server
const server = new McpServer({
    name: 'restaurant-finder-mcp',
    version: '1.0.0'
});

const transport = new StdioServerTransport();

// Register the restaurant finder tool
server.tool(
  "find_restaurants",
  {
    location: z.string().min(1, "Location is required"),
    limit: z.number().optional().default(20),
  },
  async (args) => {
    try {
      // Get restaurants using Google Maps API
      const restaurants = await searchGooglePlaces({
        location: args.location,
        limit: args.limit,
        apiKey: googleApiKey
      });
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(restaurants, null, 2)
          }
        ]
      };
    } catch (error) {
      // Don't use console.error here
      return {
        content: [
          {
            type: "text",
            text: `No se encontraron restaurantes para la ubicación: ${args.location}`
          }
        ]
      }
    }
  }
);

// Register the web scraping tool
server.tool(
  "web_scraping",
  {
    url: z.string().url("URL must be valid"),
  },
  async (args) => {
    try {
      const scrapedData = await scrapeWebPage(args.url);
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              title: scrapedData.title,
              text: scrapedData.text,
              metadata: scrapedData.metadata,
              links_count: scrapedData.links.length,
              sample_links: scrapedData.links.slice(0, 5)
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error al hacer scraping de la URL: ${args.url}. Error: ${error.message}`
          }
        ]
      }
    }
  }
);

// Register the multi-page web scraping tool
server.tool(
  "multi_page_scraping",
  {
    urls: z.array(z.string().url("All URLs must be valid")).min(1, "At least one URL is required"),
  },
  async (args) => {
    try {
      const scrapedData = await scrapeMultiplePages(args.urls);
      
      // Preparar un resumen para no sobrecargar la respuesta
      const summary = scrapedData.pages.map(page => ({
        url: page.url,
        title: page.title,
        text_length: page.text.length,
        links_count: page.links.length
      }));
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              pages_scraped: scrapedData.pages.length,
              summary,
              full_content: scrapedData
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error al hacer scraping de múltiples URLs. Error: ${error.message}`
          }
        ]
      }
    }
  }
);

// Register the domain URL listing tool
server.tool(
  "list_domain_urls",
  {
    domain_url: z.string().url("Domain URL must be valid"),
    max_depth: z.number().optional().default(2),
    max_urls: z.number().optional().default(50),
    include_external_links: z.boolean().optional().default(false),
    timeout_ms: z.number().optional().default(25000),
    batch_size: z.number().optional().default(5),
    filter_mode: z.enum(['none', 'menu', 'custom']).optional().default('menu'),
    custom_exclude_patterns: z.array(z.string()).optional(),
    custom_include_patterns: z.array(z.string()).optional(),
    adaptive_search: z.boolean().optional().default(true),
  },
  async (args) => {
    try {
      const urlsData = await listDomainUrls(args.domain_url, {
        maxDepth: args.max_depth,
        maxUrls: args.max_urls,
        includeExternalLinks: args.include_external_links,
        timeoutMs: args.timeout_ms,
        batchSize: args.batch_size,
        filterMode: args.filter_mode,
        customExcludePatterns: args.custom_exclude_patterns,
        customIncludePatterns: args.custom_include_patterns,
        adaptiveSearch: args.adaptive_search
      });
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              domain: urlsData.domain,
              urls_found: urlsData.urlsFound,
              filtered_urls_count: urlsData.filteredUrls.length,
              filtered_urls: urlsData.filteredUrls,
              ...(urlsData.priorityPaths ? { priority_paths: urlsData.priorityPaths } : {}),
              all_urls: urlsData.urls,
              timed_out: urlsData.timedOut,
              ...(urlsData.externalUrls ? { external_urls: urlsData.externalUrls } : {})
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error al listar URLs del dominio: ${args.domain_url}. Error: ${error.message}`
          }
        ]
      }
    }
  }
);

// Register the combined restaurant and crawling tool
server.tool(
  "find_and_crawl_restaurants",
  {
    location: z.string().min(1, "Location is required"),
    limit: z.number().optional().default(20),
  },
  async (args) => {
    // Notify start and carry progressToken
    const meta = (args as any)._meta;
    console.log(`[find_and_crawl_restaurants] started, progressToken=${meta?.progressToken}`);
    try {
      const restaurants = await searchGooglePlaces({
        location: args.location,
        limit: args.limit,
        apiKey: googleApiKey
      });
      console.log(`[find_and_crawl_restaurants] retrieved ${restaurants.length} restaurants`);
      // Crawl each restaurant's website with concurrency limit and sliding timeout
      const MAX_CONCURRENCY = 3;
      const CRAWL_TIMEOUT_MS = 60000; // 1 minute sliding window
      let deadline = Date.now() + CRAWL_TIMEOUT_MS;
      async function crawlRestaurants(): Promise<Array<{ id: string; urls: string[] }>> {
        const results: Array<{ id: string; urls: string[] }> = [];
        for (let i = 0; i < restaurants.length; i += MAX_CONCURRENCY) {
          if (Date.now() > deadline) {
            console.log(`[find_and_crawl_restaurants] timeout reached after processing ${results.length} restaurants`);
            break;
          }
          const batch = restaurants.slice(i, i + MAX_CONCURRENCY);
          const batchResults = await Promise.all(batch.map(async r => {
            if (r.web) {
              try {
                const data = await listDomainUrls(r.web, { filterMode: 'none' });
                const urls = data.filteredUrls.length > 0 ? data.filteredUrls : [];
                urls.unshift(r.web);
                return { id: r.id, urls };
              } catch {
                return { id: r.id, urls: [] };
              }
            }
            return { id: r.id, urls: [] };
          }));
          results.push(...batchResults);
          console.log(`[find_and_crawl_restaurants] processed batch ${Math.floor(i/MAX_CONCURRENCY)+1}/${Math.ceil(restaurants.length/MAX_CONCURRENCY)} – total processed ${results.length}`);
          // reset deadline on progress
          deadline = Date.now() + CRAWL_TIMEOUT_MS;
        }
        return results;
      }
      const urlsByRestaurant = await crawlRestaurants();
      console.log(`[find_and_crawl_restaurants] crawling completed, sending response`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              restaurants,
              urls_to_scrape: urlsByRestaurant
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error in combined tool: ${error.message}`
          }
        ]
      };
    }
  }
);

// Connect the server to the transport
await server.connect(transport);
