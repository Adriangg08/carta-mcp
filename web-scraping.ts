import { JSDOM } from "jsdom";
import puppeteer from 'puppeteer';

/**
 * Función para extraer texto de una página web
 */
export async function scrapeWebPage(url: string): Promise<{
  title: string;
  text: string;
  links: { url: string; text: string }[];
  metadata: Record<string, string>;
}> {
  // Obtener HTML estático o dinámico con Puppeteer si falla
  async function fetchPageContent(targetUrl: string): Promise<string> {
    try {
      const res = await fetch(targetUrl);
      if (!res.ok) throw new Error(`Fetch error: ${res.statusText}`);
      return await res.text();
    } catch {
      const browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(targetUrl, { waitUntil: 'networkidle2' });
      const content = await page.content();
      await browser.close();
      return content;
    }
  }
  try {
    // Cargar contenido (estático o dinámico según sea necesario)
    const html = await fetchPageContent(url);
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // Extraer título
    const title = document.title || url;
    
    // Extraer metadatos
    const metadata: Record<string, string> = {};
    const metaTags = document.querySelectorAll("meta");
    metaTags.forEach((meta) => {
      const name = meta.getAttribute("name") || meta.getAttribute("property");
      const content = meta.getAttribute("content");
      if (name && content) {
        metadata[name] = content;
      }
    });
    
    // Extraer texto principal (eliminar scripts, estilos, etc.)
    const scripts = document.querySelectorAll("script, style, noscript, iframe");
    scripts.forEach(s => s.remove());
    
    // Extraer texto del cuerpo
    const bodyText = document.body.textContent || "";
    const cleanText = bodyText
      .replace(/\s+/g, " ")
      .trim();
    
    // Extraer enlaces
    const links: { url: string; text: string }[] = [];
    const anchorTags = document.querySelectorAll("a[href]");
    anchorTags.forEach((a) => {
      const href = a.getAttribute("href");
      const text = a.textContent?.trim();
      if (href && text) {
        // Convertir URLs relativas a absolutas
        try {
          const absoluteUrl = new URL(href, url).toString();
          links.push({ url: absoluteUrl, text });
        } catch (e) {
          // Ignorar URLs inválidas
        }
      }
    });
    
    return {
      title,
      text: cleanText,
      links,
      metadata
    };
  } catch (error: any) {
    throw new Error(`Error scraping web page: ${error.message}`);
  }
}

/**
 * Función para extraer texto de múltiples páginas web
 */
export async function scrapeMultiplePages(urls: string[]): Promise<{
  pages: Array<{
    url: string;
    title: string;
    text: string;
    links: { url: string; text: string }[];
    metadata: Record<string, string>;
  }>;
}> {
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const data = await scrapeWebPage(url);
        return {
          url,
          ...data
        };
      } catch (error) {
        return {
          url,
          title: url,
          text: `Error scraping this URL: ${error}`,
          links: [],
          metadata: {}
        };
      }
    })
  );
  
  return { pages: results };
}

/**
 * Función para listar todas las URLs de un dominio específico
 * Realiza un crawling recursivo hasta la profundidad especificada
 * con límites de tiempo para evitar timeouts
 * y filtros inteligentes para encontrar URLs relevantes para cartas de restaurantes
 */
export async function listDomainUrls(
  domainUrl: string, 
  options: { 
    maxDepth?: number; 
    maxUrls?: number;
    includeExternalLinks?: boolean;
    timeoutMs?: number;
    batchSize?: number;
    filterMode?: 'none' | 'menu' | 'custom';
    customExcludePatterns?: string[];
    customIncludePatterns?: string[];
    adaptiveSearch?: boolean;
  } = {}
): Promise<{
  domain: string;
  urlsFound: number;
  urls: string[];
  filteredUrls: string[];
  priorityPaths?: string[];
  externalUrls?: string[];
  timedOut?: boolean;
}> {
  // Configuración por defecto
  const maxDepth = options.maxDepth || 2;
  const maxUrls = options.maxUrls || 50;
  const includeExternalLinks = options.includeExternalLinks || false;
  const timeoutMs = options.timeoutMs || 25000; // 25 segundos por defecto
  const batchSize = options.batchSize || 5; // Procesar 5 URLs a la vez por defecto
  const filterMode = options.filterMode || 'menu'; // Por defecto, filtrar para encontrar menús
  const adaptiveSearch = options.adaptiveSearch !== undefined ? options.adaptiveSearch : true; // Activado por defecto
  
  // Patrones de exclusión para URLs irrelevantes
  const defaultExcludePatterns = [
    // Patrones generales a excluir
    /\.(jpg|jpeg|png|gif|svg|webp|ico|pdf|doc|docx|xls|xlsx|zip|rar|exe|dmg)$/i, // Archivos
    /\/(wp-|wp\/|wordpress\/|wp-content|wp-includes)/i, // WordPress
    /\/(tag|tags|category|categories|author|search|page|comments)/i, // Blogs
    /\/(login|register|signup|signin|auth|account|profile|dashboard)/i, // Autenticación
    /\/(privacy|privacidad|cookies|terms|terminos|condiciones|legal|aviso-legal)/i, // Legal
    /\/(contact|contacto|about|sobre-nosotros|quienes-somos|historia)/i, // Información
    /\/(blog|news|noticias|articulos|articles|press|prensa)/i, // Contenido editorial
    /\/(shop|tienda|store|carrito|checkout|compra)(?:\/|$)/i, // Comercio, excluding cart pages but not '/carta'
    /\/(faq|faqs|help|ayuda|soporte|support)/i, // Ayuda
    /\/(events|eventos|calendar|calendario)/i, // Eventos
    /\/(gallery|galeria|photos|fotos|videos|imagenes)/i, // Multimedia
    /\/(social|facebook|twitter|instagram|linkedin|youtube)/i, // Redes sociales
    /\/(rss|feed|atom|sitemap|robots\.txt)/i, // Técnicos
    /\/(api|json|xml|graphql|webhook)/i, // APIs
    /\/(ads|advertising|publicidad|banner)/i, // Publicidad
    /\/(tracking|analytics|pixel)/i, // Analítica
    /\/(careers|jobs|empleo|trabajo)/i, // Empleo
    /\/(download|descargar|upload|subir)/i, // Descargas
    /\/(subscribe|suscribir|newsletter)/i, // Suscripciones
  ];
  
  // Patrones de inclusión para URLs potencialmente relacionadas con cartas/menús
  const menuIncludePatterns = [
    /(menu|carta|food|comida|platos|dishes|specialties|especialidades)/i,
    /(dinner|lunch|breakfast|cena|almuerzo|desayuno)/i,
    /(restaurant|restaurante|bar|cafeteria|cafe|bistro|pub)/i,
    /(eat|comer|dining|cenar|gastronomia|gastronomy)/i,
    /(cuisine|cocina|chef|kitchen|recetas|recipes)/i,
    /(tapas|raciones|pinchos|entrantes|starters|appetizers)/i,
    /(main-courses|platos-principales|postres|desserts)/i,
    /(bebidas|drinks|vinos|wines|cocktails|cocteles)/i,
    /(vegetarian|vegetariano|vegan|vegano|gluten-free|sin-gluten)/i,
    /(takeaway|para-llevar|delivery|domicilio)/i,
  ];
  
  // Patrones específicos para identificar rutas de cartas
  const cartaPathPatterns = [
    /(carta|menu|food|comida)/i
  ];
  
  // Determinar qué patrones usar según el modo de filtrado
  const excludePatterns = options.customExcludePatterns 
    ? options.customExcludePatterns.map(p => new RegExp(p, 'i'))
    : defaultExcludePatterns;
    
  const includePatterns = options.customIncludePatterns
    ? options.customIncludePatterns.map(p => new RegExp(p, 'i'))
    : (filterMode === 'menu' ? menuIncludePatterns : []);
  
  // Validar y normalizar la URL del dominio
  let baseUrl: URL;
  try {
    baseUrl = new URL(domainUrl);
  } catch (error) {
    throw new Error(`URL de dominio inválida: ${domainUrl}`);
  }
  
  const baseDomain = baseUrl.hostname;
  
  // Conjunto para almacenar URLs únicas encontradas
  const foundUrls = new Set<string>([baseUrl.toString()]);
  const externalUrls = new Set<string>();
  
  // Cola de URLs para procesar
  const urlQueue: Array<{ url: string; depth: number; noDepthLimit?: boolean }> = [
    { url: baseUrl.toString(), depth: 0, noDepthLimit: false }
  ];
  
  // URLs ya visitadas
  const visitedUrls = new Set<string>();
  
  // Control de tiempo
  const startTime = Date.now();
  let timedOut = false;
  
  // Rutas prioritarias para la búsqueda adaptativa
  const priorityPaths = new Set<string>();
  let adaptiveMode = false; // Se activará después de procesar el primer nivel
  
  // Procesar URLs mientras haya en la cola y no excedamos el límite
  while (urlQueue.length > 0 && foundUrls.size < maxUrls && !timedOut) {
    // Verificar si se ha agotado el tiempo
    if (Date.now() - startTime > timeoutMs) {
      timedOut = true;
      break;
    }
    
    // Tomar un lote de URLs para procesar en paralelo
    const batch: Array<{ url: string; depth: number; noDepthLimit?: boolean }> = [];
    for (let i = 0; i < batchSize && urlQueue.length > 0; i++) {
      const item = urlQueue.shift();
      if (item) {
        batch.push(item);
      }
    }
    
    // Procesar el lote en paralelo
    await Promise.all(batch.map(async ({ url, depth, noDepthLimit = false }) => {
      // Skip if visited or beyond depth limit (unless infinite depth)
      if (visitedUrls.has(url) || (!noDepthLimit && depth >= maxDepth)) {
        return;
      }
      
      // Marcar como visitada
      visitedUrls.add(url);
      
      try {
        // Verificar si estamos en modo adaptativo y si esta URL no está en una ruta prioritaria
        if (adaptiveSearch && adaptiveMode && priorityPaths.size > 0) {
          const currentUrl = new URL(url);
          const currentPath = currentUrl.pathname;
          
          // Verificar si esta URL está en alguna de las rutas prioritarias
          const isInPriorityPath = Array.from(priorityPaths).some(priorityPath => 
            currentPath.startsWith(priorityPath)
          );
          
          // Si no está en una ruta prioritaria y no estamos en el nivel 0, saltar
          if (!isInPriorityPath && depth > 0) {
            return;
          }
        }
        
        // Hacer scraping de la página con un timeout individual
        const pageDataPromise = scrapeWebPage(url);
        
        // Crear un timeout para esta página específica
        const timeoutPromise = new Promise<null>((_, reject) => {
          setTimeout(() => reject(new Error("Timeout individual")), 5000); // 5 segundos por página
        });
        
        // Usar Promise.race para implementar el timeout
        const pageData = await Promise.race([pageDataPromise, timeoutPromise]) as Awaited<ReturnType<typeof scrapeWebPage>>;
        
        // Procesar los enlaces encontrados
        for (const link of pageData.links) {
          try {
            const linkUrl = new URL(link.url);
            
            // Verificar si el enlace pertenece al mismo dominio
            if (linkUrl.hostname === baseDomain) {
              // Aplicar filtros solo si no estamos en modo 'none'
              if (filterMode !== 'none') {
                const urlString = linkUrl.toString();
                const urlPath = linkUrl.pathname.toLowerCase();
                
                // Verificar si la URL debe ser excluida
                const shouldExclude = excludePatterns.some(pattern => 
                  pattern.test(urlString) || pattern.test(urlPath)
                );
                
                if (shouldExclude) {
                  continue; // Saltar esta URL
                }
                
                // Si hay patrones de inclusión, verificar si la URL coincide con alguno
                if (includePatterns.length > 0) {
                  // También verificar el texto del enlace para mayor contexto
                  const linkText = link.text.toLowerCase();
                  const shouldInclude = includePatterns.some(pattern => 
                    pattern.test(urlString) || pattern.test(urlPath) || pattern.test(linkText)
                  );
                  
                  // Si no coincide con ningún patrón de inclusión, saltar
                  if (!shouldInclude) {
                    continue;
                  }
                }
              }
              
              // Si estamos en el primer nivel (depth = 0) y tenemos búsqueda adaptativa activada,
              // verificar si esta URL contiene patrones de carta para añadirla a las rutas prioritarias
              if (adaptiveSearch && depth === 0) {
                const urlPath = linkUrl.pathname.toLowerCase();
                
                // Verificar si la ruta contiene patrones de carta
                const isCartaPath = cartaPathPatterns.some(pattern => 
                  pattern.test(urlPath)
                );
                
                if (isCartaPath) {
                  // Extraer el primer nivel de la ruta para priorizar
                  const pathSegments = urlPath.split('/').filter(segment => segment);
                  if (pathSegments.length > 0) {
                    const priorityPath = '/' + pathSegments[0];
                    priorityPaths.add(priorityPath);
                  }
                }
              }
              
              // Añadir a la colección si no existe
              if (!foundUrls.has(linkUrl.toString())) {
                foundUrls.add(linkUrl.toString());
                
                // Determine if this branch gets infinite depth
                const nextNoDepthLimit = noDepthLimit || cartaPathPatterns.some(pattern => pattern.test(linkUrl.pathname));
                
                // Añadir a la cola para procesar si no excedemos la profundidad
                if (nextNoDepthLimit || depth + 1 < maxDepth) {
                  urlQueue.push({ url: linkUrl.toString(), depth: depth + 1, noDepthLimit: nextNoDepthLimit });
                }
              }
            } else if (includeExternalLinks) {
              // Guardar enlaces externos si se solicita
              externalUrls.add(linkUrl.toString());
            }
          } catch (e) {
            // Ignorar URLs inválidas
          }
        }
      } catch (error) {
        // Ignorar errores en páginas individuales para continuar con otras
        // No usar console.error para evitar ruido en la consola
      }
    }));
    
    // Después de procesar el primer nivel, activar el modo adaptativo si encontramos rutas prioritarias
    if (adaptiveSearch && !adaptiveMode) {
      const allProcessedInDepthZero = batch.every(item => item.depth > 0);
      if (allProcessedInDepthZero && priorityPaths.size > 0) {
        adaptiveMode = true;
      }
    }
    
    // Verificar si hemos alcanzado el límite máximo de URLs
    if (foundUrls.size >= maxUrls) {
      break;
    }
  }
  
  // Filtrar las URLs encontradas para la respuesta final
  let filteredUrls = Array.from(foundUrls);

  console.log(`[list_domain_urls] Found ${filteredUrls.length} URLs`);
  
  // Si estamos en modo de filtrado, aplicar filtros adicionales a las URLs encontradas
  if (filterMode !== 'none') {
    filteredUrls = filteredUrls.filter(url => {
      // Verificar si la URL coincide con algún patrón de inclusión
      if (includePatterns.length > 0) {
        return includePatterns.some(pattern => pattern.test(url));
      }
      return true;
    });
  }
  
  // Ordenar las URLs por subruta (primer segmento) y luego alfabéticamente
  filteredUrls.sort((a, b) => {
    const aPath = new URL(a).pathname.split('/').filter(Boolean);
    const bPath = new URL(b).pathname.split('/').filter(Boolean);
    const aSub = aPath[0] || '';
    const bSub = bPath[0] || '';
    if (aSub < bSub) return -1;
    if (aSub > bSub) return 1;
    // mismo subruta, ordenar por URL completa
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  
  return {
    domain: baseDomain,
    urlsFound: foundUrls.size,
    urls: Array.from(foundUrls),
    filteredUrls,
    ...(priorityPaths.size > 0 ? { priorityPaths: Array.from(priorityPaths) } : {}),
    ...(includeExternalLinks ? { externalUrls: Array.from(externalUrls) } : {}),
    timedOut
  };
}
