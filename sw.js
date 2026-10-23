// 앱 셸 캐시: 오프라인에서도 앱이 열리고 저장된 기록을 볼 수 있게 한다.
// 번역 요청(api.anthropic.com)은 캐시하지 않는다.
// 배포할 때 CACHE 버전을 올리면 이전 캐시가 정리된다.

// 글꼴 조각(fonts/subset/*.woff2)은 화면에 필요한 것만 받아지고 아래 fetch 처리에서 자동으로 캐시된다.
const CACHE = "biztr-shell-v14";
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 다른 앱에서 「공유 → Biz 번역」 (안드로이드, manifest 의 share_target).
// 카톡 · Zalo · 갤러리 · 캡처 도구에서 보낸 사진을 잠깐 맡아 두고, 앱을 열어 첫 화면에서 꺼내 간다.
const SHARE_CACHE = "biztr-share";

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll("images").filter((f) => f && typeof f === "object" && f.size > 0);
    const text = [form.get("title"), form.get("text"), form.get("url")].filter(Boolean).join("\n").trim();
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) await cache.delete(key);
    const names = [];
    for (const [i, file] of files.slice(0, 4).entries()) {
      const name = `shared/${Date.now()}-${i}`;
      await cache.put(name, new Response(file, { headers: { "content-type": file.type || "image/png" } }));
      names.push(name);
    }
    await cache.put("shared/meta", new Response(JSON.stringify({ names, text, at: Date.now() }), { headers: { "content-type": "application/json" } }));
  } catch {
    /* 못 받아도 앱은 연다 */
  }
  return Response.redirect("./?share=1", 303);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/share-target")) {
    event.respondWith(receiveShare(request));
    return;
  }
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
