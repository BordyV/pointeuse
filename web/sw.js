// Service worker minimal : met l'app en cache pour qu'elle s'ouvre hors connexion.
const CACHE = 'pointeuse-v2';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.json',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  '../shared/core.js', '../shared/planning.js',
];

// Un clic sur une notification (ex. « Arrivée pointée ») ouvre l'app.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow('./'))),
  );
});

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Réseau d'abord (pour avoir les mises à jour), cache en secours.
self.addEventListener('fetch', (e) => {
  // Les appels à Claude (POST, autre domaine) passent sans cache.
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request)),
  );
});
