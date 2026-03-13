// Bang! The Bullet — Deck Management
// Draw, shuffle, reshuffle, draw-checks
(function(exports) {
'use strict';

const D = window.BangData;

/**
 * Mixin: adds deck management methods to an engine instance.
 * Call DeckMixin.apply(engine) to bind.
 */
const DeckMixin = {
  apply(engine) {
    Object.assign(engine, DeckMixin.methods);
  },

  methods: {
    drawFromDeck(count) {
      const cards = [];
      for (let i = 0; i < count; i++) {
        if (this.state.deck.length === 0) this.reshuffleDeck();
        if (this.state.deck.length === 0) break;
        cards.push(this.state.deck.pop());
      }
      return cards;
    },

    reshuffleDeck() {
      if (this.state.discard.length <= 1) return;
      const top = this.state.discard.pop();
      this.state.deck = D.shuffle([...this.state.discard]);
      this.state.discard = top ? [top] : [];
      this.addLog('Deck reshuffled from discard pile.');
    },

    /**
     * Draw a card for a "draw!" check (barrel, dynamite, jail).
     * Lucky Duke gets two cards and must choose.
     * Returns a card, or {luckyDuke: true, cards: [c1, c2]}, or null.
     */
    drawCheck(playerIdx) {
      const eff = this.getEffectiveCharacter(playerIdx);
      if (eff.effect === 'lucky_draw') {
        if (this.state.deck.length === 0) this.reshuffleDeck();
        const c1 = this.state.deck.length > 0 ? this.state.deck.pop() : null;
        if (this.state.deck.length === 0) this.reshuffleDeck();
        const c2 = this.state.deck.length > 0 ? this.state.deck.pop() : null;
        if (!c1) return c2 || null;
        if (!c2) { this.state.discard.push(c1); return c1; }
        return { luckyDuke: true, cards: [c1, c2] };
      }
      if (this.state.deck.length === 0) this.reshuffleDeck();
      if (this.state.deck.length === 0) return null;
      const card = this.state.deck.pop();
      this.state.discard.push(card);
      return card;
    },

    resolveLuckyDuke(chosenIdx, cards) {
      this.state.discard.push(cards[0], cards[1]);
      return cards[chosenIdx];
    },
  },
};

exports.BangDeckMixin = DeckMixin;
})(window);
