/*
 * csv.js — half-hourly consumption from a CSV file.
 *
 * Formats accepted:
 *   - Octopus "Download your data" exports. Header 'Consumption (kWh), Start, End' with a
 *     space after each comma (newer files add 'Estimated Cost Inc. Tax (p)' and
 *     'Standing Charge Inc. Tax (p)' columns). Timestamps are ISO with the local offset
 *     ('2025-10-26T01:00:00+01:00' then '...01:00:00Z'). Since Aug 2024 the import file
 *     OMITS half-hours with zero consumption and can print a zero as '0E-20'.
 *   - Generic 'start,kWh' / 'timestamp,value' / 'date,time,kwh' files, with or without
 *     a header (a few preamble lines such as 'MPAN: …' are skipped), comma/semicolon/tab
 *     separated, ascending or descending, kWh or Wh, values with or without a unit suffix.
 * The value column is the import/consumption one: an Export or generation column is never
 * read as usage (it is all zeros for most homes, which the gap rules would then discard).
 * Timestamps without an offset are read as Europe/London wall-clock time, unless the
 * header says UTC/GMT (and not also BST/UK/local, as in 'Date/Time (GMT/BST)'). In the October repeated hour, the first 01:xx is BST and the second
 * GMT (file order decides). a/b/yyyy dates are day-first unless the file proves otherwise
 * (a middle field above 12), and impossible dates are rejected rather than rolled over.
 * A file with only an end-of-interval column is shifted back by the reading length.
 * Readings at 5/10/15-minute resolution are summed into half-hours (incomplete half-hours
 * are dropped so they get gap-filled instead of under-counted); hourly readings are split
 * evenly (with a warning). Everything is keyed by UTC epoch ms of the slot start.
 */

import { SLOT_MS, ukOffsetMs, daysInMonth } from './time.js';
import { DataError } from './dataset.js';

const HOUR_MS = 3_600_000;
const MAX_ROW_WARNINGS = 5;
const HEADER_SEARCH_LINES = 12;

/** Split one CSV line, honouring double quotes. */
function splitLine(line, delim) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
            if (c === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
            } else cur += c;
        } else if (c === '"') q = true;
        else if (c === delim) { out.push(cur.trim()); cur = ''; }
        else cur += c;
    }
    out.push(cur.trim());
    return out;
}

function detectDelimiter(lines) {
    const sample = lines.slice(0, 20).join('\n');
    const counts = [',', ';', '\t'].map(d => [d, sample.split(d).length]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 1 ? counts[0][0] : ',';
}

/**
 * Convert a Europe/London wall-clock time (given as if it were UTC) to epoch ms.
 * `prevMs` resolves the repeated October hour by file order.
 * @param {number} wallMs  the wall-clock reading encoded with Date.UTC
 * @param {number} [prevMs]  UTC ms of the previous row
 * @returns {{ ms: number, note?: 'gap'|'ambiguous' }}
 */
export function londonWallToUtc(wallMs, prevMs = -Infinity) {
    const bst = wallMs - HOUR_MS;
    const bstOk = ukOffsetMs(bst) === HOUR_MS;
    const gmtOk = ukOffsetMs(wallMs) === 0;
    if (bstOk && gmtOk) return { ms: bst > prevMs ? bst : wallMs, note: 'ambiguous' };
    if (bstOk) return { ms: bst };
    if (gmtOk) return { ms: wallMs };
    return { ms: wallMs, note: 'gap' }; // 01:xx on the spring-forward night doesn't exist
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const DMY_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?)?$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ONLY_RE = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?$/i;

/** Date.UTC silently rolls 13/01 into next January; reject impossible fields instead. */
function validParts(y, mo, d, hh, mi, ss) {
    return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) && mi >= 0 && mi < 60 && ss >= 0 && ss < 61
        && hh >= 0 && (hh < 24 || (hh === 24 && mi === 0 && ss === 0));
}

/**
 * Parse one timestamp cell (optionally with a separate time cell).
 * @param {string} cell
 * @param {string|null} [timeCell]  time of day when the date is in another column
 * @param {number} [prevMs]  UTC ms of the previous row (resolves the repeated October hour)
 * @param {{ mdy?: boolean, utc?: boolean }} [opts]  mdy: a/b/yyyy is month/day (US order);
 *   utc: times without an offset are UTC rather than London wall clock
 * @returns {{ ms: number, local: boolean, note?: 'gap'|'ambiguous' }|null}  local = read as London wall clock
 */
export function parseTimestamp(cell, timeCell = null, prevMs = -Infinity, { mdy = false, utc = false } = {}) {
    let s = String(cell ?? '').trim().replace(/^"|"$/g, '');
    if (!s) return null;
    if (timeCell != null && String(timeCell).trim()) s = `${s} ${String(timeCell).trim()}`;
    const naive = wall => (utc ? { ms: wall, local: false } : { ...londonWallToUtc(wall, prevMs), local: true });
    if (/^\d{9,13}(\.\d+)?$/.test(s)) {
        const v = Number(s);
        const ms = v < 1e11 ? v * 1000 : v; // epoch seconds vs ms
        return { ms, local: false };
    }
    let m = ISO_RE.exec(s);
    if (m) {
        const [, y, mo, d, hh, mi, ss = '0', off] = m;
        if (!validParts(+y, +mo, +d, +hh, +mi, +ss)) return null;
        const wall = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
        if (off) {
            if (/^z$/i.test(off)) return { ms: wall, local: false };
            const sign = off[0] === '-' ? -1 : 1;
            const digits = off.slice(1).replace(':', '');
            const offMs = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
            return { ms: wall - offMs, local: false };
        }
        return naive(wall);
    }
    m = DMY_RE.exec(s);
    if (m) {
        const [, a, b, y, hh = '0', mi = '0', ss = '0', ampm] = m;
        const d = mdy ? +b : +a, mo = mdy ? +a : +b;
        let h = +hh;
        if (ampm) {
            if (h < 1 || h > 12) return null;
            h = (h % 12) + (/^p/i.test(ampm) ? 12 : 0);
        }
        if (!validParts(+y, mo, d, h, +mi, +ss)) return null;
        return naive(Date.UTC(+y, mo - 1, d, h, +mi, +ss));
    }
    m = DATE_RE.exec(s);
    if (m) {
        if (!validParts(+m[1], +m[2], +m[3], 0, 0, 0)) return null;
        return naive(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    }
    return null;
}

function parseNumber(cell, delim = ',') {
    let s = String(cell ?? '').trim().replace(/^"|"$/g, '').trim();
    if (!s) return NaN;
    // '0,25' in a semicolon/tab file is a decimal comma; '1,234.5' is a thousands separator.
    if (delim !== ',' && /^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    return s === '' ? NaN : Number(s); // handles '0E-20' and '0.093'
}

/** kWh from a value cell; a 'kWh'/'Wh' suffix in the cell wins over the column's unit. */
function parseEnergy(cell, delim, columnScale = 1) {
    let s = String(cell ?? '').trim().replace(/^"|"$/g, '').trim();
    let scale = columnScale;
    const unit = /\s*(kwh|wh)$/i.exec(s);
    if (unit) {
        scale = /^k/i.test(unit[1]) ? 1 : 0.001;
        s = s.slice(0, unit.index);
    }
    return parseNumber(s, delim) * scale;
}

const VALUE_EXCLUDE = /cost|charge|price|tax|£|\(p\)|export|generat|solar|feed|\bpv\b|\bnet\b|carbon|co2|temp|time|date|stamp|start|\bend\b|period|interval/;

/** Find column indexes from a header row; null when the row isn't a header. */
function mapHeader(cells) {
    const low = cells.map(c => c.toLowerCase().replace(/^﻿/, '').trim());
    const looksHeader = low.some(c => /[a-z]{3}/.test(c) && !/^\d/.test(c) && !ISO_RE.test(c));
    if (!looksHeader) return null;
    const find = (re, exclude) => low.findIndex(c => re.test(c) && !(exclude && exclude.test(c)));
    // Import/consumption first, so 'Export (kWh)' (or 'Generation') is never taken for usage.
    let value = find(/import|consumption|usage|demand|\bused\b/, VALUE_EXCLUDE);
    if (value < 0) value = find(/kwh|\bwh\b|energy|reading|value|amount/, VALUE_EXCLUDE);
    const end = find(/\bend\b|^to$|until|finish/);
    const date = find(/date|day/, /time|stamp/);
    const timeOnly = find(/time|hh:mm/, /date|stamp/);
    let start = find(/start|from|timestamp|time ?stamp|interval|begin|datetime|date\s*(?:&|and|\/)?\s*time|period|reading time/, /\bend\b|until|finish|kwh|consumption/);
    let time = -1;
    if (start >= 0 && start === date && timeOnly >= 0) time = timeOnly;
    if (start < 0 && date >= 0) { start = date; time = timeOnly; }
    if (start < 0 && timeOnly >= 0) start = timeOnly; // a full timestamp in a 'time' column
    let endOnly = false;
    if (start < 0 && end >= 0) { start = end; endOnly = true; }
    const timeHeaders = [start, time, end, date].filter(i => i >= 0).map(i => low[i]).join(' ');
    // 'Date/Time (GMT/BST)' or 'UK time (GMT)' is UK clock time, not UTC: only a header that
    // names UTC/GMT/Z without a local-time word switches the naive times to UTC.
    const zoneWord = /utc|gmt|\bz\b|zulu/.test(timeHeaders);
    const localWord = /bst|\buk\b|local|london|british|summer|wall.?clock/.test(timeHeaders);
    return {
        value, start, time, endOnly,
        end: endOnly ? -1 : end,
        date: date >= 0 && date !== start ? date : -1,
        utc: zoneWord && !localWord,
        ukClockHeader: zoneWord && localWord,
        scale: value >= 0 && /\bwh\b/.test(low[value]) && !/kwh/.test(low[value]) ? 0.001 : 1,
        octopus: low.some(c => /^consumption \(kwh\)$/.test(c)),
        text: cells.join(', '),
    };
}

/**
 * Locate the header (skipping preamble lines such as 'MPAN: …') or the first headerless
 * data line within the first few lines.
 */
function findColumns(lines, delim) {
    let firstHeader = null;
    for (let i = 0; i < Math.min(lines.length, HEADER_SEARCH_LINES); i++) {
        const cells = splitLine(lines[i], delim);
        const cols = mapHeader(cells);
        if (cols) {
            if (cols.value >= 0 && cols.start >= 0) return { cols, dataFrom: i + 1, format: cols.octopus ? 'octopus' : 'generic' };
            firstHeader ??= cols;
            continue;
        }
        const isTs = c => parseTimestamp(c) || parseTimestamp(c, null, -Infinity, { mdy: true });
        const tIdx = cells.findIndex(c => isTs(c));
        const vIdx = cells.findIndex((c, k) => k !== tIdx && !isTs(c) && Number.isFinite(parseEnergy(c, delim)));
        if (tIdx >= 0 && vIdx >= 0) {
            return { cols: { value: vIdx, start: tIdx, end: -1, time: -1, date: -1, endOnly: false, utc: false, scale: 1 }, dataFrom: i, format: 'headerless' };
        }
        break; // a data-looking line we can't read: no header will follow it
    }
    if (firstHeader) {
        throw new DataError('CSV', `Couldn't find a timestamp and a kWh column in the header (${firstHeader.text}).`, { action: 'useDemo' });
    }
    throw new DataError('CSV', "Couldn't recognise this file: expected a timestamp and a kWh value on each line.", { action: 'useDemo' });
}

/**
 * Parse a consumption CSV into half-hourly readings.
 *
 * @param {string} text
 * @returns {{ rows: Array<[number, number]>, format: 'octopus'|'generic'|'headerless', warnings: string[] }}
 *   rows: ascending, one per UTC slot start, kWh in that half-hour
 * @throws {DataError} code 'CSV' when nothing usable is found
 */
export function parseConsumptionCsv(text) {
    const warnings = [];
    const lines = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/).filter(l => l.trim() !== '');
    if (!lines.length) throw new DataError('CSV', 'The file is empty.', { action: 'useDemo' });
    const delim = detectDelimiter(lines);
    const { cols, dataFrom, format } = findColumns(lines, delim);
    if (dataFrom > 1 || (format === 'headerless' && dataFrom > 0)) warnings.push(`${format === 'headerless' ? dataFrom : dataFrom - 1} lines before the data were skipped.`);
    if (cols.scale !== 1) warnings.push('Readings are in Wh and were converted to kWh.');
    if (cols.utc) warnings.push('Times are read as UTC, as the header says.');
    else if (cols.ukClockHeader) warnings.push('Times are read as UK clock time (GMT in winter, BST in summer), as the header says.');

    const body = [];
    for (let i = dataFrom; i < lines.length; i++) body.push({ line: i + 1, cells: splitLine(lines[i], delim) });

    // The date part and time part of a row: a 'Start' column may hold only '00:30' with the
    // date in its own column.
    const stampOf = (cells, idx) => {
        const c = cells[idx] ?? '';
        if (cols.date >= 0 && TIME_ONLY_RE.test(c.trim())) return [cells[cols.date], c];
        return [c, idx === cols.start && cols.time >= 0 ? cells[cols.time] : null];
    };

    // US month/day order only when the file proves it (a middle field above 12, never a first).
    let dayFirst = 0, monthFirst = 0;
    for (const { cells } of body) {
        const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{4}/.exec(String(stampOf(cells, cols.start)[0] ?? '').trim());
        if (m) { if (+m[1] > 12) dayFirst++; if (+m[2] > 12) monthFirst++; }
    }
    const mdy = monthFirst > 0 && dayFirst === 0;
    if (mdy) warnings.push('Dates were read as month/day/year (US order).');
    else if (monthFirst && dayFirst) warnings.push('Some dates look month-first; all were read as day/month/year.');
    const opts = { mdy, utc: cols.utc };
    const stamp = (cells, idx, prev) => { const [a, b] = stampOf(cells, idx); return parseTimestamp(a, b, prev, opts); };

    // Newest-first files would resolve the repeated October hour backwards: read them reversed.
    let up = 0, down = 0, last = null;
    for (let i = 0; i < Math.min(body.length, 400); i++) {
        const ts = stamp(body[i].cells, cols.start);
        if (!ts) continue;
        if (last !== null) { if (ts.ms > last) up++; else if (ts.ms < last) down++; }
        last = ts.ms;
    }
    if (down > up) body.reverse();

    const raw = [];
    let bad = 0, negative = 0, gapTimes = 0, prev = -Infinity;
    const badRow = (line, why) => {
        bad++;
        if (bad <= MAX_ROW_WARNINGS) warnings.push(`Line ${line}: ${why}`);
    };
    for (const { line, cells } of body) {
        const ts = stamp(cells, cols.start, prev);
        if (!ts || !Number.isFinite(ts.ms)) { badRow(line, `unreadable time '${cells[cols.start] ?? ''}'`); continue; }
        const v = parseEnergy(cells[cols.value], delim, cols.scale);
        if (!Number.isFinite(v)) { badRow(line, `unreadable value '${cells[cols.value] ?? ''}'`); continue; }
        if (v < 0) { negative++; continue; }
        let durMs = null;
        if (cols.end >= 0) {
            const te = stamp(cells, cols.end, ts.ms);
            if (te && te.ms > ts.ms) durMs = te.ms - ts.ms;
        }
        if (ts.note === 'gap') gapTimes++;
        prev = ts.ms;
        raw.push([ts.ms, v, durMs]);
    }
    if (bad > MAX_ROW_WARNINGS) warnings.push(`…and ${bad - MAX_ROW_WARNINGS} more unreadable lines were skipped.`);
    if (negative) warnings.push(`${negative} negative readings were skipped (is this an export file?).`);
    if (gapTimes) warnings.push(`${gapTimes} times fall in the hour skipped when clocks go forward.`);
    if (!raw.length) throw new DataError('CSV', 'No readable half-hourly rows were found in the file.', { action: 'useDemo' });

    raw.sort((a, b) => a[0] - b[0]);
    // Resolution: the End column when present, else the smallest spacing between starts
    // that is common (≥10% of gaps). Missing rows make the median spacing useless, and
    // Octopus files drop zero rows, so the shortest common gap is the honest estimate.
    const freq = new Map();
    let total = 0;
    for (let i = 1; i < raw.length && total < 5000; i++) {
        const d = raw[i][0] - raw[i - 1][0];
        if (d > 0) { freq.set(d, (freq.get(d) ?? 0) + 1); total++; }
    }
    const common = [...freq.entries()].filter(([, c]) => c >= Math.max(1, total * 0.1)).map(([d]) => d);
    const spacing = common.length ? Math.min(...common) : SLOT_MS;
    const durs = raw.map(r => r[2]).filter(Boolean).sort((a, b) => a - b);
    const typical = durs.length ? durs[durs.length >> 1] : spacing;
    if (typical >= 23 * HOUR_MS) {
        throw new DataError('CSV', 'This file has daily (or longer) readings; half-hourly data is needed.', { action: 'useDemo' });
    }
    // Only 5/10/15/30/60-minute readings are meaningful; anything else is read as half-hourly.
    const valid = d => d === HOUR_MS || d === SLOT_MS || (d < SLOT_MS && SLOT_MS % d === 0);
    const step = valid(typical) ? typical : SLOT_MS;
    if (step === HOUR_MS) warnings.push('Readings are hourly; each hour was split evenly into two half-hours.');
    if (step < SLOT_MS) warnings.push(`Readings every ${Math.round(step / 60000)} minutes were added up into half-hours.`);
    if (cols.endOnly) warnings.push('Times mark the end of each reading and were moved to its start.');

    const bySlot = new Map();
    const parts = new Map(); // slot → sub-readings seen (short-interval files)
    const subSeen = new Set();
    let dupes = 0, misaligned = 0;
    for (const [t, v, dur] of raw) {
        const len = dur && valid(dur) ? dur : step;
        const ms = cols.endOnly ? t - len : t;
        if (len === HOUR_MS) {
            const s0 = Math.floor(ms / SLOT_MS) * SLOT_MS;
            if (s0 !== ms) misaligned++;
            for (let k = 0; k < 2; k++) {
                const key = s0 + k * SLOT_MS;
                if (bySlot.has(key)) dupes++; else bySlot.set(key, v / 2);
            }
            continue;
        }
        const key = Math.floor(ms / SLOT_MS) * SLOT_MS;
        if (len < SLOT_MS) {
            if (subSeen.has(ms)) { dupes++; continue; } // summing a repeated quarter-hour would double it
            subSeen.add(ms);
            bySlot.set(key, (bySlot.get(key) ?? 0) + v);
            parts.set(key, (parts.get(key) ?? 0) + 1);
            continue;
        }
        if (key !== ms) misaligned++;
        if (bySlot.has(key)) { dupes++; continue; }
        bySlot.set(key, v);
    }
    if (step < SLOT_MS) {
        // A half-hour missing some of its short readings would be under-counted; drop it so
        // it is estimated from similar days instead.
        const need = SLOT_MS / step;
        let partial = 0;
        for (const [key, c] of parts) if (c < need) { bySlot.delete(key); partial++; }
        if (partial) warnings.push(`${partial} half-hours had only some of their ${Math.round(step / 60000)}-minute readings and will be estimated.`);
    }
    if (dupes) warnings.push(`${dupes} duplicate half-hours were ignored (the first reading was kept).`);
    if (misaligned) warnings.push(`${misaligned} readings didn't start on :00 or :30 and were moved to their half-hour.`);
    if (!bySlot.size) throw new DataError('CSV', 'No complete half-hours were found in the file.', { action: 'useDemo' });

    const rows = [...bySlot.entries()].sort((a, b) => a[0] - b[0]);
    const span = rows[rows.length - 1][0] - rows[0][0] + SLOT_MS;
    const missing = Math.round(span / SLOT_MS) - rows.length;
    if (missing > 0 && format === 'octopus') {
        warnings.push(`${missing} half-hours are absent. Octopus files leave out half-hours with zero use; they will be estimated.`);
    } else if (missing > 0) {
        warnings.push(`${missing} half-hours are absent and will be estimated.`);
    }
    return { rows, format, warnings };
}
