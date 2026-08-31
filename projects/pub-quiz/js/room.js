/*
 * room.js — the host's side of the phone layer.
 *
 * Wraps SlopLobby so the rest of the app never touches the network. The quiz
 * calls open()/close()/reveal() as it moves through a round; this module works
 * out what each phone should be looking at and collects what thumbs did.
 *
 * The contract this implements is written down in PHONES.md. The short version:
 * the host is the only authority, no phone is ever sent an answer, the unit of
 * play is the table, and every round must still be playable with no phones at
 * all.
 *
 * Nothing in here scores anything. Submissions go to formats.js, which is pure.
 */

const ROOM_PREFIX = 'pubquiz-';
const STORAGE_KEY = 'pubquiz-client-id';

/** A submission the host has accepted, keyed by team. */
const emptyEntries = () => ({});

export class QuizRoom {
    #lobby = null;
    #teams = [];
    #bind = new Map();        // clientId -> teamId
    #seen = new Map();        // `${clientId}|${roundId}|${qi}` -> last accepted seq
    #listeners = new Set();

    // What the phones are currently looking at. The host owns all of it.
    #live = null;             // { roundId, qi, format, open, viewFor(teamId) }
    #entries = emptyEntries();

    roomCode = '';
    state = 'idle';           // idle | connecting | open | error

    /** Subscribe to any change worth re-rendering the host screen for. */
    onChange(fn) {
        if (typeof fn !== 'function') return () => {};
        this.#listeners.add(fn);
        return () => this.#listeners.delete(fn);
    }

    #emit() {
        for (const fn of Array.from(this.#listeners)) {
            try { fn(this.snapshot()); } catch { /* a listener must not break the quiz */ }
        }
    }

    /** Everything the host screen needs, and nothing it could leak. */
    snapshot() {
        const claimed = {};
        for (const teamId of this.#bind.values()) claimed[teamId] = (claimed[teamId] || 0) + 1;
        return {
            state: this.state,
            roomCode: this.roomCode,
            devices: this.#bind.size,
            claimed,
            entries: { ...this.#entries },
            live: this.#live ? { roundId: this.#live.roundId, qi: this.#live.qi, open: this.#live.open } : null,
        };
    }

    get available() {
        return typeof globalThis.SlopLobby === 'function'
            || (globalThis.SlopLobby && typeof globalThis.SlopLobby === 'object');
    }

    /**
     * Open a room. Resolves with the code to put on screen.
     * Safe to call twice; the second call returns the existing code.
     */
    async open(teams) {
        this.#teams = (teams || []).map((t) => ({ id: t.id, name: t.name }));
        if (this.#lobby) { this.#greetAll(); return this.roomCode; }

        const Lobby = globalThis.SlopLobby;
        if (!Lobby) throw new Error('SlopLobby is not loaded');

        this.state = 'connecting';
        this.#emit();

        this.#lobby = new Lobby({
            roomPrefix: ROOM_PREFIX,
            storageKey: STORAGE_KEY,
            onHostData: (clientId, data) => this.#onData(clientId, data),
            onPlayerJoined: (clientId) => { this.#greet(clientId); },
            onPlayerRejoined: (clientId) => { this.#greet(clientId); },
            // A dropped phone keeps its team. The table is still in the game and
            // may well be answering out loud; the host decides, not the network.
            onPlayerLeft: () => this.#emit(),
            onPlayerLost: (clientId) => { this.#bind.delete(clientId); this.#emit(); },
            onRoomCode: (code) => { this.roomCode = code; this.#emit(); },
        });

        this.roomCode = await this.#lobby.createRoom('Quizmaster');
        this.state = 'open';
        this.#emit();
        return this.roomCode;
    }

    close() {
        try { this.#lobby?.destroy(); } catch { /* nothing useful to do */ }
        this.#lobby = null;
        this.#bind.clear();
        this.#seen.clear();
        this.#live = null;
        this.#entries = emptyEntries();
        this.state = 'idle';
        this.roomCode = '';
        this.#emit();
    }

    // ---- what the phones are looking at ----

    /**
     * Put a question in front of the phones.
     * @param {object} spec { roundId, qi, format, viewFor(teamId) -> object }
     * `viewFor` is called per team and must never return a correct answer.
     */
    present(spec) {
        this.#live = { ...spec, open: false };
        this.#entries = emptyEntries();
        this.#pushAll();
    }

    /** Let thumbs move. */
    openQuestion() {
        if (!this.#live) return;
        this.#live.open = true;
        this.#pushAll();
    }

    /** Stop accepting. Anything arriving after this is dropped, including a flush. */
    closeQuestion() {
        if (!this.#live) return;
        this.#live.open = false;
        this.#pushAll();
    }

    /** Nothing for phones to do — between rounds, or during a written round. */
    idle(message = 'Sit tight.') {
        this.#live = null;
        this.#entries = emptyEntries();
        this.#broadcast({ t: 'idle', message });
        this.#emit();
    }

    /** What every team has submitted for the live question. */
    entries() {
        return { ...this.#entries };
    }

    /**
     * Record a submission on a team's behalf — the host proxy. This is what
     * makes a phoneless team, a flat battery or a router failure survivable:
     * the table says it out loud and the host enters it.
     */
    enterFor(teamId, value) {
        if (!this.#live) return;
        this.#entries[teamId] = { value, byHost: true };
        this.#emit();
    }

    // ---- inbound ----

    #onData(clientId, data) {
        if (!data || typeof data !== 'object') return;

        if (data.t === 'claim') {
            const team = this.#teams.find((x) => x.id === data.teamId);
            if (!team) return;
            this.#bind.set(clientId, team.id);
            this.#greet(clientId);
            this.#emit();
            return;
        }

        if (data.t !== 'commit') return;

        const teamId = this.#bind.get(clientId);
        // The binding decides the team, never the payload. A phone cannot answer
        // for a table it has not claimed.
        if (!teamId || !this.#live || !this.#live.open) return;
        if (data.roundId !== this.#live.roundId || data.qi !== this.#live.qi) return;

        // SlopNet queues messages for an absent phone and flushes them on return,
        // so a commit can arrive twice. The sequence is what makes a lock or a
        // bank impossible to replay.
        const key = `${clientId}|${data.roundId}|${data.qi}`;
        const seq = Number(data.seq);
        if (!Number.isFinite(seq) || seq <= (this.#seen.get(key) ?? -1)) return;
        this.#seen.set(key, seq);

        this.#entries[teamId] = { value: data.value, clientId };
        this.#send(clientId, { t: 'ack', roundId: data.roundId, qi: data.qi, seq });
        this.#pushTo(clientId);
        this.#emit();
    }

    // ---- outbound ----

    #greet(clientId) {
        this.#send(clientId, {
            t: 'hello',
            teams: this.#teams,
            teamId: this.#bind.get(clientId) || null,
        });
        this.#pushTo(clientId);
    }

    #greetAll() {
        for (const clientId of this.#bind.keys()) this.#greet(clientId);
    }

    #pushTo(clientId) {
        if (!this.#live) { this.#send(clientId, { t: 'idle', message: 'Sit tight.' }); return; }
        const teamId = this.#bind.get(clientId);
        if (!teamId) return;
        this.#send(clientId, {
            t: 'view',
            roundId: this.#live.roundId,
            qi: this.#live.qi,
            format: this.#live.format,
            open: this.#live.open,
            view: this.#live.viewFor(teamId, this.#entries[teamId]),
            submitted: Object.prototype.hasOwnProperty.call(this.#entries, teamId),
        });
    }

    #pushAll() {
        for (const clientId of this.#bind.keys()) this.#pushTo(clientId);
        this.#emit();
    }

    #send(clientId, payload) {
        try { this.#lobby?.send(clientId, payload); } catch { /* a dead phone is not an error */ }
    }

    #broadcast(payload) {
        try { this.#lobby?.broadcast(payload); } catch { /* as above */ }
    }
}
