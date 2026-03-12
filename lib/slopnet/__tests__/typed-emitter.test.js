import { describe, it, expect, beforeEach, vi } from 'vitest';

// Import the library
const SlopNet = require('../slopnet.js');
const { TypedEmitter } = SlopNet;

describe('TypedEmitter', () => {
    let emitter;

    beforeEach(() => {
        emitter = new TypedEmitter();
    });

    describe('on / emit', () => {
        it('should call listener when event is emitted', () => {
            const fn = vi.fn();
            emitter.on('test', fn);
            emitter.emit('test', 'arg1', 'arg2');
            expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
        });

        it('should support multiple listeners for the same event', () => {
            const fn1 = vi.fn();
            const fn2 = vi.fn();
            emitter.on('test', fn1);
            emitter.on('test', fn2);
            emitter.emit('test', 'data');
            expect(fn1).toHaveBeenCalledWith('data');
            expect(fn2).toHaveBeenCalledWith('data');
        });

        it('should not call listeners for different events', () => {
            const fn = vi.fn();
            emitter.on('other', fn);
            emitter.emit('test');
            expect(fn).not.toHaveBeenCalled();
        });

        it('should return false when no listeners exist', () => {
            expect(emitter.emit('nonexistent')).toBe(false);
        });

        it('should return true when listeners exist', () => {
            emitter.on('test', () => {});
            expect(emitter.emit('test')).toBe(true);
        });

        it('should call listeners in registration order', () => {
            const order = [];
            emitter.on('test', () => order.push(1));
            emitter.on('test', () => order.push(2));
            emitter.on('test', () => order.push(3));
            emitter.emit('test');
            expect(order).toEqual([1, 2, 3]);
        });

        it('should support chaining with on()', () => {
            const result = emitter.on('test', () => {});
            expect(result).toBe(emitter);
        });
    });

    describe('off', () => {
        it('should remove a specific listener', () => {
            const fn = vi.fn();
            emitter.on('test', fn);
            emitter.off('test', fn);
            emitter.emit('test');
            expect(fn).not.toHaveBeenCalled();
        });

        it('should remove all listeners for an event when no fn specified', () => {
            const fn1 = vi.fn();
            const fn2 = vi.fn();
            emitter.on('test', fn1);
            emitter.on('test', fn2);
            emitter.off('test');
            emitter.emit('test');
            expect(fn1).not.toHaveBeenCalled();
            expect(fn2).not.toHaveBeenCalled();
        });

        it('should not affect other events', () => {
            const fn1 = vi.fn();
            const fn2 = vi.fn();
            emitter.on('test1', fn1);
            emitter.on('test2', fn2);
            emitter.off('test1', fn1);
            emitter.emit('test2');
            expect(fn2).toHaveBeenCalled();
        });

        it('should handle removing non-existent listener gracefully', () => {
            expect(() => emitter.off('nonexistent', () => {})).not.toThrow();
        });

        it('should support chaining with off()', () => {
            const result = emitter.off('test', () => {});
            expect(result).toBe(emitter);
        });
    });

    describe('once', () => {
        it('should call listener only once', () => {
            const fn = vi.fn();
            emitter.once('test', fn);
            emitter.emit('test', 'first');
            emitter.emit('test', 'second');
            expect(fn).toHaveBeenCalledTimes(1);
            expect(fn).toHaveBeenCalledWith('first');
        });

        it('should not interfere with other listeners', () => {
            const onceFn = vi.fn();
            const regularFn = vi.fn();
            emitter.once('test', onceFn);
            emitter.on('test', regularFn);
            emitter.emit('test');
            emitter.emit('test');
            expect(onceFn).toHaveBeenCalledTimes(1);
            expect(regularFn).toHaveBeenCalledTimes(2);
        });

        it('should support chaining', () => {
            const result = emitter.once('test', () => {});
            expect(result).toBe(emitter);
        });
    });

    describe('removeAllListeners', () => {
        it('should remove all listeners for a specific event', () => {
            const fn1 = vi.fn();
            const fn2 = vi.fn();
            emitter.on('test', fn1);
            emitter.on('other', fn2);
            emitter.removeAllListeners('test');
            emitter.emit('test');
            emitter.emit('other');
            expect(fn1).not.toHaveBeenCalled();
            expect(fn2).toHaveBeenCalled();
        });

        it('should remove all listeners when no event specified', () => {
            const fn1 = vi.fn();
            const fn2 = vi.fn();
            emitter.on('test', fn1);
            emitter.on('other', fn2);
            emitter.removeAllListeners();
            emitter.emit('test');
            emitter.emit('other');
            expect(fn1).not.toHaveBeenCalled();
            expect(fn2).not.toHaveBeenCalled();
        });

        it('should support chaining', () => {
            const result = emitter.removeAllListeners();
            expect(result).toBe(emitter);
        });
    });

    describe('listenerCount', () => {
        it('should return 0 for events with no listeners', () => {
            expect(emitter.listenerCount('test')).toBe(0);
        });

        it('should return the correct count', () => {
            emitter.on('test', () => {});
            emitter.on('test', () => {});
            expect(emitter.listenerCount('test')).toBe(2);
        });

        it('should decrease after removing a listener', () => {
            const fn = () => {};
            emitter.on('test', fn);
            emitter.on('test', () => {});
            expect(emitter.listenerCount('test')).toBe(2);
            emitter.off('test', fn);
            expect(emitter.listenerCount('test')).toBe(1);
        });
    });

    describe('edge cases', () => {
        it('should handle listener that removes itself', () => {
            const fn = vi.fn(() => {
                emitter.off('test', fn);
            });
            const fn2 = vi.fn();
            emitter.on('test', fn);
            emitter.on('test', fn2);
            emitter.emit('test');
            expect(fn).toHaveBeenCalledTimes(1);
            expect(fn2).toHaveBeenCalledTimes(1);
        });

        it('should handle emitting with no arguments', () => {
            const fn = vi.fn();
            emitter.on('test', fn);
            emitter.emit('test');
            expect(fn).toHaveBeenCalledWith();
        });

        it('should handle emitting with many arguments', () => {
            const fn = vi.fn();
            emitter.on('test', fn);
            emitter.emit('test', 1, 2, 3, 4, 5);
            expect(fn).toHaveBeenCalledWith(1, 2, 3, 4, 5);
        });
    });
});
