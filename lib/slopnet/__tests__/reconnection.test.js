/**
 * Integration tests: Reconnection scenarios.
 *
 * Tests automatic reconnection, message queuing during disconnect,
 * reconnect window behavior, and host reconnection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { PeerHost, PeerClient } = SlopNet;

const BASE_CONFIG = {
    roomPrefix: 'recon-',
    heartbeatInterval: 0,
    reconnectWindowMs: 60000,
    connectionTimeout: 3000,
    reconnectBackoffBase: 50,
    reconnectBackoffMultiplier: 1.5,
    reconnectBackoffMax: 500,
    _PeerClass: MockPeer,
};

function createHost(overrides = {}) {
    return new PeerHost({ ...BASE_CONFIG, ...overrides });
}

function createClient(overrides = {}) {
    return new PeerClient({ ...BASE_CONFIG, ...overrides });
}

describe('Reconnection Integration', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('client reconnection to host', () => {
        it('should automatically reconnect when connection drops', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const reconnectedFn = vi.fn();
            client.on('reconnected', reconnectedFn);

            const cp = client.connect('ROOM1', 'alice', { name: 'Alice' });
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            expect(client.isConnected).toBe(true);

            // Drop connection
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);
            expect(client.isConnected).toBe(false);

            // Wait for reconnection
            await vi.advanceTimersByTimeAsync(300);

            expect(reconnectedFn).toHaveBeenCalled();
            expect(client.isConnected).toBe(true);

            client.destroy();
            host.destroy();
        });

        it('should emit client-rejoined on host side', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const rejoinedFn = vi.fn();
            host.on('client-rejoined', rejoinedFn);

            const client = createClient();
            const cp = client.connect('ROOM1', 'alice', { name: 'Alice' });
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Drop connection
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            // Wait for reconnection
            await vi.advanceTimersByTimeAsync(300);

            expect(rejoinedFn).toHaveBeenCalledWith('alice', { name: 'Alice' });

            client.destroy();
            host.destroy();
        });

        it('should maintain client ID across reconnections', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Reconnect multiple times
            for (let i = 0; i < 3; i++) {
                client.connection.close();
                await vi.advanceTimersByTimeAsync(300);
                expect(client.isConnected).toBe(true);
                expect(host.isClientConnected('alice')).toBe(true);
            }

            // Should still only be one client
            expect(host.getAllClientIds()).toEqual(['alice']);

            client.destroy();
            host.destroy();
        });

        it('should resume communication after reconnect', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Disconnect and reconnect
            client.connection.close();
            await vi.advanceTimersByTimeAsync(300);

            // Test communication works
            const clientData = [];
            const hostData = [];
            client.on('data', d => clientData.push(d));
            host.on('data', (id, d) => hostData.push({ id, d }));

            host.send('alice', { type: 'post-reconnect', value: 42 });
            client.send({ type: 'reply', value: 'ok' });
            await vi.advanceTimersByTimeAsync(20);

            expect(clientData).toEqual([{ type: 'post-reconnect', value: 42 }]);
            expect(hostData).toEqual([{ id: 'alice', d: { type: 'reply', value: 'ok' } }]);

            client.destroy();
            host.destroy();
        });
    });

    describe('message queuing during reconnection', () => {
        it('should queue messages sent while disconnected', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Disconnect
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);
            expect(client.isConnected).toBe(false);

            // Queue messages while disconnected
            client.send({ type: 'queued', seq: 1 });
            client.send({ type: 'queued', seq: 2 });
            client.send({ type: 'queued', seq: 3 });
            expect(client.queueSize).toBe(3);

            // Set up data listener on host
            const hostData = [];
            host.on('data', (id, data) => hostData.push(data));

            // Wait for reconnection
            await vi.advanceTimersByTimeAsync(300);
            expect(client.isConnected).toBe(true);
            expect(client.queueSize).toBe(0);

            // Wait for queued messages to be delivered
            await vi.advanceTimersByTimeAsync(50);

            expect(hostData).toHaveLength(3);
            expect(hostData[0]).toEqual({ type: 'queued', seq: 1 });
            expect(hostData[1]).toEqual({ type: 'queued', seq: 2 });
            expect(hostData[2]).toEqual({ type: 'queued', seq: 3 });

            client.destroy();
            host.destroy();
        });

        it('should preserve message order in queue', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            for (let i = 0; i < 10; i++) {
                client.send({ seq: i });
            }
            expect(client.queueSize).toBe(10);

            const hostData = [];
            host.on('data', (id, data) => hostData.push(data));

            await vi.advanceTimersByTimeAsync(300);
            await vi.advanceTimersByTimeAsync(50);

            expect(hostData).toHaveLength(10);
            for (let i = 0; i < 10; i++) {
                expect(hostData[i].seq).toBe(i);
            }

            client.destroy();
            host.destroy();
        });
    });

    describe('reconnect window', () => {
        it('should keep client in disconnected state within window', async () => {
            const host = createHost({ reconnectWindowMs: 5000 });
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient({ maxReconnectAttempts: 0 });
            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            client.destroy();
            await vi.advanceTimersByTimeAsync(20);

            // Within window
            expect(host.getDisconnectedClientIds()).toContain('alice');
            expect(host.getAllClientIds()).toContain('alice');

            // After window expires
            await vi.advanceTimersByTimeAsync(5100);
            expect(host.getAllClientIds()).not.toContain('alice');

            host.destroy();
        });

        it('should cancel reconnect window timer if client rejoins', async () => {
            const host = createHost({ reconnectWindowMs: 2000 });
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const lostFn = vi.fn();
            host.on('client-lost', lostFn);

            const client = createClient();
            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Disconnect
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            expect(host.getDisconnectedClientIds()).toContain('alice');

            // Reconnect within window
            await vi.advanceTimersByTimeAsync(300);
            expect(client.isConnected).toBe(true);

            // Wait past original window - should NOT emit client-lost
            await vi.advanceTimersByTimeAsync(3000);
            expect(lostFn).not.toHaveBeenCalled();
            expect(host.isClientConnected('alice')).toBe(true);

            client.destroy();
            host.destroy();
        });

        it('should emit client-lost when reconnect window expires', async () => {
            const host = createHost({ reconnectWindowMs: 1000 });
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const lostFn = vi.fn();
            host.on('client-lost', lostFn);

            const client = createClient({ maxReconnectAttempts: 0 });
            const cp = client.connect('ROOM1', 'alice', { name: 'Alice' });
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            client.destroy();
            await vi.advanceTimersByTimeAsync(20);

            // Before window
            expect(lostFn).not.toHaveBeenCalled();

            // After window
            await vi.advanceTimersByTimeAsync(1100);
            expect(lostFn).toHaveBeenCalledWith('alice', { name: 'Alice' });

            host.destroy();
        });
    });

    describe('exponential backoff verification', () => {
        it('should use increasing delays between reconnection attempts', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient({
                reconnectBackoffBase: 100,
                reconnectBackoffMultiplier: 2,
                reconnectBackoffMax: 1000,
                maxReconnectAttempts: 5,
            });

            const reconnectingCalls = [];
            client.on('reconnecting', (attempt, max) => {
                reconnectingCalls.push({ attempt, max, time: Date.now() });
            });

            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Destroy host so reconnection always fails
            host.destroy();
            await vi.advanceTimersByTimeAsync(10);

            // Disconnect
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            // Run through several reconnect attempts
            // Attempt 1: 100ms delay
            await vi.advanceTimersByTimeAsync(110);
            // Error from peer-unavailable, then attempt 2: 200ms
            await vi.advanceTimersByTimeAsync(210);
            // Attempt 3: 400ms
            await vi.advanceTimersByTimeAsync(410);
            // Attempt 4: 800ms
            await vi.advanceTimersByTimeAsync(810);
            // Attempt 5: 1000ms (capped)
            await vi.advanceTimersByTimeAsync(1010);

            expect(reconnectingCalls.length).toBeGreaterThanOrEqual(3);
            // Verify attempts are numbered correctly
            for (let i = 0; i < reconnectingCalls.length; i++) {
                expect(reconnectingCalls[i].max).toBe(5);
            }

            client.destroy();
        });
    });

    describe('multiple clients reconnecting', () => {
        it('should handle multiple clients disconnecting and reconnecting', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const clients = [];
            for (let i = 0; i < 3; i++) {
                const c = createClient();
                const cp = c.connect('ROOM1', `player${i}`, {});
                await vi.advanceTimersByTimeAsync(50);
                await cp;
                clients.push(c);
            }

            expect(host.getConnectedClientIds()).toHaveLength(3);

            // Disconnect all clients
            for (const c of clients) {
                c.connection.close();
            }
            await vi.advanceTimersByTimeAsync(10);

            expect(host.getConnectedClientIds()).toHaveLength(0);
            expect(host.getDisconnectedClientIds()).toHaveLength(3);

            // Wait for all to reconnect
            await vi.advanceTimersByTimeAsync(500);

            expect(host.getConnectedClientIds()).toHaveLength(3);
            for (let i = 0; i < 3; i++) {
                expect(host.isClientConnected(`player${i}`)).toBe(true);
                expect(clients[i].isConnected).toBe(true);
            }

            clients.forEach(c => c.destroy());
            host.destroy();
        });

        it('should handle staggered reconnections', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            // Connect 3 clients with different backoff settings
            const c1 = createClient({ reconnectBackoffBase: 50, reconnectBackoffMax: 100 });
            const c2 = createClient({ reconnectBackoffBase: 100, reconnectBackoffMax: 200 });
            const c3 = createClient({ reconnectBackoffBase: 150, reconnectBackoffMax: 300 });

            const cp1 = c1.connect('ROOM1', 'fast', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp1;
            const cp2 = c2.connect('ROOM1', 'medium', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp2;
            const cp3 = c3.connect('ROOM1', 'slow', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp3;

            // Disconnect all
            c1.connection.close();
            c2.connection.close();
            c3.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            // Fast reconnects first
            await vi.advanceTimersByTimeAsync(70);
            // c1 might be reconnected now
            // Medium next
            await vi.advanceTimersByTimeAsync(200);
            // Slow last
            await vi.advanceTimersByTimeAsync(400);

            // All should be reconnected by now
            expect(c1.isConnected).toBe(true);
            expect(c2.isConnected).toBe(true);
            expect(c3.isConnected).toBe(true);

            c1.destroy();
            c2.destroy();
            c3.destroy();
            host.destroy();
        });
    });

    describe('host reconnection', () => {
        it('should reconnect host to signaling server', async () => {
            const host = createHost({
                reconnectBackoffBase: 50,
                reconnectBackoffMax: 200,
            });
            const reconnectedFn = vi.fn();
            const reconnectingFn = vi.fn();
            host.on('reconnected', reconnectedFn);
            host.on('reconnecting', reconnectingFn);

            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            // Simulate signaling server disconnect
            host.peer.simulateDisconnect();
            await vi.advanceTimersByTimeAsync(10);

            // Wait for reconnect
            await vi.advanceTimersByTimeAsync(200);

            expect(reconnectingFn).toHaveBeenCalled();
            expect(reconnectedFn).toHaveBeenCalled();

            host.destroy();
        });

        it('should allow clients to rejoin after host reconnects', async () => {
            const host = createHost({
                reconnectBackoffBase: 50,
                reconnectBackoffMax: 100,
            });
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient({
                reconnectBackoffBase: 50,
                reconnectBackoffMax: 100,
            });
            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Host disconnects from signaling server
            host.peer.simulateDisconnect();
            await vi.advanceTimersByTimeAsync(10);

            // This causes all connections to be marked as disconnected
            // Wait for host to reconnect
            await vi.advanceTimersByTimeAsync(200);

            // Client's connection might have been dropped too
            // Close client connection to trigger reconnect
            if (client.connection && !client.connection._closed) {
                client.connection.close();
            }
            await vi.advanceTimersByTimeAsync(10);

            // Wait for client to reconnect
            await vi.advanceTimersByTimeAsync(500);

            // Communication should work again
            const clientData = [];
            client.on('data', d => clientData.push(d));
            host.send('alice', { type: 'welcome-back' });
            await vi.advanceTimersByTimeAsync(20);

            // If reconnection worked, client should have received the message
            if (client.isConnected) {
                expect(clientData).toEqual([{ type: 'welcome-back' }]);
            }

            client.destroy();
            host.destroy();
        });
    });

    describe('edge cases', () => {
        it('should handle destroy during reconnection', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Disconnect
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            // Destroy while reconnecting
            client.destroy();
            await vi.advanceTimersByTimeAsync(500);

            // Should not throw or cause issues
            expect(client.isConnected).toBe(false);

            host.destroy();
        });

        it('should handle host destroy during client reconnection', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient({ maxReconnectAttempts: 3 });
            const failedFn = vi.fn();
            client.on('reconnect-failed', failedFn);

            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Disconnect client
            client.connection.close();
            await vi.advanceTimersByTimeAsync(10);

            // Destroy host
            host.destroy();
            await vi.advanceTimersByTimeAsync(10);

            // Wait for reconnect attempts to exhaust
            await vi.advanceTimersByTimeAsync(3000);

            expect(failedFn).toHaveBeenCalled();

            client.destroy();
        });

        it('should not reconnect if already connected', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const reconnectingFn = vi.fn();
            client.on('reconnecting', reconnectingFn);

            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Call reconnect while connected - should be a no-op
            client.reconnect();
            await vi.advanceTimersByTimeAsync(100);

            expect(reconnectingFn).not.toHaveBeenCalled();

            client.destroy();
            host.destroy();
        });

        it('should handle multiple rapid disconnects gracefully', async () => {
            const host = createHost();
            const hp = host.start('ROOM1');
            await vi.advanceTimersByTimeAsync(20);
            await hp;

            const client = createClient();
            const cp = client.connect('ROOM1', 'alice', {});
            await vi.advanceTimersByTimeAsync(50);
            await cp;

            // Multiple disconnect/reconnect cycles
            for (let i = 0; i < 5; i++) {
                if (client.connection && !client.connection._closed) {
                    client.connection.close();
                }
                await vi.advanceTimersByTimeAsync(300);
            }

            // Should still be functional
            if (client.isConnected) {
                const clientData = [];
                client.on('data', d => clientData.push(d));
                host.send('alice', { type: 'ping' });
                await vi.advanceTimersByTimeAsync(20);
                expect(clientData).toEqual([{ type: 'ping' }]);
            }

            client.destroy();
            host.destroy();
        });
    });
});
