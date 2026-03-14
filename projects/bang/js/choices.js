// Bang! The Bullet — Choice Handlers
// Target selection, card picks, discards, draw choices
(function(exports) {
'use strict';

const D = window.BangData;

const ChoicesMixin = {
  apply(engine) {
    Object.assign(engine, ChoicesMixin.methods);
  },

  methods: {
    handleChooseTarget(playerIdx, targetIdx) {
      const p = this.state.pending;
      if (!p || p.type !== 'choose_target') throw new Error('No target selection pending');
      if (p.playerIdx !== playerIdx) throw new Error('Not your choice');
      if (!p.validTargets.includes(targetIdx)) throw new Error('Invalid target');

      this.state.pending = null;
      const cardName = p.cardName;

      if (cardName === 'Jail') {
        this.playJailCard(playerIdx, p.equipCard, targetIdx);
      } else if (cardName === 'Panic!') {
        this.playPanic(playerIdx, null, targetIdx);
      } else if (cardName === 'Cat Balou') {
        this.playCatBalou(playerIdx, null, targetIdx);
      } else if (cardName === 'Rag Time') {
        this.playRagTime(playerIdx, null, targetIdx);
      } else if (cardName === 'Duel') {
        this.playDuel(playerIdx, null, targetIdx);
      } else if (cardName === 'Springfield') {
        this.playSpringfield(playerIdx, null, targetIdx);
      } else if (cardName === 'Tequila') {
        this.state.pending = { type: 'tequila_discard', playerIdx, targetIdx };
      } else if (cardName === 'BANG!' || cardName === 'Punch' || cardName === 'Missed!') {
        this.playBang(playerIdx, { name: cardName }, targetIdx);
      }
    },

    handleChooseCardFromTarget(playerIdx, action) {
      const p = this.state.pending;
      if (!p || p.type !== 'choose_card_from_target') throw new Error('No card selection pending');
      if (p.playerIdx !== playerIdx) throw new Error('Not your choice');

      const target = this.state.players[p.targetIdx];
      this.state.pending = null;

      // Normalize: UI sends choiceIdx: -1 for "random from hand" or a card ID string
      const choice = action.choice !== undefined ? action.choice : action.cardId;

      const isDiscard = p.cardName === 'Cat Balou' || p.cardName === 'Rag Time';

      if (choice === 'hand' || choice === -1 || choice === null || choice === undefined) {
        // Random from hand
        if (target.hand.length === 0) throw new Error('Target has no cards in hand');
        const ri = Math.floor(Math.random() * target.hand.length);
        const card = target.hand.splice(ri, 1)[0];
        if (isDiscard) {
          this.state.discard.push(card);
          this.addLog('A card from ' + target.name + "'s hand is discarded.");
        } else {
          this.state.players[playerIdx].hand.push(card);
          this.addLog(this.state.players[playerIdx].name + ' takes a card from ' + target.name + "'s hand.");
        }
      } else {
        // Specific in-play card by ID
        const cardId = choice;
        const cardIdx = target.inPlay.findIndex(c => c.id === cardId);
        if (cardIdx < 0) throw new Error('Card not found in play');
        const card = target.inPlay.splice(cardIdx, 1)[0];
        if (isDiscard) {
          this.state.discard.push(card);
          this.addLog(target.name + "'s " + card.name + ' is discarded.');
        } else {
          this.state.players[playerIdx].hand.push(card);
          this.addLog(this.state.players[playerIdx].name + ' takes ' + card.name + ' from ' + target.name + '.');
        }
      }

      // Rag Time: also draw a card
      if (p.cardName === 'Rag Time') {
        const drawn = this.drawFromDeck(1);
        this.state.players[playerIdx].hand.push(...drawn);
      }
    },

    handlePick(playerIdx, cardIdOrIdx) {
      const p = this.state.pending;
      if (!p) throw new Error('No pending action');

      if (p.type === 'lucky_duke') {
        if (playerIdx !== p.playerIdx) throw new Error('Not your choice');
        // Convert card ID to index (0 or 1)
        let idx;
        if (typeof cardIdOrIdx === 'number' && cardIdOrIdx >= 0 && cardIdOrIdx < p.cards.length) {
          idx = cardIdOrIdx;
        } else {
          idx = p.cards.findIndex(c => c && c.id === cardIdOrIdx);
        }
        if (idx < 0 || idx >= p.cards.length) throw new Error('Invalid Lucky Duke choice');
        this.handleChoose(playerIdx, idx);
        return;
      }

      if (p.type === 'general_store') {
        if (playerIdx !== p.pickOrder[p.currentIdx]) throw new Error('Not your pick');

        let pickedIdx;
        if (typeof cardIdOrIdx === 'number') {
          pickedIdx = cardIdOrIdx;
        } else {
          pickedIdx = p.cards.findIndex(c => c && c.id === cardIdOrIdx);
        }
        if (pickedIdx < 0 || pickedIdx >= p.cards.length || !p.cards[pickedIdx]) throw new Error('Invalid card choice');

        const card = p.cards[pickedIdx];
        p.cards[pickedIdx] = null;
        this.state.players[playerIdx].hand.push(card);
        this.addLog(this.state.players[playerIdx].name + ' takes ' + card.name + ' from General Store.');

        p.currentIdx++;
        while (p.currentIdx < p.pickOrder.length && this.state.players[p.pickOrder[p.currentIdx]].eliminated) {
          p.currentIdx++;
        }
        if (p.currentIdx >= p.pickOrder.length || p.cards.every(c => !c)) {
          p.cards.forEach(c => { if (c) this.state.discard.push(c); });
          this.state.pending = null;
        }
        return;
      }

      if (p.type === 'kit_carlson') {
        if (playerIdx !== p.playerIdx) throw new Error('Not your pick');
        let pickedIdx;
        if (typeof cardIdOrIdx === 'number') {
          pickedIdx = cardIdOrIdx;
        } else {
          pickedIdx = p.cards.findIndex(c => c && c.id === cardIdOrIdx);
        }
        if (pickedIdx < 0 || !p.cards[pickedIdx]) throw new Error('Invalid choice');

        const card = p.cards[pickedIdx];
        p.cards[pickedIdx] = null;
        this.state.players[playerIdx].hand.push(card);
        p.picked.push(card.id);

        if (p.picked.length >= 2) {
          const remaining = p.cards.find(c => c !== null);
          if (remaining) this.state.deck.push(remaining);
          this.addLog(this.state.players[playerIdx].name + ' picks 2 cards (Kit Carlson).');
          this.state.pending = null;
          this.enterPlayPhase();
        }
        return;
      }
    },

    handleChoose(playerIdx, choice) {
      const p = this.state.pending;
      if (!p) throw new Error('No pending action');

      if (p.type === 'lucky_duke') {
        return this._handleLuckyDukeChoice(playerIdx, choice);
      }

      if (p.type === 'vera_custer') {
        if (playerIdx !== p.playerIdx) throw new Error('Not your choice');
        // choice is an array index into validTargets, map to player index
        const targetIdx = typeof choice === 'number' ? p.validTargets[choice] : choice;
        if (targetIdx === undefined || !p.validTargets.includes(targetIdx)) throw new Error('Invalid choice');
        const copied = this.state.players[targetIdx].character;
        this.state.veraCusterCopy = { ...copied };
        this.addLog(this.state.players[playerIdx].name + ' copies ' + copied.name + "'s ability!");
        this.state.pending = null;
        this.processTurnStart();
        return;
      }

      if (p.type === 'draw_choice') {
        return this._handleDrawChoice(playerIdx, choice);
      }

      // Discard-cost card handlers
      if (p.type === 'springfield_discard') {
        if (playerIdx !== p.playerIdx) throw new Error('Not your choice');
        const player = this.state.players[playerIdx];
        const ci = player.hand.findIndex(c => c.id === choice);
        if (ci < 0) throw new Error('Card not in hand');
        const discarded = player.hand.splice(ci, 1)[0];
        this.state.discard.push(discarded);
        this.addLog(player.name + ' discards ' + discarded.name + ' for Springfield.');
        this.state.pending = null;
        this.resolveBangHit(playerIdx, p.targetIdx, p.card);
        return;
      }

      if (p.type === 'brawl_discard') {
        if (playerIdx !== p.playerIdx) throw new Error('Not your choice');
        const player = this.state.players[playerIdx];
        const ci = player.hand.findIndex(c => c.id === choice);
        if (ci < 0) throw new Error('Card not in hand');
        const discarded = player.hand.splice(ci, 1)[0];
        this.state.discard.push(discarded);
        this.addLog(player.name + ' discards ' + discarded.name + ' for Brawl.');
        this.state.pending = null;
        const respondents = this.getAlivePlayers().filter(i => i !== playerIdx);
        if (respondents.length > 0) {
          this.state.pending = {
            type: 'brawl_response',
            sourceIdx: playerIdx,
            respondents,
            currentIdx: 0,
          };
        }
        return;
      }

      if (p.type === 'brawl_response') {
        const respIdx = p.respondents[p.currentIdx];
        if (playerIdx !== respIdx) throw new Error('Not your response');
        const player = this.state.players[playerIdx];

        if (choice === 'pass' || choice === null) {
          if (player.hand.length > 0) {
            const ri = Math.floor(Math.random() * player.hand.length);
            const lost = player.hand.splice(ri, 1)[0];
            this.state.discard.push(lost);
            this.addLog(player.name + ' loses a card from hand to Brawl.');
          }
        } else {
          const ci = player.inPlay.findIndex(c => c.id === choice);
          if (ci >= 0) {
            const lost = player.inPlay.splice(ci, 1)[0];
            this.state.discard.push(lost);
            this.addLog(player.name + ' discards ' + lost.name + ' from play.');
          }
        }

        p.currentIdx++;
        while (p.currentIdx < p.respondents.length && this.state.players[p.respondents[p.currentIdx]].eliminated) {
          p.currentIdx++;
        }
        if (p.currentIdx >= p.respondents.length) {
          this.state.pending = null;
        }
        return;
      }

      if (p.type === 'whisky_discard') {
        if (playerIdx !== p.playerIdx) throw new Error('Not your choice');
        const player = this.state.players[playerIdx];
        const ci = player.hand.findIndex(c => c.id === choice);
        if (ci < 0) throw new Error('Card not in hand');
        const discarded = player.hand.splice(ci, 1)[0];
        this.state.discard.push(discarded);
        const heal = Math.min(2, player.maxHp - player.hp);
        player.hp += heal;
        this.addLog(player.name + ' drinks Whisky and heals ' + heal + ' HP.');
        this.state.pending = null;
        return;
      }

      if (p.type === 'tequila_discard') {
        if (playerIdx !== p.playerIdx) throw new Error('Not your choice');
        const player = this.state.players[playerIdx];
        const ci = player.hand.findIndex(c => c.id === choice);
        if (ci < 0) throw new Error('Card not in hand');
        const discarded = player.hand.splice(ci, 1)[0];
        this.state.discard.push(discarded);
        const target = this.state.players[p.targetIdx];
        if (target.hp < target.maxHp) target.hp++;
        this.addLog(player.name + ' serves Tequila to ' + target.name + '! (+1 HP)');
        this.state.pending = null;
        return;
      }
    },

    _handleLuckyDukeChoice(playerIdx, choice) {
      const p = this.state.pending;
      if (playerIdx !== p.playerIdx) throw new Error('Not your choice');
      const chosenCard = this.resolveLuckyDuke(choice, p.cards);
      const cont = p.continuation;
      this.state.pending = null;

      if (cont.type === 'dynamite') {
        const dynCard = this.state.players[cont.playerIdx].inPlay.find(c => c.id === cont.dynCardId) || { id: cont.dynCardId, name: 'Dynamite' };
        this.resolveDynamite(cont.playerIdx, chosenCard, dynCard);
        if (!this.state.winner && !this.state.pending && !this.state.players[cont.playerIdx].eliminated) {
          if (this.hasInPlay(cont.playerIdx, 'Jail')) {
            this.processJail(cont.playerIdx);
          } else {
            this.processDrawPhase(cont.playerIdx);
          }
        }
      } else if (cont.type === 'jail') {
        const jailCard = { id: cont.jailCardId, name: 'Jail' };
        this.resolveJail(cont.playerIdx, chosenCard, jailCard);
      } else if (cont.type === 'bang_hit') {
        const c = cont;
        if (D.isHeart(chosenCard)) {
          this.addLog(this.state.players[c.targetIdx].name + "'s " + (c.barrelChecked ? 'ability' : 'Barrel') + ' saves them! (Lucky Duke: ' + D.cardDrawStr(chosenCard) + ')');
          c.missedPlayed++;
          if (c.missedPlayed >= c.missedNeeded) return;
        } else {
          this.addLog(this.state.players[c.targetIdx].name + "'s " + (c.barrelChecked ? 'ability' : 'Barrel') + ' fails. (Lucky Duke: ' + D.cardDrawStr(chosenCard) + ')');
        }
        this.state.pending = {
          type: 'bang_response', sourceIdx: c.sourceIdx, targetIdx: c.targetIdx,
          card: c.card, missedNeeded: c.missedNeeded, missedPlayed: c.missedPlayed,
          barrelChecked: c.barrelChecked, jourdonnaisChecked: c.jourdonnaisChecked,
        };
      } else if (cont.type === 'barrel_check') {
        if (D.isHeart(chosenCard)) {
          this.addLog('Barrel succeeds! (Lucky Duke: ' + D.cardDrawStr(chosenCard) + ')');
          if (cont.onSuccess) cont.onSuccess.call(this);
        } else {
          this.addLog('Barrel fails. (Lucky Duke: ' + D.cardDrawStr(chosenCard) + ')');
          if (cont.onFail) cont.onFail.call(this);
        }
      }
    },

    _handleDrawChoice(playerIdx, choice) {
      const p = this.state.pending;
      if (playerIdx !== p.playerIdx) throw new Error('Not your choice');
      const player = this.state.players[playerIdx];

      if (p.choiceType === 'jesse_jones') {
        if (choice === 'deck' || choice === 0) {
          player.hand.push(...this.drawFromDeck(2));
          this.addLog(player.name + ' draws 2 cards from deck.');
        } else {
          // choice is target player index (or option index starting from 1)
          const targetIdx = typeof choice === 'number' && choice > 0 && p.validTargets ? p.validTargets[choice - 1] : choice;
          const target = this.state.players[targetIdx];
          if (target && target.hand.length > 0) {
            const ri = Math.floor(Math.random() * target.hand.length);
            player.hand.push(target.hand.splice(ri, 1)[0]);
            this.addLog(player.name + ' draws a card from ' + target.name + "'s hand (Jesse Jones).");
          }
          player.hand.push(...this.drawFromDeck(1));
          this.addLog(player.name + ' draws 1 more card from deck.');
        }
      } else if (p.choiceType === 'pedro_ramirez') {
        if (choice === 'deck' || choice === 0) {
          player.hand.push(...this.drawFromDeck(2));
          this.addLog(player.name + ' draws 2 cards from deck.');
        } else {
          const topDiscard = this.state.discard.pop();
          if (topDiscard) {
            player.hand.push(topDiscard);
            this.addLog(player.name + ' takes ' + topDiscard.name + ' from discard (Pedro Ramirez).');
          }
          player.hand.push(...this.drawFromDeck(1));
          this.addLog(player.name + ' draws 1 more card from deck.');
        }
      } else if (p.choiceType === 'pat_brennan') {
        if (choice === 'deck' || choice === 0) {
          player.hand.push(...this.drawFromDeck(2));
          this.addLog(player.name + ' draws 2 cards from deck.');
        } else {
          // choice is {playerIdx, cardId} or an index into validTargets
          let targetInfo = choice;
          if (typeof choice === 'number' && p.validTargets) {
            targetInfo = p.validTargets[choice - 1];
          }
          if (targetInfo && targetInfo.playerIdx !== undefined) {
            const target = this.state.players[targetInfo.playerIdx];
            const ci = target.inPlay.findIndex(c => c.id === targetInfo.cardId);
            if (ci >= 0) {
              const taken = target.inPlay.splice(ci, 1)[0];
              player.hand.push(taken);
              this.addLog(player.name + ' takes ' + taken.name + ' from ' + target.name + ' (Pat Brennan).');
            }
          }
        }
      }

      this.state.pending = null;
      this.enterPlayPhase();
    },

    handleDiscard(playerIdx, cardIds) {
      const p = this.state.pending;
      if (!p || p.type !== 'discard_required') throw new Error('No discard pending');
      if (playerIdx !== p.playerIdx) throw new Error('Not your discard');
      if (!cardIds || cardIds.length !== p.count) throw new Error('Must discard exactly ' + p.count + ' cards');

      const player = this.state.players[playerIdx];
      const discarded = [];
      for (const cid of cardIds) {
        const ci = player.hand.findIndex(c => c.id === cid);
        if (ci < 0) throw new Error('Card not in hand: ' + cid);
        discarded.push(player.hand.splice(ci, 1)[0]);
      }
      this.state.discard.push(...discarded);
      this.addLog(player.name + ' discards ' + discarded.length + ' card(s).');
      this.state.pending = null;
      this.checkSuzyLafayette(playerIdx);
      this.advanceTurn();
    },
  },
};

exports.BangChoicesMixin = ChoicesMixin;
})(window);
