const CACHE = 'aura-autonomous-client-v10';
const SHELL = ['./', './index.html', './client.js', './manifest.webmanifest'];
const OPTIONAL_ASSETS = ['/assets/icon_128x128.png', '/assets/settings/setting.png', '/assets/settings/color-wheel.png', '/assets/nav/music-library.png', '/assets/nav/search.png', '/assets/nav/diamond.png', '/assets/nav/heart.png', '/assets/nav/playlists.png', '/assets/nav/down-arrow.png', '/assets/nav/statistic.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    await cache.addAll(SHELL);
    await Promise.all(OPTIONAL_ASSETS.map(asset => cache.add(asset).catch(() => null)));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('aura-autonomous-') && key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' && url.pathname.startsWith('/autonomousclientmobile')) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put('./', response.clone()));
      return response;
    }).catch(async () => (await caches.match('./')) || (await caches.match('./index.html')) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/autonomousclientmobile/')) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    })));
  }
});
