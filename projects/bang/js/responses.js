// Bang! The Bullet — Response Handling
// Bang, Indians, Gatling, Duel, Beer Save responses
(function(exports) {
'use strict';

const D = window.BangData;

const ResponsesMixin = {
  apply(engine) {
    Object.assign(engine, ResponsesMixin.methods);
  },

  methods: {
    handleResponse(playerIdx, action) {
      const p = this.state.pending;
      if (!p) throw new Error('No pending action');

      switch (p.type) {
        case 'bang_response':
          this._handleBangResponse(playerIdx, action);
          break;
        case 'indians_response':
          this._handleIndiansResponse(playerIdx, action);
          break;
        case 'gatling_response':
          this._handleGatlingResponse(playerIdx, action);
          break;
        case 'duel_response':
          this._handleDuelResponse(playerIdx, action);
          break;
        case 'beer_save':
          this._handleBeerSave(playerIdx, action);
          break;
        default:
          throw new Error('Cannot respond to: ' + p.type);
      }
    },

    _handleBangResponse(playerIdx, action) {
      const p = this.state.pending;
      if (playerIdx !== p.targetIdx) throw new Error('Not your response');

      if (action.cardId === null || action.cardId === undefined || action.cardId === 'pass') {
        this.addLog(this.state.players[playerIdx].name + ' takes the hit!');
        this.state.pending = null;
        this.applyDamage(playerIdx, 1, p.sourceIdx);
        return;
      }

      const player = this.state.players[playerIdx];
      const eff = this.getEffectiveCharacter(playerIdx);

      // Check if response is from in-play green card
      const inPlayCard = player.inPlay.find(c => c.id === action.cardId);
      if (inPlayCard) {
        if (inPlayCard.name === 'Dodge') {
          player.inPlay = player.inPlay.filter(c => c.id !== inPlayCard.id);
          this.state.discard.push(inPlayCard);
          p.missedPlayed++;
          this.addLog(player.name + ' uses Dodge! (Missed! + draws a card)');
          player.hand.push(...this.drawFromDeck(1));
          this.triggerMollyStark(playerIdx);
          if (p.missedPlayed >= p.missedNeeded) {
            this.addLog(player.name + ' avoids the shot!');
            this.state.pending = null;
            return;
          }
          return;
        }
        if (inPlayCard.name === 'Can Can') {
          player.inPlay = player.inPlay.filter(c => c.id !== inPlayCard.id);
          this.state.discard.push(inPlayCard);
          p.missedPlayed++;
          this.addLog(player.name + ' uses Can Can!');
          const atk = this.state.players[p.sourceIdx];
          if (atk.hand.length > 0) {
            const ri = Math.floor(Math.random() * atk.hand.length);
            player.hand.push(atk.hand.splice(ri, 1)[0]);
          }
          this.triggerMollyStark(playerIdx);
          if (p.missedPlayed >= p.missedNeeded) {
            this.state.pending = null;
            return;
          }
          return;
        }
        if (inPlayCard.name === 'Conestoga') {
          player.inPlay = player.inPlay.filter(c => c.id !== inPlayCard.id);
          this.state.discard.push(inPlayCard);
          p.missedPlayed++;
          this.addLog(player.name + ' uses Conestoga!');
          const nearby = this.getAlivePlayers().filter(i => i !== playerIdx && this.calcDistance(playerIdx, i) <= 1);
          if (nearby.length > 0) {
            const ti = nearby[Math.floor(Math.random() * nearby.length)];
            const tp = this.state.players[ti];
            if (tp.hand.length > 0) {
              const ri = Math.floor(Math.random() * tp.hand.length);
              player.hand.push(tp.hand.splice(ri, 1)[0]);
            }
          }
          this.triggerMollyStark(playerIdx);
          if (p.missedPlayed >= p.missedNeeded) {
            this.state.pending = null;
            return;
          }
          return;
        }
      }

      // Card from hand
      const cardIdx = player.hand.findIndex(c => c.id === action.cardId);
      if (cardIdx < 0) throw new Error('Card not in hand');
      const card = player.hand[cardIdx];

      const isValidMissed = card.name === 'Missed!' ||
        (eff.effect === 'bang_missed_swap' && card.name === 'BANG!') ||
        eff.effect === 'any_as_missed';
      if (!isValidMissed) throw new Error('Not a valid Missed! card');

      player.hand.splice(cardIdx, 1);
      this.state.discard.push(card);
      p.missedPlayed++;
      this.addLog(player.name + ' plays ' + card.name + ' as Missed!');
      this.triggerMollyStark(playerIdx);
      this.checkSuzyLafayette(playerIdx);

      if (p.missedPlayed >= p.missedNeeded) {
        this.addLog(player.name + ' avoids the shot!');
        this.state.pending = null;
      }
    },

    _handleIndiansResponse(playerIdx, action) {
      const p = this.state.pending;
      const respIdx = p.respondents[p.currentIdx];
      if (playerIdx !== respIdx) throw new Error('Not your response');
      const player = this.state.players[playerIdx];

      if (action.cardId === null || action.cardId === undefined || action.cardId === 'pass') {
        this.addLog(player.name + ' has no BANG! — takes 1 damage!');
        // Save Indians state before clearing pending
        const savedSource = p.sourceIdx;
        const savedRespondents = p.respondents;
        const savedNextIdx = p.currentIdx + 1;
        this.state.pending = null;
        this.applyDamage(playerIdx, 1, savedSource);
        // Attach continuation if beer_save interrupted us
        if (this.state.pending && this.state.pending.type === 'beer_save') {
          this.state.pending.continuation = {
            type: 'resume_indians',
            sourceIdx: savedSource,
            respondents: savedRespondents,
            nextIdx: savedNextIdx,
          };
          return;
        }
        if (this.state.winner) return;
        // Resume inline (no beer_save interruption)
        p.currentIdx++;
        while (p.currentIdx < p.respondents.length) {
          if (!this.state.players[p.respondents[p.currentIdx]].eliminated) break;
          p.currentIdx++;
        }
        if (p.currentIdx < p.respondents.length) {
          this.state.pending = p;
        }
        return;
      }

      const cardIdx = player.hand.findIndex(c => c.id === action.cardId);
      if (cardIdx < 0) throw new Error('Card not in hand');
      const card = player.hand[cardIdx];

      const eff = this.getEffectiveCharacter(playerIdx);
      const isValidBang = card.name === 'BANG!' ||
        (eff.effect === 'bang_missed_swap' && card.name === 'Missed!');
      if (!isValidBang) throw new Error('Must play a BANG!');

      player.hand.splice(cardIdx, 1);
      this.state.discard.push(card);
      this.addLog(player.name + ' discards ' + card.name + '.');
      this.triggerMollyStark(playerIdx);
      this.checkSuzyLafayette(playerIdx);
      this._advanceIndiansResponse(p);
    },

    _advanceIndiansResponse(p) {
      p.currentIdx++;
      while (p.currentIdx < p.respondents.length) {
        if (!this.state.players[p.respondents[p.currentIdx]].eliminated) break;
        p.currentIdx++;
      }
      if (p.currentIdx >= p.respondents.length) {
        this.state.pending = null;
      } else {
        this.state.pending = p;
      }
    },

    _handleGatlingResponse(playerIdx, action) {
      const p = this.state.pending;
      const respIdx = p.respondents[p.currentIdx];
      if (playerIdx !== respIdx) throw new Error('Not your response');
      const player = this.state.players[playerIdx];

      if (action.cardId === null || action.cardId === undefined || action.cardId === 'pass') {
        this.addLog(player.name + ' takes 1 damage from Gatling!');
        // Save Gatling state before clearing pending
        const savedSource = p.sourceIdx;
        const savedRespondents = p.respondents;
        const savedNextIdx = p.currentIdx + 1;
        this.state.pending = null;
        this.applyDamage(playerIdx, 1, savedSource);
        // Attach continuation if beer_save interrupted us
        if (this.state.pending && this.state.pending.type === 'beer_save') {
          this.state.pending.continuation = {
            type: 'resume_gatling',
            sourceIdx: savedSource,
            respondents: savedRespondents,
            nextIdx: savedNextIdx,
          };
          return;
        }
        if (this.state.winner) return;
        // Resume inline
        p.currentIdx++;
        while (p.currentIdx < p.respondents.length) {
          if (!this.state.players[p.respondents[p.currentIdx]].eliminated) break;
          p.currentIdx++;
        }
        if (p.currentIdx < p.respondents.length) {
          this.state.pending = p;
        }
        return;
      }

      const cardIdx = player.hand.findIndex(c => c.id === action.cardId);
      const inPlayCard = (cardIdx < 0) ? player.inPlay.find(c => c.id === action.cardId) : null;

      if (inPlayCard && inPlayCard.name === 'Dodge') {
        player.inPlay = player.inPlay.filter(c => c.id !== inPlayCard.id);
        this.state.discard.push(inPlayCard);
        this.addLog(player.name + ' uses Dodge!');
        player.hand.push(...this.drawFromDeck(1));
        this.triggerMollyStark(playerIdx);
        this._advanceGatlingResponse(p);
        return;
      }

      if (cardIdx >= 0) {
        const card = player.hand[cardIdx];
        const eff = this.getEffectiveCharacter(playerIdx);
        const isValidMissed = card.name === 'Missed!' ||
          (eff.effect === 'bang_missed_swap' && card.name === 'BANG!') ||
          eff.effect === 'any_as_missed';
        if (!isValidMissed) throw new Error('Not a valid Missed!');

        player.hand.splice(cardIdx, 1);
        this.state.discard.push(card);
        this.addLog(player.name + ' plays ' + card.name + '!');
        this.triggerMollyStark(playerIdx);
        this.checkSuzyLafayette(playerIdx);
      }
      this._advanceGatlingResponse(p);
    },

    _advanceGatlingResponse(p) {
      p.currentIdx++;
      while (p.currentIdx < p.respondents.length) {
        if (!this.state.players[p.respondents[p.currentIdx]].eliminated) break;
        p.currentIdx++;
      }
      if (p.currentIdx >= p.respondents.length) {
        this.state.pending = null;
      } else {
        this.state.pending = p;
      }
    },

    _handleDuelResponse(playerIdx, action) {
      const p = this.state.pending;
      if (playerIdx !== p.currentResponder) throw new Error('Not your response');
      const player = this.state.players[playerIdx];

      if (action.cardId === null || action.cardId === undefined || action.cardId === 'pass') {
        this.addLog(player.name + ' cannot respond — loses the Duel!');
        this.state.pending = null;
        this.applyDamage(playerIdx, 1, playerIdx === p.targetIdx ? p.sourceIdx : p.targetIdx);
        return;
      }

      const cardIdx = player.hand.findIndex(c => c.id === action.cardId);
      if (cardIdx < 0) throw new Error('Card not in hand');
      const card = player.hand[cardIdx];

      const eff = this.getEffectiveCharacter(playerIdx);
      const isValidBang = card.name === 'BANG!' ||
        (eff.effect === 'bang_missed_swap' && card.name === 'Missed!');
      if (!isValidBang) throw new Error('Must play a BANG!');

      player.hand.splice(cardIdx, 1);
      this.state.discard.push(card);
      this.addLog(player.name + ' plays ' + card.name + ' in the Duel!');
      this.triggerMollyStark(playerIdx);
      this.checkSuzyLafayette(playerIdx);

      p.currentResponder = (playerIdx === p.sourceIdx) ? p.targetIdx : p.sourceIdx;
      this.state.pending = p;
    },

    _handleBeerSave(playerIdx, action) {
      const p = this.state.pending;
      if (playerIdx !== p.playerIdx) throw new Error('Not your response');
      const player = this.state.players[playerIdx];
      const continuation = p.continuation || null;

      if (action.cardId === null || action.cardId === undefined || action.cardId === 'pass') {
        this.state.pending = null;
        this.eliminatePlayer(playerIdx, p.killerIdx);
        if (continuation && !this.state.winner && !this.state.pending) {
          this._resumeContinuation(continuation);
        }
        return;
      }

      const cardIdx = player.hand.findIndex(c => c.id === action.cardId && c.name === 'Beer');
      if (cardIdx < 0) throw new Error('Not a Beer card');

      const card = player.hand.splice(cardIdx, 1)[0];
      this.state.discard.push(card);
      const heal = this.getEffectiveCharacter(playerIdx).effect === 'super_beer' ? 2 : 1;
      player.hp += heal;
      this.addLog(player.name + ' drinks Beer to survive! (HP: ' + player.hp + ')');
      this.triggerMollyStark(playerIdx);
      this.checkSuzyLafayette(playerIdx);

      if (player.hp <= 0) {
        if (player.hand.some(c => c.name === 'Beer')) {
          return; // Keep the pending (still need more beers)
        }
        this.state.pending = null;
        this.eliminatePlayer(playerIdx, p.killerIdx);
        if (continuation && !this.state.winner && !this.state.pending) {
          this._resumeContinuation(continuation);
        }
      } else {
        this.state.pending = null;
        if (continuation && !this.state.winner) {
          this._resumeContinuation(continuation);
        }
      }
    },
  },
};

exports.BangResponsesMixin = ResponsesMixin;
})(window);
