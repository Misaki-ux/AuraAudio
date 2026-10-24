const CACHE_NAME = 'aura-mobile-v7';
const APP_SHELL = ['/mobile/', '/manifest.webmanifest', '/assets/icon_32x32.png', '/assets/icon_128x128.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(error => {
    console.warn('[AuraAudio] Could not cache the mobile app shell:', error);
  }));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('aura-mobile-') && key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  
  // Ignore non-GET, cross-origin, and API requests (especially media streaming)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
          }
          return response;
        }).catch(() => new Response('', { status: 404, statusText: 'Not Found' }));
      })
    );
    return;
  }
  
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/mobile/', clone)).catch(() => {});
        }
        return response;
      }).catch(async () => (await caches.match('/mobile/')) || (await caches.match(request)) || Response.error())
    );
  }
});