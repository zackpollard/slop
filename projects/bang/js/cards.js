// Bang! The Bullet — Card Playing Logic
// All playXxx methods and validation
(function(exports) {
'use strict';

const D = window.BangData;

const CardsMixin = {
  apply(engine) {
    Object.assign(engine, CardsMixin.methods);
  },

  methods: {
    playCard(playerIdx, cardId, targetIdx) {
      const p = this.state.players[playerIdx];
      if (this.state.turnPhase !== 'play' || playerIdx !== this.state.currentTurn) {
        throw new Error('Cannot play cards now');
      }

      const cardIdx = p.hand.findIndex(c => c.id === cardId);
      if (cardIdx < 0) throw new Error('Card not in hand');
      const card = p.hand[cardIdx];

      switch (card.name) {
        case 'BANG!':
          this._validateBang(playerIdx, card, targetIdx);
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.state.bangsPlayedThisTurn++;
          this.playBang(playerIdx, card, targetIdx);
          break;
        case 'Punch':
          this._validatePunch(playerIdx, card, targetIdx);
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playBang(playerIdx, card, targetIdx);
          break;
        case 'Missed!':
          if (this.getEffectiveCharacter(playerIdx).effect === 'bang_missed_swap') {
            this._validateBang(playerIdx, card, targetIdx);
            p.hand.splice(cardIdx, 1);
            this.state.discard.push(card);
            this.state.bangsPlayedThisTurn++;
            this.playBang(playerIdx, card, targetIdx);
          } else {
            throw new Error('Cannot play Missed! during your turn');
          }
          break;
        case 'Beer':
          this._validateBeer(playerIdx);
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playBeer(playerIdx, card);
          break;
        case 'Saloon':
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playSaloon(playerIdx, card);
          break;
        case 'Stagecoach':
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playStagecoach(playerIdx, card);
          break;
        case 'Wells Fargo':
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playWellsFargo(playerIdx, card);
          break;
        case 'Pony Express':
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playPonyExpress(playerIdx, card);
          break;
        case 'Panic!':
          if (targetIdx === undefined || targetIdx === null) {
            p.hand.splice(cardIdx, 1);
            this.state.discard.push(card);
            const valid = this.getValidTargets(playerIdx, 'Panic!');
            this.state.pending = { type: 'choose_target', playerIdx, cardName: 'Panic!', validTargets: valid };
            return;
          }
          this._validatePanic(playerIdx, targetIdx);
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playPanic(playerIdx, card, targetIdx);
          break;
        case 'Cat Balou':
        case 'Rag Time':
          if (targetIdx === undefined || targetIdx === null) {
            p.hand.splice(cardIdx, 1);
            this.state.discard.push(card);
            const valid = this.getValidTargets(playerIdx, card.name);
            this.state.pending = { type: 'choose_target', playerIdx, cardName: card.name, validTargets: valid };
            return;
          }
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          if (card.name === 'Rag Time') this.playRagTime(playerIdx, card, targetIdx);
          else this.playCatBalou(playerIdx, card, targetIdx);
          break;
        case 'General Store':
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playGeneralStore(playerIdx, card);
          break;
        case 'Duel':
          if (targetIdx === undefined || targetIdx === null) {
            p.hand.splice(cardIdx, 1);
            this.state.discard.push(card);
            const valid = this.getValidTargets(playerIdx, 'Duel');
            this.state.pending = { type: 'choose_target', playerIdx, cardName: 'Duel', validTargets: valid };
            return;
          }
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playDuel(playerIdx, card, targetIdx);
          break;
        case 'Indians!':
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playIndians(playerIdx, card);
          break;
        case 'Gatling':
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playGatling(playerIdx, card);
          break;
        case 'Jail':
          if (targetIdx === undefined || targetIdx === null) {
            p.hand.splice(cardIdx, 1);
            const valid = this.getValidTargets(playerIdx, 'Jail');
            this.state.pending = { type: 'choose_target', playerIdx, cardName: 'Jail', validTargets: valid, equipCard: card };
            return;
          }
          this._validateJail(playerIdx, targetIdx);
          p.hand.splice(cardIdx, 1);
          this.playJailCard(playerIdx, card, targetIdx);
          break;
        case 'Dynamite':
          p.hand.splice(cardIdx, 1);
          this.playDynamiteCard(playerIdx, card);
          break;
        case 'Springfield':
          if (p.hand.length < 2) throw new Error('Need a card to discard for Springfield');
          if (targetIdx === undefined || targetIdx === null) {
            p.hand.splice(cardIdx, 1);
            this.state.discard.push(card);
            const valid = this.getValidTargets(playerIdx, 'Springfield');
            this.state.pending = { type: 'choose_target', playerIdx, cardName: 'Springfield', validTargets: valid };
            return;
          }
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.playSpringfield(playerIdx, card, targetIdx);
          break;
        case 'Brawl':
          if (p.hand.length < 2) throw new Error('Need a card to discard for Brawl'); // card itself + 1 more
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.state.pending = { type: 'brawl_discard', playerIdx };
          break;
        case 'Whisky':
          if (p.hand.length < 2) throw new Error('Need a card to discard for Whisky');
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.state.pending = { type: 'whisky_discard', playerIdx };
          break;
        case 'Tequila':
          if (targetIdx === undefined || targetIdx === null) {
            if (p.hand.length < 2) throw new Error('Need a card to discard for Tequila');
            p.hand.splice(cardIdx, 1);
            this.state.discard.push(card);
            const valid = this.getValidTargets(playerIdx, 'Tequila');
            this.state.pending = { type: 'choose_target', playerIdx, cardName: 'Tequila', validTargets: valid };
            return;
          }
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.state.pending = { type: 'tequila_discard', playerIdx, targetIdx };
          break;
        default:
          if (D.isWeapon(card)) {
            p.hand.splice(cardIdx, 1);
            this.playWeapon(playerIdx, card);
          } else if (D.isEquipment(card)) {
            if (this.hasInPlay(playerIdx, card.name) && D.isBlueEquipment(card)) {
              throw new Error('Already have ' + card.name + ' in play');
            }
            p.hand.splice(cardIdx, 1);
            this.playEquipment(playerIdx, card);
          } else {
            throw new Error('Unknown card: ' + card.name);
          }
      }
    },

    // ── Validation ──────────────────────────────────────────
    _validateBang(pi, card, targetIdx) {
      if (targetIdx === undefined || targetIdx === null) throw new Error('BANG! needs a target');
      if (targetIdx === pi) throw new Error('Cannot BANG! yourself');
      if (!this.canUseBang(pi)) throw new Error('Already used BANG! this turn');
      if (!this.isInRange(pi, targetIdx)) throw new Error('Target out of range');
      if (this.state.players[targetIdx].eliminated) throw new Error('Target is eliminated');
    },

    _validatePunch(pi, card, targetIdx) {
      if (targetIdx === undefined || targetIdx === null) throw new Error('Punch needs a target');
      if (targetIdx === pi) throw new Error('Cannot Punch yourself');
      if (!this.isInRange(pi, targetIdx)) throw new Error('Target out of range');
      if (this.state.players[targetIdx].eliminated) throw new Error('Target is eliminated');
    },

    _validateBeer(pi) {
      if (this.getAliveCount() <= 2) throw new Error('Beer has no effect with only 2 players');
      if (this.state.players[pi].hp >= this.state.players[pi].maxHp) throw new Error('Already at max HP');
    },

    _validatePanic(pi, targetIdx) {
      if (targetIdx === pi) throw new Error('Cannot Panic! yourself');
      if (this.calcDistance(pi, targetIdx) > 1) throw new Error('Target too far for Panic! (distance 1 only)');
      const t = this.state.players[targetIdx];
      if (t.eliminated) throw new Error('Target is eliminated');
      if (t.hand.length === 0 && t.inPlay.length === 0) throw new Error('Target has no cards');
    },

    _validateJail(pi, targetIdx) {
      if (targetIdx === pi) throw new Error('Cannot jail yourself');
      if (this.state.players[targetIdx].role === 'sheriff') throw new Error('Cannot jail the Sheriff');
      if (this.state.players[targetIdx].eliminated) throw new Error('Target is eliminated');
    },

    // ── Card effects ──────────────────────────────────────
    playBang(sourceIdx, card, targetIdx) {
      const src = this.state.players[sourceIdx];
      const tgt = this.state.players[targetIdx];

      // Apache Kid: diamond BANG! has no effect
      if (this.getEffectiveCharacter(targetIdx).effect === 'diamond_immune' && D.isDiamond(card)) {
        this.addLog(src.name + ' plays ' + D.cardStr(card) + ' on ' + tgt.name + ' — Apache Kid ignores diamonds!');
        return;
      }

      this.addLog(src.name + ' plays ' + card.name + ' on ' + tgt.name + '!');
      this.resolveBangHit(sourceIdx, targetIdx, card);
    },

    resolveBangHit(sourceIdx, targetIdx, card) {
      const tgt = this.state.players[targetIdx];
      const isBelleTurn = this.state.currentTurn === sourceIdx &&
        this.getEffectiveCharacter(sourceIdx).effect === 'nullify_equipment';

      let barrelChecked = false;
      let jourdonnaisChecked = false;
      let missedNeeded = this.getEffectiveCharacter(sourceIdx).effect === 'double_missed' ? 2 : 1;
      let missedPlayed = 0;

      // Auto-check Barrel
      if (!isBelleTurn && this.hasInPlay(targetIdx, 'Barrel')) {
        const result = this.drawCheck(targetIdx);
        if (result && result.luckyDuke) {
          this.state.pending = {
            type: 'lucky_duke', playerIdx: targetIdx,
            cards: result.cards, reason: 'barrel',
            continuation: { type: 'bang_hit', sourceIdx, targetIdx, card, missedNeeded, missedPlayed, barrelChecked: true, jourdonnaisChecked },
          };
          return;
        }
        barrelChecked = true;
        if (result && D.isHeart(result)) {
          this.addLog(tgt.name + "'s Barrel saves them! (" + D.cardDrawStr(result) + ')');
          missedPlayed++;
          if (missedPlayed >= missedNeeded) return;
        } else {
          this.addLog(tgt.name + "'s Barrel fails. (" + (result ? D.cardDrawStr(result) : '?') + ')');
        }
      }

      // Auto-check Jourdonnais
      if (this.getEffectiveCharacter(targetIdx).effect === 'builtin_barrel') {
        const result = this.drawCheck(targetIdx);
        if (result && result.luckyDuke) {
          this.state.pending = {
            type: 'lucky_duke', playerIdx: targetIdx,
            cards: result.cards, reason: 'jourdonnais',
            continuation: { type: 'bang_hit', sourceIdx, targetIdx, card, missedNeeded, missedPlayed, barrelChecked, jourdonnaisChecked: true },
          };
          return;
        }
        jourdonnaisChecked = true;
        if (result && D.isHeart(result)) {
          this.addLog(tgt.name + "'s ability saves them! (" + D.cardDrawStr(result) + ')');
          missedPlayed++;
          if (missedPlayed >= missedNeeded) return;
        } else {
          this.addLog(tgt.name + "'s ability fails. (" + (result ? D.cardDrawStr(result) : '?') + ')');
        }
      }

      // Need Missed! response
      this.state.pending = {
        type: 'bang_response', sourceIdx, targetIdx, card,
        missedNeeded, missedPlayed, barrelChecked, jourdonnaisChecked,
      };
    },

    playBeer(pi, card) {
      const p = this.state.players[pi];
      const heal = this.getEffectiveCharacter(pi).effect === 'super_beer' ? 2 : 1;
      const actual = Math.min(heal, p.maxHp - p.hp);
      p.hp += actual;
      this.addLog(p.name + ' drinks Beer and heals ' + actual + ' HP.');
      this.checkSuzyLafayette(pi);
    },

    playSaloon(pi) {
      this.addLog(this.state.players[pi].name + ' plays Saloon! Everyone heals 1 HP.');
      for (const i of this.getAlivePlayers()) {
        const p = this.state.players[i];
        if (p.hp < p.maxHp) p.hp++;
      }
    },

    playStagecoach(pi) {
      const drawn = this.drawFromDeck(2);
      this.state.players[pi].hand.push(...drawn);
      this.addLog(this.state.players[pi].name + ' plays Stagecoach, draws 2 cards.');
      this.checkSuzyLafayette(pi);
    },

    playWellsFargo(pi) {
      const drawn = this.drawFromDeck(3);
      this.state.players[pi].hand.push(...drawn);
      this.addLog(this.state.players[pi].name + ' plays Wells Fargo, draws 3 cards.');
      this.checkSuzyLafayette(pi);
    },

    playPonyExpress(pi) {
      const drawn = this.drawFromDeck(3);
      this.state.players[pi].hand.push(...drawn);
      this.addLog(this.state.players[pi].name + ' plays Pony Express, draws 3 cards.');
      this.checkSuzyLafayette(pi);
    },

    playPanic(pi, card, targetIdx) {
      const tgt = this.state.players[targetIdx];
      this.addLog(this.state.players[pi].name + ' plays Panic! on ' + tgt.name + '!');
      this.state.pending = {
        type: 'choose_card_from_target',
        playerIdx: pi,
        targetIdx,
        cardName: 'Panic!',
      };
    },

    playCatBalou(pi, card, targetIdx) {
      const tgt = this.state.players[targetIdx];
      this.addLog(this.state.players[pi].name + ' plays Cat Balou on ' + tgt.name + '!');
      this.state.pending = {
        type: 'choose_card_from_target',
        playerIdx: pi,
        targetIdx,
        cardName: 'Cat Balou',
      };
    },

    playRagTime(pi, card, targetIdx) {
      const tgt = this.state.players[targetIdx];
      this.addLog(this.state.players[pi].name + ' plays Rag Time on ' + tgt.name + '!');
      this.state.pending = {
        type: 'choose_card_from_target',
        playerIdx: pi,
        targetIdx,
        cardName: 'Rag Time',
      };
    },

    playGeneralStore(pi) {
      const alive = this.getAlivePlayers();
      const revealed = this.drawFromDeck(alive.length);
      this.addLog(this.state.players[pi].name + ' opens a General Store! (' + revealed.length + ' cards)');
      const startIdx = alive.indexOf(pi);
      const order = [];
      for (let i = 0; i < alive.length; i++) {
        order.push(alive[(startIdx + i) % alive.length]);
      }
      this.state.pending = {
        type: 'general_store',
        cards: revealed,
        pickOrder: order,
        currentIdx: 0,
      };
    },

    playDuel(pi, card, targetIdx) {
      this.addLog(this.state.players[pi].name + ' challenges ' + this.state.players[targetIdx].name + ' to a Duel!');
      this.state.pending = {
        type: 'duel_response',
        sourceIdx: pi,
        targetIdx,
        currentResponder: targetIdx,
      };
    },

    playIndians(pi) {
      this.addLog(this.state.players[pi].name + ' plays Indians!');
      const respondents = this.getAlivePlayers().filter(i => i !== pi);
      if (respondents.length === 0) return;
      this.state.pending = {
        type: 'indians_response',
        sourceIdx: pi,
        respondents,
        currentIdx: 0,
      };
    },

    playGatling(pi) {
      this.addLog(this.state.players[pi].name + ' fires the Gatling!');
      const respondents = this.getAlivePlayers().filter(i => i !== pi);
      if (respondents.length === 0) return;
      this.state.pending = {
        type: 'gatling_response',
        sourceIdx: pi,
        respondents,
        currentIdx: 0,
      };
    },

    playEquipment(pi, card) {
      this.state.players[pi].inPlay.push(card);
      this.addLog(this.state.players[pi].name + ' puts ' + card.name + ' in play.');
    },

    playWeapon(pi, card) {
      const p = this.state.players[pi];
      const oldWeapon = p.inPlay.find(c => D.isWeapon(c));
      if (oldWeapon) {
        p.inPlay = p.inPlay.filter(c => c.id !== oldWeapon.id);
        this.state.discard.push(oldWeapon);
        this.addLog(p.name + ' discards ' + oldWeapon.name + '.');
      }
      p.inPlay.push(card);
      this.addLog(p.name + ' equips ' + card.name + ' (range ' + D.getWeaponRange(card) + ').');
    },

    playJailCard(pi, card, targetIdx) {
      this.state.players[targetIdx].inPlay.push(card);
      this.addLog(this.state.players[pi].name + ' puts ' + this.state.players[targetIdx].name + ' in Jail!');
    },

    playDynamiteCard(pi, card) {
      this.state.players[pi].inPlay.push(card);
      this.addLog(this.state.players[pi].name + ' plays Dynamite!');
    },

    playSpringfield(pi, card, targetIdx) {
      this.addLog(this.state.players[pi].name + ' plays Springfield on ' + this.state.players[targetIdx].name + '!');
      this.state.pending = {
        type: 'springfield_discard',
        playerIdx: pi,
        targetIdx,
        card,
      };
    },
  },
};

exports.BangCardsMixin = CardsMixin;
})(window);
