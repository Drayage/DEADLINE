/*
 * DEADLINE 서비스워커 — 앱 셸 캐시(설치/오프라인 싱글플레이).
 * 온라인 대전은 Firebase(교차출처) 네트워크가 필요하므로 캐시하지 않는다.
 * index.html 갱신 시 CACHE 버전을 올린다.
 */
const CACHE = "deadline-v2";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon.svg",
  "./icon-maskable.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon-180.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // 같은 출처(앱 셸)만 처리. Firebase 등 외부는 그대로 네트워크.
  if (url.origin !== self.location.origin) return;
  // 네트워크 우선 + 실패 시 캐시 폴백(최신 index.html 유지하되 오프라인 대비).
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
  );
});
