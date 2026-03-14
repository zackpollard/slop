// Bang! The Bullet — Turn Flow
// Start turn, draw phase, play phase, end turn, advance turn
(function(exports) {
'use strict';

const D = window.BangData;

const TurnsMixin = {
  apply(engine) {
    Object.assign(engine, TurnsMixin.methods);
  },

  methods: {
    startTurn() {
      const pi = this.state.currentTurn;
      const p = this.state.players[pi];
      this.state.bangsPlayedThisTurn = 0;
      this.state.buffaloRifleUsed = false;
      this.state.joseDelgadoUsed = 0;
      this.state.veraCusterCopy = null;
      this.state.turnPhase = 'start';

      this.addLog(p.name + "'s turn begins.");

      // Vera Custer: choose character to copy
      if (p.character.effect === 'copy_ability') {
        const targets = this.getAlivePlayers().filter(i => i !== pi);
        if (targets.length > 0) {
          this.state.pending = {
            type: 'vera_custer',
            playerIdx: pi,
            validTargets: targets,
          };
          return;
        }
      }

      this.processTurnStart();
    },

    processTurnStart() {
      const pi = this.state.currentTurn;
      // Dynamite check (before Jail)
      if (this.hasInPlay(pi, 'Dynamite')) {
        this.processDynamite(pi);
        if (this.state.winner || this.state.pending) return;
        if (this.state.players[pi].eliminated) {
          this.advanceTurn();
          return;
        }
      }
      // Jail check
      if (this.hasInPlay(pi, 'Jail')) {
        this.processJail(pi);
        return;
      }
      this.processDrawPhase(pi);
    },

    processDynamite(pi) {
      const p = this.state.players[pi];
      const dynCard = p.inPlay.find(c => c.name === 'Dynamite');
      const result = this.drawCheck(pi);

      if (result && result.luckyDuke) {
        this.state.pending = {
          type: 'lucky_duke',
          playerIdx: pi,
          cards: result.cards,
          reason: 'dynamite',
          continuation: { type: 'dynamite', playerIdx: pi, dynCardId: dynCard.id },
        };
        return;
      }

      this.resolveDynamite(pi, result, dynCard);
    },

    resolveDynamite(pi, drawnCard, dynCard) {
      const p = this.state.players[pi];
      if (drawnCard && D.isSpade2to9(drawnCard)) {
        this.addLog('BOOM! Dynamite explodes on ' + p.name + '! (' + D.cardDrawStr(drawnCard) + ')');
        this.removeFromInPlay(pi, dynCard.id);
        this.state.discard.push(dynCard);
        this.applyDamage(pi, 3, -1);
        // Attach continuation if beer_save interrupted
        if (this.state.pending && this.state.pending.type === 'beer_save') {
          this.state.pending.continuation = {
            type: 'resume_turn_start',
            playerIdx: pi,
          };
        }
      } else {
        this.addLog(p.name + "'s Dynamite doesn't explode. (" + (drawnCard ? D.cardDrawStr(drawnCard) : '?') + ')');
        this.removeFromInPlay(pi, dynCard.id);
        const next = this.getNextAlive(pi);
        if (next !== pi) {
          this.state.players[next].inPlay.push(dynCard);
          this.addLog('Dynamite passes to ' + this.state.players[next].name + '.');
        } else {
          this.state.discard.push(dynCard);
        }
      }
    },

    processJail(pi) {
      const p = this.state.players[pi];
      const jailCard = p.inPlay.find(c => c.name === 'Jail');
      const result = this.drawCheck(pi);

      if (result && result.luckyDuke) {
        this.state.pending = {
          type: 'lucky_duke',
          playerIdx: pi,
          cards: result.cards,
          reason: 'jail',
          continuation: { type: 'jail', playerIdx: pi, jailCardId: jailCard.id },
        };
        return;
      }

      this.resolveJail(pi, result, jailCard);
    },

    resolveJail(pi, drawnCard, jailCard) {
      const p = this.state.players[pi];
      this.removeFromInPlay(pi, jailCard.id);
      this.state.discard.push(jailCard);

      if (drawnCard && D.isHeart(drawnCard)) {
        this.addLog(p.name + ' escapes Jail! (' + D.cardDrawStr(drawnCard) + ')');
        this.processDrawPhase(pi);
      } else {
        this.addLog(p.name + ' stays in Jail. (' + (drawnCard ? D.cardDrawStr(drawnCard) : '?') + ') Turn skipped.');
        this.advanceTurn();
      }
    },

    processDrawPhase(pi) {
      this.state.turnPhase = 'draw';
      const p = this.state.players[pi];
      const eff = this.getEffectiveCharacter(pi);

      switch (eff.effect) {
        case 'draw_from_player': // Jesse Jones
          this.state.pending = {
            type: 'draw_choice',
            playerIdx: pi,
            choiceType: 'jesse_jones',
            validTargets: this.getAlivePlayers().filter(i => i !== pi && this.state.players[i].hand.length > 0),
          };
          return;
        case 'draw_pick_3': { // Kit Carlson
          const three = this.drawFromDeck(3);
          this.state.pending = {
            type: 'kit_carlson',
            playerIdx: pi,
            cards: three,
            picked: [],
          };
          return;
        }
        case 'draw_from_discard': // Pedro Ramirez
          if (this.state.discard.length > 0) {
            this.state.pending = {
              type: 'draw_choice',
              playerIdx: pi,
              choiceType: 'pedro_ramirez',
            };
            return;
          }
          break;
        case 'draw_from_inplay': { // Pat Brennan
          const targets = [];
          this.getAlivePlayers().forEach(i => {
            this.state.players[i].inPlay.forEach(c => {
              targets.push({ playerIdx: i, cardId: c.id, cardName: c.name });
            });
          });
          if (targets.length > 0) {
            this.state.pending = {
              type: 'draw_choice',
              playerIdx: pi,
              choiceType: 'pat_brennan',
              validTargets: targets,
            };
            return;
          }
          break;
        }
        case 'draw_bonus_red': // Black Jack
          this.doBlackJackDraw(pi);
          return;
        case 'draw_per_wound': { // Bill Noface
          const wounds = p.maxHp - p.hp;
          const count = 1 + wounds;
          p.hand.push(...this.drawFromDeck(count));
          this.addLog(p.name + ' draws ' + count + ' cards (1 + ' + wounds + ' wounds).');
          this.enterPlayPhase();
          return;
        }
        case 'draw_three': // Pixie Pete
          p.hand.push(...this.drawFromDeck(3));
          this.addLog(p.name + ' draws 3 cards.');
          this.enterPlayPhase();
          return;
      }

      // Default: draw 2
      p.hand.push(...this.drawFromDeck(2));
      this.addLog(p.name + ' draws 2 cards.');
      this.enterPlayPhase();
    },

    doBlackJackDraw(pi) {
      const p = this.state.players[pi];
      const cards = this.drawFromDeck(2);
      p.hand.push(...cards);
      if (cards.length >= 2 && D.isRed(cards[1])) {
        const bonus = this.drawFromDeck(1);
        p.hand.push(...bonus);
        this.addLog(p.name + ' draws 2 cards. Second card is ' + D.cardDrawStr(cards[1]) + ' (red) — draws 1 more!');
      } else {
        this.addLog(p.name + ' draws 2 cards.' + (cards.length >= 2 ? ' Second: ' + D.cardDrawStr(cards[1]) + ' (black).' : ''));
      }
      this.enterPlayPhase();
    },

    enterPlayPhase() {
      this.state.turnPhase = 'play';
      this.state.pending = null;
      this.checkSuzyLafayette(this.state.currentTurn);
    },

    advanceTurn() {
      if (this.state.winner) return;
      const next = this.getNextAlive(this.state.currentTurn);
      this.state.currentTurn = next;
      this.state.pending = null;
      this.startTurn();
    },

    endTurn(pi) {
      if (pi !== this.state.currentTurn) throw new Error('Not your turn');
      if (this.state.turnPhase !== 'play') throw new Error('Cannot end turn now');

      const p = this.state.players[pi];
      const limit = this.getHandLimit(pi);
      if (p.hand.length > limit) {
        this.state.turnPhase = 'discard';
        this.state.pending = {
          type: 'discard_required',
          playerIdx: pi,
          count: p.hand.length - limit,
        };
        return;
      }
      this.advanceTurn();
    },

    getHandLimit(pi) {
      const eff = this.getEffectiveCharacter(pi);
      if (eff.effect === 'big_hand') return 10; // Sean Mallory
      return this.state.players[pi].hp;
    },

    canUseBang(pi) {
      if (this.state.buffaloRifleUsed) return false;
      const eff = this.getEffectiveCharacter(pi);
      if (eff.effect === 'unlimited_bangs') return true;
      const weapon = this.state.players[pi].inPlay.find(c => c.name === 'Volcanic');
      if (weapon) return true;
      return this.state.bangsPlayedThisTurn < 1;
    },
  },
};

exports.BangTurnsMixin = TurnsMixin;
})(window);
