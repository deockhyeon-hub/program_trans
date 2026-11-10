// Workbox 7.4.1 (CDN) 서비스워커. 배포할 때 버전 숫자를 올릴 필요 없다.
// 화면(HTML)은 네트워크 먼저(3초 넘으면 캐시), CSS/JS 는 캐시를 먼저 보여 주고 뒤에서 새로 받는다.
// 번역 요청(바깥 API)은 캐시하지 않는다 : 같은 주소(origin)가 아니면 아무 라우트도 안 만든다.
importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.4.1/workbox-sw.js");

self.skipWaiting();
workbox.core.clientsClaim();


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

const { registerRoute } = workbox.routing;
const { NetworkFirst, StaleWhileRevalidate, CacheFirst } = workbox.strategies;
const { ExpirationPlugin } = workbox.expiration;
const sameOrigin = ({ url }) => url.origin === self.location.origin;

// 공유 받기(POST)는 가장 먼저.
registerRoute(({ url }) => url.pathname.endsWith("/share-target"), ({ request }) => receiveShare(request), "POST");

// 주소 뒤 ?share=1 같은 꼬리는 캐시 이름에서 뺀다(오프라인에서도 열리게).
const stripSearch = { cacheKeyWillBeUsed: async ({ request }) => { const u = new URL(request.url); u.search = ""; return u.href; } };

registerRoute(
  ({ request, url }) => request.mode === "navigate" && url.origin === self.location.origin,
  new NetworkFirst({ cacheName: "biztr-html", networkTimeoutSeconds: 3, plugins: [stripSearch] }),
);
registerRoute(
  (c) => sameOrigin(c) && ["style", "script", "manifest"].includes(c.request.destination),
  new StaleWhileRevalidate({ cacheName: "biztr-static" }),
);
registerRoute(
  (c) => sameOrigin(c) && (["image", "font"].includes(c.request.destination) || c.url.pathname.endsWith(".woff2")),
  new CacheFirst({ cacheName: "biztr-assets", plugins: [new ExpirationPlugin({ maxAgeSeconds: 30 * 86400, maxEntries: 120 })] }),
);

// 옛 손수 캐시(biztr-shell-v*)는 지운다.
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("biztr-shell-")).map((k) => caches.delete(k)))));
});
