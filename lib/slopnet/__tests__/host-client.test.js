/**
 * Integration tests: Host-Client basic interactions.
 *
 * These tests use the MockPeer to simulate real PeerJS connections,
 * testing the full join/data/disconnect flow through SlopNet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { PeerHost, PeerClient } = SlopNet;

const BASE_CONFIG = {
    roomPrefix: 'integ-',
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

describe('Host-Client Integration', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('basic connection flow', () => {
        it('should complete a full join handshake', async () => {
            const host = createHost();
            const hp = host.start('GAME1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const hostJoinedFn = vi.fn();
            host.on('client-joined', hostJoinedFn);

            const client = createClient();
            const clientConnectedFn = vi.fn();
            client.on('connected', clientConnectedFn);

            const cp = client.connect('GAME1', 'alice', { name: 'Alice', avatar: 'cat' });
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            expect(hostJoinedFn).toHaveBeenCalledWith('alice', { name: 'Alice', avatar: 'cat' });
            expect(clientConnectedFn).toHaveBeenCalled();
            expect(host.getConnectedClientIds()).toEqual(['alice']);
            expect(client.isConnected).toBe(true);

            client.destroy();
            host.destroy();
        });

        it('should handle bidirectional data exchange', async () => {
            const host = createHost();
            const hp = host.start('GAME1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const cp = client.connect('GAME1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Host -> Client
            const clientDataFn = vi.fn();
            client.on('data', clientDataFn);
            host.send('alice', { type: 'deal', cards: ['AS', 'KH'] });
            await vi.advanceTimersByTimeAsync(10);
            expect(clientDataFn).toHaveBeenCalledWith({ type: 'deal', cards: ['AS', 'KH'] });

            // Client -> Host
            const hostDataFn = vi.fn();
            host.on('data', hostDataFn);
            client.send({ type: 'bet', amount: 100 });
            await vi.advanceTimersByTimeAsync(10);
            expect(hostDataFn).toHaveBeenCalledWith('alice', { type: 'bet', amount: 100 });

            client.destroy();
            host.destroy();
        });

        it('should handle multiple rounds of data exchange', async () => {
            const host = createHost();
            const hp = host.start('GAME1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const cp = client.connect('GAME1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            const hostData = [];
            const clientData = [];
            host.on('data', (id, d) => hostData.push(d));
            client.on('data', d => clientData.push(d));

            // Simulate a few rounds
            for (let i = 0; i < 5; i++) {
                host.send('alice', { round: i });
                client.send({ response: i });
            }
            await vi.advanceTimersByTimeAsync(50);

            expect(clientData).toHaveLength(5);
            expect(hostData).toHaveLength(5);
            expect(clientData[2]).toEqual({ round: 2 });
            expect(hostData[2]).toEqual({ response: 2 });

            client.destroy();
            host.destroy();
        });

        it('should handle complex nested data structures', async () => {
            const host = createHost();
            const hp = host.start('GAME1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const cp = client.connect('GAME1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            const clientDataFn = vi.fn();
            client.on('data', clientDataFn);

            const complexData = {
                type: 'game-state',
                players: [
                    { name: 'Alice', score: 100, cards: [{ suit: 'hearts', value: 'A' }] },
                    { name: 'Bob', score: 50, cards: [] },
                ],
                board: { community: ['AS', '2H', '3D'], pot: 500 },
                meta: { round: 3, phase: 'river', timestamp: 1234567890 },
            };

            host.send('alice', complexData);
            await vi.advanceTimersByTimeAsync(10);

            expect(clientDataFn).toHaveBeenCalledWith(complexData);

            client.destroy();
            host.destroy();
        });
    });

    describe('disconnect handling', () => {
        it('should emit disconnect events on both sides', async () => {
            const host = createHost();
            const hp = host.start('GAME1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient({ maxReconnectAttempts: 0 });
            const cp = client.connect('GAME1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            const hostLeftFn = vi.fn();
            const clientDisconnectedFn = vi.fn();
            host.on('client-left', hostLeftFn);
            client.on('disconnected', clientDisconnectedFn);

            // Close from client side
            client.connection.close();
            await vi.advanceTimersByTimeAsync(20);

            expect(hostLeftFn).toHaveBeenCalledWith('alice', {});
            expect(clientDisconnectedFn).toHaveBeenCalled();
            expect(client.isConnected).toBe(false);
            expect(host.getDisconnectedClientIds()).toContain('alice');

            client.destroy();
            host.destroy();
        });

        it('should handle client destroy gracefully', async () => {
            const host = createHost();
            const hp = host.start('GAME1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const cp = client.connect('GAME1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            const hostLeftFn = vi.fn();
            host.on('client-left', hostLeftFn);

            client.destroy();
            await vi.advanceTimersByTimeAsync(20);

            expect(hostLeftFn).toHaveBeenCalledWith('alice', {});

            host.destroy();
        });

        it('should handle host destroy gracefully', async () => {
            const host = createHost();
            const hp = host.start('GAME1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient({ maxReconnectAttempts: 0 });
            const clientDisconnectedFn = vi.fn();
            client.on('disconnected', clientDisconnectedFn);

            const cp = client.connect('GAME1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            host.destroy();
            await vi.advanceTimersByTimeAsync(20);

            expect(clientDisconnectedFn).toHaveBeenCalled();

            client.destroy();
        });
    });

    describe('broadcasting', () => {
        it('should broadcast to all connected clients', async () => {
            const host = createHost();
            const hp = host.start('GAME1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const clients = [];
            const dataFns = [];
            for (let i = 0; i < 4; i++) {
                const c = createClient();
                const cp = c.connect('GAME1', `player${i}`, { name: `P${i}` });
                await vi.advanceTimersByTimeAsync(50);
                await cp;
                const fn = vi.fn();
                c.on('data', fn);
                clients.push(c);
                dataFns.push(fn);
            }

            host.broadcast({ type: 'game-start', round: 1 });
            await vi.advanceTimersByTimeAsync(20);

            for (const fn of dataFns) {
                expect(fn).toHaveBeenCalledWith({ type: 'game-start', round: 1 });
            }

            clients.forEach(c => c.destroy());
            host.destroy();
        });

        it('should skip disconnected clients in broadcast', async () => {
            const host = createHost();
            const hp = host.start('GAME1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const c1 = createClient({ maxReconnectAttempts: 0 });
            const c2 = createClient({ maxReconnectAttempts: 0 });
            const cp1 = c1.connect('GAME1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp1;
            const cp2 = c2.connect('GAME1', 'bob', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp2;

            const dataFn1 = vi.fn();
            const dataFn2 = vi.fn();
            c1.on('data', dataFn1);
            c2.on('data', dataFn2);

            // Disconnect alice
            c1.connection.close();
            await vi.advanceTimersByTimeAsync(20);

            host.broadcast({ type: 'update' });
            await vi.advanceTimersByTimeAsync(10);

            expect(dataFn1).not.toHaveBeenCalled();
            expect(dataFn2).toHaveBeenCalledWith({ type: 'update' });

            c1.destroy();
            c2.destroy();
            host.destroy();
        });
    });
});
