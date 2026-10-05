/*
 * solar-design-default — what the Design tab opens on when nothing asks for an option.
 *
 * QA finding (journey-desktop): Design opened on a hard-coded S01 (Octopus 2×460 W) and wrote it to
 * store.scenarios.activeId as if the user had chosen it, so Orientation — which follows activeId —
 * then answered the west question for S01 while the Verdict's answer was about its best buy
 * (City Plumbing 2×515 W): the headline west numbers changed between tabs with the visit order.
 *
 * Now: ?scenario= → the option chosen last (activeId) → the Verdict's pick (best buy, else the one
 * that comes closest) → S01 only while no Verdict is in. That default never becomes activeId, and
 * while untouched it follows a Verdict that arrives later (the finished one, or a running one's
 * partials from 'plugin' on). The view methods run on Object.create(view) with a stubbed ctx (no DOM).
 */
import { describe, it, expect, vi } from 'vitest';
import designView, { verdictPick } from '../../../projects/solar-calculator/js/views/design.js';

const AUTOS = [
    { id: 'S01', name: 'Octopus 2×460 W', route: 'plugin', featured: true, arrays: [] },
    { id: 'S05', name: 'City Plumbing 2×515 W', route: 'plugin', featured: true, arrays: [] },
    { id: 'S07', name: 'Hardwired 4 kWh', route: 'hardwired', featured: true, arrays: [] },
    { id: 'R1', name: 'Use 100 W less', route: 'reference', arrays: [] },
];
const VERDICT = { bestBuyId: 'S05', headline: { kind: 'buy' }, ranked: [{ id: 'S05' }] };

function fakeStore(scenarios = {}) {
    let state = { scenarios: { saved: [], pinned: [], activeId: null, ...scenarios }, settings: {} };
    const writes = [];
    return {
        writes,
        get: () => state,
        set(patch) {
            writes.push(patch);
            state = { ...state, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { ...state[k], ...v }])) };
        },
        update(key, fn) { writes.push({ [key]: 'update' }); state = { ...state, [key]: fn(state[key]) }; },
    };
}

/**
 * @param {{ verdict?: object|null, running?: boolean, scenarios?: object, params?: object }} o
 *   verdict: what verdictIfReady() says; running: a verdict is in flight (verdictIfReady({ wait }) is a promise)
 */
function designStub({ verdict = null, running = false, scenarios, params = {} } = {}) {
    const view = Object.create(designView);
    const store = fakeStore(scenarios);
    const replace = vi.fn();
    const hub = {
        ready: verdict,
        partial: null,
        verdictIfReady({ wait = false } = {}) {
            if (hub.ready) return wait ? Promise.resolve(hub.ready) : hub.ready;
            return wait && running ? new Promise(() => {}) : null;
        },
        verdict: vi.fn(({ onPartial } = {}) => { hub.partial = onPartial; return new Promise(() => {}); }),
    };
    view.ctx = {
        store,
        data: hub,
        router: { current: () => 'design', params: () => params, replace },
        ui: { toast: vi.fn() },
    };
    view.params = params;
    view.alive = true;
    view.visible = true;
    view.v = {};
    view.st = { autos: AUTOS, draft: null, source: null, base: '', result: null, fin: {} };
    view.renderAll = vi.fn();
    view.renderBar = vi.fn();
    view.scheduleRun = vi.fn();
    const activeWrites = () => store.writes.filter(w => w.scenarios && w.scenarios !== 'update' && 'activeId' in w.scenarios);
    return { view, store, hub, replace, activeWrites };
}

describe('verdictPick: the option the Verdict points at', () => {
    it('its best buy; with nothing worth buying, the one that comes closest — once it is finished', () => {
        expect(verdictPick(VERDICT, AUTOS)).toEqual({ id: 'S05', why: 'best' });
        const none = { bestBuyId: null, headline: { kind: 'none', closestId: 'S07' } };
        expect(verdictPick(none, AUTOS)).toEqual({ id: 'S07', why: 'closest' });
        // a partial's "comes closest" can still move; its best buy can't (it never flips once shown)
        expect(verdictPick(none, AUTOS, { partial: true })).toBeNull();
        expect(verdictPick(VERDICT, AUTOS, { partial: true })).toEqual({ id: 'S05', why: 'best' });
    });

    it('nothing for no verdict, an id Design does not have, or a yardstick', () => {
        expect(verdictPick(null, AUTOS)).toBeNull();
        expect(verdictPick({ bestBuyId: 'S99' }, AUTOS)).toBeNull();
        expect(verdictPick({ bestBuyId: null, headline: { closestId: 'R1' } }, AUTOS)).toBeNull();
    });
});

describe('Design opens on the Verdict’s pick, not a hard-coded S01', () => {
    it('with a finished Verdict and nothing chosen: its best buy, and activeId stays unset (Orientation keeps to the Verdict)', () => {
        const { view, store, activeWrites, replace } = designStub({ verdict: VERDICT });
        view.pickInitial();
        expect(view.st.draft.id).toBe('S05');
        expect(view.st.source).toMatchObject({ kind: 'auto', id: 'S05', implicit: true });
        expect(store.get().scenarios.activeId).toBeNull();
        expect(activeWrites()).toEqual([]);
        // the address still names what's on screen
        expect(replace).toHaveBeenCalledWith('design', { scenario: 'S05' });
    });

    it('no Verdict yet: S01, still not the active scenario — and the finished Verdict then moves it to the best buy', () => {
        const { view, hub, store } = designStub();
        view.pickInitial();
        expect(view.st.draft.id).toBe('S01');
        expect(store.get().scenarios.activeId).toBeNull();
        // none running, so Design doesn't start one
        expect(hub.verdict).not.toHaveBeenCalled();
        hub.ready = VERDICT;
        view.onVerdict(VERDICT);
        expect(view.st.draft.id).toBe('S05');
        expect(view.st.source.implicit).toBe(true);
        expect(store.get().scenarios.activeId).toBeNull();
        // swapped before any S01 figures were up: nothing to announce
        expect(view.ctx.ui.toast).not.toHaveBeenCalled();
    });

    it('says so when the swap replaces figures the user was already looking at', () => {
        const { view, hub } = designStub();
        view.pickInitial();
        view.st.result = { system: view.st.draft };
        hub.ready = VERDICT;
        view.onVerdict(VERDICT);
        expect(view.st.draft.id).toBe('S05');
        expect(view.ctx.ui.toast).toHaveBeenCalledWith('Now showing the Verdict’s best buy, the City Plumbing 2×515 W.', expect.anything());
    });

    it('a Verdict already running: joins it (never starts one) and takes the best buy from its first partial that has one', () => {
        const { view, hub } = designStub({ running: true });
        view.pickInitial();
        expect(view.st.draft.id).toBe('S01');
        expect(hub.verdict).toHaveBeenCalledTimes(1);
        hub.partial('usage', { bestBuyId: null });
        expect(view.st.draft.id).toBe('S01');
        hub.partial('plugin', { bestBuyId: 'S05', headline: { kind: 'buy' } });
        expect(view.st.draft.id).toBe('S05');
        expect(view.st.source.implicit).toBe(true);
    });

    it('an option the user chose (activeId) wins over the Verdict', () => {
        const { view } = designStub({ verdict: VERDICT, scenarios: { activeId: 'S01' } });
        view.pickInitial();
        expect(view.st.draft.id).toBe('S01');
        expect(view.st.source.implicit).toBeFalsy();
    });

    it('?scenario= wins, and is the user’s choice (activeId)', () => {
        const { view, store } = designStub({ verdict: VERDICT, params: { scenario: 'S07' } });
        view.pickInitial();
        expect(view.st.draft.id).toBe('S07');
        expect(store.get().scenarios.activeId).toBe('S07');
    });

    it('an edited default stays put when the Verdict comes in', () => {
        const { view, hub } = designStub();
        view.pickInitial();
        view.st.draft = { ...view.st.draft, name: 'My Octopus kit' };
        hub.ready = VERDICT;
        view.onVerdict(VERDICT);
        expect(view.st.draft.id).toBe('S01');
        expect(view.st.draft.name).toBe('My Octopus kit');
    });

    it('a chosen option never follows the Verdict', () => {
        const { view, hub } = designStub({ scenarios: { activeId: 'S01' } });
        view.pickInitial();
        hub.ready = VERDICT;
        view.onVerdict(VERDICT);
        expect(view.st.draft.id).toBe('S01');
    });

    it('a link to the default on screen makes it a choice; Design’s own address update does not', () => {
        const { view, store } = designStub({ verdict: VERDICT });
        view.pickInitial();
        // syncUrl's own replace() comes back through show()
        expect(view.urlEcho).toBe('S05');
        view.show({ scenario: 'S05' });
        expect(view.st.source.implicit).toBe(true);
        expect(store.get().scenarios.activeId).toBeNull();
        // a later link from the Verdict ("Design it") to the same option
        view.show({ scenario: 'S05' });
        expect(view.st.source.implicit).toBe(false);
        expect(store.get().scenarios.activeId).toBe('S05');
    });

    it('starting from another ready-made option is a choice', () => {
        const { view, store } = designStub({ verdict: VERDICT });
        view.pickInitial();
        view.startFrom('auto:S01');
        expect(view.st.draft.id).toBe('S01');
        expect(view.st.source.implicit).toBeFalsy();
        expect(store.get().scenarios.activeId).toBe('S01');
    });
});
