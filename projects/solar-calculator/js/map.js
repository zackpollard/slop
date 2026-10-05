/*
 * map.js — Leaflet location picker and azimuth handle.
 *
 * Leaflet (1.9.4, the same build projects/roof-calculator uses) is only fetched from cdnjs the first
 * time a map is actually shown — most visits never need it. Markers are CSS divIcons, so Leaflet's
 * default PNG markers (which the CSP's img-src wouldn't allow from cdnjs anyway) are never requested.
 *
 * Satellite imagery is Esri World Imagery; "Map" is OpenStreetMap (whose tile policy needs the
 * default Referer, so the page must not set referrer=no-referrer).
 */

import { h, segmented, fmt } from './ui.js';

const LEAFLET_VERSION = '1.9.4';
const LEAFLET_CSS = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VERSION}/leaflet.min.css`;
const LEAFLET_JS = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VERSION}/leaflet.min.js`;
const UK_CENTRE = { lat: 53.8, lon: -2.4, zoom: 6 };

const TILES = {
    satellite: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        options: { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
    },
    map: {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        options: { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' },
    },
};

let leafletPromise = null;

/**
 * Load Leaflet once (CSS + script from cdnjs).
 * @returns {Promise<object>} the Leaflet namespace (window.L)
 */
export function loadLeaflet() {
    if (globalThis.L?.map) return Promise.resolve(globalThis.L);
    leafletPromise ??= new Promise((resolve, reject) => {
        if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
            document.head.appendChild(h('link', { rel: 'stylesheet', href: LEAFLET_CSS, crossorigin: 'anonymous' }));
        }
        const s = h('script', { src: LEAFLET_JS, async: true, crossorigin: 'anonymous' });
        s.addEventListener('load', () => (globalThis.L?.map ? resolve(globalThis.L) : reject(new Error('The map library loaded but did not start.'))));
        s.addEventListener('error', () => { leafletPromise = null; s.remove(); reject(new Error('Couldn’t load the map library — check your connection.')); });
        document.head.appendChild(s);
    });
    return leafletPromise;
}

const round5 = v => Math.round(v * 1e5) / 1e5;

function frame(el) {
    el.classList.add('map-box');
    const loading = h('div', { class: 'map-loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), '  Loading map…');
    const host = h('div', { style: { position: 'absolute', inset: '0' } });
    el.replaceChildren(host, loading);
    return { host, loading };
}

function baseMap(L, host, center, zoom) {
    const map = L.map(host, { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([center.lat, center.lon], zoom);
    const layers = { satellite: L.tileLayer(TILES.satellite.url, TILES.satellite.options), map: L.tileLayer(TILES.map.url, TILES.map.options) };
    let active = 'satellite';
    layers[active].addTo(map);
    map.attributionControl.setPrefix(false);
    const setLayer = key => {
        if (key === active || !layers[key]) return;
        map.removeLayer(layers[active]);
        layers[key].addTo(map);
        active = key;
    };
    // Leaflet measures its container once; tabs and <details> resize it later.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize()) : null;
    ro?.observe(host);
    return { map, setLayer, ro };
}

function layerSwitch(el, setLayer) {
    const seg = segmented({
        size: 'sm', ariaLabel: 'Map style', value: 'satellite',
        options: [{ value: 'satellite', label: 'Satellite' }, { value: 'map', label: 'Map' }],
        onChange: setLayer,
    });
    const box = h('div', { class: 'map-layers' }, seg);
    // Keep map drags/zooms from starting on the control.
    for (const ev of ['pointerdown', 'dblclick', 'wheel']) box.addEventListener(ev, e => e.stopPropagation());
    el.appendChild(box);
}

/**
 * A satellite map with a draggable pin; clicking moves the pin. onChange gets the new position.
 * @param {HTMLElement} el container (gets the .map-box styling; give it a height or use the default 320px)
 * @param {{ lat?: number|null, lon?: number|null, zoom?: number, onChange?: (pos: { lat: number, lon: number }) => void }} opts
 * @returns {Promise<{ map: object, setView(lat: number, lon: number, zoom?: number): void, getLatLng(): { lat: number, lon: number }|null, destroy(): void }>}
 */
export async function createLocationMap(el, { lat = null, lon = null, zoom, onChange } = {}) {
    const { host, loading } = frame(el);
    let L;
    try { L = await loadLeaflet(); } catch (err) {
        loading.replaceChildren(err.message);
        throw err;
    }
    loading.remove();
    const has = Number.isFinite(lat) && Number.isFinite(lon);
    const start = has ? { lat, lon } : UK_CENTRE;
    const { map, setLayer, ro } = baseMap(L, host, start, zoom ?? (has ? 18 : UK_CENTRE.zoom));
    layerSwitch(el, setLayer);
    const readout = h('div', { class: 'map-readout', 'aria-live': 'polite' });
    el.appendChild(readout);
    const icon = L.divIcon({ className: '', html: '<div class="map-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
    let marker = null;
    const paint = p => { readout.textContent = p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : 'Click the map to set your home'; };
    const place = (ll, fire) => {
        const p = { lat: round5(ll.lat), lon: round5(ll.lng) };
        if (!marker) {
            marker = L.marker([p.lat, p.lon], { icon, draggable: true, keyboard: true, title: 'Your home (drag to move)' }).addTo(map);
            marker.on('dragend', () => place(marker.getLatLng(), true));
        } else marker.setLatLng([p.lat, p.lon]);
        paint(p);
        if (fire) onChange?.(p);
    };
    if (has) place({ lat, lng: lon }, false); else paint(null);
    map.on('click', e => place(e.latlng, true));
    return {
        map,
        setView(la, lo, z) {
            if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
            map.setView([la, lo], z ?? Math.max(map.getZoom(), 17));
            place({ lat: la, lng: lo }, false);
        },
        getLatLng() { if (!marker) return null; const p = marker.getLatLng(); return { lat: round5(p.lat), lon: round5(p.lng) }; },
        destroy() { ro?.disconnect(); map.remove(); el.replaceChildren(); },
    };
}

/**
 * Point a panel direction on the satellite view: a fixed pin at the home and a handle you drag
 * round it. The arrow shows the way the panels face (compass azimuth, 0 = N, 90 = E).
 * @param {HTMLElement} el
 * @param {{ lat: number, lon: number, azimuth?: number, zoom?: number, onChange?: (azimuth: number) => void }} opts
 * @returns {Promise<{ map: object, setAzimuth(az: number): void, destroy(): void }>}
 */
export async function createAzimuthPicker(el, { lat, lon, azimuth = 180, zoom = 19, onChange } = {}) {
    const { host, loading } = frame(el);
    let L;
    try { L = await loadLeaflet(); } catch (err) {
        loading.replaceChildren(err.message);
        throw err;
    }
    loading.remove();
    const center = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : UK_CENTRE;
    const { map, setLayer, ro } = baseMap(L, host, center, Number.isFinite(lat) ? zoom : UK_CENTRE.zoom);
    layerSwitch(el, setLayer);
    const readout = h('div', { class: 'map-readout', 'aria-live': 'polite' });
    el.appendChild(readout);

    const pin = L.marker([center.lat, center.lon], { icon: L.divIcon({ className: '', html: '<div class="map-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false }).addTo(map);
    const handle = L.marker([center.lat, center.lon], {
        icon: L.divIcon({ className: '', html: '<div class="map-handle"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        draggable: true, keyboard: true, title: 'Drag to set the direction the panels face',
    }).addTo(map);
    const line = L.polyline([], { color: '#c4a24e', weight: 3, opacity: 0.95, interactive: false }).addTo(map);
    let az = ((Math.round(azimuth) % 360) + 360) % 360;
    const RADIUS_PX = 90;

    // Place in screen space so the handle stays a comfortable distance away at any zoom.
    const layout = () => {
        const c = map.latLngToContainerPoint([center.lat, center.lon]);
        const r = (az * Math.PI) / 180;
        const p = L.point(c.x + RADIUS_PX * Math.sin(r), c.y - RADIUS_PX * Math.cos(r));
        const ll = map.containerPointToLatLng(p);
        handle.setLatLng(ll);
        line.setLatLngs([[center.lat, center.lon], ll]);
        readout.textContent = `Panels face ${fmt.compass(az)} · ${az}°`;
    };
    handle.on('drag', () => {
        const c = map.latLngToContainerPoint([center.lat, center.lon]);
        const p = map.latLngToContainerPoint(handle.getLatLng());
        const a = (Math.atan2(p.x - c.x, -(p.y - c.y)) * 180) / Math.PI;
        az = ((Math.round(a) % 360) + 360) % 360;
        line.setLatLngs([[center.lat, center.lon], handle.getLatLng()]);
        readout.textContent = `Panels face ${fmt.compass(az)} · ${az}°`;
    });
    handle.on('dragend', () => { layout(); onChange?.(az); });
    map.on('zoomend moveend resize', layout);
    layout();
    void pin;
    return {
        map,
        setAzimuth(a) { if (Number.isFinite(a)) { az = ((Math.round(a) % 360) + 360) % 360; layout(); } },
        destroy() { ro?.disconnect(); map.remove(); el.replaceChildren(); },
    };
}
