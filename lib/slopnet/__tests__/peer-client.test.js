import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry, flushMicrotasks, waitForEvent } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { PeerClient, PeerHost } = SlopNet;

function createHost(roomCode = 'ROOM1', overrides = {}) {
    return new PeerHost({
        roomPrefix: 'test-',
        heartbeatInterval: 0,
        reconnectWindowMs: 60000,
        _PeerClass: MockPeer,
        ...overrides,
    });
}

function createClient(overrides = {}) {
    return new PeerClient({
        roomPrefix: 'test-',
        heartbeatInterval: 0,
        connectionTimeout: 5000,
        _PeerClass: MockPeer,
        ...overrides,
    });
}

describe('PeerClient', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('initialization', () => {
        it('should connect to a host and emit connected event', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(10);
            await hp;

            const client = createClient();
            const connectedFn = vi.fn();
            client.on('connected', connectedFn);

            const cp = client.connect('ROOM1', 'player1', { name: 'Alice' });
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            expect(connectedFn).toHaveBeenCalled();
            expect(client.isConnected).toBe(true);
            expect(client.clientId).toBe('player1');

            client.destroy();
            host.destroy();
        });

        it('should throw if connect called after destroy', () => {
            const client = createClient();
            client.destroy();
            expect(() => client.connect('ROOM1', 'p1')).toThrow('destroyed');
        });

        it('should throw if connect called while already connected', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(10);
            await hp;

            const client = createClient();
            const cp = client.connect('ROOM1', 'player1');
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            expect(() => client.connect('ROOM2', 'player1')).toThrow('already connected');

            client.destroy();
            host.destroy();
        });

        it('should reject on connection timeout when host does not exist', async () => {
            const client = createClient({ connectionTimeout: 200 });
            const errorFn = vi.fn();
            client.on('error', errorFn);

            const cp = client.connect('NONEXISTENT', 'player1').catch(e => e);
            await vi.advanceTimersByTimeAsync(10); // peer-unavailable error
            const result = await cp;

            expect(result).toBeInstanceOf(Error);

            client.destroy();
        });
    });

    describe('data exchange', () => {
        let host, client;

        beforeEach(async () => {
            host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(10);
            await hp;

            client = createClient();
            const cp = client.connect('ROOM1', 'player1', { name: 'Alice' });
            await vi.advanceTimersByTimeAsync(50);
            await cp;
        });

        afterEach(() => {
            client.destroy();
            host.destroy();
        });

        it('should send data from client to host', async () => {
            const dataFn = vi.fn();
            host.on('data', dataFn);

            client.send({ type: 'action', value: 'bet' });
            await vi.advanceTimersByTimeAsync(10);

            expect(dataFn).toHaveBeenCalledWith('player1', { type: 'action', value: 'bet' });
        });

        it('should receive data from host', async () => {
            const dataFn = vi.fn();
            client.on('data', dataFn);

            host.send('player1', { type: 'state', round: 2 });
            await vi.advanceTimersByTimeAsync(10);

            expect(dataFn).toHaveBeenCalledWith({ type: 'state', round: 2 });
        });

        it('should return true for successful send', () => {
            expect(client.send({ type: 'test' })).toBe(true);
        });
    });

    describe('message queuing', () => {
        it('should queue messages when disconnected', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(10);
            await hp;

            const client = createClient({ maxReconnectAttempts: 0 });
            const cp = client.connect('ROOM1', 'player1');
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Disconnect
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            // Send while disconnected
            client.send({ type: 'queued1' });
            client.send({ type: 'queued2' });

            expect(client.queueSize).toBe(2);

            client.destroy();
            host.destroy();
        });

        it('should flush queued messages on reconnect', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(10);
            await hp;

            const client = createClient({
                reconnectBackoffBase: 50,
                reconnectBackoffMax: 100,
            });
            const cp = client.connect('ROOM1', 'player1');
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            const dataFn = vi.fn();
            host.on('data', dataFn);

            // Disconnect
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            // Queue messages
            client.send({ type: 'queued1' });
            client.send({ type: 'queued2' });
            expect(client.queueSize).toBe(2);

            // Wait for reconnection
            await vi.advanceTimersByTimeAsync(200);

            // Messages should have been flushed
            expect(client.queueSize).toBe(0);

            // Wait for the flushed messages to arrive
            await vi.advanceTimersByTimeAsync(50);
            const userCalls = dataFn.mock.calls.filter(c => !c[1].type.startsWith('__slopnet_'));
            expect(userCalls).toHaveLength(2);

            client.destroy();
            host.destroy();
        });
    });

    describe('reconnection', () => {
        it('should attempt reconnect on disconnect', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(10);
            await hp;

            const client = createClient({
                reconnectBackoffBase: 100,
                reconnectBackoffMax: 500,
            });
            const reconnectingFn = vi.fn();
            client.on('reconnecting', reconnectingFn);

            const cp = client.connect('ROOM1', 'player1');
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Disconnect
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            // First reconnect attempt
            await vi.advanceTimersByTimeAsync(110);
            expect(reconnectingFn).toHaveBeenCalledWith(1, 20);

            client.destroy();
            host.destroy();
        });

        it('should emit reconnected event on successful reconnect', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(10);
            await hp;

            const client = createClient({
                reconnectBackoffBase: 50,
                reconnectBackoffMax: 100,
            });
            const reconnectedFn = vi.fn();
            client.on('reconnected', reconnectedFn);

            const cp = client.connect('ROOM1', 'player1');
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Disconnect
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            // Wait for reconnection
            await vi.advanceTimersByTimeAsync(200);

            expect(reconnectedFn).toHaveBeenCalled();
            expect(client.isConnected).toBe(true);

            client.destroy();
            host.destroy();
        });

        it('should emit reconnect-failed after max attempts with no host', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(10);
            await hp;

            const client = createClient({
                maxReconnectAttempts: 2,
                reconnectBackoffBase: 50,
                reconnectBackoffMax: 100,
            });
            const failedFn = vi.fn();
            client.on('reconnect-failed', failedFn);

            const cp = client.connect('ROOM1', 'player1');
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Destroy host so reconnection fails
            host.destroy();
            await vi.advanceTimersByTimeAsync(10);

            // Disconnect client
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            // Wait for both reconnect attempts to exhaust
            // Attempt 1: 50ms delay + connection attempt
            await vi.advanceTimersByTimeAsync(70);
            // Attempt 2: 75ms delay + connection attempt
            await vi.advanceTimersByTimeAsync(200);

            // The error events from peer-unavailable should trigger more attempts
            // Eventually it should fail
            await vi.advanceTimersByTimeAsync(500);

            expect(failedFn).toHaveBeenCalled();

            client.destroy();
        });

        it('should use exponential backoff', async () => {
            const delays = [];
            const origSetTimeout = globalThis.setTimeout;

            const client = createClient({
                reconnectBackoffBase: 100,
                reconnectBackoffMultiplier: 2,
                reconnectBackoffMax: 1000,
            });

            // Verify computed backoff values
            const { _computeBackoff } = SlopNet;
            expect(_computeBackoff(0, 100, 2, 1000)).toBe(100);
            expect(_computeBackoff(1, 100, 2, 1000)).toBe(200);
            expect(_computeBackoff(2, 100, 2, 1000)).toBe(400);
            expect(_computeBackoff(3, 100, 2, 1000)).toBe(800);
            expect(_computeBackoff(4, 100, 2, 1000)).toBe(1000); // capped

            client.destroy();
        });

        it('manual reconnect() should reset attempt counter', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(10);
            await hp;

            const client = createClient({
                maxReconnectAttempts: 10,
                reconnectBackoffBase: 50,
            });

            const cp = client.connect('ROOM1', 'player1');
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Disconnect via connection close
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            // Let first auto-reconnect attempt fire (bumps counter)
            await vi.advanceTimersByTimeAsync(60);

            // Now manually call reconnect - should reset the counter
            // First disconnect again if we reconnected
            if (client.isConnected) {
                client.connection.close();
                await vi.advanceTimersByTimeAsync(10);
            }

            const reconnectingFn = vi.fn();
            client.on('reconnecting', reconnectingFn);

            client.reconnect();
            await vi.advanceTimersByTimeAsync(10);

            // Should have fired with attempt=1 (reset from 0)
            expect(reconnectingFn).toHaveBeenCalled();
            const firstCall = reconnectingFn.mock.calls[0];
            expect(firstCall[0]).toBe(1);

            client.destroy();
            host.destroy();
        });
    });

    describe('destroy', () => {
        it('should clean up all resources', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(10);
            await hp;

            const client = createClient();
            const destroyedFn = vi.fn();
            client.on('destroyed', destroyedFn);

            const cp = client.connect('ROOM1', 'player1');
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            client.destroy();

            expect(destroyedFn).toHaveBeenCalled();
            expect(client.isConnected).toBe(false);
            expect(client.queueSize).toBe(0);

            host.destroy();
        });

        it('should be idempotent', () => {
            const client = createClient();
            client.destroy();
            expect(() => client.destroy()).not.toThrow();
        });
    });
});
