/*
 * Service worker de Canticora web (ADR-023).
 *
 * Estrategia:
 *  - Instalación: se precarga el cascarón completo —incluidos los `.wasm` y el catálogo de
 *    ejemplo— para que la app funcione sin conexión desde la primera visita. La lista la genera el
 *    despliegue (`webApp/tools/make-precache.mjs`) porque los artefactos de Kotlin/Wasm llevan
 *    hash.
 *  - Navegación: red primero (para estrenar cada versión del cascarón en cuanto se publica) y
 *    caché como respaldo.
 *  - Recursos con hash (`.wasm`, iconos): caché primero, son inmutables. El catálogo de ejemplo
 *    también se cachea, así la segunda apertura no lo vuelve a descargar.
 *  - **Cascarón sin hash** (`canticora.js`, `precache-manifest.js`): red primero. Si se sirvieran
 *    de caché, el index nuevo pediría el `.js` viejo y una publicación no llegaría nunca al
 *    usuario que ya tiene la app instalada.
 *
 * Al cambiar el cascarón (index.html, estilos de espera, iconos o código) hay que subir VERSION;
 * el despliegue además le añade el commit publicado, así que dos versiones nunca comparten caché.
 */
const VERSION = 'v4+f398d5b';
const PREFIX = 'canticora-web-';
const CACHE = PREFIX + VERSION;

/** Respaldo mínimo si el manifiesto generado no está disponible. */
const PRECACHE_FALLBACK = [
    './',
    './index.html',
    './manifest.webmanifest',
    './canticora.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/favicon-32.png',
    './icons/apple-touch-icon.png'
];

/** Cascarón sin hash en el nombre: no puede servirse de caché sin arriesgar quedarse atrás. */
const UNHASHED_SHELL = /(?:^|\/)(?:canticora\.js|precache-manifest\.js)$/;

function precacheList() {
    try {
        importScripts('./precache-manifest.js');
    } catch (error) {
        return PRECACHE_FALLBACK;
    }
    const generated = self.__CANTICORA_PRECACHE__;
    return Array.isArray(generated) && generated.length > 0 ? generated : PRECACHE_FALLBACK;
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        const urls = precacheList();
        // Uno a uno: un recurso ausente no debe invalidar la instalación entera.
        await Promise.all(urls.map((url) => cache.add(url).catch(() => undefined)));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(
            names
                .filter((name) => name.startsWith(PREFIX) && name !== CACHE)
                .map((name) => caches.delete(name))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate' || UNHASHED_SHELL.test(url.pathname)) {
        event.respondWith(networkFirst(request));
        return;
    }

    event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE);
    try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
    } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        const shell = await cache.match('./index.html');
        if (shell) return shell;
        throw error;
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
        await cache.put(request, response.clone());
    }
    return response;
}
