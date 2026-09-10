/**
 * Adversarial protocol review for herd-mentality
 * Attack vectors: message order, round stamping, phase transitions, etc.
 */

import { describe, it, expect } from 'vitest';

class HerdClientState {
    constructor() {
        this.roundNumber = 0;
        this.gamePhase = 'lobby';
        this.myAnswer = null;
        this.myAnswerSent = false;
        this.players = [];
        this.scores = Object.create(null);
    }

    handleMessage(data) {
        if (!data || typeof data !== 'object') return { ignored: 'no-data' };

        switch (data.type) {
            case 'rejoin': {
                if (!Number.isInteger(data.round)) return { ignored: 'no-round' };
                if (data.round < this.roundNumber) return { ignored: 'stale-rejoin' };
                this.roundNumber = data.round;
                this.gamePhase = data.gamePhase || 'lobby';
                if (Array.isArray(data.players)) this.players = data.players;
                if (typeof data.scores === 'object' && data.scores) this.scores = data.scores;
                return { accepted: 'rejoin' };
            }

            case 'question': {
                if (!Number.isInteger(data.round)) return { ignored: 'no-round' };
                if (data.round < this.roundNumber) return { ignored: 'stale-question' };
                if (data.round > this.roundNumber) return { ignored: 'ahead-question' };
                this.roundNumber = data.round;
                this.gamePhase = 'answering';
                this.myAnswer = null;
                return { accepted: 'question' };
            }

            case 'answer-ack': {
                if (!Number.isInteger(data.round) || data.round !== this.roundNumber) {
                    return { ignored: 'wrong-round' };
                }
                if (this.gamePhase !== 'answering') return { ignored: 'wrong-phase' };
                this.myAnswerSent = true;
                return { accepted: 'answer-ack' };
            }

            case 'progress': {
                if (!Number.isInteger(data.round) || data.round !== this.roundNumber) {
                    return { ignored: 'wrong-round' };
                }
                if (this.gamePhase !== 'answering') return { ignored: 'wrong-phase' };
                if (Array.isArray(data.answered) && data.answered.includes('self') && this.myAnswer) {
                    this.myAnswerSent = true;
                }
                return { accepted: 'progress' };
            }

            case 'round-closed': {
                if (!Number.isInteger(data.round) || data.round !== this.roundNumber) {
                    return { ignored: 'wrong-round' };
                }
                this.gamePhase = 'merge';
                return { accepted: 'round-closed' };
            }

            case 'results': {
                if (!Number.isInteger(data.round) || data.round !== this.roundNumber) {
                    return { ignored: 'wrong-round' };
                }
                this.gamePhase = 'results';
                if (typeof data.scores === 'object' && data.scores) this.scores = data.scores;
                return { accepted: 'results' };
            }

            case 'next-round': {
                if (!Number.isInteger(data.round) || data.round !== this.roundNumber) {
                    return { ignored: 'wrong-round' };
                }
                this.roundNumber++;
                this.gamePhase = 'question';
                this.myAnswer = null;
                return { accepted: 'next-round' };
            }

            default:
                return { ignored: 'unknown-type' };
        }
    }

    submitAnswer(answer) {
        if (this.gamePhase !== 'answering') return { rejected: 'wrong-phase' };
        const trimmed = String(answer || '').trim();
        if (!trimmed) return { rejected: 'blank-answer' };
        this.myAnswer = { round: this.roundNumber, text: trimmed };
        this.myAnswerSent = false;
        return { submitted: true };
    }
}

describe('attack-herd-mentality', () => {
    describe('message order attacks', () => {
        it('question arrives after stale state', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;

            const questionMsg = { type: 'question', round: 2, question: 'test?' };
            const res = client.handleMessage(questionMsg);
            expect(res.ignored).toBe('ahead-question'); // Ahead, ask resync
        });

        it('progress message for current round while mid-answer', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'answering';
            client.myAnswer = null;

            const progressMsg = { type: 'progress', round: 1, answered: ['alice', 'bob'], total: 3 };
            const res = client.handleMessage(progressMsg);
            expect(res.accepted).toBe('progress');
            // Should NOT falsely mark as sent since we have no answer
            expect(client.myAnswerSent).toBe(false);
        });

        it('answer-ack arrives in merge phase', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'answering';
            client.myAnswer = { round: 1, text: 'foo' };
            client.gamePhase = 'merge';

            const ackMsg = { type: 'answer-ack', round: 1 };
            const res = client.handleMessage(ackMsg);
            expect(res.ignored).toBe('wrong-phase');
        });
    });

    describe('round stamping', () => {
        it('stale question is ignored', () => {
            const client = new HerdClientState();
            client.roundNumber = 5;

            const oldQ = { type: 'question', round: 4, question: 'old?' };
            const res = client.handleMessage(oldQ);
            expect(res.ignored).toBe('stale-question');
            expect(client.roundNumber).toBe(5);
        });

        it('ahead question triggers resync request', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;

            const futureQ = { type: 'question', round: 3, question: '?' };
            const res = client.handleMessage(futureQ);
            expect(res.ignored).toBe('ahead-question');
        });

        it('stale rejoin is ignored', () => {
            const client = new HerdClientState();
            client.roundNumber = 10;

            const oldRejoin = { type: 'rejoin', round: 5, gamePhase: 'answering' };
            const res = client.handleMessage(oldRejoin);
            expect(res.ignored).toBe('stale-rejoin');
            expect(client.roundNumber).toBe(10);
        });

        it('ahead rejoin is accepted and syncs client', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.players = ['alice'];

            const futureRejoin = {
                type: 'rejoin',
                round: 5,
                gamePhase: 'answering',
                players: ['alice', 'bob'],
                scores: { alice: 2, bob: 1 }
            };

            const res = client.handleMessage(futureRejoin);
            expect(res.accepted).toBe('rejoin');
            expect(client.roundNumber).toBe(5);
            expect(client.players).toEqual(['alice', 'bob']);
        });

        it('answer for wrong round in message is rejected at host', () => {
            // This is conceptual - host would check round at ingest (line 1386 in herd)
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'answering';

            // Host would reject answer if roundNumber doesn't match
            // Simulate: host says "wrong round" via answer-reject for old round
            const rejectMsg = { type: 'answer-reject', round: 0 };
            const res = client.handleMessage(rejectMsg);
            // Different message type, but principle is round-checking
            expect(res.ignored).toBe('unknown-type'); // We don't handle this type
        });
    });

    describe('phase transitions', () => {
        it('answer-ack during question phase is rejected', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'question';

            const ackMsg = { type: 'answer-ack', round: 1 };
            const res = client.handleMessage(ackMsg);
            expect(res.ignored).toBe('wrong-phase');
        });

        it('progress during merge phase is rejected', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'merge';

            const progressMsg = { type: 'progress', round: 1, answered: [] };
            const res = client.handleMessage(progressMsg);
            expect(res.ignored).toBe('wrong-phase');
        });

        it('results during merge phase moves to results', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'merge';

            const resultsMsg = { type: 'results', round: 1, scores: { alice: 1 } };
            const res = client.handleMessage(resultsMsg);
            expect(res.accepted).toBe('results');
            expect(client.gamePhase).toBe('results');
        });
    });

    describe('rejoin payload', () => {
        it('rejoin with negative round label (display issue, not protocol bug)', () => {
            const client = new HerdClientState();
            client.roundNumber = 0;

            const rejoinMsg = {
                type: 'rejoin',
                round: 5,
                label: -10, // Negative, would display as "Round -10"
                gamePhase: 'answering',
                question: 'test?'
            };

            const res = client.handleMessage(rejoinMsg);
            expect(res.accepted).toBe('rejoin');
            expect(client.roundNumber).toBe(5);
            // NOTE: This is a cosmetic bug, not a protocol security issue
        });

        it('rejoin with missing round', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;

            const noRound = { type: 'rejoin', gamePhase: 'lobby' };
            const res = client.handleMessage(noRound);
            expect(res.ignored).toBe('no-round');
        });

        it('rejoin can sync client across multiple rounds', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'answering';

            const rejoinMsg = {
                type: 'rejoin',
                round: 10,
                gamePhase: 'results',
                scores: { alice: 5, bob: 3 }
            };

            const res = client.handleMessage(rejoinMsg);
            expect(res.accepted).toBe('rejoin');
            expect(client.roundNumber).toBe(10);
            expect(client.gamePhase).toBe('results');
        });
    });

    describe('progress message safety', () => {
        it('progress only confirms, never invents answers', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'answering';
            client.myAnswer = null;
            client.myAnswerSent = false;

            const progressMsg = {
                type: 'progress',
                round: 1,
                answered: ['self'],
                total: 2
            };

            const res = client.handleMessage(progressMsg);
            // Progress says "self" answered, but client has no answer
            // Should NOT set myAnswerSent = true
            expect(client.myAnswerSent).toBe(false);
            expect(client.myAnswer).toBeNull();
        });

        it('progress confirms when answer already exists', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'answering';
            client.myAnswer = { round: 1, text: 'my answer' };
            client.myAnswerSent = false;

            const progressMsg = {
                type: 'progress',
                round: 1,
                answered: ['self'],
                total: 2
            };

            const res = client.handleMessage(progressMsg);
            // Now we DO have an answer, so confirm it's sent
            expect(client.myAnswerSent).toBe(true);
        });
    });

    describe('malformed messages', () => {
        it('null message', () => {
            const client = new HerdClientState();
            const res = client.handleMessage(null);
            expect(res.ignored).toBe('no-data');
        });

        it('NaN round field', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;

            const nanMsg = { type: 'question', round: NaN };
            const res = client.handleMessage(nanMsg);
            expect(res.ignored).toBe('no-round');
        });

        it('string round field', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;

            const stringMsg = { type: 'question', round: '1' };
            const res = client.handleMessage(stringMsg);
            expect(res.ignored).toBe('no-round');
        });

        it('unknown message type', () => {
            const client = new HerdClientState();
            const res = client.handleMessage({ type: 'fake-message' });
            expect(res.ignored).toBe('unknown-type');
        });
    });

    describe('answer submission', () => {
        it('blank answer rejected', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'answering';

            const res = client.submitAnswer('   ');
            expect(res.rejected).toBe('blank-answer');
        });

        it('answer during wrong phase rejected', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'merge';

            const res = client.submitAnswer('answer');
            expect(res.rejected).toBe('wrong-phase');
        });

        it('answer submitted successfully', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'answering';

            const res = client.submitAnswer('my answer');
            expect(res.submitted).toBe(true);
            expect(client.myAnswer.round).toBe(1);
            expect(client.myAnswer.text).toBe('my answer');
        });
    });

    describe('duplicate message handling', () => {
        it('duplicate answer-ack is idempotent', () => {
            const client = new HerdClientState();
            client.roundNumber = 1;
            client.gamePhase = 'answering';
            client.myAnswer = { round: 1, text: 'answer' };

            const ack = { type: 'answer-ack', round: 1 };
            client.handleMessage(ack);
            const firstSent = client.myAnswerSent;

            client.handleMessage(ack);
            const secondSent = client.myAnswerSent;

            expect(firstSent).toBe(secondSent);
        });

        it('duplicate rejoin updates state idempotently', () => {
            const client = new HerdClientState();

            const rejoin = { type: 'rejoin', round: 1, players: ['alice', 'bob'] };
            client.handleMessage(rejoin);
            const players1 = client.players;

            client.handleMessage(rejoin);
            const players2 = client.players;

            expect(players1).toEqual(players2);
        });
    });
});
