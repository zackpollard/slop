/**
 * REPRO 3 — "heartbeat judges the timeout before it sends its own ping"
 *
 * BUG (slopnet.js:455-473, specifically the ordering of :466 and :471)
 *
 *   _startHeartbeat() {                                   // host
 *       this._heartbeatTimer = setInterval(() => {
 *           const now = Date.now();                       // :460
 *           for (const [, client] of this.clients) {
 *               if (client.disconnected) continue;        // :462
 *               ...
 *               if (client._lastPong && (now - client._lastPong) > heartbeatTimeout) {
 *                   this._handleDisconnect(client.conn);  // :466-468  <-- judged FIRST
 *                   continue;
 *               }
 *               try { client.conn.send({ type: '__slopnet_ping' }); } catch (e) {}   // :471
 *           }
 *       }, this.config.heartbeatInterval);
 *   }
 *
 * `client._lastPong` is written in exactly three places — :275 (an inbound pong), :298
 * (rejoin) and :322 (join) — and a pong is only ever produced in reply to a host ping
 * (client replies at :731-733). Regular game traffic does NOT refresh it (:332-334).
 * So `now - client._lastPong` is not "how long the link has been silent"; it is "how long
 * since MY OWN PREVIOUS TIMER WAKE". With the production defaults that are actually live —
 * heartbeatInterval 5000 / heartbeatTimeout 15000 (DEFAULT_CONFIG:102-103; sloplobby.js:162
 * and :246 pass only `roomPrefix`, and no app overrides them) — the host tolerates exactly
 * three missed wakes of its own timer, no matter how healthy the transport is.
 *
 * REAL-USER SEQUENCE (no race, no hostile actor):
 *   1. Alice hosts flip-7 / CAH / herd-mentality on her phone; Bob and Carol are connected
 *      and healthy.
 *   2. Alice switches to WhatsApp, or another tab, or her screen locks. After ~5 minutes
 *      hidden, Chrome applies intensive wake-up throttling: a chained setInterval gets ONE
 *      wake per minute. Inbound DataChannel message events are NOT throttled, so the links
 *      stay provably alive — the clients keep pinging and the host keeps answering them
 *      from the message handler at :267-271.
 *   3. The next host wake lands 60s after the previous one. On that single tick
 *      `now - _lastPong ≈ 60000 > 15000` for EVERY entry in `this.clients`, so :467 calls
 *      `_handleDisconnect` for the whole table in one loop pass.
 *   4. It is permanent. :462 now skips those clients in every future ping loop, and the
 *      only un-disconnect paths need either a pong (:272-281 — which needs a ping that will
 *      never be sent) or a `__slopnet_join` from the client (:285+ — which the client only
 *      sends after ITS own timeout, and the client never times out because the host keeps
 *      answering its pings at :267-271 without touching `_lastPong` or `disconnected`).
 *   5. `send` returns false (:373-375) and `broadcast` silently skips (:394), so the table
 *      freezes with an error on nobody's screen. At +120s `client-lost` fires (:359) — an
 *      event nothing outside the tests ever subscribes to. After that deletion the still-
 *      live client's traffic reaches the host as `clientId = conn.peer` (:333), a raw peer
 *      id the apps cannot map back to a player.
 *
 * WHY THE EXISTING 101 TESTS CANNOT SEE IT
 *   Every suite builds its peers with `heartbeatInterval: 0` — host-client.test.js:15,
 *   multi-client.test.js:15, peer-client.test.js:10 and :20, peer-host.test.js:10,
 *   reconnection.test.js:15 — so `_startHeartbeat` returns at :457 and lines 459-473
 *   execute in 0 of 101 tests. These tests therefore run the REAL DEFAULT_CONFIG (only
 *   `_PeerClass` is injected), because the bug is a property of those shipped defaults.
 *
 * ON THE MOCK — mock-peer.js is UNCHANGED and needed no changes.
 *   The missing capability is not in the transport, it is in the clock: vitest's fake
 *   timers fire every scheduled tick faithfully, and there is no way to say "the browser
 *   skipped eleven wakes and then fired one". So this file adds a small LOCAL helper,
 *   `throttleHostHeartbeat()` (below), which detaches the host's heartbeat callback from
 *   the timer wheel and hands back a manual `wake()`. Nothing about the host or the
 *   transport is altered: the same callback runs, with the same `Date.now()`, over the same
 *   MockPeer connections — only the spacing between wakes changes, which is precisely what
 *   a throttled or frozen tab does. The first test in this file drives the *same* helper at
 *   the normal 5s cadence and passes, proving the harness is not what causes the eviction.
 *
 * These tests FAIL on purpose. Do not "fix" them by relaxing the assertions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { PeerHost, PeerClient, DEFAULT_CONFIG } = SlopNet;

// Production defaults verbatim — only the Peer implementation is injected.
const PROD_CONFIG = { _PeerClass: MockPeer };

const ROOM = 'ROOM3';
const HEARTBEAT = DEFAULT_CONFIG.heartbeatInterval;   // 5000
const TIMEOUT = DEFAULT_CONFIG.heartbeatTimeout;      // 15000

/**
 * Take the host's heartbeat off the timer wheel and return a manual `wake()`.
 *
 * This models browser timer throttling / tab freezing, which the existing harness has no
 * way to express. The heartbeat callback itself is untouched — we simply choose when it
 * fires. Everything else (the clients' own 5s heartbeats, the mock's async message
 * delivery, Date.now()) keeps running off the normal fake clock, exactly as a hidden tab's
 * inbound DataChannel events keep being serviced while its timers are throttled.
 */
function throttleHostHeartbeat(host) {
    host._stopHeartbeat();

    let tick = null;
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = (fn) => {
        tick = fn;
        // Hand back a real handle so a later _stopHeartbeat()/destroy() can clear something.
        return realSetInterval(() => {}, 1e9);
    };
    try {
        host._startHeartbeat();
    } finally {
        globalThis.setInterval = realSetInterval;
    }

    if (typeof tick !== 'function') {
        throw new Error('host heartbeat did not arm — heartbeatInterval must be > 0');
    }
    return () => tick();
}

async function startHost(events) {
    const host = new PeerHost(PROD_CONFIG);
    for (const type of ['client-joined', 'client-rejoined', 'client-left', 'client-lost']) {
        host.on(type, (clientId) => events.push(`${type}:${clientId}`));
    }
    const started = host.start(ROOM);
    await vi.advanceTimersByTimeAsync(20);
    await started;
    return host;
}

async function joinClient(clientId, name) {
    const client = new PeerClient(PROD_CONFIG);
    const connected = client.connect(ROOM, clientId, { name });
    await vi.advanceTimersByTimeAsync(50);
    await connected;
    return client;
}

describe('REPRO: host heartbeat evaluates the timeout before sending its own ping', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('SANITY: the same manual wake at the normal 5s cadence keeps everyone connected', async () => {
        const events = [];
        const host = await startHost(events);
        const alice = await joinClient('alice', 'Alice');
        const bob = await joinClient('bob', 'Bob');

        const wake = throttleHostHeartbeat(host);

        // Foreground tab: 24 wakes, one every heartbeatInterval, for two minutes.
        for (let i = 0; i < 24; i++) {
            await vi.advanceTimersByTimeAsync(HEARTBEAT);
            wake();
            await vi.advanceTimersByTimeAsync(10);
        }

        expect(host.getConnectedClientIds().sort()).toEqual(['alice', 'bob']);
        expect(events).toEqual(['client-joined:alice', 'client-joined:bob']);

        alice.destroy();
        bob.destroy();
        host.destroy();
    });

    it('does not evict every client when one timer wake arrives late on a demonstrably live link', async () => {
        const events = [];
        const host = await startHost(events);
        const alice = await joinClient('alice', 'Alice');
        const bob = await joinClient('bob', 'Bob');

        const wake = throttleHostHeartbeat(host);

        // A minute of healthy foreground play first, so _lastPong is fresh for everyone.
        for (let i = 0; i < 12; i++) {
            await vi.advanceTimersByTimeAsync(HEARTBEAT);
            wake();
            await vi.advanceTimersByTimeAsync(10);
        }
        expect(host.getConnectedClientIds().sort()).toEqual(['alice', 'bob']);

        // --- Alice switches to WhatsApp. Her page is hidden; Chrome throttles its timers to
        //     one wake per minute. Nothing else changes: both clients keep running their own
        //     5s heartbeats and the host keeps answering them from the (unthrottled) message
        //     handler at slopnet.js:267-271. ---
        const pingsSeenByHostDuringThrottle = [];
        const rawHandleData = host._handleData.bind(host);
        host._handleData = (conn, data) => {
            if (data && data.type === '__slopnet_ping') pingsSeenByHostDuringThrottle.push(conn.peer);
            return rawHandleData(conn, data);
        };

        await vi.advanceTimersByTimeAsync(60000);

        // The link is provably alive in BOTH directions across the whole throttled minute:
        // the clients pinged, the host answered, the clients' own timeout never tripped.
        expect(pingsSeenByHostDuringThrottle.length).toBeGreaterThan(0);
        expect(alice.isConnected).toBe(true);
        expect(bob.isConnected).toBe(true);

        // --- The single throttled wake. ---
        wake();
        await vi.advanceTimersByTimeAsync(50);

        const gap = 60000;
        expect(
            host.getConnectedClientIds().sort(),
            `ONE late timer wake (${gap}ms after the previous one, vs heartbeatInterval=${HEARTBEAT}) ` +
            `evicted the entire table in a single loop pass. slopnet.js:466 compares ` +
            `now - client._lastPong (${gap}ms) against heartbeatTimeout (${TIMEOUT}ms) BEFORE ` +
            `slopnet.js:471 sends this tick's ping, and _lastPong is only ever advanced by a pong ` +
            `(:275) — i.e. one tick after a ping the host itself sent. So the host is not measuring ` +
            `client silence, it is measuring the spacing of its own wakes, and tolerates exactly 3 of ` +
            `them. Both clients answered ${pingsSeenByHostDuringThrottle.length} pings across this very ` +
            `minute and both still report isConnected=true. Host emitted: [${events.join(', ')}]`
        ).toEqual(['alice', 'bob']);

        alice.destroy();
        bob.destroy();
        host.destroy();
    });

    it('the false eviction is unrecoverable once the host tab comes back to the foreground', async () => {
        const events = [];
        const host = await startHost(events);
        const alice = await joinClient('alice', 'Alice');
        const bob = await joinClient('bob', 'Bob');

        const wake = throttleHostHeartbeat(host);
        await vi.advanceTimersByTimeAsync(HEARTBEAT);
        wake();
        await vi.advanceTimersByTimeAsync(10);

        // Hidden for a minute, then the one catch-up wake.
        await vi.advanceTimersByTimeAsync(60000);
        wake();
        await vi.advanceTimersByTimeAsync(50);

        // --- Alice comes back to the game. The tab is foregrounded and the heartbeat runs
        //     normally again for two full minutes. ---
        host._startHeartbeat();
        await vi.advanceTimersByTimeAsync(120000);

        expect(
            host.getConnectedClientIds().sort(),
            `After the host tab returned to the foreground and ticked normally for 120s, the falsely ` +
            `evicted clients were never re-adopted. slopnet.js:462 (\`if (client.disconnected) continue\`) ` +
            `excludes them from every future ping, and the only un-disconnect paths need a pong ` +
            `(:272-281, requires a ping that will never be sent) or a __slopnet_join (:285+, which the ` +
            `client only sends after its OWN timeout — and it never times out, because the host keeps ` +
            `answering its pings at :267-271 without touching _lastPong or disconnected). ` +
            `alice.isConnected=${alice.isConnected}, bob.isConnected=${bob.isConnected}. ` +
            `Host emitted: [${events.join(', ')}]`
        ).toEqual(['alice', 'bob']);

        alice.destroy();
        bob.destroy();
        host.destroy();
    });

    it('does not silently drop the host\'s outbound game state to a live client', async () => {
        const events = [];
        const host = await startHost(events);
        const inbound = [];
        host.on('data', (clientId, data) => inbound.push({ clientId, data }));

        const alice = await joinClient('alice', 'Alice');
        const bob = await joinClient('bob', 'Bob');

        const received = [];
        alice.on('data', (data) => received.push(data));

        const wake = throttleHostHeartbeat(host);
        await vi.advanceTimersByTimeAsync(HEARTBEAT);
        wake();
        await vi.advanceTimersByTimeAsync(10);

        // One throttled minute, one late wake — the whole table is evicted.
        await vi.advanceTimersByTimeAsync(60000);
        wake();
        await vi.advanceTimersByTimeAsync(50);

        // The host tries to push the next round of game state, as every app does after any
        // state change. Nothing throws; nothing arrives.
        const sendResult = host.send('alice', { type: 'state', round: 2 });
        host.broadcast({ type: 'state', round: 2 });
        await vi.advanceTimersByTimeAsync(50);

        expect(
            { sendResult, aliceReceived: received.length },
            `The host's outbound state stopped dead with an error on nobody's screen: send() ` +
            `returned false at slopnet.js:373-375 and broadcast() skipped the client at :394, both ` +
            `because of the disconnected flag set by the spurious heartbeat eviction. ` +
            `alice.isConnected=${alice.isConnected} and her DataChannel is still open. ` +
            `Host emitted: [${events.join(', ')}]`
        ).toEqual({ sendResult: true, aliceReceived: 1 });

        alice.destroy();
        bob.destroy();
        host.destroy();
    });

    it('does not lose the clientId of a live client once the reconnect window has closed', async () => {
        const events = [];
        const host = await startHost(events);
        const inbound = [];
        host.on('data', (clientId, data) => inbound.push({ clientId, data }));

        const alice = await joinClient('alice', 'Alice');
        const bob = await joinClient('bob', 'Bob');

        const wake = throttleHostHeartbeat(host);
        await vi.advanceTimersByTimeAsync(HEARTBEAT);
        wake();
        await vi.advanceTimersByTimeAsync(10);

        // One throttled minute, one late wake — the whole table is evicted.
        await vi.advanceTimersByTimeAsync(60000);
        wake();
        await vi.advanceTimersByTimeAsync(50);

        // Past the 120s reconnect window the host deletes the record entirely (:356-359) and
        // emits client-lost — an event no app subscribes to.
        await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.reconnectWindowMs + 1000);
        expect(events).toContain('client-lost:alice');
        expect(alice.isConnected).toBe(true);

        // Alice, who never noticed anything, submits her answer.
        inbound.length = 0;
        alice.send({ type: 'answer', text: 'blue' });
        await vi.advanceTimersByTimeAsync(50);

        expect(
            inbound.map(m => m.clientId),
            `A still-connected player's message reached the host under a raw PeerJS peer id instead ` +
            `of her clientId: after client-lost deleted her from \`clients\`, slopnet.js:332-334 falls ` +
            `back to \`conn.peer\`. herd-mentality and texas-holdem then silently drop the message, ` +
            `while cards-against-humanity would key state.submissions by the raw peer id and corrupt ` +
            `its round-advance count. Host emitted: [${events.join(', ')}]`
        ).toEqual(['alice']);

        alice.destroy();
        bob.destroy();
        host.destroy();
    });
});
