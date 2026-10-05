/*
 * vat.js — VAT on domestic electricity as a schedule over time.
 *
 * Octopus's value_inc_vat on long-lived records (standing charges, flat tariffs) is retroactively
 * rewritten when the rate changes, so the app always prices from value_exc_vat and applies this
 * schedule itself. Export income is never VAT'd and must not pass through here.
 */

import { SLOT_MS } from './time.js';

/**
 * UK domestic electricity VAT: 5% until 1 Oct 2026 00:00 BST, 0% (temporary relief) until
 * 1 Apr 2027 00:00 BST, then back to 5%. Each entry applies to instants before `untilMs`.
 * @type {ReadonlyArray<{ untilMs: number, rate: number }>}
 */
export const DEFAULT_VAT_SCHEDULE = Object.freeze([
    Object.freeze({ untilMs: Date.parse('2026-09-30T23:00:00Z'), rate: 0.05 }),
    Object.freeze({ untilMs: Date.parse('2027-03-31T23:00:00Z'), rate: 0 }),
    Object.freeze({ untilMs: Infinity, rate: 0.05 }),
]);

/**
 * The default schedule, or the "VAT stays at 0%" variant the finance toggle offers.
 * @param {{ returnsTo5?: boolean }} [opts]
 * @returns {ReadonlyArray<{ untilMs: number, rate: number }>}
 */
export function vatSchedule({ returnsTo5 = true } = {}) {
    if (returnsTo5) return DEFAULT_VAT_SCHEDULE;
    return Object.freeze([DEFAULT_VAT_SCHEDULE[0], Object.freeze({ untilMs: Infinity, rate: 0 })]);
}

/**
 * VAT rate in force at an instant. Entries must be sorted by untilMs; instants past the last
 * entry keep its rate.
 * @param {number} ms UTC epoch ms
 * @param {ReadonlyArray<{ untilMs: number, rate: number }>|null} [schedule] null = the default
 * @returns {number} e.g. 0.05
 */
export function vatAt(ms, schedule = DEFAULT_VAT_SCHEDULE) {
    // null (e.g. an unset finance option serialised through the worker) means the default
    const sch = schedule ?? DEFAULT_VAT_SCHEDULE;
    for (const e of sch) if (ms < e.untilMs) return e.rate;
    return sch.length ? sch[sch.length - 1].rate : 0;
}

/**
 * Per-slot prices including VAT from ex-VAT prices.
 * @param {ArrayLike<number>} excArray p/kWh exc VAT, one per slot
 * @param {number} start UTC ms of slot 0
 * @param {ReadonlyArray<{ untilMs: number, rate: number }>|null} [schedule] null = the default
 * @returns {Float64Array}
 */
export function withVat(excArray, start, schedule = DEFAULT_VAT_SCHEDULE) {
    schedule = schedule ?? DEFAULT_VAT_SCHEDULE;
    const n = excArray.length;
    const out = new Float64Array(n);
    if (!schedule.length) { out.set(excArray); return out; }
    let e = 0;
    for (let t = 0; t < n; t++) {
        // slots are ascending, so the schedule pointer only moves forward (the last entry is open-ended)
        const ms = start + t * SLOT_MS;
        while (e < schedule.length - 1 && ms >= schedule[e].untilMs) e++;
        out[t] = excArray[t] * (1 + schedule[e].rate);
    }
    return out;
}
