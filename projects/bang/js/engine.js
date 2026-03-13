// Bang! The Bullet — Game Engine
// Main class that composes all mixins
(function(exports) {
'use strict';

const D = window.BangData;

class BangEngine {
  constructor() {
    this.state = null;

    // Apply all mixins
    window.BangDeckMixin.apply(this);
    window.BangDistanceMixin.apply(this);
    window.BangTurnsMixin.apply(this);
    window.BangCardsMixin.apply(this);
    window.BangResponsesMixin.apply(this);
    window.BangChoicesMixin.apply(this);
    window.BangAbilitiesMixin.apply(this);
    window.BangDamageMixin.apply(this);
    window.BangViewsMixin.apply(this);
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
    roles = roles.filter(r => r !== 'sheriff');
    roles = D.shuffle(roles);
    roles.unshift('sheriff');

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
        character: { ...char },
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
      currentTurn: 0,
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

    // Deal starting hands
    for (let i = 0; i < n; i++) {
      const p = this.state.players[i];
      const cards = this.drawFromDeck(p.hp);
      p.hand.push(...cards);
    }

    this.addLog('Game started with ' + n + ' players!');
    this.addLog(players[0].name + ' is the Sheriff!');

    this.startTurn();
    return this.state;
  }

  // ─── ACTION DISPATCH ────────────────────────────────────
  handleAction(playerIdx, action) {
    if (this.state.winner) throw new Error('Game is over');

    const act = action.action || action.type;

    switch (act) {
      case 'play_card':
        this.playCard(playerIdx, action.cardId, action.targetIdx);
        break;
      case 'end_turn':
        this.endTurn(playerIdx);
        break;
      case 'respond':
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
        if (action.cardIds && action.cardIds.length > 0) {
          for (const cid of action.cardIds) {
            this.handlePick(playerIdx, cid);
          }
        }
        break;
      case 'choose':
        this.handleChoose(playerIdx, action.choice !== undefined ? action.choice : action.choiceIdx);
        break;
      case 'choose_target':
        this.handleChooseTarget(playerIdx, action.targetIdx);
        break;
      case 'choose_card':
      case 'choose_card_from_target':
        this.handleChooseCardFromTarget(playerIdx, { choice: action.cardId || action.choice || 'hand' });
        break;
      case 'use_ability':
        this.useAbility(playerIdx, action.ability || action.abilityType, action.data || action);
        break;
      case 'play_with_discard':
        this.playCard(playerIdx, action.cardId, action.targetIdx);
        if (this.state.pending && this.state.pending.type && this.state.pending.type.endsWith('_discard') && action.discardId) {
          this.handleChoose(playerIdx, action.discardId);
        }
        break;
      default:
        throw new Error('Unknown action: ' + act);
    }
  }

  // ─── HELPERS ──────────────────────────────────────────
  addLog(msg) {
    this.state.log.push({ msg, time: Date.now() });
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
