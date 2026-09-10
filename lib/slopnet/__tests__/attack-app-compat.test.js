/**
 * ADVERSARIAL — backward compatibility with the four unmodified consumers
 * (cards-against-humanity, herd-mentality, flip-7, texas-holdem).
 *
 * Every case below models wiring one of those four apps actually has in
 * projects/<app>/index.html today. None of them may be edited to make this library
 * change land, so a failure here is a regression the library owes.
 *
 * Each `it` is written so that FAILING == the bug is present.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';
import {
    SlopLobby, SlopLobbyModule,
    installBrowserGlobals, installSlopNetGlobal, restoreGlobals,
    advance, startHost, joinClient, recordEvents, createClient,
} from './lib-harness.js';

describe('attack: app compatibility', () => {
    let env;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        env = installBrowserGlobals();
        installSlopNetGlobal();
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    function clientLobby(storageKey, extra = {}) {
        const msgs = [];
        const states = [];
        const lobby = new SlopLobby({
            roomPrefix: extra.roomPrefix || 'f7-',
            storageKey,
            onClientData: d => msgs.push(d),
            onStateChange: (s, d) => states.push([s, d]),
            ...extra,
        });
        return { lobby, msgs, states };
    }

    async function hostRoom(prefix, key, code) {
        const seen = [];
        const lobby = new SlopLobby({
            roomPrefix: prefix, storageKey: key,
            onPlayerJoined: () => {}, onPlayerRejoined: () => {},
            onHostData: (id, d) => seen.push(d),
        });
        const p = lobby.createRoom('Host', code);
        await advance(20);
        await p;
        return { lobby, seen };
    }

    // ── A1 (C9) ───────────────────────────────────────────────────────────────
    // The seat token is minted per HOST while the clientId is per tab, so it is stored
    // per ROOM (`storageKey + '-token-' + roomCode`). With one key per app, a tab that
    // visited the other table at the same party overwrote the first room's token and
    // was then refused its own seat there — "That seat belongs to another connection" —
    // for the life of the tab.
    it('A1: visiting a second room does not lock the tab out of the first', async () => {
        const a = await hostRoom('f7-', 'f7-host-a', 'AAAAAA');
        const b = await hostRoom('f7-', 'f7-host-b', 'BBBBBB');

        // 1. joins table A, is seated, closes the tab's game (destroy, not a reload).
        let t = clientLobby('f7-client-id');
        let p = t.lobby.joinRoom('AAAAAA', 'Carol');
        await advance(50);
        await p;
        const clientId = t.lobby.clientId;
        const tokenA = env.store.get('f7-client-id-token-AAAAAA');
        expect(tokenA).toBeTruthy();
        t.lobby.destroy();
        await advance(20);

        // 2. wanders over to table B (the other half of the party) and is seated there.
        t = clientLobby('f7-client-id');
        p = t.lobby.joinRoom('BBBBBB', 'Carol');
        await advance(50);
        await p;
        expect(t.lobby.clientId, 'same tab ⇒ same clientId').toBe(clientId);
        // Table B's token lives under its own key; table A's is untouched.
        expect(env.store.get('f7-client-id-token-BBBBBB')).toBeTruthy();
        expect(env.store.get('f7-client-id-token-BBBBBB')).not.toBe(tokenA);
        expect(env.store.get('f7-client-id-token-AAAAAA')).toBe(tokenA);
        t.lobby.destroy();
        await advance(20);

        // 3. goes back to table A, which is still running and still holds her seat.
        t = clientLobby('f7-client-id');
        const errors = [];
        t.lobby.joinRoom('AAAAAA', 'Carol').catch(e => errors.push(e.reason || e.type));
        await advance(200);

        // 4. and again long after table A's reconnect window released the seat: a
        //    released seat has no holder to protect, so a returning player is let in
        //    (and issued a fresh token) rather than refused for ever.
        await advance(130000);
        t = clientLobby('f7-client-id');
        t.lobby.joinRoom('AAAAAA', 'Carol').catch(e => errors.push(e.reason || e.type));
        await advance(200);

        expect(
            errors,
            'table A must never refuse its own player, before or after the seat is released'
        ).toEqual([]);
        expect(t.lobby.client.isConnected).toBe(true);
        expect(a.lobby.getConnectedClientIds()).toEqual([clientId]);

        t.lobby.destroy(); a.lobby.destroy(); b.lobby.destroy();
    });

    // ── A8 (C9 + C17) ─────────────────────────────────────────────────────────
    // C17 gives getClientId an in-memory fallback so a private/partitioned tab can
    // still join. C9 then requires a token that the same broken storage cannot keep.
    // The two together turn every "try again" tap in such a tab into a permanent
    // lockout — herd-mentality's startPlayer(), flip-7's join-after-error,
    // texas-holdem's resetToLobby() and CAH's re-join all build a fresh SlopLobby.
    it('A8: in a private/partitioned tab, joining again is refused for ever', async () => {
        restoreGlobals();
        env = installBrowserGlobals({ throwingStorage: true });
        installSlopNetGlobal();

        const host = await hostRoom('hm-', 'hm-host', 'ROOMHM');

        const first = clientLobby('hm-client-id', { roomPrefix: 'hm-' });
        let p = first.lobby.joinRoom('ROOMHM', 'Carol');
        await advance(50);
        await p;
        const clientId = first.lobby.clientId;

        // The link drops and the app tears its lobby down (reconnect-failed / user tap).
        first.lobby.destroy();
        await advance(20);

        // "Try again" — a brand new SlopLobby, same page, so the SAME in-memory clientId.
        const second = clientLobby('hm-client-id', { roomPrefix: 'hm-' });
        const errors = [];
        second.lobby.joinRoom('ROOMHM', 'Carol').catch(e => errors.push(e.reason || e.type));
        await advance(200);
        expect(second.lobby.clientId, 'C17 keeps the identity...').toBe(clientId);
        expect(
            errors,
            '...but C9 has no way to prove it, so the seat holder is refused its own seat'
        ).toEqual([]);

        host.lobby.destroy();
    });

    // ── A2 (C9 + C15) ─────────────────────────────────────────────────────────
    // A reject that lands BEFORE the first ack settles connect() as a rejection AND
    // arrives as the { type:'join-error', reason } message every app already paints
    // (lib-spec C5/C10 — the apps are unmodified in this phase and none of them reads
    // err.reason: flip-7 index.html:1734-1743 and herd :1384-1392 paint a fixed
    // "could not connect, check the room code" from their catch, which is actively
    // misleading when the code was right). The two used to race, and the catch runs
    // second, so the accurate reason lost. The message is therefore handed over one
    // tick LATER than the promise: both paths fire, and the host's own words are the
    // last thing painted.
    it('A2: a door-step rejection reaches the app on both paths, and the true reason is painted last', async () => {
        const host = await hostRoom('f7-', 'f7-host', 'ROOMAA');

        // Carol is in the room and connected — her seat is occupied, so it really is
        // protected. Somebody else's tab now asserts her clientId.
        const carol = clientLobby('f7-c');
        let p = carol.lobby.joinRoom('ROOMAA', 'Carol');
        await advance(50);
        await p;
        const carolId = carol.lobby.clientId;

        const painted = [];
        const errors = [];
        env.useStore(new Map([['f7-c', carolId]]));       // a different tab, no token
        const lobby = new SlopLobby({
            roomPrefix: 'f7-', storageKey: 'f7-c',
            onClientData: (d) => { if (d.type === 'join-error') painted.push('reason: ' + d.reason); },
        });
        lobby.joinRoom('ROOMAA', 'Mallory')
            .catch(e => { errors.push(e); painted.push('caught: ' + e.reason); });
        await advance(200);

        expect(painted, 'the app\'s own catch first, the host\'s reason last').toEqual([
            'caught: That seat belongs to another connection',
            'reason: That seat belongs to another connection',
        ]);
        expect(errors[0].type).toBe('rejected');
        expect(carol.lobby.client.isConnected, 'the seat holder is untouched').toBe(true);

        carol.lobby.destroy(); host.lobby.destroy();
    });

    // ── A2b — a rejection AFTER the ack still uses the message channel ─────────
    // Every app already handles { type:'join-error' } (herd's name clash, flip-7's
    // "game already started"); those arrive when connect() has long since resolved and
    // there is nothing else to carry them.
    it('A2b: a rejection after the player is in still arrives as { type: join-error }', async () => {
        const hostLobby = new SlopLobby({
            roomPrefix: 'f7-', storageKey: 'f7-h2b',
            onPlayerJoined: () => 'Name already taken',
            onPlayerRejoined: () => {},
        });
        const hp = hostLobby.createRoom('Host', 'ROOMA2');
        await advance(20);
        await hp;

        const painted = [];
        const t = clientLobby('f7-c2b', {
            onClientData: (d) => { if (d.type === 'join-error') painted.push('reason: ' + d.reason); },
        });
        const p = t.lobby.joinRoom('ROOMA2', 'Carol').catch(e => painted.push('caught: ' + e.type));
        await advance(200);
        await p;

        expect(painted).toEqual(['reason: Name already taken']);
        hostLobby.destroy();
    });

    // ── A3 (C18) ──────────────────────────────────────────────────────────────
    // C18 claimed that escaping ' as &#39; made `onclick="fn('${esc(name)}')"` safe.
    // It does not: the HTML parser decodes character references inside an attribute
    // value BEFORE the handler source is compiled, so &#39; is a bare apostrophe again
    // and O'Brien is still a syntax error. esc() is for text and attribute VALUES;
    // escJs() is the one that survives into JavaScript. (flip-7:1401 / :1553 / :2331 /
    // :2364 must switch to it — or to data-* attributes — in the app phase.)
    it("A3: escJs() repairs onclick=\"fn('...')\" for a name with an apostrophe; esc() cannot", () => {
        const { esc, escJs } = SlopLobbyModule;
        // What the HTML parser hands the JS compiler.
        const decode = (v) => v
            .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        const compiles = (attrValue) => {
            try { new Function(decode(attrValue)); return true; } catch (e) { return false; }
        };

        expect(compiles(`window._removePlayer('${esc("O'Brien")}')`)).toBe(false);
        expect(compiles(`window._removePlayer('${escJs("O'Brien")}')`)).toBe(true);

        // ...and the handler receives the name intact.
        let got = null;
        new Function('window', decode(`window._removePlayer('${escJs("O'Brien <b>&</b>")}')`))
            ({ _removePlayer: (n) => { got = n; } });
        expect(got).toBe("O'Brien <b>&</b>");

        // esc() still does its own job: quotes cannot end an attribute value.
        expect(esc('a"b')).toBe('a&quot;b');
        expect(esc("a'b")).toBe('a&#39;b');
    });

    // ── A4 (C24) ──────────────────────────────────────────────────────────────
    // SlopLobby now wires visibilitychange → client.resume() for every app for free,
    // and resume() judges the channel on 3 s of WALL CLOCK. These are phone games at
    // both ends; when the player's phone wakes first the host's page is still frozen
    // and cannot answer, so a healthy DataChannel is declared dead and every app
    // paints its disconnected UI (flip-7 even throws the player back to the join form
    // when the game has not started: index.html:1710-1720).
    it('A4: the visibility hook kills a healthy channel when the HOST tab is still asleep', async () => {
        const host = await hostRoom('hm-', 'hm-host', 'ROOMHM');
        const t = clientLobby('hm-c', { roomPrefix: 'hm-' });
        const p = t.lobby.joinRoom('ROOMHM', 'Carol');
        await advance(50);
        await p;

        // The host's phone locks: its page stops executing. Nothing is dispatched to
        // it and none of its timers run. The channel itself is untouched and open.
        const hostConn = [...host.lobby.host.clients.values()][0].conn;
        const realEmit = hostConn.emit.bind(hostConn);
        hostConn.emit = () => {};
        host.lobby.host._stopHeartbeat();

        // The player's phone wakes first. (Call this lobby's own visibility handler
        // rather than _dispatch(): both fake lobbies share one document here, and in
        // real life the host is a different device whose page is not running at all.)
        t.lobby._onVisibility();
        await advance(3100);

        expect(
            t.states.map(s => s[0]),
            'channel open=' + t.lobby.client.connection.open + '; the client dropped a live ' +
            'channel on a 3 s wall clock, five times tighter than the heartbeat it replaces'
        ).toEqual(['connecting', 'connected']);

        hostConn.emit = realEmit;
        t.lobby.destroy(); host.lobby.destroy();
    });

    // ── A4b (control) — the heartbeat this replaces would still be waiting ────
    it('A4b control: without the visibility hook the same freeze is not a drop at 3 s', async () => {
        const host = await hostRoom('hm-', 'hm-host2', 'ROOMH2');
        const t = clientLobby('hm-c2', { roomPrefix: 'hm-' });
        const p = t.lobby.joinRoom('ROOMH2', 'Carol');
        await advance(50);
        await p;

        const hostConn = [...host.lobby.host.clients.values()][0].conn;
        const realEmit = hostConn.emit.bind(hostConn);
        hostConn.emit = () => {};
        host.lobby.host._stopHeartbeat();

        await advance(14000);              // no resume(): the heartbeat rule alone
        expect(t.states.map(s => s[0])).toEqual(['connecting', 'connected']);

        hostConn.emit = realEmit;
        t.lobby.destroy(); host.lobby.destroy();
    });

    // ── A9 (C10) — expected to PASS: flip-7 keeps its own visibilitychange ────
    // flip-7:1811-1821 registers document.addEventListener('visibilitychange') at page
    // load and calls lobby.client.reconnect(). SlopLobby now registers a second one
    // calling resume(). They must not start two overlapping attempts.
    it('A9: flip-7\'s own visibilitychange handler does not double-wire with SlopLobby\'s', async () => {
        const host = await hostRoom('f7-', 'f7-h9', 'ROOMF9');
        const t = clientLobby('f7-c9');
        const p = t.lobby.joinRoom('ROOMF9', 'Carol');
        await advance(50);
        await p;

        t.lobby.client.connection.close();          // link drops, ladder armed
        await advance(10);
        expect(t.lobby.client.isConnected).toBe(false);

        // flip-7's handler runs first (registered at page load), then SlopLobby's.
        const peers = new Set();
        const orig = t.lobby.client._createPeerAndConnect.bind(t.lobby.client);
        let attempts = 0;
        t.lobby.client._createPeerAndConnect = (...a) => { attempts++; return orig(...a); };

        if (!t.lobby.client.isConnected) t.lobby.client.reconnect();   // flip-7:1817
        t.lobby._onVisibility();                                      // sloplobby
        expect(attempts, 'exactly one attempt in flight').toBe(1);
        await advance(200);
        expect(t.lobby.client.isConnected).toBe(true);
        expect(peers.size).toBe(0);

        t.lobby.destroy(); host.lobby.destroy();
    });

    // ── A5 (C3) ───────────────────────────────────────────────────────────────
    // 'superseded' is terminal and silent, and none of the four apps have ever heard
    // of it: the losing tab used to keep a fully painted, fully interactive game on
    // screen while every tap was dropped, behind a three-second toast. The terminal
    // handlers now follow the specific state with 'reconnect-failed', which all four
    // DO branch on, so the tab ends up somewhere honest.
    it('A5: a superseded tab is told, in a vocabulary every app already understands', async () => {
        const host = await hostRoom('cah-', 'cah-host', 'ROOMCC');

        const tab1 = clientLobby('cah-c', { roomPrefix: 'cah-' });
        let p = tab1.lobby.joinRoom('ROOMCC', 'Carol');
        await advance(50);
        await p;

        // Chrome "Duplicate tab": same sessionStorage ⇒ same clientId AND token.
        const tab2 = clientLobby('cah-c', { roomPrefix: 'cah-' });
        p = tab2.lobby.joinRoom('ROOMCC', 'Carol');
        await advance(50);
        await p;

        expect(tab1.lobby.client.terminalReason).toBe('superseded');
        const delivered = tab1.lobby.sendToHost({ type: 'submit', cards: ['a'] });
        await advance(50);

        expect(delivered).toBe(false);
        expect(host.seen, 'the host never hears the tap').toEqual([]);
        expect(
            tab1.states.map(s => s[0]).filter(s => s !== 'connecting' && s !== 'connected'),
            'a superseded tab must not be left showing a live-looking game it can no ' +
            'longer play: the specific state is wrapped in the two states every app ' +
            'already acts on — flip-7 only CREATES its banner on \'disconnected\' and ' +
            'only rewrites it on \'reconnect-failed\' (index.html:1751/1784), and ' +
            'herd/CAH/holdem leave the game on the last one'
        ).toEqual(['disconnected', 'superseded', 'reconnect-failed']);

        tab1.lobby.destroy(); tab2.lobby.destroy(); host.lobby.destroy();
    });

    // ── A6 (C5) — expected to PASS: guards texas-holdem's send-then-kick ────────
    it('A6: texas-holdem send-then-removeClient(clientId) still delivers the message', async () => {
        const seen = [];
        const hostLobby = new SlopLobby({
            roomPrefix: 'th-', storageKey: 'th-host',
            onPlayerJoined: (clientId) => {
                hostLobby.send(clientId, { type: 'error', message: 'Game already in progress' });
                hostLobby.removeClient(clientId);      // ONE argument, as the app calls it
            },
            onPlayerRejoined: () => {},
        });
        const hp = hostLobby.createRoom('Alice', 'ROOMTH');
        await advance(20);
        await hp;

        const t = clientLobby('th-c', { roomPrefix: 'th-' });
        const p = t.lobby.joinRoom('ROOMTH', 'Carol');
        await advance(80);
        await p;
        expect(t.msgs).toEqual([{ type: 'error', message: 'Game already in progress' }]);
        t.lobby.destroy(); hostLobby.destroy();
    });

    // ── A7 (C5/C26) — expected to PASS: guards herd's string rejection ─────────
    it('A7: herd name-clash rejection is delivered once, with no retry storm', async () => {
        let joins = 0;
        const hostLobby = new SlopLobby({
            roomPrefix: 'hm-', storageKey: 'hm-host',
            onPlayerJoined: () => { joins++; return 'Name already taken'; },
            onPlayerRejoined: () => {},
        });
        const hp = hostLobby.createRoom('Alice', 'ROOMHM');
        await advance(20);
        await hp;

        const t = clientLobby('hm-c', { roomPrefix: 'hm-' });
        const p = t.lobby.joinRoom('ROOMHM', 'Alice');
        await advance(80);
        await p;
        await advance(300000);                       // five minutes of would-be retries

        expect(joins).toBe(1);
        expect(t.msgs).toEqual([{ type: 'join-error', reason: 'Name already taken' }]);
        expect(t.lobby.client).toBeNull();
        hostLobby.destroy();
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
   ROUND 2 — further backward-compatibility attacks on the four unmodified apps.
   Every `it` below FAILS while the bug it names is present.
   ═══════════════════════════════════════════════════════════════════════════ */

describe('attack round 2: app compatibility', () => {
    let env;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        env = installBrowserGlobals();
        installSlopNetGlobal();
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    // ── B1 (C3 + C10 `_endOfTheRoad`) ────────────────────────────────────────
    // sloplobby.js:720-722 raises onStateChange('reconnect-failed') after
    // 'superseded'/'room-closed' and justifies it with:
    //     "All four consumers DO branch on 'reconnect-failed' (back to the lobby /
    //      home screen)"
    // flip-7 does not. flip-7:1726-1728 calls showReconnectFailed('peer'), and
    // showReconnectFailed (flip-7:1784-1796) mutates an EXISTING #reconnect-banner
    // and creates nothing:  `const banner = ...getElementById('reconnect-banner');
    //                        if (banner) { ... }`
    // The banner is only ever created by showReconnectBanner (flip-7:1751-1758),
    // which is reached from onStateChange('disconnected') alone — and a terminal
    // client never emits 'disconnected' (C8). So the superseded flip-7 tab gets a
    // three-second toast and nothing else: the fully painted, fully interactive
    // board the fallback exists to prevent.
    it('B1: a superseded flip-7 tab is left on a live-looking board — the fallback state is a no-op there', async () => {
        // flip-7's DOM, faithful to the elements the handlers below touch.
        const els = new Map();
        const mk = (id) => {
            const e = {
                id, innerHTML: '', textContent: '', style: {}, _classes: new Set(),
                classList: {
                    add: (c) => e._classes.add(c),
                    remove: (c) => e._classes.delete(c),
                    contains: (c) => e._classes.has(c),
                },
            };
            els.set(id, e);
            return e;
        };
        ['mp-banner', 'join-connecting', 'join-waiting', 'join-form', 'join-error',
            'mp-connection-dot'].forEach(mk);
        els.get('join-waiting')._classes.delete('hidden');   // the screen the player is on
        els.get('join-form')._classes.add('hidden');
        env.document.getElementById = (id) => els.get(id) || null;

        // flip-7:1751-1758 / :1779-1782 / :1784-1796, transcribed.
        let gameStarted = false;
        const showJoinError = (m) => { els.get('join-error').textContent = m; };
        const showReconnectFailed = () => {
            const banner = env.document.getElementById('reconnect-banner');
            if (banner) banner.innerHTML = 'Disconnected from host … Retry';
        };
        const onStateChange = (status) => {
            if (status === 'disconnected') {
                if (gameStarted) {
                    // showReconnectBanner() would CREATE #reconnect-banner here
                    const b = mk('reconnect-banner');
                    b.innerHTML = 'Reconnecting…';
                } else {
                    showJoinError('Disconnected from host.');
                    els.get('join-connecting').classList.add('hidden');
                    els.get('join-waiting').classList.add('hidden');
                    els.get('join-form').classList.remove('hidden');
                }
            } else if (status === 'reconnect-failed') {
                showReconnectFailed('peer');
            }
        };

        const hostLobby = new SlopLobby({
            roomPrefix: 'f7-', storageKey: 'f7-hB1',
            onPlayerJoined: () => {}, onPlayerRejoined: () => {},
        });
        const hp = hostLobby.createRoom('Host', 'ROOMB1');
        await advance(20);
        await hp;

        const tab1 = new SlopLobby({
            roomPrefix: 'f7-', storageKey: 'f7-cB1',
            onClientData: () => {}, onStateChange,
        });
        let p = tab1.joinRoom('ROOMB1', 'Carol');
        await advance(50);
        await p;

        // Chrome "Duplicate tab" / re-opening the room link: same sessionStorage,
        // so the same clientId AND the same seat token. Newest wins (C3).
        const tab2 = new SlopLobby({ roomPrefix: 'f7-', storageKey: 'f7-cB1' });
        p = tab2.joinRoom('ROOMB1', 'Carol');
        await advance(50);
        await p;
        await advance(5000);

        expect(tab1.client.terminalReason, 'precondition: tab 1 really was superseded')
            .toBe('superseded');

        expect(
            els.has('reconnect-banner') ||
            els.get('join-form')._classes.has('hidden') === false,
            'flip-7 shows the superseded tab NOTHING: showReconnectFailed only edits a ' +
            'banner that onStateChange(\'disconnected\') would have created, and a ' +
            'terminal client never emits \'disconnected\'. The player is left on the ' +
            'waiting screen of a game whose every tap is now dropped ' +
            '(sendToHost -> ' + tab1.sendToHost({ type: 'score-submit' }) + ').'
        ).toBe(true);

        tab1.destroy(); tab2.destroy(); hostLobby.destroy();
    });

    // ── B2 (C17) ──────────────────────────────────────────────────────────────
    // C17: "Wrap both in try/catch with an in-memory fallback id (module-level
    // variable) so joining still works". The fallback is WRITE-ONLY:
    //   readWithFallback (sloplobby.js:162-166) consults memoryStore only when
    //   getItem() THREW. Safari private browsing / a full quota is the opposite
    //   shape — getItem works, setItem throws (QuotaExceededError) — so every
    //   write lands in memoryStore and every read returns the store's own null.
    // getClientId therefore mints a NEW id on every call, loadToken always misses,
    // and loadRoomCode always misses.
    it('B2: when setItem throws but getItem works, the in-memory fallback is never read', () => {
        const real = globalThis.sessionStorage;
        const backing = new Map();
        globalThis.sessionStorage = {
            getItem: (k) => (backing.has(k) ? backing.get(k) : null),
            setItem: () => { throw new Error('QuotaExceededError'); },
            removeItem: (k) => backing.delete(k),
        };
        try {
            const first = SlopLobbyModule.getClientId('hm-client-id');
            const second = SlopLobbyModule.getClientId('hm-client-id');
            expect(
                second,
                'C17 promises the identity survives a storage that will not keep it; ' +
                'here every getClientId() call is a different player'
            ).toBe(first);
        } finally {
            globalThis.sessionStorage = real;
        }
    });

    // ── B2b — what B2 costs an unmodified app ────────────────────────────────
    // herd-mentality:1362-1394 builds a FRESH SlopLobby for every join and every
    // auto-rejoin, so it calls getClientId() again each time. With B2's storage the
    // returning player arrives under a brand-new clientId, the host announces
    // 'client-joined' rather than 'client-rejoined', and herd:887-890 refuses them
    // their own name. Since C5 that refusal is TERMINAL, so "try again" cannot help:
    // the player is out of the game for the rest of the night.
    it('B2b: a herd player who reconnects in a private tab is locked out of their own seat', async () => {
        const real = globalThis.sessionStorage;
        const backing = new Map();
        globalThis.sessionStorage = {
            getItem: (k) => (backing.has(k) ? backing.get(k) : null),
            setItem: () => { throw new Error('QuotaExceededError'); },
            removeItem: (k) => backing.delete(k),
        };
        try {
            // herd's host: index.html:880-902.
            const seatedNames = [];
            const hostLobby = new SlopLobby({
                roomPrefix: 'hm-', storageKey: 'hm-hostB2',
                onPlayerJoined: (clientId, metadata) => {
                    const name = (metadata && metadata.name || '').trim();
                    if (seatedNames.some(n => n.toLowerCase() === name.toLowerCase())) {
                        return 'Name already taken';
                    }
                    seatedNames.push(name);
                },
                onPlayerRejoined: () => {},
                onPlayerLeft: () => {},
            });
            const hp = hostLobby.createRoom('Host', 'ROOMB2');
            await advance(20);
            await hp;

            const first = new SlopLobby({ roomPrefix: 'hm-', storageKey: 'hm-cB2' });
            let p = first.joinRoom('ROOMB2', 'Carol');
            await advance(50);
            await p;

            // Her phone dies; the seat is released after the reconnect window.
            first.destroy();
            await advance(130000);

            // herd's startPlayer() runs again (auto-rejoin, or she taps Join).
            const painted = [];
            const again = new SlopLobby({
                roomPrefix: 'hm-', storageKey: 'hm-cB2',
                onClientData: (d) => painted.push(d.type + ':' + d.reason),
            });
            again.joinRoom('ROOMB2', 'Carol').catch(e => painted.push('throw:' + e.reason));
            await advance(300);

            expect(
                painted,
                'she is a stranger to the host, so her own name is "already taken" — and ' +
                'the refusal is terminal, so no retry can ever get her back in'
            ).toEqual([]);

            hostLobby.destroy(); again.destroy();
        } finally {
            globalThis.sessionStorage = real;
        }
    });

    // ── B3 (C10) ──────────────────────────────────────────────────────────────
    // joinRoom registers the visibilitychange listener (sloplobby.js:693) BEFORE
    // connect(), and its failure path (`dropClient()`, :704) does not unregister it.
    // herd:1385-1393 and flip-7:1735-1745 build a fresh SlopLobby per attempt and
    // herd's catch never calls destroy(), so every mistyped room code leaves a
    // listener — and the lobby it closes over — alive for the life of the page.
    it('B3: a failed joinRoom leaves its visibilitychange listener (and its lobby) registered', async () => {
        for (let i = 0; i < 3; i++) {
            const lobby = new SlopLobby({ roomPrefix: 'hm-', storageKey: 'hm-cB3' });
            lobby.joinRoom('NOPE' + i, 'Bob').catch(() => {});   // herd:1385 — no destroy()
            await advance(50);
        }
        expect(
            env.document._listenerCount('visibilitychange'),
            'three mistyped room codes, three permanently registered listeners'
        ).toBe(0);
    });

    // ── B4 (C2/C4) ────────────────────────────────────────────────────────────
    // A record is bound to a connection in ONE direction that can be overwritten:
    // _bindConn (slopnet.js:783-787) stamps conn._slopnetClientId, and a second join
    // on the same connection re-stamps it. _clientForConn (:790-796) then resolves
    // only the newest, so the first record is unreachable for ever: its 'close' is
    // ignored (C2), no window timer is ever armed, 'client-left'/'client-lost' can
    // never fire, and it stays in host.clients — and in lobby.players — for the life
    // of the room. CAH's round gate (needed = players.length - 1) can then never be
    // satisfied; texas-holdem's table never frees the seat.
    it('B4: two joins on one connection seat only the first, and leave no ghost', async () => {
        const host = await startHost('ROOMB4');
        const tab = new MockPeer();
        await advance(10);
        const conn = tab.connect('lib-ROOMB4', { reliable: true });
        await advance(10);
        conn.send({ type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alice' } });
        await advance(10);
        conn.send({ type: '__slopnet_join', clientId: 'bob', metadata: { name: 'Bob' } });
        await advance(10);
        // The second identity is ignored outright now. It used to be honoured — the first
        // seat put down and the channel re-stamped — which is what made 'alice' a ghost
        // no disconnect could ever reach, because the channel her record pointed at
        // belonged to 'bob' by then.
        expect(host.getAllClientIds().sort(), 'only the first identity is seated').toEqual(['alice']);

        const log = recordEvents(host, ['client-left', 'client-lost']);
        conn.close();
        await advance(200000);          // well past reconnectWindowMs

        expect(
            host.getAllClientIds(),
            'the connection is gone and 200 s have passed, so no seat may remain: ' +
            'events seen = ' + JSON.stringify(log.map(e => e.event + ':' + e.args[0]))
        ).toEqual([]);

        tab.destroy(); host.destroy();
    });

    // ── B5 (C9) ───────────────────────────────────────────────────────────────
    // The seat token protects an OCCUPIED seat only (slopnet.js:702-709). While the
    // holder is inside their reconnect window the seat is NOT occupied, so a join
    // that presents no token is accepted AND re-mints the token (:708). The true
    // holder's ladder then brings them back with a token that no longer matches a
    // seat that IS now occupied, so they are refused — terminally, and for the life
    // of the room. Before C9 the same sequence was harmless: last writer won and the
    // real player simply took their seat back. clientIds are not secret — CAH
    // broadcasts every player's id in `player-list` (index.html:496-499) and flip-7
    // in its lobby update — so this is reachable without guessing anything.
    it('B5: a token-less join during the reconnect window locks the seat holder out for good', async () => {
        const host = await startHost('ROOMB5', { reconnectWindowMs: 120000 });
        const alice = await joinClient('ROOMB5', 'alice', { name: 'Alice' },
            { reconnectBackoffBase: 40000, reconnectBackoffMultiplier: 1, reconnectBackoffMax: 40000 });
        const aliceToken = alice.token;
        expect(aliceToken).toBeTruthy();

        // Her channel drops (tunnel). Her seat is held; her next rung is 40 s away.
        alice.connection.close();
        await advance(100);
        expect(alice.isConnected).toBe(false);

        // Somebody else asserts her clientId with no token at all. The seat is HELD —
        // empty, but held — and Alice confirmed its token, so it is defended: the
        // stranger is turned away and the seat does not move. (Round 1 accepted this
        // join and re-minted the token underneath her, which is what made her own
        // ladder's return a terminal 'rejected' below.)
        const other = createClient();
        const otherJoin = other.connect('ROOMB5', 'alice', { name: 'Mallory' })
            .then(() => 'ok', e => 'err:' + e.type);
        await advance(200);
        expect(await otherJoin, 'a held seat whose token was confirmed is not claimable').toBe('err:rejected');
        expect(host._findClientByClientId('alice').token, 'and the token is not re-minted').toBe(aliceToken);

        // Her ladder brings her home with the token the host itself issued her.
        const alog = recordEvents(alice, ['rejected', 'reconnected', 'connected']);
        await advance(60000);

        expect(
            alice.terminalReason,
            'Alice presented the token this host minted for her and was told ' +
            JSON.stringify(alog.map(e => [e.event, e.args[0]])) +
            '. Her app sees { type:"join-error" } and stops for good.'
        ).toBe(null);

        host.destroy(); alice.destroy(); other.destroy();
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
   ROUND 3 — the kick that STICKS, seen from the four unmodified apps.

   C5/`_rememberRejection` holds the kick reason for the NEXT join that clientId
   makes, and `_handleJoin` consumes it BEFORE it looks at anything else. That is
   the right medicine for a client whose ladder keeps walking it back in, but the
   clientId is per TAB (sessionStorage) and lives for the whole page — so the very
   next thing the player does by hand, in the same tab, on the app's own
   instructions, is refused too.

   Every `it` below FAILS while the bug it names is present.
   ═══════════════════════════════════════════════════════════════════════════ */

describe('attack round 3 (fixed): the sticky kick vs. the apps that retry by hand', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        installSlopNetGlobal();
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    /** A client-side lobby wired exactly like the four apps wire theirs. */
    function player(storageKey, prefix, extra = {}) {
        const msgs = [];
        const states = [];
        const lobby = new SlopLobby({
            roomPrefix: prefix,
            storageKey,
            onClientData: d => msgs.push(d),
            onStateChange: (s, d) => states.push([s, d]),
            ...extra,
        });
        return { lobby, msgs, states };
    }

    // ── D1 (C5/C26) — herd-mentality, index.html:880-895 + :1472 ──────────────
    // herd's onPlayerJoined returns 'Name already taken', its client paints that
    // reason and goes back to the join screen (index.html:1472-1475), and the
    // player types another name. It is the SAME TAB, so getClientId() hands back
    // the SAME clientId — and the host refuses that second, perfectly good name
    // with the first attempt's reason.
    it('D1: herd — the corrected name reaches onPlayerJoined and is seated', async () => {
        const taken = new Set(['Alice']);              // the host's own name
        const seen = [];
        const hostLobby = new SlopLobby({
            roomPrefix: 'hm-', storageKey: 'hm-host',
            onPlayerJoined: (id, meta) => {
                const name = ((meta && meta.name) || '').trim();
                seen.push(name);
                if (taken.has(name)) return 'Name already taken';
                taken.add(name);
            },
            onPlayerRejoined: () => {},
        });
        const hp = hostLobby.createRoom('Alice', 'ROOMD1');
        await advance(20);
        await hp;

        // Bob types the host's name by mistake.
        const first = player('hm-player', 'hm-');
        const p1 = first.lobby.joinRoom('ROOMD1', 'Alice');
        await advance(80);
        await p1;
        expect(first.msgs).toEqual([{ type: 'join-error', reason: 'Name already taken' }]);

        // index.html:1473 — showScreen('join-screen'). He retypes and joins again;
        // startPlayer() builds a fresh SlopLobby, but the tab's clientId is the same.
        const second = player('hm-player', 'hm-');
        let err = null;
        const p2 = second.lobby.joinRoom('ROOMD1', 'Bobby').then(() => {}, e => { err = e; });
        await advance(200);
        await p2;
        await advance(10);                            // the deferred door-step join-error

        expect(
            err && err.type,
            'the second join — a name nobody in the room has — was refused at the door with ' +
            JSON.stringify({ reason: err && err.reason, painted: second.msgs }) +
            '. onPlayerJoined was never even asked: ' + JSON.stringify(seen)
        ).toBeFalsy();
        expect(seen, 'the host must be asked about the corrected name').toEqual(['Alice', 'Bobby']);
        expect(second.msgs, 'and "Name already taken" is not painted over a free name').toEqual([]);
        expect(hostLobby.getConnectedClientIds().length, 'Bobby is seated').toBe(1);

        second.lobby.destroy(); first.lobby.destroy(); hostLobby.destroy();
    });

    // ── D2 (C5) — texas-holdem, index.html:1335-1345 + :1345 client :1444 ─────
    // holdem's gate is "send an error, then removeClient", with NO reason — so
    // SlopNet remembers a rejection whose reason is the empty string. The player
    // is shown 'Game already in progress' and dropped to the lobby; when the table
    // finishes and they tap Join again, that empty-reason kick is spent on THEM:
    // joinRoom() rejects, index.html:1807 toasts 'Failed: Join rejected', and
    // nothing tells them to simply try once more.
    it('D2: texas-holdem — the player waiting for the next table is dealt in on their next tap', async () => {
        let inProgress = true;
        let hostLobby;
        hostLobby = new SlopLobby({
            roomPrefix: 'th-', storageKey: 'th-host',
            onPlayerJoined: (clientId) => {
                if (inProgress) {
                    hostLobby.send(clientId, { type: 'error', message: 'Game already in progress' });
                    hostLobby.removeClient(clientId);
                    return;
                }
                hostLobby.players.set(clientId, { name: 'Carol', playerId: 'p1' });
                hostLobby.send(clientId, { type: 'joined', playerId: 'p1' });
            },
            onPlayerRejoined: () => {},
        });
        const hp = hostLobby.createRoom('Host', 'ROOMD2');
        await advance(20);
        await hp;

        // Carol tries to sit down mid-hand.
        const first = player('th-player', 'th-');
        const p1 = first.lobby.joinRoom('ROOMD2', 'Carol');
        await advance(120);
        await p1;
        expect(first.msgs).toEqual([{ type: 'error', message: 'Game already in progress' }]);
        first.lobby.destroy();                         // index.html:1444 resetToLobby()

        // The table finishes and goes back to the waiting room.
        inProgress = false;

        const second = player('th-player', 'th-');
        let err = null;
        const p2 = second.lobby.joinRoom('ROOMD2', 'Carol').then(() => {}, e => { err = e; });
        await advance(200);
        await p2;

        expect(
            err && err.type,
            'the table is open and Carol was refused at the door: ' +
            JSON.stringify({ message: err && err.message, painted: second.msgs })
        ).toBeFalsy();
        expect(second.msgs, 'she should have been dealt in').toEqual([{ type: 'joined', playerId: 'p1' }]);

        second.lobby.destroy(); hostLobby.destroy();
    });

    // ── D3 (C10/C26) — flip-7, index.html:1738-1743 + :1944 ───────────────────
    // A door-step refusal hands the reason over on the NEXT tick so that it lands
    // after the app's own catch. flip-7's catch calls cleanupMultiplayer(), which
    // calls lobby.destroy() — and the deferred hand-over is guarded by
    // `this._destroyed`, so the reason is dropped on the floor. The player is told
    // 'Could not connect. Check the room code and try again.' about a room code
    // that is perfectly correct.
    it('D3: flip-7 — the host\'s reason is swallowed when the app cleans up in its catch', async () => {
        let started = true;
        const hostLobby = new SlopLobby({
            roomPrefix: 'f7-', storageKey: 'f7-host-d3',
            onPlayerJoined: () => (started ? 'Game already in progress. You can only rejoin with your original name.' : undefined),
            onPlayerRejoined: () => {},
        });
        const hp = hostLobby.createRoom('Host', 'ROOMD3');
        await advance(20);
        await hp;

        // Attempt 1: rejected after the ack, so the reason is painted normally.
        const first = player('f7-player', 'f7-');
        const p1 = first.lobby.joinRoom('ROOMD3', 'Dave');
        await advance(120);
        await p1;
        first.lobby.destroy();                          // cleanupMultiplayer()

        // Attempt 2, exactly as the message instructs. Now the refusal is at the
        // DOOR (the held kick), and flip-7's catch destroys the lobby.
        const second = player('f7-player', 'f7-');
        const shown = [];
        let joinErrorSeen = null;
        second.lobby._onClientData = (d) => {
            second.msgs.push(d);
            if (d.type === 'join-error') joinErrorSeen = d.reason;
        };
        const p2 = second.lobby.joinRoom('ROOMD3', 'Dave').then(() => {}, (err) => {
            // index.html:1738-1743
            shown.push(err.type === 'peer-unavailable'
                ? 'Room not found. Check the code and try again.'
                : 'Could not connect. Check the room code and try again.');
            second.lobby.destroy();                     // cleanupMultiplayer()
        });
        await advance(200);
        await p2;
        await advance(50);                              // let the deferred hand-over run

        expect(
            joinErrorSeen,
            'the player was shown ' + JSON.stringify(shown) +
            ' and never learnt why: the deferred join-error is dropped once the app has cleaned up'
        ).toBe('Game already in progress. You can only rejoin with your original name.');

        hostLobby.destroy();
    });
});

describe('attack round 3 (fixed): scope of the sticky kick', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        installSlopNetGlobal();
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    // ── D1b — the scope of the sticky kick, restated ──────────────────────────
    // The held rejection is aimed at the RETRY LADDER, not at the clientId: it is
    // consumed only by a join that carries `staleMs` (a PeerClient that has been
    // acked at some point, i.e. the machine coming back on its own). A player who
    // taps Join again because the app told them to arrives on a PeerClient built
    // since, carries no staleMs, and goes to onPlayerJoined like anybody else.
    it('D1b: a deliberate second tap is admitted, while an automatic rung is still refused', async () => {
        const taken = new Set(['Alice']);
        const hostLobby = new SlopLobby({
            roomPrefix: 'hm-', storageKey: 'hm-host-b',
            onPlayerJoined: (id, meta) => {
                const name = ((meta && meta.name) || '').trim();
                if (taken.has(name)) return 'Name already taken';
                taken.add(name);
            },
            onPlayerRejoined: () => {},
        });
        const hp = hostLobby.createRoom('Alice', 'ROOMD1B');
        await advance(20);
        await hp;

        const attempt = async (key, name) => {
            const msgs = [];
            const lobby = new SlopLobby({
                roomPrefix: 'hm-', storageKey: key,
                onClientData: d => msgs.push(d),
            });
            let err = null;
            const p = lobby.joinRoom('ROOMD1B', name).then(() => {}, e => { err = e; });
            await advance(200);
            await p;
            await advance(10);
            return { ok: !err, err, msgs, lobby };
        };

        const a1 = await attempt('hm-p2', 'Alice');       // clashes
        expect(a1.ok).toBe(true);                          // acked, then rejected
        expect(a1.msgs).toEqual([{ type: 'join-error', reason: 'Name already taken' }]);

        const a2 = await attempt('hm-p2', 'Bobby');       // the corrected name
        expect(a2.ok, 'the second tap is let in — no wasted attempt').toBe(true);
        expect(a2.msgs, 'and nothing stale is painted at it').toEqual([]);
        expect(hostLobby.getConnectedClientIds().length).toBe(1);

        a2.lobby.destroy(); hostLobby.destroy();
    });

    // The other half of the same rule: the AUTOMATIC ladder of a kicked player is
    // still refused, which is what stops "send an error, then removeClient" from
    // looping the player back in once a second all night.
    it('D1b: the kicked player\'s own retry ladder is still turned away', async () => {
        let calls = 0;
        let hostLobby;
        hostLobby = new SlopLobby({
            roomPrefix: 'hm2-', storageKey: 'hm2-host',
            onPlayerJoined: (clientId) => {
                calls++;
                hostLobby.send(clientId, { type: 'error', message: 'Game already in progress' });
                hostLobby.removeClient(clientId);
            },
            onPlayerRejoined: () => {},
        });
        const hp = hostLobby.createRoom('Host', 'ROOMD1C');
        await advance(20);
        await hp;

        const msgs = [];
        const lobby = new SlopLobby({
            roomPrefix: 'hm2-', storageKey: 'hm2-player',
            onClientData: d => msgs.push(d),
        });
        const p = lobby.joinRoom('ROOMD1C', 'Carol').catch(() => {});
        await advance(120);
        await p;
        await advance(300000);                             // five minutes of ladder

        expect(calls, 'the ladder must not be re-seated and re-kicked once a second').toBe(1);
        expect(lobby.client, 'and the client is terminal, not still climbing').toBeNull();

        lobby.destroy(); hostLobby.destroy();
    });
});

describe('attack round 3: a kick that no app can paint', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        installSlopNetGlobal();
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    // ── D4 (C8/C10/C26) ───────────────────────────────────────────────────────
    // 'superseded' and 'room-closed' are wrapped in _endOfTheRoad (sloplobby.js:822)
    // precisely because an app that has not learnt the new words would otherwise sit
    // on a live-looking board. 'rejected' gets no such wrapping: the only signals are
    // { type:'join-error' } — which CAH and texas-holdem never look at — and
    // onStateChange('rejected'), which none of the four branch on. A REASONLESS kick
    // (SlopLobby.removeClient(id), the documented host API, and the one texas-holdem
    // calls at index.html:1338/1344) has no join-error either, so the player's app is
    // left exactly where 'disconnected' put it: flip-7's "Reconnecting…" banner, for
    // ever, with the Retry button wired to a client that is null.
    it('D4: removeClient() on a seated player leaves flip-7 reconnecting for ever', async () => {
        const hostLobby = new SlopLobby({
            roomPrefix: 'f7-', storageKey: 'f7-host-d4',
            onPlayerJoined: () => {}, onPlayerRejoined: () => {},
        });
        const hp = hostLobby.createRoom('Host', 'ROOMD4');
        await advance(20);
        await hp;

        // flip-7's client banner state machine (index.html:1710-1727), verbatim.
        let banner = 'none';
        const msgs = [];
        const lobby = new SlopLobby({
            roomPrefix: 'f7-', storageKey: 'f7-player-d4',
            onClientData: d => msgs.push(d),
            onStateChange: (status) => {
                if (status === 'disconnected') banner = 'Reconnecting…';
                else if (status === 'reconnected') banner = 'none';
                else if (status === 'reconnect-failed') banner = 'Disconnected from host [Retry]';
            },
        });
        const p = lobby.joinRoom('ROOMD4', 'Dave');
        await advance(80);
        await p;
        const seat = lobby.clientId;
        expect(hostLobby.getConnectedClientIds()).toEqual([seat]);

        // The host taps "Remove player" mid-game.
        hostLobby.removeClient(seat);
        await advance(600000);                        // ten minutes of nothing

        expect(
            banner,
            'the game is over for this player and their screen still says ' +
            JSON.stringify(banner) + ' (messages painted: ' + JSON.stringify(msgs) + ', ' +
            'lobby.client=' + (lobby.client ? 'terminal' : 'null') + '). ' +
            "'superseded' and 'room-closed' get _endOfTheRoad's bookends; 'rejected' does not."
        ).toBe('Disconnected from host [Retry]');

        lobby.destroy(); hostLobby.destroy();
    });
});
