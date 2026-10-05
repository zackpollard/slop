import { describe, it, expect } from 'vitest';
import { parseConsumptionCsv, parseTimestamp, londonWallToUtc } from '../../../projects/solar-calculator/js/csv.js';
import { DataError } from '../../../projects/solar-calculator/js/dataset.js';

const SLOT = 1_800_000;
const ms = s => Date.parse(s);

describe('Octopus "Download your data" CSV', () => {
    it('reads the classic export with BOM, CRLF, spaces after commas and mixed offsets', () => {
        const text = '﻿Consumption (kWh), Start, End\r\n'
            + ' 0.093, 2025-10-26T00:30:00+01:00, 2025-10-26T01:00:00+01:00\r\n'
            + ' 0.101, 2025-10-26T01:00:00+01:00, 2025-10-26T01:30:00+01:00\r\n'
            + ' 0.110, 2025-10-26T01:30:00+01:00, 2025-10-26T01:00:00Z\r\n'
            + ' 0.120, 2025-10-26T01:00:00Z, 2025-10-26T01:30:00Z\r\n'
            + ' 0E-20, 2025-10-26T01:30:00Z, 2025-10-26T02:00:00Z\r\n';
        const { rows, format, warnings } = parseConsumptionCsv(text);
        expect(format).toBe('octopus');
        expect(rows.map(r => r[0])).toEqual([
            ms('2025-10-25T23:30:00Z'), ms('2025-10-26T00:00:00Z'), ms('2025-10-26T00:30:00Z'),
            ms('2025-10-26T01:00:00Z'), ms('2025-10-26T01:30:00Z')]);
        expect(rows.map(r => r[1])).toEqual([0.093, 0.101, 0.11, 0.12, 0]);
        expect(warnings).toEqual([]);
    });

    it('reads the newer export with cost columns and warns that zero rows are omitted', () => {
        const text = 'Consumption (kwh), Estimated Cost Inc. Tax (p), Standing Charge Inc. Tax (p), Start, End\n'
            + '0.25, 4.1, 0.78, 2026-01-15T00:00:00Z, 2026-01-15T00:30:00Z\n'
            + '0.30, 4.9, 0.78, 2026-01-15T00:30:00Z, 2026-01-15T01:00:00Z\n'
            + '0.40, 6.6, 0.78, 2026-01-15T02:00:00Z, 2026-01-15T02:30:00Z\n';
        const { rows, format, warnings } = parseConsumptionCsv(text);
        expect(format).toBe('octopus');
        expect(rows).toEqual([[ms('2026-01-15T00:00:00Z'), 0.25], [ms('2026-01-15T00:30:00Z'), 0.3], [ms('2026-01-15T02:00:00Z'), 0.4]]);
        expect(warnings.join(' ')).toMatch(/2 half-hours are absent.*zero use/);
    });
});

describe('generic CSVs', () => {
    it("reads 'start,kWh' with naive local times (BST in summer, GMT in winter)", () => {
        const text = 'start,kWh\n2026-07-01 16:00,0.5\n2026-07-01 16:30,0.6\n2026-01-15 16:00,0.7\n';
        const { rows, format } = parseConsumptionCsv(text);
        expect(format).toBe('generic');
        expect(rows).toEqual([[ms('2026-01-15T16:00:00Z'), 0.7], [ms('2026-07-01T15:00:00Z'), 0.5], [ms('2026-07-01T15:30:00Z'), 0.6]]);
    });

    it("reads 'timestamp,value' and resolves the repeated October hour by file order", () => {
        const text = 'timestamp,value\n2025-10-26T00:30:00,1\n2025-10-26T01:00:00,2\n2025-10-26T01:30:00,3\n2025-10-26T01:00:00,4\n2025-10-26T01:30:00,5\n2025-10-26T02:00:00,6\n';
        const { rows } = parseConsumptionCsv(text);
        expect(rows).toEqual([
            [ms('2025-10-25T23:30:00Z'), 1], [ms('2025-10-26T00:00:00Z'), 2], [ms('2025-10-26T00:30:00Z'), 3],
            [ms('2025-10-26T01:00:00Z'), 4], [ms('2025-10-26T01:30:00Z'), 5], [ms('2025-10-26T02:00:00Z'), 6]]);
    });

    it('reads headerless files and separate date/time columns, semicolons and decimal commas', () => {
        const h = parseConsumptionCsv('2026-02-01T00:00:00Z,0.2\n2026-02-01T00:30:00Z,0.3\n');
        expect(h.format).toBe('headerless');
        expect(h.rows).toEqual([[ms('2026-02-01T00:00:00Z'), 0.2], [ms('2026-02-01T00:30:00Z'), 0.3]]);

        const dt = parseConsumptionCsv('Date;Time;kWh\n01/02/2026;00:00;0,25\n01/02/2026;00:30;0,35\n');
        expect(dt.rows).toEqual([[ms('2026-02-01T00:00:00Z'), 0.25], [ms('2026-02-01T00:30:00Z'), 0.35]]);

        const tab = parseConsumptionCsv('time\tusage\n2026-02-01T00:00:00Z\t1.5\n2026-02-01T00:30:00Z\t1.25\n');
        expect(tab.rows.map(r => r[1])).toEqual([1.5, 1.25]);
    });

    it('sums 15-minute readings into half-hours and splits hourly ones', () => {
        const q = parseConsumptionCsv('start,kwh\n2026-02-01T00:00Z,0.1\n2026-02-01T00:15Z,0.2\n2026-02-01T00:30Z,0.3\n2026-02-01T00:45Z,0.4\n');
        expect(q.rows.map(r => r[0])).toEqual([ms('2026-02-01T00:00:00Z'), ms('2026-02-01T00:30:00Z')]);
        expect(q.rows[0][1]).toBeCloseTo(0.3, 12);
        expect(q.rows[1][1]).toBeCloseTo(0.7, 12);
        expect(q.warnings.join(' ')).toMatch(/15 minutes/);

        const hourly = parseConsumptionCsv('start,kwh\n2026-02-01T00:00Z,1\n2026-02-01T01:00Z,2\n2026-02-01T02:00Z,3\n');
        expect(hourly.rows).toEqual([
            [ms('2026-02-01T00:00:00Z'), 0.5], [ms('2026-02-01T00:30:00Z'), 0.5], [ms('2026-02-01T01:00:00Z'), 1],
            [ms('2026-02-01T01:30:00Z'), 1], [ms('2026-02-01T02:00:00Z'), 1.5], [ms('2026-02-01T02:30:00Z'), 1.5]]);
        expect(hourly.warnings.join(' ')).toMatch(/hourly/);
    });

    it('skips unreadable and negative rows with warnings, keeps the first of duplicates', () => {
        const text = 'start,kwh\n2026-02-01T00:00Z,0.2\nnot a date,0.3\n2026-02-01T00:30Z,abc\n2026-02-01T01:00Z,-0.4\n2026-02-01T01:30Z,0.5\n2026-02-01T01:30Z,0.9\n';
        const { rows, warnings } = parseConsumptionCsv(text);
        expect(rows).toEqual([[ms('2026-02-01T00:00:00Z'), 0.2], [ms('2026-02-01T01:30:00Z'), 0.5]]);
        const w = warnings.join(' | ');
        expect(w).toMatch(/Line 3: unreadable time/);
        expect(w).toMatch(/Line 4: unreadable value/);
        expect(w).toMatch(/1 negative/);
        expect(w).toMatch(/1 duplicate/);
    });

    it('throws CSV errors for empty, unrecognisable or daily files', () => {
        for (const text of ['', 'name,colour\nbob,red\n', 'hello world\nfoo bar\n']) {
            const err = (() => { try { parseConsumptionCsv(text); } catch (e) { return e; } })();
            expect(err).toBeInstanceOf(DataError);
            expect(err.code).toBe('CSV');
        }
        expect(() => parseConsumptionCsv('date,kwh\n2026-02-01,10\n2026-02-02,11\n2026-02-03,12\n')).toThrow(/daily/);
    });
});

describe('defensive parsing (files people actually have)', () => {
    it('never reads an Export or generation column as usage', () => {
        const { rows } = parseConsumptionCsv('Start,Export (kWh),Import (kWh)\n2026-01-01T00:00Z,0.0,0.4\n2026-01-01T00:30Z,0.1,0.5\n');
        expect(rows.map(r => r[1])).toEqual([0.4, 0.5]);
        const g = parseConsumptionCsv('timestamp,generation kwh,consumption kwh\n2026-01-01T00:00Z,0,0.7\n');
        expect(g.rows[0][1]).toBe(0.7);
    });

    it('reads naive times as UTC when the header says so', () => {
        const { rows, warnings } = parseConsumptionCsv('Timestamp (UTC),Consumption (kWh)\n2026-07-01 12:00,0.5\n2026-07-01 12:30,0.6\n');
        expect(rows.map(r => r[0])).toEqual([ms('2026-07-01T12:00:00Z'), ms('2026-07-01T12:30:00Z')]);
        expect(warnings.join(' ')).toMatch(/UTC/);
        for (const head of ['Start (GMT)', 'Start (UTC)', 'Time (Z)']) {
            const r = parseConsumptionCsv(`${head},kWh\n2026-06-01 00:00,1.0\n`);
            expect(r.rows[0][0], head).toBe(ms('2026-06-01T00:00:00Z'));
        }
    });

    it("reads a 'GMT/BST' (UK clock) header as London wall-clock time, not UTC", () => {
        // GMT/BST, UK time or local time: summer rows are BST, so 00:00 is 23:00Z the day before.
        for (const head of ['Date/Time (GMT/BST)', 'Timestamp (UK time GMT/BST)', 'Start - local time (GMT)', 'Start (BST)']) {
            const { rows, warnings } = parseConsumptionCsv(`${head},kWh\n2026-06-01 00:00,1.0\n2026-06-01 00:30,2.0\n2026-06-01 01:00,3.0\n`);
            expect(rows.map(r => r[0]), head).toEqual([ms('2026-05-31T23:00:00Z'), ms('2026-05-31T23:30:00Z'), ms('2026-06-01T00:00:00Z')]);
            expect(warnings.join(' '), head).not.toMatch(/read as UTC/);
        }
        const gb = parseConsumptionCsv('Date/Time (GMT/BST),kWh\n2026-01-15 16:00,1.0\n');
        expect(gb.rows[0][0]).toBe(ms('2026-01-15T16:00:00Z')); // winter: GMT = UTC
        expect(gb.warnings.join(' ')).toMatch(/UK clock time/);
        // and the October repeated hour still resolves by file order on that path
        const oct = parseConsumptionCsv('Date/Time (GMT/BST),kWh\n2025-10-26 01:00,0.1\n2025-10-26 01:30,0.2\n2025-10-26 01:00,0.3\n2025-10-26 01:30,0.4\n');
        expect(oct.rows.map(r => r[0])).toEqual([ms('2025-10-26T00:00:00Z'), ms('2025-10-26T00:30:00Z'), ms('2025-10-26T01:00:00Z'), ms('2025-10-26T01:30:00Z')]);
    });

    it('rejects impossible dates instead of rolling them over, and detects US month/day order', () => {
        expect(parseTimestamp('13/13/2026 00:00')).toBeNull();
        expect(parseTimestamp('2026-02-30T00:00:00Z')).toBeNull();
        expect(parseTimestamp('01/13/2026 00:30', null, -Infinity, { mdy: true }).ms).toBe(ms('2026-01-13T00:30:00Z'));
        const us = parseConsumptionCsv('Date,Time,kWh\n01/13/2026,00:00,0.4\n01/13/2026,00:30,0.5\n');
        expect(us.rows.map(r => r[0])).toEqual([ms('2026-01-13T00:00:00Z'), ms('2026-01-13T00:30:00Z')]);
        expect(us.warnings.join(' ')).toMatch(/month\/day/);
        // Without proof (no middle field > 12) dates stay day-first (UK).
        const uk = parseConsumptionCsv('Date,Time,kWh\n01/02/2026,00:00,0.4\n');
        expect(uk.rows[0][0]).toBe(ms('2026-02-01T00:00:00Z'));
        expect(parseTimestamp('01-02-2026 07:30').ms).toBe(ms('2026-02-01T07:30:00Z'));
        expect(parseTimestamp('1/13/2026 1:30:00 PM', null, -Infinity, { mdy: true }).ms).toBe(ms('2026-01-13T13:30:00Z'));
    });

    it('skips preamble lines, converts Wh and unit suffixes, shifts end-only times to slot starts', () => {
        const pre = parseConsumptionCsv('Meter serial: 19L123\nMPAN: 1200000000001\n\nStart,kWh\n2026-01-01T00:00Z,0.4\n2026-01-01T00:30Z,0.5\n');
        expect(pre.rows).toEqual([[ms('2026-01-01T00:00:00Z'), 0.4], [ms('2026-01-01T00:30:00Z'), 0.5]]);
        expect(pre.warnings.join(' ')).toMatch(/2 lines before the data/);
        const wh = parseConsumptionCsv('start,Usage (Wh)\n2026-01-01T00:00Z,400\n2026-01-01T00:30Z,500\n');
        expect(wh.rows.map(r => r[1])).toEqual([0.4, 0.5]);
        const unit = parseConsumptionCsv('start,kwh\n2026-01-01T00:00Z,0.4 kWh\n2026-01-01T00:30Z,450Wh\n');
        expect(unit.rows.map(r => r[1])).toEqual([0.4, 0.45]);
        const endOnly = parseConsumptionCsv('End,kWh\n2026-01-01T00:30Z,0.4\n2026-01-01T01:00Z,0.5\n2026-01-01T01:30Z,0.6\n');
        expect(endOnly.rows.map(r => r[0])).toEqual([ms('2026-01-01T00:00:00Z'), ms('2026-01-01T00:30:00Z'), ms('2026-01-01T01:00:00Z')]);
    });

    it('takes the date from its own column when Start holds only a time of day', () => {
        const { rows } = parseConsumptionCsv('Date,Start time,End time,kWh\n15/01/2026,16:00,16:30,0.7\n15/01/2026,16:30,17:00,0.8\n');
        expect(rows).toEqual([[ms('2026-01-15T16:00:00Z'), 0.7], [ms('2026-01-15T16:30:00Z'), 0.8]]);
    });

    it('does not double a repeated 15-minute reading, and drops incomplete half-hours', () => {
        const d = parseConsumptionCsv('start,kwh\n2026-02-01T00:00Z,0.1\n2026-02-01T00:15Z,0.2\n2026-02-01T00:15Z,0.2\n2026-02-01T00:30Z,0.3\n2026-02-01T00:45Z,0.4\n2026-02-01T01:00Z,0.5\n');
        expect(d.rows.map(r => r[0])).toEqual([ms('2026-02-01T00:00:00Z'), ms('2026-02-01T00:30:00Z')]);
        expect(d.rows[0][1]).toBeCloseTo(0.3, 12);
        expect(d.warnings.join(' ')).toMatch(/1 half-hours had only some/);
    });

    it('reads newest-first files, resolving the repeated October hour in time order', () => {
        const text = 'timestamp,value\n2025-10-26T02:00:00,6\n2025-10-26T01:30:00,5\n2025-10-26T01:00:00,4\n2025-10-26T01:30:00,3\n2025-10-26T01:00:00,2\n2025-10-26T00:30:00,1\n';
        const { rows, warnings } = parseConsumptionCsv(text);
        expect(rows).toEqual([
            [ms('2025-10-25T23:30:00Z'), 1], [ms('2025-10-26T00:00:00Z'), 2], [ms('2025-10-26T00:30:00Z'), 3],
            [ms('2025-10-26T01:00:00Z'), 4], [ms('2025-10-26T01:30:00Z'), 5], [ms('2025-10-26T02:00:00Z'), 6]]);
        expect(warnings.join(' ')).not.toMatch(/duplicate/);
    });

    it('parses two years of an Octopus export quickly', () => {
        let text = 'Consumption (kWh), Start, End\n';
        for (let t = ms('2024-10-01T00:00:00Z'); t < ms('2026-10-01T00:00:00Z'); t += SLOT) {
            text += ` 0.4, ${new Date(t).toISOString().replace('.000', '')}, ${new Date(t + SLOT).toISOString().replace('.000', '')}\n`;
        }
        const t0 = performance.now();
        const { rows } = parseConsumptionCsv(text);
        expect(rows).toHaveLength(35040);
        expect(performance.now() - t0).toBeLessThan(1000);
    });
});

describe('timestamp helpers', () => {
    it('maps London wall-clock to UTC around both clock changes', () => {
        expect(londonWallToUtc(ms('2026-03-29T00:30:00Z')).ms).toBe(ms('2026-03-29T00:30:00Z'));
        expect(londonWallToUtc(ms('2026-03-29T01:30:00Z')).note).toBe('gap');
        expect(londonWallToUtc(ms('2026-03-29T02:00:00Z')).ms).toBe(ms('2026-03-29T01:00:00Z'));
        const amb = londonWallToUtc(ms('2025-10-26T01:00:00Z'));
        expect(amb).toEqual({ ms: ms('2025-10-26T00:00:00Z'), note: 'ambiguous' });
        expect(londonWallToUtc(ms('2025-10-26T01:00:00Z'), ms('2025-10-26T00:30:00Z')).ms).toBe(ms('2025-10-26T01:00:00Z'));
    });

    it('parses ISO with and without colons in the offset, UK dates and epoch numbers', () => {
        expect(parseTimestamp('2026-06-01T12:00:00+0100').ms).toBe(ms('2026-06-01T11:00:00Z'));
        expect(parseTimestamp('2026-06-01T12:00:00+01:00').ms).toBe(ms('2026-06-01T11:00:00Z'));
        expect(parseTimestamp('15/01/2026 16:30').ms).toBe(ms('2026-01-15T16:30:00Z'));
        expect(parseTimestamp('1767225600').ms).toBe(1767225600000);
        expect(parseTimestamp('garbage')).toBeNull();
        expect(SLOT).toBe(1_800_000);
    });
});
