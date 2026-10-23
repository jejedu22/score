// Service worker : coquille de l'application en cache, dernier état connu disponible hors ligne.
const CACHE = 'belote-v2';
const SHELL = ['./', 'coinche.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Réseau d'abord (données et page toujours à jour), cache en secours hors ligne.
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) {
      // Signale à la page qu'elle affiche une copie locale
      const headers = new Headers(hit.headers);
      headers.set('X-Offline', '1');
      return new Response(hit.body, { status: hit.status, headers });
    }
    throw err;
  }
}

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  // Les écritures (POST/DELETE) passent directement au serveur.
  if (request.mode === 'navigate') e.respondWith(networkFirst(request).catch(() => caches.match('./')));
  else e.respondWith(networkFirst(request));
});
