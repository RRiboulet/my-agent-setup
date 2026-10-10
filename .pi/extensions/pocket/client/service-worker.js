/* pocket phone client service worker.
 *
 * Network-first for everything, with a cached shell as the fallback. That order
 * is the whole point: the worker exists so a launch on a flaky connection paints
 * something immediately, and a worker that served its cache first would keep
 * showing a client from an older daemon after an upgrade.
 *
 * /api/ is never cached: a cached API response on a phone that just came back
 * into signal would show a story that stopped being true minutes ago.
 */

const SHELL = "/|/index.html|/app.js|/styles.css|/manifest.webmanifest|/icon.svg".split("|");

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open("pocket-shell")
			.then((cache) => cache.addAll(SHELL))
			.then(() => self.skipWaiting())
			.catch(() => undefined),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== "pocket-shell").map((key) => caches.delete(key))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith("/api/")) return; // never cache a session

	event.respondWith(
		fetch(request)
			.then((response) => {
				const copy = response.clone();
				void caches.open("pocket-shell").then((cache) => cache.put(request, copy)).catch(() => undefined);
				return response;
			})
			.catch(async () => {
				const cache = await caches.open("pocket-shell");
				return (await cache.match(request)) || (await cache.match("/index.html")) || Response.error();
			}),
	);
});
