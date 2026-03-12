/**
 * Integration tests: Multi-client scenarios.
 *
 * Tests handling of many simultaneous clients, connect/disconnect cycles,
 * client isolation, and game lobby patterns.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { PeerHost, PeerClient } = SlopNet;

const BASE_CONFIG = {
    roomPrefix: 'multi-',
    heartbeatInterval: 0,
    reconnectWindowMs: 60000,
    connectionTimeout: 5000,
    _PeerClass: MockPeer,
};

function createHost(overrides = {}) {
    return new PeerHost({ ...BASE_CONFIG, ...overrides });
}

function createClient(overrides = {}) {
    return new PeerClient({ ...BASE_CONFIG, ...overrides });
}

describe('Multi-Client Integration', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('many simultaneous clients', () => {
        it('should handle 10 clients connecting', async () => {
            const host = createHost();
            const hp = host.start('LOBBY');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const clients = [];
            for (let i = 0; i < 10; i++) {
                const c = createClient();
                const cp = c.connect('LOBBY', `player${i}`, { name: `Player ${i}` });
                await vi.advanceTimersByTimeAsync(50);
                await cp;
                clients.push(c);
            }

            expect(host.getConnectedClientIds()).toHaveLength(10);
            for (let i = 0; i < 10; i++) {
                expect(host.isClientConnected(`player${i}`)).toBe(true);
            }

            clients.forEach(c => c.destroy());
            host.destroy();
        });

        it('should broadcast to 10 clients simultaneously', async () => {
            const host = createHost();
            const hp = host.start('LOBBY');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const clients = [];
            const dataFns = [];
            for (let i = 0; i < 10; i++) {
                const c = createClient();
                const cp = c.connect('LOBBY', `player${i}`, {});
                await vi.advanceTimersByTimeAsync(50);
                await cp;
                const fn = vi.fn();
                c.on('data', fn);
                clients.push(c);
                dataFns.push(fn);
            }

            host.broadcast({ type: 'round-start', data: { round: 1, pot: 0 } });
            await vi.advanceTimersByTimeAsync(50);

            for (let i = 0; i < 10; i++) {
                expect(dataFns[i]).toHaveBeenCalledWith({ type: 'round-start', data: { round: 1, pot: 0 } });
            }

            clients.forEach(c => c.destroy());
            host.destroy();
        });

        it('should receive data from 10 clients', async () => {
            const host = createHost();
            const hp = host.start('LOBBY');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const hostData = [];
            host.on('data', (clientId, data) => hostData.push({ clientId, data }));

            const clients = [];
            for (let i = 0; i < 10; i++) {
                const c = createClient();
                const cp = c.connect('LOBBY', `player${i}`, {});
                await vi.advanceTimersByTimeAsync(50);
                await cp;
                clients.push(c);
            }

            // Each client sends a message
            for (let i = 0; i < 10; i++) {
                clients[i].send({ type: 'action', value: i });
            }
            await vi.advanceTimersByTimeAsync(50);

            expect(hostData).toHaveLength(10);
            for (let i = 0; i < 10; i++) {
                const msg = hostData.find(d => d.data.value === i);
                expect(msg).toBeTruthy();
                expect(msg.clientId).toBe(`player${i}`);
            }

            clients.forEach(c => c.destroy());
            host.destroy();
        });
    });

    describe('connect/disconnect cycles', () => {
        it('should handle rapid connect/disconnect of multiple clients', async () => {
            const host = createHost({ reconnectWindowMs: 0 });
            const hp = host.start('LOBBY');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const joinEvents = [];
            const leftEvents = [];
            host.on('client-joined', id => joinEvents.push(id));
            host.on('client-left', id => leftEvents.push(id));
            host.on('client-lost', id => leftEvents.push(id + '-lost'));

            // Connect 5 clients
            const clients = [];
            for (let i = 0; i < 5; i++) {
                const c = createClient({ maxReconnectAttempts: 0 });
                const cp = c.connect('LOBBY', `p${i}`, {});
                await vi.advanceTimersByTimeAsync(50);
                await cp;
                clients.push(c);
            }
            expect(joinEvents).toHaveLength(5);

            // Disconnect all
            for (const c of clients) {
                c.destroy();
            }
            await vi.advanceTimersByTimeAsync(50);

            // All should be gone (reconnectWindowMs=0)
            expect(host.getAllClientIds()).toHaveLength(0);

            // Connect 5 new clients
            const newClients = [];
            for (let i = 0; i < 5; i++) {
                const c = createClient({ maxReconnectAttempts: 0 });
                const cp = c.connect('LOBBY', `new_p${i}`, {});
                await vi.advanceTimersByTimeAsync(50);
                await cp;
                newClients.push(c);
            }

            expect(host.getConnectedClientIds()).toHaveLength(5);

            newClients.forEach(c => c.destroy());
            host.destroy();
        });

        it('should handle a client disconnecting and reconnecting as new', async () => {
            const host = createHost({ reconnectWindowMs: 0 });
            const hp = host.start('LOBBY');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const c = createClient({ maxReconnectAttempts: 0 });
            const cp = c.connect('LOBBY', 'alice', { name: 'Alice' });
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            expect(host.getConnectedClientIds()).toEqual(['alice']);

            c.destroy();
            await vi.advanceTimersByTimeAsync(50);

            expect(host.getAllClientIds()).toHaveLength(0);

            // Reconnect as new client with same ID
            const c2 = createClient({ maxReconnectAttempts: 0 });
            const cp2 = c2.connect('LOBBY', 'alice', { name: 'Alice v2' });
            await vi.advanceTimersByTimeAsync(50);
            await cp2;

            expect(host.getConnectedClientIds()).toEqual(['alice']);

            c2.destroy();
            host.destroy();
        });
    });

    describe('client isolation', () => {
        it('should only deliver targeted messages to the correct client', async () => {
            const host = createHost();
            const hp = host.start('LOBBY');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const clients = [];
            const dataFns = [];
            for (let i = 0; i < 3; i++) {
                const c = createClient();
                const cp = c.connect('LOBBY', `p${i}`, {});
                await vi.advanceTimersByTimeAsync(50);
                await cp;
                const fn = vi.fn();
                c.on('data', fn);
                clients.push(c);
                dataFns.push(fn);
            }

            // Send targeted message only to p1
            host.send('p1', { type: 'secret', for: 'you only' });
            await vi.advanceTimersByTimeAsync(20);

            expect(dataFns[0]).not.toHaveBeenCalled();
            expect(dataFns[1]).toHaveBeenCalledWith({ type: 'secret', for: 'you only' });
            expect(dataFns[2]).not.toHaveBeenCalled();

            clients.forEach(c => c.destroy());
            host.destroy();
        });

        it('should route client messages to host with correct client IDs', async () => {
            const host = createHost();
            const hp = host.start('LOBBY');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const hostData = [];
            host.on('data', (clientId, data) => hostData.push({ clientId, data }));

            const c1 = createClient();
            const c2 = createClient();
            const cp1 = c1.connect('LOBBY', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp1;
            const cp2 = c2.connect('LOBBY', 'bob', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp2;

            c1.send({ from: 'alice' });
            c2.send({ from: 'bob' });
            await vi.advanceTimersByTimeAsync(20);

            const aliceMsg = hostData.find(d => d.data.from === 'alice');
            const bobMsg = hostData.find(d => d.data.from === 'bob');
            expect(aliceMsg.clientId).toBe('alice');
            expect(bobMsg.clientId).toBe('bob');

            c1.destroy();
            c2.destroy();
            host.destroy();
        });
    });

    describe('game lobby scenarios', () => {
        it('should simulate a complete game lobby flow', async () => {
            const host = createHost();
            const hp = host.start('POKER');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const events = [];
            host.on('client-joined', (id, meta) => events.push({ type: 'joined', id, meta }));
            host.on('client-left', (id) => events.push({ type: 'left', id }));
            host.on('data', (id, data) => events.push({ type: 'data', id, data }));

            // Players join one by one
            const alice = createClient();
            const ap = alice.connect('POKER', 'alice', { name: 'Alice' });
            await vi.advanceTimersByTimeAsync(50);
            await ap;

            const bob = createClient();
            const bp = bob.connect('POKER', 'bob', { name: 'Bob' });
            await vi.advanceTimersByTimeAsync(50);
            await bp;

            const charlie = createClient();
            const chp = charlie.connect('POKER', 'charlie', { name: 'Charlie' });
            await vi.advanceTimersByTimeAsync(50);
            await chp;

            expect(host.getConnectedClientIds()).toHaveLength(3);

            // Host broadcasts game start
            const clientDatas = { alice: [], bob: [], charlie: [] };
            alice.on('data', d => clientDatas.alice.push(d));
            bob.on('data', d => clientDatas.bob.push(d));
            charlie.on('data', d => clientDatas.charlie.push(d));

            host.broadcast({ type: 'game-start', players: ['Host', 'Alice', 'Bob', 'Charlie'] });
            await vi.advanceTimersByTimeAsync(20);

            expect(clientDatas.alice[0]).toEqual({ type: 'game-start', players: ['Host', 'Alice', 'Bob', 'Charlie'] });
            expect(clientDatas.bob[0]).toEqual({ type: 'game-start', players: ['Host', 'Alice', 'Bob', 'Charlie'] });
            expect(clientDatas.charlie[0]).toEqual({ type: 'game-start', players: ['Host', 'Alice', 'Bob', 'Charlie'] });

            // Players respond
            alice.send({ type: 'ready' });
            bob.send({ type: 'ready' });
            charlie.send({ type: 'ready' });
            await vi.advanceTimersByTimeAsync(20);

            const readyMsgs = events.filter(e => e.type === 'data' && e.data.type === 'ready');
            expect(readyMsgs).toHaveLength(3);

            alice.destroy();
            bob.destroy();
            charlie.destroy();
            host.destroy();
        });

        it('should handle late joiners during lobby phase', async () => {
            const host = createHost();
            const hp = host.start('ROOM');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            // First player
            const c1 = createClient();
            const cp1 = c1.connect('ROOM', 'p1', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp1;

            // Broadcast lobby state
            const c1Data = [];
            c1.on('data', d => c1Data.push(d));

            host.broadcast({ type: 'lobby', players: ['p1'] });
            await vi.advanceTimersByTimeAsync(10);

            // Second player joins
            const c2 = createClient();
            const cp2 = c2.connect('ROOM', 'p2', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp2;

            const c2Data = [];
            c2.on('data', d => c2Data.push(d));

            // Broadcast updated lobby
            host.broadcast({ type: 'lobby', players: ['p1', 'p2'] });
            await vi.advanceTimersByTimeAsync(10);

            expect(c1Data).toHaveLength(2);
            expect(c2Data).toHaveLength(1);
            expect(c2Data[0]).toEqual({ type: 'lobby', players: ['p1', 'p2'] });

            c1.destroy();
            c2.destroy();
            host.destroy();
        });

        it('should handle host sending targeted state to each player', async () => {
            const host = createHost();
            const hp = host.start('DEAL');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const clients = [];
            const received = {};
            for (const name of ['alice', 'bob', 'charlie']) {
                const c = createClient();
                const cp = c.connect('DEAL', name, {});
                await vi.advanceTimersByTimeAsync(50);
                await cp;
                received[name] = [];
                c.on('data', d => received[name].push(d));
                clients.push(c);
            }

            // Deal different hands to each player
            host.send('alice', { type: 'deal', cards: ['AS', 'KH'] });
            host.send('bob', { type: 'deal', cards: ['2C', '7D'] });
            host.send('charlie', { type: 'deal', cards: ['QS', 'QH'] });
            await vi.advanceTimersByTimeAsync(20);

            expect(received.alice).toEqual([{ type: 'deal', cards: ['AS', 'KH'] }]);
            expect(received.bob).toEqual([{ type: 'deal', cards: ['2C', '7D'] }]);
            expect(received.charlie).toEqual([{ type: 'deal', cards: ['QS', 'QH'] }]);

            clients.forEach(c => c.destroy());
            host.destroy();
        });
    });

    describe('relay pattern', () => {
        it('should relay messages between clients through the host', async () => {
            const host = createHost();
            const hp = host.start('RELAY');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            // Set up relay: when host gets data from one client, forward to others
            host.on('data', (fromId, data) => {
                if (data.type === 'chat') {
                    host.broadcast({ type: 'chat', from: fromId, message: data.message }, [fromId]);
                }
            });

            const alice = createClient();
            const bob = createClient();
            const ap = alice.connect('RELAY', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await ap;
            const bp = bob.connect('RELAY', 'bob', {});
            await vi.advanceTimersByTimeAsync(50);
            await bp;

            const aliceData = [];
            const bobData = [];
            alice.on('data', d => aliceData.push(d));
            bob.on('data', d => bobData.push(d));

            // Alice sends a chat
            alice.send({ type: 'chat', message: 'Hello!' });
            await vi.advanceTimersByTimeAsync(20);

            // Bob should receive it, Alice should not (excluded)
            expect(bobData).toEqual([{ type: 'chat', from: 'alice', message: 'Hello!' }]);
            expect(aliceData).toEqual([]);

            // Bob responds
            bob.send({ type: 'chat', message: 'Hi Alice!' });
            await vi.advanceTimersByTimeAsync(20);

            expect(aliceData).toEqual([{ type: 'chat', from: 'bob', message: 'Hi Alice!' }]);

            alice.destroy();
            bob.destroy();
            host.destroy();
        });
    });
});
