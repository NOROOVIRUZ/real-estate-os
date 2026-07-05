'use strict';

const CACHE = 'reos-v2';
const SHELL = ['./index.html', './app.js', './styles.css', './icon.svg', './icon-192.png'];

self.addEventListener('install', e => {
  // 일부 실패해도 설치 계속 (addAll은 하나라도 실패 시 전체 실패)
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.allSettled(SHELL.map(url => c.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks =>
      Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  let url;
  try { url = new URL(e.request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 네트워크 우선, 실패 시 캐시 폴백
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
