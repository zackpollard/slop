/**
 * The six library defects found by the second (fresh) audit, after the first wave of
 * fixes had already landed. Three of them were regressions introduced BY that first
 * wave, which is the reason this file exists as its own set: each test here is the
 * shape of a mistake that a fix made, not a mistake the original code made.
 *
 * Judged real by two independent reviewers each, then re-traced against the code before
 * being fixed. Each `it` names the defect it pins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry, MockPeer } from './mock-peer.js';
import {
    SlopNet, SlopLobby, installBrowserGlobals, installSlopNetGlobal, restoreGlobals,
    createClient, startHost, joinClient, recordEvents, advance,
} from './lib-harness.js';

const HOST_EVENTS = ['client-joined', 'client-rejoined', 'client-left', 'client-lost'];

describe('audit wave 2 — library', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    /* ── The seat tie-break ───────────────────────────────────────────────────
       "Newest wins" compared two stamps that measure OPPOSITE DIRECTIONS of the
       same link: the joiner's staleMs is how long since IT heard from the host,
       heardFromAt is when the HOST last heard from the holder. For one tab
       reconnecting into its own seat those describe the same link, so the winner
       depended on which direction happened to carry the last packet — and a player
       whose final act was outbound (tap, then the radio dies: the ordinary case)
       lost their own seat terminally, since 'superseded' never reconnects. */

    it('does not supersede a player whose last act was OUTBOUND — their own reconnect wins', async () => {
        const host = await startHost('TIE', { heartbeatInterval: 0 });
        const a = await joinClient('TIE', 'alice', { name: 'Alice' });
        const token = a.token;

        // The shape that used to lose: the host hears from her AFTER the last thing she
        // heard from the host. One tap is enough.
        await advance(3000);
        a.send({ type: 'tap' });
        await advance(20);
        const seat = host._findClientByClientId('alice');
        expect(seat.heardFromAt, 'the host has heard from her more recently than she from it')
            .toBeGreaterThan(Date.now() - a._lastPongTime);

        // Her radio dies. The HOST does not know that yet — nothing closed the channel
        // from its side, so the seat is still 'occupied' and the tie-break runs. This is
        // the whole point: her reconnect has to win against her own still-open ghost.
        // What a real PeerClient reports: time since IT last heard from this host. It
        // cannot predate her own binding, because the ack that bound her was inbound.
        const staleMs = Date.now() - a._lastPongTime;
        expect(seat.conn.open, 'the host still believes the old channel is fine').toBe(true);
        const peer = new MockPeer();
        const conn = peer.connect('lib-TIE', { reliable: true });
        const inbox = [];
        conn.on('data', d => inbox.push(d));
        await advance(10);
        conn.send({ type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alice' }, token, staleMs });
        await advance(20);

        expect(
            inbox.map(m => m.type),
            'she is acked back into her own seat, not told she was superseded'
        ).toEqual(['__slopnet_join_ack']);
        expect(host.isClientConnected('alice')).toBe(true);
        expect(
            host._findClientByClientId('alice').conn.open,
            'and the seat is bound to a live channel'
        ).toBe(true);
        expect(
            a.terminalReason,
            'while the ghost she left behind is the one told to stop'
        ).toBe('superseded');

        a.destroy(); host.destroy();
    });

    it('still supersedes a rung from before the current holder connected', async () => {
        // The case the tie-break exists for: a throttled tab's rung fires long after the
        // player opened the game again, carrying the same clientId and token.
        const host = await startHost('TIE2', { heartbeatInterval: 0 });
        const first = await joinClient('TIE2', 'alice', { name: 'Alice' });
        const token = first.token;
        const staleFromOldTab = 1000;      // its last contact: ~now
        await advance(2000);

        // The player opens the game again; this connection becomes the holder and speaks.
        const live = new MockPeer();
        const liveConn = live.connect('lib-TIE2', { reliable: true });
        liveConn.on('data', () => {});
        await advance(10);
        liveConn.send({ type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alice' }, token });
        await advance(10);
        liveConn.send({ type: 'hello' });
        await advance(20);
        expect(host._findClientByClientId('alice').heardFromAt).toBeGreaterThan(0);
        await advance(5000);

        // Now the abandoned tab's overdue rung arrives. Its last contact predates the
        // moment the live holder was bound, so it is the one told to stop.
        const old = new MockPeer();
        const oldConn = old.connect('lib-TIE2', { reliable: true });
        const oldInbox = [];
        oldConn.on('data', d => oldInbox.push(d));
        await advance(10);
        oldConn.send({
            type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alice' },
            token, staleMs: Date.now() - (Date.now() - 8000 - staleFromOldTab),
        });
        await advance(20);

        expect(oldInbox.map(m => m.type)).toEqual(['__slopnet_superseded']);
        expect(liveConn.open, 'the tab in front of the player keeps the seat').toBe(true);

        first.destroy(); host.destroy();
    });

    /* ── The held kick ────────────────────────────────────────────────────── */

    it('spends an undelivered kick when the player is seated again', async () => {
        const host = await startHost('KICK', { heartbeatInterval: 0 });
        const a = await joinClient('KICK', 'alice', { name: 'Alice' });
        host.rejectClient('alice', 'Name already taken');
        a.destroy();
        await advance(20);
        expect(host._pendingRejections.has('alice')).toBe(true);

        const peer = new MockPeer();
        const conn = peer.connect('lib-KICK', { reliable: true });
        conn.on('data', () => {});
        await advance(10);
        conn.send({ type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alicia' } });
        await advance(20);

        expect(
            host._pendingRejections.has('alice'),
            'left in the map, it waited for this player\'s next ORDINARY reconnect and ' +
            'ejected them mid-game with the words from an argument that was over'
        ).toBe(false);
        host.destroy();
    });

    /* ── The remembered room code ─────────────────────────────────────────── */

    it('does not re-roll a code the caller asked to REUSE when the server still holds it', async () => {
        // A host tab that was discarded and restored re-presents the code every player is
        // already holding. The PeerServer keeps the dead socket's id for its alive_timeout,
        // so 'unavailable-id' here almost always means "that is still yours" — and taking a
        // new code silently strands the whole table on one that now dials nothing.
        const squatter = new MockPeer('lib-REUSE');
        await advance(10);

        const host = new SlopNet.PeerHost({ roomPrefix: 'lib-', _PeerClass: MockPeer, heartbeatInterval: 0 });
        const busy = [];
        host.on('room-code-busy', (n, max) => busy.push([n, max]));
        const started = host.start('REUSE', { reuse: true });
        await advance(50);

        expect(host.roomCode, 'the code is kept, not re-rolled').toBe('REUSE');
        expect(busy.length, 'and the wait is announced').toBeGreaterThan(0);

        // The server lets go; the next attempt takes the same id.
        squatter.destroy();
        await advance(20000);
        await expect(started).resolves.toBe('REUSE');
        expect(host.roomCode).toBe('REUSE');
        host.destroy();
    });

    it('still re-rolls a code it generated itself, and one the caller merely suggested', async () => {
        for (const opts of [undefined, { reuse: false }]) {
            resetRegistry();
            const squatter = new MockPeer('lib-TAKEN');
            await advance(10);
            const host = new SlopNet.PeerHost({ roomPrefix: 'lib-', _PeerClass: MockPeer, heartbeatInterval: 0 });
            const code = await (async () => { const p = host.start('TAKEN', opts); await advance(50); return p; })();
            expect(code, 'a fresh choice may be swapped for another').not.toBe('TAKEN');
            squatter.destroy(); host.destroy();
        }
    });

    /* ── The hung signalling rung ─────────────────────────────────────────── */

    it('gives a host reconnect rung a deadline, so one that never opens cannot wedge the ladder', async () => {
        const host = await startHost('HANG', { heartbeatInterval: 0, connectionTimeout: 3000 });
        const attempts = [];
        host.on('reconnecting', (n) => attempts.push(n));

        // Hold every future registration mid-handshake: the rung's peer never opens, and
        // peerjs has no event for that.
        MockPeer.openDelayMs = 1e9;
        host.peer.simulateDisconnect();
        await advance(50);
        const first = attempts.length;
        expect(first, 'the ladder started').toBeGreaterThan(0);

        // Without a deadline this is where it stopped for ever: no timer, no event, and
        // every lever out (resume, _startReconnect, _doReconnect) gated on the rung.
        await advance(20000);
        expect(
            attempts.length,
            'the hung rung timed out and the ladder kept knocking'
        ).toBeGreaterThan(first);

        MockPeer.openDelayMs = 0;
        host.destroy();
    });

    /* ── Forged record fields ─────────────────────────────────────────────── */

    it('never copies a joining client\'s metadata into the host\'s own player record', async () => {
        installBrowserGlobals();
        installSlopNetGlobal();
        try {
            const seen = [];
            const lobby = new SlopLobby({
                roomPrefix: 'lib-', storageKey: 'lib-forge',
                onPlayerJoined: (clientId) => { seen.push(clientId); },
            });
            const code = await (async () => { const p = lobby.createRoom('Host'); await advance(50); return p; })();

            const c = new SlopNet.PeerClient({ roomPrefix: 'lib-', _PeerClass: MockPeer });
            // Every field an app hangs authority on, offered by the client itself.
            const p = c.connect(code, 'mallory', {
                name: 'Mallory', playerId: 'host', seatId: 'host', isHost: true, score: 999,
            });
            await advance(50);
            await p;

            const record = lobby.players.get('mallory');
            expect(Object.keys(record), 'the record is the host\'s bookkeeping, not the client\'s')
                .toEqual(['name']);
            expect(record.name).toBe('Mallory');
            c.destroy(); lobby.destroy();
        } finally {
            restoreGlobals();
        }
    });
});
