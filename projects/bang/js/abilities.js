// Bang! The Bullet — Character Abilities & Green Cards
(function(exports) {
'use strict';

const D = window.BangData;

const AbilitiesMixin = {
  apply(engine) {
    Object.assign(engine, AbilitiesMixin.methods);
  },

  methods: {
    useAbility(playerIdx, abilityType, data) {
      if (playerIdx !== this.state.currentTurn) throw new Error('Not your turn');
      if (this.state.turnPhase !== 'play') throw new Error('Can only use abilities during play phase');
      const player = this.state.players[playerIdx];

      // Normalize ability names from UI
      const normalizedType = this._normalizeAbilityType(abilityType);

      switch (normalizedType) {
        case 'sid_ketchum': {
          if (!data || !data.cardIds || data.cardIds.length !== 2) throw new Error('Must discard 2 cards');
          if (player.hp >= player.maxHp) throw new Error('Already at max HP');
          for (const cid of data.cardIds) {
            const ci = player.hand.findIndex(c => c.id === cid);
            if (ci < 0) throw new Error('Card not in hand');
            this.state.discard.push(player.hand.splice(ci, 1)[0]);
          }
          player.hp = Math.min(player.hp + 1, player.maxHp);
          this.addLog(player.name + ' discards 2 cards to heal 1 HP (Sid Ketchum).');
          this.checkSuzyLafayette(playerIdx);
          break;
        }
        case 'chuck_wengam': {
          if (player.hp <= 1) throw new Error('Too risky — would die!');
          player.hp--;
          player.hand.push(...this.drawFromDeck(2));
          this.addLog(player.name + ' loses 1 HP to draw 2 cards (Chuck Wengam).');
          break;
        }
        case 'doc_holyday': {
          if (!data || !data.cardIds || data.cardIds.length !== 2) throw new Error('Must discard 2 cards');
          if (data.targetIdx === undefined) throw new Error('Need a target');
          if (!this.isInRange(playerIdx, data.targetIdx)) throw new Error('Target out of range');
          for (const cid of data.cardIds) {
            const ci = player.hand.findIndex(c => c.id === cid);
            if (ci < 0) throw new Error('Card not in hand');
            this.state.discard.push(player.hand.splice(ci, 1)[0]);
          }
          this.addLog(player.name + ' discards 2 cards for a shot! (Doc Holyday)');
          this.checkSuzyLafayette(playerIdx);
          this.resolveBangHit(playerIdx, data.targetIdx, { name: 'BANG!', suit: 'C', value: 1 });
          break;
        }
        case 'jose_delgado': {
          if (this.state.joseDelgadoUsed >= 2) throw new Error('Already used ability twice this turn');
          // Accept both data.cardId and data.cardIds[0]
          const cardId = data.cardId || (data.cardIds && data.cardIds[0]);
          if (!cardId) throw new Error('Must discard a blue card');
          const ci = player.hand.findIndex(c => c.id === cardId && D.isBlueEquipment(c));
          if (ci < 0) throw new Error('Not a blue card in hand');
          this.state.discard.push(player.hand.splice(ci, 1)[0]);
          player.hand.push(...this.drawFromDeck(2));
          this.state.joseDelgadoUsed++;
          this.addLog(player.name + ' discards a blue card to draw 2 (José Delgado).');
          this.checkSuzyLafayette(playerIdx);
          break;
        }
        default:
          throw new Error('Unknown ability: ' + abilityType);
      }
    },

    /**
     * Normalize ability type names from UI to engine format.
     * UI sends 'discard_to_heal', engine expects 'sid_ketchum', etc.
     */
    _normalizeAbilityType(type) {
      const map = {
        'discard_to_heal': 'sid_ketchum',
        'hp_for_cards': 'chuck_wengam',
        'discard_to_bang': 'doc_holyday',
        'blue_for_cards': 'jose_delgado',
        // Also accept engine names directly
        'sid_ketchum': 'sid_ketchum',
        'chuck_wengam': 'chuck_wengam',
        'doc_holyday': 'doc_holyday',
        'jose_delgado': 'jose_delgado',
      };
      return map[type] || type;
    },

    useGreenCard(playerIdx, cardId) {
      const player = this.state.players[playerIdx];
      const ci = player.inPlay.findIndex(c => c.id === cardId);
      if (ci < 0) throw new Error('Card not in play');
      const card = player.inPlay[ci];

      if (card.name === 'Derringer') {
        player.inPlay.splice(ci, 1);
        this.state.discard.push(card);
        this.addLog(player.name + ' uses Derringer!');
        player.hand.push(...this.drawFromDeck(1));
        const valid = this.getAlivePlayers().filter(i => i !== playerIdx && this.calcDistance(playerIdx, i) <= 1);
        if (valid.length > 0) {
          this.state.pending = { type: 'choose_target', playerIdx, cardName: 'BANG!', validTargets: valid };
        }
        return;
      }
      if (card.name === 'Howitzer') {
        player.inPlay.splice(ci, 1);
        this.state.discard.push(card);
        this.addLog(player.name + ' fires the Howitzer!');
        this.playGatling(playerIdx, card);
        return;
      }
      if (card.name === 'Pepperbox') {
        player.inPlay.splice(ci, 1);
        this.state.discard.push(card);
        this.addLog(player.name + ' uses Pepperbox!');
        const valid = this.getAlivePlayers().filter(i => i !== playerIdx);
        if (valid.length > 0) {
          this.state.pending = { type: 'choose_target', playerIdx, cardName: 'BANG!', validTargets: valid };
        }
        return;
      }
      if (card.name === 'Buffalo Rifle') {
        player.inPlay.splice(ci, 1);
        this.state.discard.push(card);
        this.state.buffaloRifleUsed = true;
        this.addLog(player.name + ' uses Buffalo Rifle!');
        const valid = this.getAlivePlayers().filter(i => i !== playerIdx);
        if (valid.length > 0) {
          this.state.pending = { type: 'choose_target', playerIdx, cardName: 'BANG!', validTargets: valid };
        }
        return;
      }
    },

    // ── Character helpers ────────────────────────────────
    getEffectiveCharacter(playerIdx) {
      const p = this.state.players[playerIdx];
      if (p.character.effect === 'copy_ability' && this.state.veraCusterCopy && playerIdx === this.state.currentTurn) {
        return this.state.veraCusterCopy;
      }
      return p.character;
    },

    triggerMollyStark(playerIdx) {
      if (playerIdx === this.state.currentTurn) return;
      if (this.getEffectiveCharacter(playerIdx).effect === 'draw_on_react') {
        const player = this.state.players[playerIdx];
        player.hand.push(...this.drawFromDeck(1));
        this.addLog(player.name + ' draws a card (Molly Stark).');
      }
    },

    checkSuzyLafayette(playerIdx) {
      const player = this.state.players[playerIdx];
      if (player.hand.length === 0 && !player.eliminated &&
        this.getEffectiveCharacter(playerIdx).effect === 'draw_on_empty') {
        player.hand.push(...this.drawFromDeck(1));
        this.addLog(player.name + ' draws a card (hand empty — Suzy Lafayette).');
      }
    },
  },
};

exports.BangAbilitiesMixin = AbilitiesMixin;
})(window);
