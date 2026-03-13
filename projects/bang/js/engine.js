// Bang! The Bullet — Game Engine
// Complete rules engine with all character abilities and card effects
(function(exports) {
'use strict';

const D = window.BangData;

class BangEngine {
  constructor() {
    this.state = null;
  }

  // ─── SETUP ──────────────────────────────────────────────
  initGame(playerInfos, useDodgeCity) {
    const n = playerInfos.length;
    const dist = D.ROLE_DIST[n];
    if (!dist) throw new Error('Need 4-8 players');

    // Build role deck
    let roles = [];
    for (const [role, count] of Object.entries(dist)) {
      for (let i = 0; i < count; i++) roles.push(role);
    }
    // Sheriff stays fixed, shuffle the rest
    roles = roles.filter(r => r !== 'sheriff');
    roles = D.shuffle(roles);
    roles.unshift('sheriff'); // Sheriff is always first assigned

    // Shuffle player order, but put Sheriff first in seat order
    const shuffledInfos = D.shuffle([...playerInfos]);
    
    // Pick characters
    const chars = D.shuffle(
      D.CHARACTERS.filter(c => useDodgeCity || c.set === 'base')
    );

    const deck = D.createDeck(useDodgeCity);
    
    const players = [];
    for (let i = 0; i < n; i++) {
      const role = roles[i];
      const char = chars[i * 2]; // Auto-pick first of 2 offered
      const maxHp = char.hp + (role === 'sheriff' ? 1 : 0);
      players.push({
        id: shuffledInfos[i].id,
        name: shuffledInfos[i].name,
        role,
        character: {...char},
        hp: maxHp,
        maxHp,
        hand: [],
        inPlay: [],
        eliminated: false,
      });
    }

    this.state = {
      phase: 'playing',
      players,
      deck,
      discard: [],
      currentTurn: 0, // Sheriff is index 0
      turnPhase: 'start',
      bangsPlayedThisTurn: 0,
      buffaloRifleUsed: false,
      joseDelgadoUsed: 0,
      pending: null,
      winner: null,
      log: [],
      useDodgeCity,
      veraCusterCopy: null,
    };

    // Deal starting hands (Sheriff gets hp+1 cards, others get hp cards... actually rules say everyone gets as many cards as their HP)
    for (let i = 0; i < n; i++) {
      const p = this.state.players[i];
      const cards = this.drawFromDeck(p.hp);
      p.hand.push(...cards);
    }

    this.addLog('Game started with ' + n + ' players!');
    this.addLog(players[0].name + ' is the Sheriff!');
    
    // Start first turn
    this.startTurn();
    return this.state;
  }

  // ─── DECK MANAGEMENT ───────────────────────────────────
  drawFromDeck(count) {
    const cards = [];
    for (let i = 0; i < count; i++) {
      if (this.state.deck.length === 0) this.reshuffleDeck();
      if (this.state.deck.length === 0) break;
      cards.push(this.state.deck.pop());
    }
    return cards;
  }

  reshuffleDeck() {
    if (this.state.discard.length <= 1) return;
    const top = this.state.discard.pop();
    this.state.deck = D.shuffle([...this.state.discard]);
    this.state.discard = top ? [top] : [];
    this.addLog('Deck reshuffled from discard pile.');
  }

  drawCheck(playerIdx) {
    // For Lucky Duke: draw 2, set pending for choice
    const eff = this.getEffectiveCharacter(playerIdx);
    if (eff.effect === 'lucky_draw') {
      if (this.state.deck.length === 0) this.reshuffleDeck();
      const c1 = this.state.deck.length > 0 ? this.state.deck.pop() : null;
      if (this.state.deck.length === 0) this.reshuffleDeck();
      const c2 = this.state.deck.length > 0 ? this.state.deck.pop() : null;
      if (!c1) return c2 || null;
      if (!c2) { this.state.discard.push(c1); return c1; }
      return {luckyDuke: true, cards: [c1, c2]};
    }
    if (this.state.deck.length === 0) this.reshuffleDeck();
    if (this.state.deck.length === 0) return null;
    const card = this.state.deck.pop();
    this.state.discard.push(card);
    return card;
  }

  resolveLuckyDuke(chosenIdx, cards) {
    // Both cards go to discard
    this.state.discard.push(cards[0], cards[1]);
    return cards[chosenIdx];
  }

  // ─── DISTANCE ───────────────────────────────────────────
  calcDistance(fromIdx, toIdx) {
    if (fromIdx === toIdx) return 0;
    const alive = this.getAlivePlayers();
    const fromPos = alive.indexOf(fromIdx);
    const toPos = alive.indexOf(toIdx);
    if (fromPos < 0 || toPos < 0) return Infinity;
    const n = alive.length;
    const clockwise = (toPos - fromPos + n) % n;
    const counter = (fromPos - toPos + n) % n;
    let dist = Math.min(clockwise, counter);

    const target = this.state.players[toIdx];
    const source = this.state.players[fromIdx];
    const isBelleTurn = this.state.currentTurn === fromIdx && 
      this.getEffectiveCharacter(fromIdx).effect === 'nullify_equipment';

    // Target's distance modifiers (Mustang, Hideout, Paul Regret)
    if (!isBelleTurn) {
      if (this.hasInPlay(toIdx, 'Mustang')) dist++;
      if (this.hasInPlay(toIdx, 'Hideout')) dist++;
    }
    if (this.getEffectiveCharacter(toIdx).effect === 'builtin_mustang') dist++;

    // Source's distance modifiers (Scope, Binocular, Rose Doolan)  
    if (this.hasInPlay(fromIdx, 'Scope')) dist--;
    if (this.hasInPlay(fromIdx, 'Binocular')) dist--;
    if (this.getEffectiveCharacter(fromIdx).effect === 'builtin_scope') dist--;

    return Math.max(dist, 1);
  }

  getWeaponRange(playerIdx) {
    const p = this.state.players[playerIdx];
    const weapon = p.inPlay.find(c => D.isWeapon(c));
    return weapon ? D.getWeaponRange(weapon) : 1;
  }

  isInRange(fromIdx, toIdx) {
    return this.calcDistance(fromIdx, toIdx) <= this.getWeaponRange(fromIdx);
  }

  // ─── TURN FLOW ─────────────────────────────────────────
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
    const eff = this.getEffectiveCharacter(pi);
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
  }

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
      return; // processJail handles continuation
    }
    this.processDrawPhase(pi);
  }

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
        continuation: {type: 'dynamite', playerIdx: pi, dynCardId: dynCard.id},
      };
      return;
    }
    
    this.resolveDynamite(pi, result, dynCard);
  }

  resolveDynamite(pi, drawnCard, dynCard) {
    const p = this.state.players[pi];
    if (drawnCard && D.isSpade2to9(drawnCard)) {
      this.addLog('BOOM! Dynamite explodes on ' + p.name + '! (' + D.cardDrawStr(drawnCard) + ')');
      this.removeFromInPlay(pi, dynCard.id);
      this.state.discard.push(dynCard);
      this.applyDamage(pi, 3, -1); // -1 = no player source
    } else {
      this.addLog(p.name + "'s Dynamite doesn't explode. (" + (drawnCard ? D.cardDrawStr(drawnCard) : '?') + ')');
      // Pass dynamite to next alive player
      this.removeFromInPlay(pi, dynCard.id);
      const next = this.getNextAlive(pi);
      if (next !== pi) {
        this.state.players[next].inPlay.push(dynCard);
        this.addLog('Dynamite passes to ' + this.state.players[next].name + '.');
      } else {
        this.state.discard.push(dynCard);
      }
    }
  }

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
        continuation: {type: 'jail', playerIdx: pi, jailCardId: jailCard.id},
      };
      return;
    }
    
    this.resolveJail(pi, result, jailCard);
  }

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
  }

  processDrawPhase(pi) {
    this.state.turnPhase = 'draw';
    const p = this.state.players[pi];
    const eff = this.getEffectiveCharacter(pi);

    switch(eff.effect) {
      case 'draw_from_player': // Jesse Jones
        this.state.pending = {
          type: 'draw_choice',
          playerIdx: pi,
          choiceType: 'jesse_jones',
          validTargets: this.getAlivePlayers().filter(i => i !== pi && this.state.players[i].hand.length > 0),
        };
        return;
      case 'draw_pick_3': // Kit Carlson
        const three = this.drawFromDeck(3);
        this.state.pending = {
          type: 'kit_carlson',
          playerIdx: pi,
          cards: three,
          picked: [],
        };
        return;
      case 'draw_from_discard': // Pedro Ramirez
        if (this.state.discard.length > 0) {
          this.state.pending = {
            type: 'draw_choice',
            playerIdx: pi,
            choiceType: 'pedro_ramirez',
          };
          return;
        }
        break; // Fall through to normal draw
      case 'draw_from_inplay': // Pat Brennan
        const targets = [];
        this.getAlivePlayers().forEach(i => {
          this.state.players[i].inPlay.forEach(c => {
            targets.push({playerIdx: i, cardId: c.id, cardName: c.name});
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
      case 'draw_bonus_red': // Black Jack
        this.doBlackJackDraw(pi);
        return;
      case 'draw_per_wound': // Bill Noface
        const wounds = p.maxHp - p.hp;
        const count = 1 + wounds;
        p.hand.push(...this.drawFromDeck(count));
        this.addLog(p.name + ' draws ' + count + ' cards (1 + ' + wounds + ' wounds).');
        this.enterPlayPhase();
        return;
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
  }

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
  }

  enterPlayPhase() {
    this.state.turnPhase = 'play';
    this.state.pending = null;
    // Check Suzy Lafayette: if hand empty after draw somehow, draw a card
    this.checkSuzyLafayette(this.state.currentTurn);
  }

  advanceTurn() {
    if (this.state.winner) return;
    const next = this.getNextAlive(this.state.currentTurn);
    this.state.currentTurn = next;
    this.state.pending = null;
    this.startTurn();
  }

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
  }

  getHandLimit(pi) {
    const eff = this.getEffectiveCharacter(pi);
    if (eff.effect === 'big_hand') return 10; // Sean Mallory
    return this.state.players[pi].hp;
  }

  // ─── CARD PLAYING ─────────────────────────────────────
  handleAction(playerIdx, action) {
    if (this.state.winner) throw new Error('Game is over');

    // Normalize: UI sends {type:...}, protocol sends {action:...}
    const act = action.action || action.type;

    switch(act) {
      case 'play_card':
        this.playCard(playerIdx, action.cardId, action.targetIdx);
        break;
      case 'end_turn':
        this.endTurn(playerIdx);
        break;
      case 'respond':
        // UI sends {type:'respond', response:'missed'|'take_hit'|..., cardId}
        // Normalize to engine format
        if (action.response === 'take_hit' || action.response === 'give_up' || action.response === 'accept_death') {
          action.cardId = null;
        }
        this.handleResponse(playerIdx, action);
        break;
      case 'discard':
        this.handleDiscard(playerIdx, action.cardIds);
        break;
      case 'pick':
      case 'pick_card':
        this.handlePick(playerIdx, action.cardId || action.cardIdx);
        break;
      case 'pick_cards':
        // Kit Carlson: pick multiple cards one at a time
        if (action.cardIds && action.cardIds.length > 0) {
          for (const cid of action.cardIds) {
            this.handlePick(playerIdx, cid);
          }
        }
        break;
      case 'choose':
        this.handleChoose(playerIdx, action.choice || action.choiceIdx);
        break;
      case 'choose_target':
        this.handleChooseTarget(playerIdx, action.targetIdx);
        break;
      case 'choose_card':
      case 'choose_card_from_target':
        this.handleChooseCardFromTarget(playerIdx, {choice: action.cardId || action.choice || 'hand'});
        break;
      case 'use_ability':
        this.useAbility(playerIdx, action.ability || action.abilityType, action.data || action);
        break;
      case 'play_with_discard':
        // UI sends this for Springfield/Brawl/Whisky: play card then discard
        this.playCard(playerIdx, action.cardId, action.targetIdx);
        // If pending is now a discard prompt, auto-resolve with the provided discardId
        if (this.state.pending && this.state.pending.type && this.state.pending.type.endsWith('_discard') && action.discardId) {
          this.handleChoose(playerIdx, action.discardId);
        }
        break;
      default:
        throw new Error('Unknown action: ' + act);
    }
  }

  playCard(playerIdx, cardId, targetIdx) {
    const p = this.state.players[playerIdx];
    if (this.state.turnPhase !== 'play' || playerIdx !== this.state.currentTurn) {
      throw new Error('Cannot play cards now');
    }
    
    const cardIdx = p.hand.findIndex(c => c.id === cardId);
    if (cardIdx < 0) throw new Error('Card not in hand');
    const card = p.hand[cardIdx];

    // Validate and route
    switch(card.name) {
      case 'BANG!':
        this.validateBang(playerIdx, card, targetIdx);
        p.hand.splice(cardIdx, 1);
        this.state.discard.push(card);
        this.state.bangsPlayedThisTurn++;
        this.playBang(playerIdx, card, targetIdx);
        break;
      case 'Punch':
        this.validatePunch(playerIdx, card, targetIdx);
        p.hand.splice(cardIdx, 1);
        this.state.discard.push(card);
        this.playBang(playerIdx, card, targetIdx); // Same as BANG! but no limit
        break;
      case 'Missed!':
        // Calamity Janet can play as BANG!
        if (this.getEffectiveCharacter(playerIdx).effect === 'bang_missed_swap') {
          this.validateBang(playerIdx, card, targetIdx);
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          this.state.bangsPlayedThisTurn++;
          this.playBang(playerIdx, card, targetIdx);
        } else {
          throw new Error('Cannot play Missed! during your turn');
        }
        break;
      case 'Beer':
        this.validateBeer(playerIdx);
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
          // Need target selection
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          const valid = this.getAlivePlayers().filter(i => i !== playerIdx && this.calcDistance(playerIdx, i) <= 1 && (this.state.players[i].hand.length > 0 || this.state.players[i].inPlay.length > 0));
          this.state.pending = {type: 'choose_target', playerIdx, cardName: 'Panic!', validTargets: valid};
          return;
        }
        this.validatePanic(playerIdx, targetIdx);
        p.hand.splice(cardIdx, 1);
        this.state.discard.push(card);
        this.playPanic(playerIdx, card, targetIdx);
        break;
      case 'Cat Balou':
      case 'Rag Time':
        if (targetIdx === undefined || targetIdx === null) {
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          const valid = this.getAlivePlayers().filter(i => i !== playerIdx && (this.state.players[i].hand.length > 0 || this.state.players[i].inPlay.length > 0));
          this.state.pending = {type: 'choose_target', playerIdx, cardName: card.name, validTargets: valid};
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
          const valid = this.getAlivePlayers().filter(i => i !== playerIdx);
          this.state.pending = {type: 'choose_target', playerIdx, cardName: 'Duel', validTargets: valid};
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
          const valid = this.getAlivePlayers().filter(i => i !== playerIdx && this.state.players[i].role !== 'sheriff');
          this.state.pending = {type: 'choose_target', playerIdx, cardName: 'Jail', validTargets: valid, equipCard: card};
          return;
        }
        this.validateJail(playerIdx, targetIdx);
        p.hand.splice(cardIdx, 1);
        this.playJailCard(playerIdx, card, targetIdx);
        break;
      case 'Dynamite':
        p.hand.splice(cardIdx, 1);
        this.playDynamiteCard(playerIdx, card);
        break;
      case 'Springfield':
        if (targetIdx === undefined || targetIdx === null) {
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          const valid = this.getAlivePlayers().filter(i => i !== playerIdx);
          this.state.pending = {type: 'choose_target', playerIdx, cardName: 'Springfield', validTargets: valid};
          return;
        }
        p.hand.splice(cardIdx, 1);
        this.state.discard.push(card);
        this.playSpringfield(playerIdx, card, targetIdx);
        break;
      case 'Brawl':
        if (p.hand.length < 1) throw new Error('Need a card to discard for Brawl');
        p.hand.splice(cardIdx, 1);
        this.state.discard.push(card);
        this.state.pending = {type: 'brawl_discard', playerIdx};
        break;
      case 'Whisky':
        if (p.hand.length < 1) throw new Error('Need a card to discard for Whisky');
        p.hand.splice(cardIdx, 1);
        this.state.discard.push(card);
        this.state.pending = {type: 'whisky_discard', playerIdx};
        break;
      case 'Tequila':
        if (targetIdx === undefined || targetIdx === null) {
          if (p.hand.length < 1) throw new Error('Need a card to discard for Tequila');
          p.hand.splice(cardIdx, 1);
          this.state.discard.push(card);
          const valid = this.getAlivePlayers();
          this.state.pending = {type: 'choose_target', playerIdx, cardName: 'Tequila', validTargets: valid};
          return;
        }
        p.hand.splice(cardIdx, 1);
        this.state.discard.push(card);
        this.state.pending = {type: 'tequila_discard', playerIdx, targetIdx};
        break;
      default:
        // Equipment (blue/green cards)
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
  }

  // ─── CARD VALIDATION ──────────────────────────────────
  validateBang(pi, card, targetIdx) {
    if (targetIdx === undefined || targetIdx === null) throw new Error('BANG! needs a target');
    if (targetIdx === pi) throw new Error('Cannot BANG! yourself');
    if (!this.canUseBang(pi)) throw new Error('Already used BANG! this turn');
    if (!this.isInRange(pi, targetIdx)) throw new Error('Target out of range');
    const t = this.state.players[targetIdx];
    if (t.eliminated) throw new Error('Target is eliminated');
  }

  validatePunch(pi, card, targetIdx) {
    if (targetIdx === undefined || targetIdx === null) throw new Error('Punch needs a target');
    if (targetIdx === pi) throw new Error('Cannot Punch yourself');
    if (!this.isInRange(pi, targetIdx)) throw new Error('Target out of range');
    if (this.state.players[targetIdx].eliminated) throw new Error('Target is eliminated');
  }

  validateBeer(pi) {
    if (this.getAliveCount() <= 2) throw new Error('Beer has no effect with only 2 players');
    if (this.state.players[pi].hp >= this.state.players[pi].maxHp) throw new Error('Already at max HP');
  }

  validatePanic(pi, targetIdx) {
    if (targetIdx === pi) throw new Error('Cannot Panic! yourself');
    if (this.calcDistance(pi, targetIdx) > 1) throw new Error('Target too far for Panic! (distance 1 only)');
    const t = this.state.players[targetIdx];
    if (t.eliminated) throw new Error('Target is eliminated');
    if (t.hand.length === 0 && t.inPlay.length === 0) throw new Error('Target has no cards');
  }

  validateJail(pi, targetIdx) {
    if (targetIdx === pi) throw new Error('Cannot jail yourself');
    if (this.state.players[targetIdx].role === 'sheriff') throw new Error('Cannot jail the Sheriff');
    if (this.state.players[targetIdx].eliminated) throw new Error('Target is eliminated');
  }

  canUseBang(pi) {
    if (this.state.buffaloRifleUsed) return false;
    const eff = this.getEffectiveCharacter(pi);
    if (eff.effect === 'unlimited_bangs') return true; // Willy the Kid
    const weapon = this.state.players[pi].inPlay.find(c => c.name === 'Volcanic');
    if (weapon) return true;
    return this.state.bangsPlayedThisTurn < 1;
  }

  getValidTargets(pi, cardName) {
    const alive = this.getAlivePlayers().filter(i => i !== pi);
    switch(cardName) {
      case 'BANG!':
      case 'Missed!': // Calamity Janet
      case 'Punch':
        return alive.filter(i => this.isInRange(pi, i));
      case 'Panic!':
        return alive.filter(i => this.calcDistance(pi, i) <= 1 && 
          (this.state.players[i].hand.length > 0 || this.state.players[i].inPlay.length > 0));
      case 'Cat Balou':
      case 'Rag Time':
      case 'Duel':
      case 'Springfield':
        return alive.filter(i => cardName === 'Cat Balou' || cardName === 'Rag Time' ? 
          (this.state.players[i].hand.length > 0 || this.state.players[i].inPlay.length > 0) : true);
      case 'Jail':
        return alive.filter(i => this.state.players[i].role !== 'sheriff');
      case 'Tequila':
        return this.getAlivePlayers(); // Can target self
      default:
        return alive;
    }
  }

  // ─── CARD EFFECTS ─────────────────────────────────────
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
  }

  resolveBangHit(sourceIdx, targetIdx, card) {
    const tgt = this.state.players[targetIdx];
    const isBelleTurn = this.state.currentTurn === sourceIdx && 
      this.getEffectiveCharacter(sourceIdx).effect === 'nullify_equipment';
    
    let barrelChecked = false;
    let jourdonnaisChecked = false;
    let missedNeeded = this.getEffectiveCharacter(sourceIdx).effect === 'double_missed' ? 2 : 1;
    let missedPlayed = 0;

    // Auto-check Barrel (if not Belle Star's turn)
    if (!isBelleTurn && this.hasInPlay(targetIdx, 'Barrel')) {
      const result = this.drawCheck(targetIdx);
      if (result && result.luckyDuke) {
        this.state.pending = {
          type: 'lucky_duke', playerIdx: targetIdx,
          cards: result.cards, reason: 'barrel',
          continuation: {type: 'bang_hit', sourceIdx, targetIdx, card, missedNeeded, missedPlayed, barrelChecked: true, jourdonnaisChecked},
        };
        return;
      }
      barrelChecked = true;
      if (result && D.isHeart(result)) {
        this.addLog(tgt.name + "'s Barrel saves them! (" + D.cardDrawStr(result) + ')');
        missedPlayed++;
        if (missedPlayed >= missedNeeded) return; // Fully saved
      } else {
        this.addLog(tgt.name + "'s Barrel fails. (" + (result ? D.cardDrawStr(result) : '?') + ')');
      }
    }

    // Auto-check Jourdonnais (built-in barrel)
    if (this.getEffectiveCharacter(targetIdx).effect === 'builtin_barrel') {
      const result = this.drawCheck(targetIdx);
      if (result && result.luckyDuke) {
        this.state.pending = {
          type: 'lucky_duke', playerIdx: targetIdx,
          cards: result.cards, reason: 'jourdonnais',
          continuation: {type: 'bang_hit', sourceIdx, targetIdx, card, missedNeeded, missedPlayed, barrelChecked, jourdonnaisChecked: true},
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
  }

  playBeer(pi, card) {
    const p = this.state.players[pi];
    const heal = this.getEffectiveCharacter(pi).effect === 'super_beer' ? 2 : 1;
    const actual = Math.min(heal, p.maxHp - p.hp);
    p.hp += actual;
    this.addLog(p.name + ' drinks Beer and heals ' + actual + ' HP.');
    this.checkSuzyLafayette(pi);
  }

  playSaloon(pi, card) {
    this.addLog(this.state.players[pi].name + ' plays Saloon! Everyone heals 1 HP.');
    for (const i of this.getAlivePlayers()) {
      const p = this.state.players[i];
      if (p.hp < p.maxHp) p.hp++;
    }
  }

  playStagecoach(pi, card) {
    const drawn = this.drawFromDeck(2);
    this.state.players[pi].hand.push(...drawn);
    this.addLog(this.state.players[pi].name + ' plays Stagecoach, draws 2 cards.');
    this.checkSuzyLafayette(pi);
  }

  playWellsFargo(pi, card) {
    const drawn = this.drawFromDeck(3);
    this.state.players[pi].hand.push(...drawn);
    this.addLog(this.state.players[pi].name + ' plays Wells Fargo, draws 3 cards.');
    this.checkSuzyLafayette(pi);
  }

  playPonyExpress(pi, card) {
    const drawn = this.drawFromDeck(3);
    this.state.players[pi].hand.push(...drawn);
    this.addLog(this.state.players[pi].name + ' plays Pony Express, draws 3 cards.');
    this.checkSuzyLafayette(pi);
  }

  playPanic(pi, card, targetIdx) {
    const tgt = this.state.players[targetIdx];
    this.addLog(this.state.players[pi].name + ' plays Panic! on ' + tgt.name + '!');
    // Set pending for card choice
    this.state.pending = {
      type: 'choose_card_from_target',
      playerIdx: pi,
      targetIdx,
      cardName: 'Panic!',
    };
  }

  playCatBalou(pi, card, targetIdx) {
    const tgt = this.state.players[targetIdx];
    this.addLog(this.state.players[pi].name + ' plays Cat Balou on ' + tgt.name + '!');
    this.state.pending = {
      type: 'choose_card_from_target',
      playerIdx: pi,
      targetIdx,
      cardName: 'Cat Balou',
    };
  }

  playRagTime(pi, card, targetIdx) {
    const tgt = this.state.players[targetIdx];
    this.addLog(this.state.players[pi].name + ' plays Rag Time on ' + tgt.name + '!');
    this.state.pending = {
      type: 'choose_card_from_target',
      playerIdx: pi,
      targetIdx,
      cardName: 'Rag Time',
    };
  }

  playGeneralStore(pi, card) {
    const alive = this.getAlivePlayers();
    const revealed = this.drawFromDeck(alive.length);
    this.addLog(this.state.players[pi].name + ' opens a General Store! (' + revealed.length + ' cards)');
    // Pick order starts from current player
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
  }

  playDuel(pi, card, targetIdx) {
    this.addLog(this.state.players[pi].name + ' challenges ' + this.state.players[targetIdx].name + ' to a Duel!');
    this.state.pending = {
      type: 'duel_response',
      sourceIdx: pi,
      targetIdx,
      currentResponder: targetIdx,
    };
  }

  playIndians(pi, card) {
    this.addLog(this.state.players[pi].name + ' plays Indians!');
    const respondents = this.getAlivePlayers().filter(i => i !== pi);
    if (respondents.length === 0) return;
    this.state.pending = {
      type: 'indians_response',
      sourceIdx: pi,
      respondents,
      currentIdx: 0,
    };
  }

  playGatling(pi, card) {
    this.addLog(this.state.players[pi].name + ' fires the Gatling!');
    const respondents = this.getAlivePlayers().filter(i => i !== pi);
    if (respondents.length === 0) return;
    this.state.pending = {
      type: 'gatling_response',
      sourceIdx: pi,
      respondents,
      currentIdx: 0,
    };
  }

  playEquipment(pi, card) {
    this.state.players[pi].inPlay.push(card);
    this.addLog(this.state.players[pi].name + ' puts ' + card.name + ' in play.');
  }

  playWeapon(pi, card) {
    const p = this.state.players[pi];
    // Discard old weapon
    const oldWeapon = p.inPlay.find(c => D.isWeapon(c));
    if (oldWeapon) {
      p.inPlay = p.inPlay.filter(c => c.id !== oldWeapon.id);
      this.state.discard.push(oldWeapon);
      this.addLog(p.name + ' discards ' + oldWeapon.name + '.');
    }
    p.inPlay.push(card);
    this.addLog(p.name + ' equips ' + card.name + ' (range ' + D.getWeaponRange(card) + ').');
  }

  playJailCard(pi, card, targetIdx) {
    this.state.players[targetIdx].inPlay.push(card);
    this.addLog(this.state.players[pi].name + ' puts ' + this.state.players[targetIdx].name + ' in Jail!');
  }

  playDynamiteCard(pi, card) {
    this.state.players[pi].inPlay.push(card);
    this.addLog(this.state.players[pi].name + ' plays Dynamite!');
  }

  playSpringfield(pi, card, targetIdx) {
    this.addLog(this.state.players[pi].name + ' plays Springfield on ' + this.state.players[targetIdx].name + '!');
    if (this.state.players[pi].hand.length === 0) {
      // No card to discard, just do the bang
      this.resolveBangHit(pi, targetIdx, card);
      return;
    }
    this.state.pending = {
      type: 'springfield_discard',
      playerIdx: pi,
      targetIdx,
      card,
    };
  }

  // ─── RESPONSE HANDLING ────────────────────────────────
  handleResponse(playerIdx, action) {
    const p = this.state.pending;
    if (!p) throw new Error('No pending action');
    
    switch(p.type) {
      case 'bang_response':
        this.handleBangResponse(playerIdx, action);
        break;
      case 'indians_response':
        this.handleIndiansResponse(playerIdx, action);
        break;
      case 'gatling_response':
        this.handleGatlingResponse(playerIdx, action);
        break;
      case 'duel_response':
        this.handleDuelResponse(playerIdx, action);
        break;
      case 'beer_save':
        this.handleBeerSave(playerIdx, action);
        break;
      default:
        throw new Error('Cannot respond to: ' + p.type);
    }
  }

  handleBangResponse(playerIdx, action) {
    const p = this.state.pending;
    if (playerIdx !== p.targetIdx) throw new Error('Not your response');
    
    if (action.cardId === null || action.cardId === undefined || action.cardId === 'pass') {
      // Take the hit
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
        return; // Need more misses
      }
      if (inPlayCard.name === 'Can Can') {
        player.inPlay = player.inPlay.filter(c => c.id !== inPlayCard.id);
        this.state.discard.push(inPlayCard);
        p.missedPlayed++;
        this.addLog(player.name + ' uses Can Can!');
        // Draw from attacker's hand
        const atk = this.state.players[p.sourceIdx];
        if (atk.hand.length > 0) {
          const ri = Math.floor(Math.random() * atk.hand.length);
          const stolen = atk.hand.splice(ri, 1)[0];
          player.hand.push(stolen);
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
        // Draw from any player at distance 1
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
    
    // Validate: must be Missed!, or BANG! (Calamity Janet), or any card (Elena Fuente)
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
    // else: still need more misses (Slab the Killer)
  }

  handleIndiansResponse(playerIdx, action) {
    const p = this.state.pending;
    const respIdx = p.respondents[p.currentIdx];
    if (playerIdx !== respIdx) throw new Error('Not your response');
    const player = this.state.players[playerIdx];
    
    if (action.cardId === null || action.cardId === undefined || action.cardId === 'pass') {
      this.addLog(player.name + ' has no BANG! — takes 1 damage!');
      this.state.pending = null;
      this.applyDamage(playerIdx, 1, p.sourceIdx);
      if (this.state.winner || this.state.pending) return;
      this.advanceIndiansResponse(p);
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
    this.advanceIndiansResponse(p);
  }

  advanceIndiansResponse(p) {
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
  }

  handleGatlingResponse(playerIdx, action) {
    const p = this.state.pending;
    const respIdx = p.respondents[p.currentIdx];
    if (playerIdx !== respIdx) throw new Error('Not your response');
    const player = this.state.players[playerIdx];
    
    if (action.cardId === null || action.cardId === undefined || action.cardId === 'pass') {
      this.addLog(player.name + ' takes 1 damage from Gatling!');
      this.state.pending = null;
      this.applyDamage(playerIdx, 1, p.sourceIdx);
      if (this.state.winner || this.state.pending) return;
      this.advanceGatlingResponse(p);
      return;
    }

    const cardIdx = player.hand.findIndex(c => c.id === action.cardId);
    const inPlayCard = !cardIdx || cardIdx < 0 ? player.inPlay.find(c => c.id === action.cardId) : null;
    
    if (inPlayCard && inPlayCard.name === 'Dodge') {
      player.inPlay = player.inPlay.filter(c => c.id !== inPlayCard.id);
      this.state.discard.push(inPlayCard);
      this.addLog(player.name + ' uses Dodge!');
      player.hand.push(...this.drawFromDeck(1));
      this.triggerMollyStark(playerIdx);
      this.advanceGatlingResponse(p);
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
    this.advanceGatlingResponse(p);
  }

  advanceGatlingResponse(p) {
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
  }

  handleDuelResponse(playerIdx, action) {
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
    
    // Switch responder
    p.currentResponder = (playerIdx === p.sourceIdx) ? p.targetIdx : p.sourceIdx;
    this.state.pending = p;
  }

  handleBeerSave(playerIdx, action) {
    const p = this.state.pending;
    if (playerIdx !== p.playerIdx) throw new Error('Not your response');
    const player = this.state.players[playerIdx];
    
    if (action.cardId === null || action.cardId === undefined || action.cardId === 'pass') {
      this.state.pending = null;
      this.eliminatePlayer(playerIdx, p.killerIdx);
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
      // Still dying, check for more beer
      if (player.hand.some(c => c.name === 'Beer')) {
        return; // Keep the pending
      }
      this.state.pending = null;
      this.eliminatePlayer(playerIdx, p.killerIdx);
    } else {
      this.state.pending = null;
    }
  }

  // ─── CHOICE HANDLERS ──────────────────────────────────
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
      this.state.pending = {type: 'tequila_discard', playerIdx, targetIdx};
    } else if (cardName === 'BANG!' || cardName === 'Punch' || cardName === 'Missed!') {
      this.playBang(playerIdx, {name: cardName}, targetIdx);
    }
  }

  handleChooseCardFromTarget(playerIdx, action) {
    const p = this.state.pending;
    if (!p || p.type !== 'choose_card_from_target') throw new Error('No card selection pending');
    if (p.playerIdx !== playerIdx) throw new Error('Not your choice');
    
    const target = this.state.players[p.targetIdx];
    this.state.pending = null;
    
    if (action.choice === 'hand') {
      // Random from hand
      if (target.hand.length === 0) throw new Error('Target has no cards in hand');
      const ri = Math.floor(Math.random() * target.hand.length);
      const card = target.hand.splice(ri, 1)[0];
      if (p.cardName === 'Cat Balou') {
        this.state.discard.push(card);
        this.addLog('A card from ' + target.name + "'s hand is discarded.");
      } else {
        // Panic! or Rag Time — take the card
        this.state.players[playerIdx].hand.push(card);
        this.addLog(this.state.players[playerIdx].name + ' takes a card from ' + target.name + "'s hand.");
      }
    } else {
      // Specific in-play card
      const cardId = action.choice;
      const cardIdx = target.inPlay.findIndex(c => c.id === cardId);
      if (cardIdx < 0) throw new Error('Card not found in play');
      const card = target.inPlay.splice(cardIdx, 1)[0];
      if (p.cardName === 'Cat Balou') {
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
  }

  handlePick(playerIdx, cardIdOrIdx) {
    const p = this.state.pending;
    if (!p) throw new Error('No pending action');
    
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
      // Skip eliminated players
      while (p.currentIdx < p.pickOrder.length && this.state.players[p.pickOrder[p.currentIdx]].eliminated) {
        p.currentIdx++;
      }
      if (p.currentIdx >= p.pickOrder.length || p.cards.every(c => !c)) {
        // Give remaining cards to discard
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
        // Put remaining card back on top of deck
        const remaining = p.cards.find(c => c !== null);
        if (remaining) this.state.deck.push(remaining);
        this.addLog(this.state.players[playerIdx].name + ' picks 2 cards (Kit Carlson).');
        this.state.pending = null;
        this.enterPlayPhase();
      }
      return;
    }
  }

  handleChoose(playerIdx, choice) {
    const p = this.state.pending;
    if (!p) throw new Error('No pending action');

    if (p.type === 'lucky_duke') {
      if (playerIdx !== p.playerIdx) throw new Error('Not your choice');
      const chosenCard = this.resolveLuckyDuke(choice, p.cards);
      const cont = p.continuation;
      this.state.pending = null;
      
      if (cont.type === 'dynamite') {
        const dynCard = this.state.players[cont.playerIdx].inPlay.find(c => c.id === cont.dynCardId) || {id: cont.dynCardId, name: 'Dynamite'};
        this.resolveDynamite(cont.playerIdx, chosenCard, dynCard);
        if (!this.state.winner && !this.state.pending && !this.state.players[cont.playerIdx].eliminated) {
          if (this.hasInPlay(cont.playerIdx, 'Jail')) {
            this.processJail(cont.playerIdx);
          } else {
            this.processDrawPhase(cont.playerIdx);
          }
        }
      } else if (cont.type === 'jail') {
        const jailCard = {id: cont.jailCardId, name: 'Jail'};
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
        // Continue bang resolution
        this.state.pending = {
          type: 'bang_response', sourceIdx: c.sourceIdx, targetIdx: c.targetIdx,
          card: c.card, missedNeeded: c.missedNeeded, missedPlayed: c.missedPlayed,
          barrelChecked: c.barrelChecked, jourdonnaisChecked: c.jourdonnaisChecked,
        };
      } else if (cont.type === 'barrel_check') {
        // Generic barrel check continuation
        if (D.isHeart(chosenCard)) {
          this.addLog('Barrel succeeds! (Lucky Duke: ' + D.cardDrawStr(chosenCard) + ')');
          if (cont.onSuccess) cont.onSuccess.call(this);
        } else {
          this.addLog('Barrel fails. (Lucky Duke: ' + D.cardDrawStr(chosenCard) + ')');
          if (cont.onFail) cont.onFail.call(this);
        }
      }
      return;
    }

    if (p.type === 'vera_custer') {
      if (playerIdx !== p.playerIdx) throw new Error('Not your choice');
      if (!p.validTargets.includes(choice)) throw new Error('Invalid choice');
      const copied = this.state.players[choice].character;
      this.state.veraCusterCopy = {...copied};
      this.addLog(this.state.players[playerIdx].name + ' copies ' + copied.name + "'s ability!");
      this.state.pending = null;
      this.processTurnStart();
      return;
    }

    if (p.type === 'draw_choice') {
      if (playerIdx !== p.playerIdx) throw new Error('Not your choice');
      const player = this.state.players[playerIdx];
      
      if (p.choiceType === 'jesse_jones') {
        if (choice === 'deck') {
          player.hand.push(...this.drawFromDeck(2));
          this.addLog(player.name + ' draws 2 cards from deck.');
        } else {
          // Draw from chosen player's hand
          const target = this.state.players[choice];
          if (target.hand.length > 0) {
            const ri = Math.floor(Math.random() * target.hand.length);
            player.hand.push(target.hand.splice(ri, 1)[0]);
            this.addLog(player.name + ' draws a card from ' + target.name + "'s hand (Jesse Jones).");
          }
          player.hand.push(...this.drawFromDeck(1));
          this.addLog(player.name + ' draws 1 more card from deck.');
        }
      } else if (p.choiceType === 'pedro_ramirez') {
        if (choice === 'deck') {
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
        if (choice === 'deck') {
          player.hand.push(...this.drawFromDeck(2));
          this.addLog(player.name + ' draws 2 cards from deck.');
        } else {
          // choice is {playerIdx, cardId}
          const target = this.state.players[choice.playerIdx];
          const ci = target.inPlay.findIndex(c => c.id === choice.cardId);
          if (ci >= 0) {
            const taken = target.inPlay.splice(ci, 1)[0];
            player.hand.push(taken);
            this.addLog(player.name + ' takes ' + taken.name + ' from ' + target.name + ' (Pat Brennan).');
          }
          // Pat Brennan: takes one card in play INSTEAD of normal draw (no second card)
        }
      }
      
      this.state.pending = null;
      this.enterPlayPhase();
      return;
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
      // All others must discard an in-play card or lose random hand card
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
        // Lose random card from hand
        if (player.hand.length > 0) {
          const ri = Math.floor(Math.random() * player.hand.length);
          const lost = player.hand.splice(ri, 1)[0];
          this.state.discard.push(lost);
          this.addLog(player.name + ' loses a card from hand to Brawl.');
        }
      } else {
        // Discard chosen in-play card
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
  }

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
  }

  // ─── ACTIVE ABILITIES ─────────────────────────────────
  useAbility(playerIdx, abilityType, data) {
    if (playerIdx !== this.state.currentTurn) throw new Error('Not your turn');
    if (this.state.turnPhase !== 'play') throw new Error('Can only use abilities during play phase');
    const player = this.state.players[playerIdx];
    const eff = this.getEffectiveCharacter(playerIdx);

    switch(abilityType) {
      case 'sid_ketchum': {
        // Discard 2 cards to heal 1 HP
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
        // Lose 1 HP to draw 2 cards
        if (player.hp <= 1) throw new Error('Too risky — would die!');
        player.hp--;
        player.hand.push(...this.drawFromDeck(2));
        this.addLog(player.name + ' loses 1 HP to draw 2 cards (Chuck Wengam).');
        break;
      }
      case 'doc_holyday': {
        // Discard 2 cards to BANG! a player in range
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
        this.resolveBangHit(playerIdx, data.targetIdx, {name: 'BANG!', suit: 'C', value: 1});
        break;
      }
      case 'jose_delgado': {
        // Discard 1 blue card from hand to draw 2 (twice per turn)
        if (this.state.joseDelgadoUsed >= 2) throw new Error('Already used ability twice this turn');
        if (!data || !data.cardId) throw new Error('Must discard a blue card');
        const ci = player.hand.findIndex(c => c.id === data.cardId && D.isBlueEquipment(c));
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
  }

  // ─── GREEN CARD ABILITIES (in-play, discard to use) ───
  useGreenCard(playerIdx, cardId) {
    const player = this.state.players[playerIdx];
    const ci = player.inPlay.findIndex(c => c.id === cardId);
    if (ci < 0) throw new Error('Card not in play');
    const card = player.inPlay[ci];
    
    if (card.name === 'Derringer') {
      // BANG! at distance 1 + draw a card
      player.inPlay.splice(ci, 1);
      this.state.discard.push(card);
      this.addLog(player.name + ' uses Derringer!');
      player.hand.push(...this.drawFromDeck(1));
      // Need target selection
      const valid = this.getAlivePlayers().filter(i => i !== playerIdx && this.calcDistance(playerIdx, i) <= 1);
      if (valid.length > 0) {
        this.state.pending = {type: 'choose_target', playerIdx, cardName: 'BANG!', validTargets: valid};
      }
      return;
    }
    if (card.name === 'Howitzer') {
      // Gatling effect
      player.inPlay.splice(ci, 1);
      this.state.discard.push(card);
      this.addLog(player.name + ' fires the Howitzer!');
      this.playGatling(playerIdx, card);
      return;
    }
    if (card.name === 'Pepperbox') {
      // BANG! any player regardless of distance
      player.inPlay.splice(ci, 1);
      this.state.discard.push(card);
      this.addLog(player.name + ' uses Pepperbox!');
      const valid = this.getAlivePlayers().filter(i => i !== playerIdx);
      if (valid.length > 0) {
        this.state.pending = {type: 'choose_target', playerIdx, cardName: 'BANG!', validTargets: valid};
      }
      return;
    }
    if (card.name === 'Buffalo Rifle') {
      // BANG! any player, but no other BANG! this turn
      player.inPlay.splice(ci, 1);
      this.state.discard.push(card);
      this.state.buffaloRifleUsed = true;
      this.addLog(player.name + ' uses Buffalo Rifle!');
      const valid = this.getAlivePlayers().filter(i => i !== playerIdx);
      if (valid.length > 0) {
        this.state.pending = {type: 'choose_target', playerIdx, cardName: 'BANG!', validTargets: valid};
      }
      return;
    }
  }

  // ─── DAMAGE & ELIMINATION ─────────────────────────────
  applyDamage(playerIdx, amount, sourceIdx) {
    const player = this.state.players[playerIdx];
    const eff = this.getEffectiveCharacter(playerIdx);
    
    for (let i = 0; i < amount; i++) {
      if (player.eliminated) break;
      player.hp--;
      
      // Bart Cassidy: draw a card per HP lost
      if (eff.effect === 'on_damage_draw') {
        const drawn = this.drawFromDeck(1);
        player.hand.push(...drawn);
        if (drawn.length > 0) this.addLog(player.name + ' draws a card (Bart Cassidy).');
      }
      
      // El Gringo: draw from attacker's hand
      if (eff.effect === 'on_damage_steal' && sourceIdx >= 0) {
        const src = this.state.players[sourceIdx];
        if (src && src.hand.length > 0) {
          const ri = Math.floor(Math.random() * src.hand.length);
          player.hand.push(src.hand.splice(ri, 1)[0]);
          this.addLog(player.name + ' steals a card from ' + src.name + ' (El Gringo).');
        }
      }
      
      if (player.hp <= 0) {
        // Check beer save
        if (this.getAliveCount() > 2 && player.hand.some(c => c.name === 'Beer')) {
          this.state.pending = {
            type: 'beer_save',
            playerIdx,
            killerIdx: sourceIdx >= 0 ? sourceIdx : -1,
          };
          return;
        }
        this.eliminatePlayer(playerIdx, sourceIdx >= 0 ? sourceIdx : -1);
        return;
      }
    }
  }

  eliminatePlayer(playerIdx, killerIdx) {
    const player = this.state.players[playerIdx];
    player.eliminated = true;
    player.hp = 0;
    this.addLog(player.name + ' (' + player.role + ') has been eliminated!');
    
    // Vulture Sam gets all cards
    const vultureIdx = this.getAlivePlayers().find(i => 
      this.getEffectiveCharacter(i).effect === 'vulture'
    );
    
    if (vultureIdx !== undefined) {
      const vs = this.state.players[vultureIdx];
      vs.hand.push(...player.hand, ...player.inPlay);
      this.addLog(vs.name + ' takes all cards from ' + player.name + ' (Vulture Sam).');
    } else {
      this.state.discard.push(...player.hand, ...player.inPlay);
    }
    player.hand = [];
    player.inPlay = [];

    // Greg Digger heals 2
    for (const i of this.getAlivePlayers()) {
      if (this.getEffectiveCharacter(i).effect === 'heal_on_eliminate') {
        const gd = this.state.players[i];
        const heal = Math.min(2, gd.maxHp - gd.hp);
        if (heal > 0) {
          gd.hp += heal;
          this.addLog(gd.name + ' heals ' + heal + ' HP (Greg Digger).');
        }
      }
      // Herb Hunter draws 2
      if (this.getEffectiveCharacter(i).effect === 'draw_on_eliminate') {
        const hh = this.state.players[i];
        hh.hand.push(...this.drawFromDeck(2));
        this.addLog(hh.name + ' draws 2 cards (Herb Hunter).');
      }
    }

    // Rewards/penalties
    if (player.role === 'outlaw' && killerIdx >= 0) {
      const killer = this.state.players[killerIdx];
      if (!killer.eliminated) {
        killer.hand.push(...this.drawFromDeck(3));
        this.addLog(killer.name + ' draws 3 cards for killing an Outlaw!');
      }
    }
    if (player.role === 'deputy' && killerIdx >= 0 && this.state.players[killerIdx].role === 'sheriff') {
      const sheriff = this.state.players[killerIdx];
      this.addLog('The Sheriff killed a Deputy! ' + sheriff.name + ' discards all cards!');
      this.state.discard.push(...sheriff.hand, ...sheriff.inPlay);
      sheriff.hand = [];
      sheriff.inPlay = [];
    }

    this.checkWinCondition();
  }

  checkWinCondition() {
    const alive = this.getAlivePlayers();
    const aliveRoles = alive.map(i => this.state.players[i].role);
    
    // Sheriff dead?
    const sheriffAlive = aliveRoles.includes('sheriff');
    if (!sheriffAlive) {
      // If only renegade(s) alive
      if (aliveRoles.every(r => r === 'renegade')) {
        this.state.winner = {team: 'renegade', desc: 'Renegade wins!'};
      } else {
        this.state.winner = {team: 'outlaw', desc: 'Outlaws win!'};
      }
      this.state.phase = 'gameOver';
      this.addLog(this.state.winner.desc);
      return;
    }

    // All outlaws and renegades dead?
    const threatsAlive = aliveRoles.some(r => r === 'outlaw' || r === 'renegade');
    if (!threatsAlive) {
      this.state.winner = {team: 'sheriff', desc: 'Sheriff and Deputies win!'};
      this.state.phase = 'gameOver';
      this.addLog(this.state.winner.desc);
      return;
    }
  }

  // ─── CHARACTER HELPERS ────────────────────────────────
  getEffectiveCharacter(playerIdx) {
    const p = this.state.players[playerIdx];
    if (p.character.effect === 'copy_ability' && this.state.veraCusterCopy && playerIdx === this.state.currentTurn) {
      return this.state.veraCusterCopy;
    }
    return p.character;
  }

  triggerMollyStark(playerIdx) {
    if (playerIdx === this.state.currentTurn) return; // Only triggers out of turn
    if (this.getEffectiveCharacter(playerIdx).effect === 'draw_on_react') {
      const player = this.state.players[playerIdx];
      player.hand.push(...this.drawFromDeck(1));
      this.addLog(player.name + ' draws a card (Molly Stark).');
    }
  }

  checkSuzyLafayette(playerIdx) {
    const player = this.state.players[playerIdx];
    if (player.hand.length === 0 && !player.eliminated && 
        this.getEffectiveCharacter(playerIdx).effect === 'draw_on_empty') {
      player.hand.push(...this.drawFromDeck(1));
      this.addLog(player.name + ' draws a card (hand empty — Suzy Lafayette).');
    }
  }

  // ─── PLAYER VIEW ──────────────────────────────────────
  getPlayerView(playerIdx) {
    const s = this.state;
    const me = s.players[playerIdx];
    
    // Determine if this player can play unlimited BANGs (Volcanic or Willy the Kid)
    const eff = this.getEffectiveCharacter(playerIdx);
    const hasVolcanic = me.inPlay.some(c => c.name === 'Volcanic');
    const canUnlimitedBangs = hasVolcanic || eff.effect === 'unlimited_bangs';

    // Get weapon name for each player
    const getWeaponName = (p) => {
      const w = p.inPlay.find(c => D.isWeapon(c));
      return w ? w.name : 'Colt .45';
    };

    return {
      yourIndex: playerIdx,
      hand: me.hand.map(c => ({...c})),
      role: me.role,
      character: {...me.character},
      hp: me.hp,
      maxHp: me.maxHp,
      myInPlay: me.inPlay.map(c => ({...c})),
      players: s.players.map((p, i) => ({
        name: p.name,
        character: p.character.name,
        characterAbility: p.character.ability,
        characterEffect: p.character.effect,
        hp: p.hp,
        maxHp: p.maxHp,
        inPlay: p.inPlay.map(c => ({...c})),
        handSize: p.hand.length,
        eliminated: p.eliminated,
        isSheriff: p.role === 'sheriff',
        role: (p.role === 'sheriff' || p.eliminated || s.phase === 'gameOver') ? p.role : null,
        roleRevealed: p.role === 'sheriff' || p.eliminated || s.phase === 'gameOver',
        isCurrentTurn: i === s.currentTurn,
        weapon: getWeaponName(p),
      })),
      currentTurn: s.currentTurn,
      turnPhase: s.turnPhase,
      deckSize: s.deck.length,
      discardTop: s.discard.length > 0 ? {...s.discard[s.discard.length - 1]} : null,
      bangPlayedThisTurn: s.bangsPlayedThisTurn > 0,
      canPlayUnlimitedBangs: canUnlimitedBangs,
      prompt: this.getPendingForPlayer(playerIdx),
      log: s.log.slice(-20),
      winner: s.winner ? s.winner.desc : null,
      winnerTeam: s.winner ? s.winner.team : null,
      phase: s.phase,
      alivePlayers: this.getAliveCount(),
    };
  }

  getPendingForPlayer(playerIdx) {
    const p = this.state.pending;
    if (!p) return null;
    
    switch(p.type) {
      case 'bang_response':
        return p.targetIdx === playerIdx ? {
          type: 'bang_response',
          source: p.sourceIdx,
          sourceName: this.state.players[p.sourceIdx].name,
          missedNeeded: p.missedNeeded,
          missedPlayed: p.missedPlayed,
        } : {type: 'waiting', msg: 'Waiting for ' + this.state.players[p.targetIdx].name + ' to respond...'};

      case 'indians_response':
        return p.respondents[p.currentIdx] === playerIdx ? {
          type: 'indians_response',
          source: p.sourceIdx,
          sourceName: this.state.players[p.sourceIdx].name,
        } : {type: 'waiting', msg: 'Waiting for ' + this.state.players[p.respondents[p.currentIdx]].name + ' to respond to Indians!...'};

      case 'gatling_response':
        return p.respondents[p.currentIdx] === playerIdx ? {
          type: 'gatling_response',
          source: p.sourceIdx,
          sourceName: this.state.players[p.sourceIdx].name,
        } : {type: 'waiting', msg: 'Waiting for ' + this.state.players[p.respondents[p.currentIdx]].name + ' to respond to Gatling...'};

      case 'duel_response': {
        const oppIdx = p.currentResponder === p.sourceIdx ? p.targetIdx : p.sourceIdx;
        return p.currentResponder === playerIdx ? {
          type: 'duel_response',
          opponent: oppIdx,
          opponentName: this.state.players[oppIdx].name,
        } : {type: 'waiting', msg: 'Duel in progress...'};
      }
      
      case 'general_store':
        return p.pickOrder[p.currentIdx] === playerIdx ? {
          type: 'general_store',
          cards: p.cards.filter(c => c !== null),
        } : {type: 'waiting', msg: 'Waiting for ' + this.state.players[p.pickOrder[p.currentIdx]].name + ' to pick from General Store...'};
      
      case 'discard_required':
        return p.playerIdx === playerIdx ? {
          type: 'discard_required',
          count: p.count,
        } : {type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is discarding...'};
      
      case 'beer_save':
        return p.playerIdx === playerIdx ? {
          type: 'beer_save',
          hpNeeded: 1 - this.state.players[playerIdx].hp,
        } : {type: 'waiting', msg: this.state.players[p.playerIdx].name + ' might survive...'};
      
      case 'choose_target':
        return p.playerIdx === playerIdx ? {
          type: 'choose_target',
          cardName: p.cardName,
          validTargets: p.validTargets,
        } : {type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing a target...'};
      
      case 'choose_card_from_target':
        return p.playerIdx === playerIdx ? {
          type: 'choose_card_from_target',
          targetIdx: p.targetIdx,
          targetName: this.state.players[p.targetIdx].name,
          inPlayCards: this.state.players[p.targetIdx].inPlay.map(c => ({...c})),
          targetHandSize: this.state.players[p.targetIdx].hand.length,
          cardName: p.cardName,
        } : {type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing a card...'};

      case 'draw_choice':
        if (p.playerIdx !== playerIdx) return {type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing draw source...'};
        if (p.choiceType === 'jesse_jones') {
          const targetNames = p.validTargets.map(i => ({label: 'Steal from ' + this.state.players[i].name, targetIdx: i}));
          return {type: 'draw_choice', message: 'Jesse Jones: Draw first card from a player or the deck?',
            options: [{label: 'Draw from deck'}, ...targetNames]};
        } else if (p.choiceType === 'pedro_ramirez') {
          const topCard = this.state.discard.length > 0 ? this.state.discard[this.state.discard.length-1] : null;
          return {type: 'draw_choice', message: 'Pedro Ramirez: Draw first card from discard' + (topCard ? ' (' + D.cardStr(topCard) + ')' : '') + ' or deck?',
            options: [{label: 'Draw from deck'}, {label: 'Draw from discard'}]};
        } else if (p.choiceType === 'pat_brennan') {
          const targetNames = p.validTargets.map(t => ({label: 'Take ' + t.cardName + ' from ' + this.state.players[t.playerIdx].name, ...t}));
          return {type: 'draw_choice', message: 'Pat Brennan: Draw from deck or take an in-play card?',
            options: [{label: 'Draw from deck'}, ...targetNames]};
        }
        return {type: 'draw_choice', message: 'Choose your draw:', options: [{label: 'Draw from deck'}]};
      
      case 'kit_carlson':
        return p.playerIdx === playerIdx ? {
          type: 'kit_carlson',
          cards: p.cards.filter(c => c !== null),
          pickedCount: p.picked.length,
        } : {type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing cards (Kit Carlson)...'};
      
      case 'lucky_duke':
        return p.playerIdx === playerIdx ? {
          type: 'lucky_duke',
          cards: p.cards,
          reason: p.reason,
        } : {type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing (Lucky Duke)...'};
      
      case 'vera_custer':
        return p.playerIdx === playerIdx ? {
          type: 'vera_custer',
          characters: p.validTargets.map(i => ({
            idx: i,
            name: this.state.players[i].character.name,
            ability: this.state.players[i].character.ability,
          })),
        } : {type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing a character to copy...'};
      
      case 'springfield_discard':
      case 'brawl_discard':
      case 'whisky_discard':
      case 'tequila_discard':
        return p.playerIdx === playerIdx ? {
          type: 'discard_for_card',
          message: 'Discard a card to play ' + p.type.replace('_discard', '') + '.',
          cardName: p.type.replace('_discard', ''),
          playCardId: p.playCardId,
          excludeCardId: p.playCardId,
          targetIdx: p.targetIdx,
        } : {type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is discarding...'};
      
      case 'brawl_response': {
        if (p.respondents[p.currentIdx] !== playerIdx) {
          return {type: 'waiting', msg: 'Waiting for ' + this.state.players[p.respondents[p.currentIdx]].name + ' to respond to Brawl...'};
        }
        const respPlayer = this.state.players[playerIdx];
        const inPlayChoices = respPlayer.inPlay.map(c => ({id: c.id, name: c.name}));
        return {
          type: 'brawl_response',
          source: p.sourceIdx,
          sourceName: this.state.players[p.sourceIdx].name,
          inPlayCards: inPlayChoices,
          hasHand: respPlayer.hand.length > 0,
        };
      }
      
      default:
        return null;
    }
  }

  // ─── HELPERS ──────────────────────────────────────────
  addLog(msg) {
    this.state.log.push({msg, time: Date.now()});
    if (this.state.log.length > 100) this.state.log.shift();
  }

  getAliveCount() {
    return this.state.players.filter(p => !p.eliminated).length;
  }

  getAlivePlayers() {
    return this.state.players.map((p, i) => p.eliminated ? -1 : i).filter(i => i >= 0);
  }

  getNextAlive(fromIdx) {
    const n = this.state.players.length;
    let i = (fromIdx + 1) % n;
    let safety = 0;
    while (this.state.players[i].eliminated && safety++ < n) {
      i = (i + 1) % n;
    }
    return i;
  }

  hasInPlay(playerIdx, cardName) {
    return this.state.players[playerIdx].inPlay.some(c => c.name === cardName);
  }

  removeFromInPlay(playerIdx, cardId) {
    const p = this.state.players[playerIdx];
    const idx = p.inPlay.findIndex(c => c.id === cardId);
    if (idx >= 0) return p.inPlay.splice(idx, 1)[0];
    return null;
  }
}

exports.BangEngine = BangEngine;
})(window);
