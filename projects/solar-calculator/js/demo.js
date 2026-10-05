/*
 * demo.js — a seeded, deterministic synthetic household for demo and manual modes.
 *
 * load_t = serverW·Δt (constant, the 24/7 servers) + household_t·scale
 *
 * household_t (W, then ×Δt) is the sum of:
 *   1. standby 45 W (router, set-top boxes, chargers) + a fridge-freezer that cycles,
 *      drawn uniformly in 0–80 W per half-hour. Disabled by `householdFloor: false`
 *      (manual mode, where the user's base load already includes standby).
 *   2. activity: a 48-slot weekday and a weekend template (local wall clock) with a
 *      weekday morning peak 06:30–08:00, a quiet working day, a cooking peak 17:30–19:00
 *      that overlaps the Agile 16:00–19:00 peak, and a long evening tail; weekends start
 *      later, add a lunchtime peak and a busier afternoon. Multiplied by a seasonal factor
 *      1 + 0.15·cos(2π(doy − 15)/365.25) (winter +15%, summer −15%), a per-day factor
 *      (≈N(1, 0.12), clamped 0.7–1.4) and per-slot noise ×U(0.75, 1.25).
 *   3. lighting: 120 W ×U(0.8, 1.2) from 30 min before sunset until 23:30, and from
 *      06:30 (weekend 08:00) until 30 min after sunrise. Sunrise/sunset come from the
 *      solar declination at London's latitude (noon ≈ 12:00 GMT), shifted to BST in
 *      summer — so lighting moves into the 16–19 window in winter only.
 *   4. appliance events: washing machine (45% of days, 1.5 kWh over 3 slots), dishwasher
 *      (60%, 1.05 kWh), oven (50% weekdays / 65% weekends, 0.65 kWh), 3–7 kettle boils
 *      (0.04 kWh each) — placed at seeded random times in plausible windows.
 * The household part is then scaled so it totals exactly householdKwhYr per 365 days of
 * window (2,700 kWh/yr default, a typical UK home without electric heating). With the
 * floor on, the always-on estimate comes out ≈ serverW + 50 W (standby + fridge lows).
 *
 * Same (local index, options) → bit-identical output: a mulberry32 PRNG seeded from
 * `seed` is consumed in slot order and nothing reads the clock.
 */

import { DT_H, ukOffsetMs } from './time.js';

/** Weekday activity template, W per local half-hour (hh 0 = 00:00). */
const WEEKDAY = [
    15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,             // 00:00–05:30
    60, 250, 450, 420, 260, 120,                                 // 06:00–08:30
    70, 70, 70, 70, 70, 70, 70, 70, 70, 70, 70, 70, 70, 70,      // 09:00–15:30
    120, 200, 350, 600, 700, 560,                                // 16:00–18:30
    420, 380, 360, 350, 330, 300, 240, 160, 80, 35,              // 19:00–23:30
];

/** Weekend activity template, W per local half-hour. */
const WEEKEND = [
    90, 50, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25,              // 00:00–05:30
    30, 40, 80, 150, 300, 420, 450, 400, 320, 280, 280, 300,     // 06:00–11:30
    420, 450, 330, 250, 230, 230, 230, 230,                      // 12:00–15:30
    250, 300, 420, 620, 680, 560,                                // 16:00–18:30
    420, 400, 380, 370, 350, 320, 260, 200, 120, 60,             // 19:00–23:30
];

const STANDBY_W = 45;
const FRIDGE_MAX_W = 80;
const LIGHT_W = 120;
const LONDON_LAT_RAD = 51.5 * Math.PI / 180;

/** mulberry32: tiny, fast, good enough for synthetic noise; seeded so runs repeat. */
export function mulberry32(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function rand() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function dayOfYear(date) {
    const [y, m, d] = date.split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86_400_000);
}

/** Sunrise/sunset in LOCAL clock hours for a date (London latitude, noon at 12:00 GMT). */
function sunTimes(date) {
    const doy = dayOfYear(date);
    const decl = 23.44 * Math.PI / 180 * Math.sin(2 * Math.PI * (284 + doy) / 365);
    const cosW = Math.max(-1, Math.min(1, -Math.tan(LONDON_LAT_RAD) * Math.tan(decl)));
    const half = Math.acos(cosW) * 180 / Math.PI / 15;
    const off = ukOffsetMs(Date.parse(`${date}T12:00:00Z`)) / 3_600_000;
    return { rise: 12 - half + off, set: 12 + half + off };
}

/** Pick a slot hh uniformly in [a, b]. */
const pick = (rand, a, b) => a + Math.floor(rand() * (b - a + 1));

/**
 * Synthetic half-hourly load on a LocalIndex grid (see the model above).
 *
 * @param {import('./time.js').LocalIndex} local  from buildLocalIndex(start, n)
 * @param {{ serverW?: number, householdKwhYr?: number, seed?: number, householdFloor?: boolean }} [opts]
 * @returns {Float64Array} kWh per slot
 */
export function syntheticLoad(local, { serverW = 500, householdKwhYr = 2700, seed = 1, householdFloor = true } = {}) {
    const n = local.hh.length;
    const rand = mulberry32(seed);
    const house = new Float64Array(n);
    // Slots of each local day, so day-level draws happen once per day in order.
    for (const day of local.days) {
        const { date, first, count } = day;
        const weekend = local.dow[first] >= 5;
        const tpl = weekend ? WEEKEND : WEEKDAY;
        const doy = dayOfYear(date);
        const season = 1 + 0.15 * Math.cos(2 * Math.PI * (doy - 15) / 365.25);
        // Box-Muller-free approximation of N(1, 0.12): sum of 3 uniforms.
        const dayFactor = Math.min(1.4, Math.max(0.7, 1 + 0.12 * ((rand() + rand() + rand() - 1.5) * 2)));
        const { rise, set } = sunTimes(date);
        const morningOn = weekend ? 8 : 6.5;

        // Appliance events for the day, as kWh added to (hh → kWh).
        const extra = new Float64Array(48);
        const add = (hh, kwhs) => kwhs.forEach((k, i) => { if (hh + i < 48) extra[hh + i] += k; });
        if (rand() < 0.45) add(weekend ? pick(rand, 18, 30) : pick(rand, 36, 42), [0.9, 0.35, 0.25]);
        if (rand() < 0.6) add(pick(rand, 40, 44), [0.55, 0.15, 0.35]);
        if (rand() < (weekend ? 0.65 : 0.5)) add(pick(rand, 34, 36), [0.35, 0.3]);
        const boils = 3 + Math.floor(rand() * 5);
        const kettleWindows = [[13, 17], [24, 26], [30, 36], [40, 43]];
        for (let k = 0; k < boils; k++) {
            const [a, b] = kettleWindows[Math.floor(rand() * kettleWindows.length)];
            extra[pick(rand, a, b)] += 0.04;
        }

        for (let t = first; t < first + count; t++) {
            const hh = local.hh[t];
            const mid = hh / 2 + 0.25; // local clock hours at the slot midpoint
            let w = tpl[hh] * season * dayFactor * (0.75 + 0.5 * rand());
            if (householdFloor) w += STANDBY_W + FRIDGE_MAX_W * rand();
            const evening = mid >= set - 0.5 && mid < 23.5;
            const morning = mid >= morningOn && mid < rise + 0.5;
            if (evening || morning) w += LIGHT_W * (0.8 + 0.4 * rand());
            house[t] = w * DT_H / 1000 + extra[hh];
        }
    }
    let sum = 0;
    for (let t = 0; t < n; t++) sum += house[t];
    const target = householdKwhYr * (n / (365 * 48));
    const scale = sum > 0 ? target / sum : 0;
    const server = Math.max(0, serverW) * DT_H / 1000;
    const out = new Float64Array(n);
    for (let t = 0; t < n; t++) out[t] = server + house[t] * scale;
    return out;
}
