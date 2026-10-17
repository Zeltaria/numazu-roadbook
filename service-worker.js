/* service-worker.js — PWA Roadbook Numazu (roadbook §10).
 *
 * Stratégies :
 *   - HTML + données (data.js / places.json) : NETWORK-FIRST
 *     -> toujours frais quand en ligne, repli sur le cache hors-ligne.
 *       (évite de figer une ancienne base de données)
 *   - Coquille statique (css / js / vendor / icônes) : CACHE-FIRST versionné.
 *   - Tuiles OpenStreetMap : cache-first opportuniste, plafonné (carte hors-ligne
 *     sur les zones déjà consultées ; jamais obligatoire).
 *
 * Pour publier une mise à jour, incrémenter CACHE_VERSION.
 */
const CACHE_VERSION = "numazu-roadbook-v19";
const SHELL_CACHE = CACHE_VERSION + "-shell";
const TILE_CACHE = CACHE_VERSION + "-tiles";
const TILE_LIMIT = 350;

const SHELL_ASSETS = [
  "./", "./index.html", "./manifest.json",
  "./css/styles.css",
  "./vendor/leaflet.js", "./vendor/leaflet.css",
  "./js/data.js", "./js/storage.js", "./js/route-planner.js", "./js/map.js",
  "./js/export.js", "./js/app.js", "./js/sw-register.js",
  "./icons/icon-32.png", "./icons/icon-180.png",
  "./icons/icon-192.png", "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // résilient : on n'échoue pas l'installation si une ressource manque
    await Promise.allSettled(SHELL_ASSETS.map((u) => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isTile(url) {
  return /(^|\.)tile\.openstreetmap\.(org|de)$/.test(url.hostname) ||
         /(^|\.)tile\.osm\.org$/.test(url.hostname);
}
function isData(url) {
  return url.pathname.endsWith("/js/data.js") || url.pathname.endsWith("/data/places.json");
}

async function networkFirst(request, fallbackShell) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackShell) {
      const idx = await cache.match("./index.html");
      if (idx) return idx;
    }
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function tileCacheFirst(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.ok) {
    cache.put(request, res.clone());
    // plafonnement grossier : on supprime les plus anciennes entrées
    const keys = await cache.keys();
    if (keys.length > TILE_LIMIT) {
      for (let i = 0; i < keys.length - TILE_LIMIT; i++) cache.delete(keys[i]);
    }
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (isTile(url)) { event.respondWith(tileCacheFirst(req).catch(() => Response.error())); return; }

  if (url.origin === location.origin) {
    if (req.mode === "navigate" || isData(url)) {
      event.respondWith(networkFirst(req, req.mode === "navigate"));
    } else {
      event.respondWith(cacheFirst(req));
    }
  }
  // autres origines (ex. attribution) : réseau par défaut, on ne gère pas.
});
