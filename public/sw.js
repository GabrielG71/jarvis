// Service worker mínimo: só existe para o app ser instalável. Tudo vai direto à rede
// (nada de cache; /api/ e o mp3 nunca são interceptados).
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('.mp3')) return
  e.respondWith(fetch(e.request))
})
