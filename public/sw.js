// App-shell cache: the UI loads offline / on flaky mobile data; API calls always go to the network.
const CACHE = 'usta-v2';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  // network-first for the shell so deploys show up immediately; fall back to cache offline
  e.respondWith(fetch(e.request).then(r => { if (r.ok && SHELL.includes(u.pathname)) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});
