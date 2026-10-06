// 앱 셸 캐시: 오프라인에서도 앱이 열리고 저장된 기록을 볼 수 있게 한다.
// 번역 요청(api.anthropic.com)은 캐시하지 않는다.
// 배포할 때 CACHE 버전을 올리면 이전 캐시가 정리된다.

// 글꼴 조각(fonts/subset/*.woff2)은 화면에 필요한 것만 받아지고 아래 fetch 처리에서 자동으로 캐시된다.
const CACHE = "biztr-shell-v9";
const SHELL = [
  "./", "index.html", "css/design.css", "css/styles.css", "fonts/pretendard.css",
  "js/theme-boot.js", "js/app.js", "js/api.js", "js/store.js", "js/translator.js", "js/images.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;

  // 네트워크 우선: 새 배포가 바로 반영되고, 오프라인일 때만 캐시를 쓴다.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit ?? caches.match("index.html"))),
  );
});
