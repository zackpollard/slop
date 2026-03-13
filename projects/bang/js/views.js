// Bang! The Bullet — Player View Generation
// Builds the personalized game state sent to each player
(function(exports) {
'use strict';

const D = window.BangData;

const ViewsMixin = {
  apply(engine) {
    Object.assign(engine, ViewsMixin.methods);
  },

  methods: {
    getPlayerView(playerIdx) {
      const s = this.state;
      const me = s.players[playerIdx];

      const eff = this.getEffectiveCharacter(playerIdx);
      const hasVolcanic = me.inPlay.some(c => c.name === 'Volcanic');
      const canUnlimitedBangs = hasVolcanic || eff.effect === 'unlimited_bangs';

      const getWeaponName = (p) => {
        const w = p.inPlay.find(c => D.isWeapon(c));
        return w ? w.name : 'Colt .45';
      };

      return {
        yourIndex: playerIdx,
        hand: me.hand.map(c => ({ ...c })),
        role: me.role,
        character: { ...me.character },
        hp: me.hp,
        maxHp: me.maxHp,
        myInPlay: me.inPlay.map(c => ({ ...c })),
        players: s.players.map((p, i) => ({
          name: p.name,
          character: p.character.name,
          characterAbility: p.character.ability,
          characterEffect: p.character.effect,
          hp: p.hp,
          maxHp: p.maxHp,
          inPlay: p.inPlay.map(c => ({ ...c })),
          handSize: p.hand.length,
          eliminated: p.eliminated,
          isSheriff: p.role === 'sheriff',
          role: (p.role === 'sheriff' || p.eliminated || s.phase === 'gameOver') ? p.role : (i === playerIdx ? p.role : null),
          roleRevealed: p.role === 'sheriff' || p.eliminated || s.phase === 'gameOver',
          isCurrentTurn: i === s.currentTurn,
          weapon: getWeaponName(p),
        })),
        currentTurn: s.currentTurn,
        turnPhase: s.turnPhase,
        deckSize: s.deck.length,
        discardTop: s.discard.length > 0 ? { ...s.discard[s.discard.length - 1] } : null,
        bangPlayedThisTurn: s.bangsPlayedThisTurn > 0,
        canPlayUnlimitedBangs: canUnlimitedBangs,
        prompt: this.getPendingForPlayer(playerIdx),
        log: s.log.slice(-20),
        winner: s.winner ? s.winner.desc : null,
        winnerTeam: s.winner ? s.winner.team : null,
        phase: s.phase,
        alivePlayers: this.getAliveCount(),
      };
    },

    getPendingForPlayer(playerIdx) {
      const p = this.state.pending;
      if (!p) return null;

      switch (p.type) {
        case 'bang_response':
          return p.targetIdx === playerIdx ? {
            type: 'bang_response',
            source: p.sourceIdx,
            sourceName: this.state.players[p.sourceIdx].name,
            missedNeeded: p.missedNeeded,
            missedPlayed: p.missedPlayed,
          } : { type: 'waiting', msg: 'Waiting for ' + this.state.players[p.targetIdx].name + ' to respond...' };

        case 'indians_response':
          return p.respondents[p.currentIdx] === playerIdx ? {
            type: 'indians_response',
            source: p.sourceIdx,
            sourceName: this.state.players[p.sourceIdx].name,
          } : { type: 'waiting', msg: 'Waiting for ' + this.state.players[p.respondents[p.currentIdx]].name + ' to respond to Indians!...' };

        case 'gatling_response':
          return p.respondents[p.currentIdx] === playerIdx ? {
            type: 'gatling_response',
            source: p.sourceIdx,
            sourceName: this.state.players[p.sourceIdx].name,
          } : { type: 'waiting', msg: 'Waiting for ' + this.state.players[p.respondents[p.currentIdx]].name + ' to respond to Gatling...' };

        case 'duel_response': {
          const oppIdx = p.currentResponder === p.sourceIdx ? p.targetIdx : p.sourceIdx;
          return p.currentResponder === playerIdx ? {
            type: 'duel_response',
            opponent: oppIdx,
            opponentName: this.state.players[oppIdx].name,
          } : { type: 'waiting', msg: 'Duel in progress...' };
        }

        case 'general_store':
          return p.pickOrder[p.currentIdx] === playerIdx ? {
            type: 'general_store',
            cards: p.cards.filter(c => c !== null),
          } : { type: 'waiting', msg: 'Waiting for ' + this.state.players[p.pickOrder[p.currentIdx]].name + ' to pick from General Store...' };

        case 'discard_required':
          return p.playerIdx === playerIdx ? {
            type: 'discard_required',
            count: p.count,
          } : { type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is discarding...' };

        case 'beer_save':
          return p.playerIdx === playerIdx ? {
            type: 'beer_save',
            hpNeeded: 1 - this.state.players[playerIdx].hp,
          } : { type: 'waiting', msg: this.state.players[p.playerIdx].name + ' might survive...' };

        case 'choose_target':
          return p.playerIdx === playerIdx ? {
            type: 'choose_target',
            cardName: p.cardName,
            validTargets: p.validTargets,
          } : { type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing a target...' };

        case 'choose_card_from_target':
          return p.playerIdx === playerIdx ? {
            type: 'choose_card_from_target',
            targetIdx: p.targetIdx,
            targetName: this.state.players[p.targetIdx].name,
            inPlayCards: this.state.players[p.targetIdx].inPlay.map(c => ({ ...c })),
            targetHandSize: this.state.players[p.targetIdx].hand.length,
            cardName: p.cardName,
          } : { type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing a card...' };

        case 'draw_choice':
          if (p.playerIdx !== playerIdx) return { type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing draw source...' };
          if (p.choiceType === 'jesse_jones') {
            const targetNames = p.validTargets.map(i => ({ label: 'Steal from ' + this.state.players[i].name, targetIdx: i }));
            return {
              type: 'draw_choice', message: 'Jesse Jones: Draw first card from a player or the deck?',
              options: [{ label: 'Draw from deck' }, ...targetNames],
            };
          } else if (p.choiceType === 'pedro_ramirez') {
            const topCard = this.state.discard.length > 0 ? this.state.discard[this.state.discard.length - 1] : null;
            return {
              type: 'draw_choice', message: 'Pedro Ramirez: Draw first card from discard' + (topCard ? ' (' + D.cardStr(topCard) + ')' : '') + ' or deck?',
              options: [{ label: 'Draw from deck' }, { label: 'Draw from discard' }],
            };
          } else if (p.choiceType === 'pat_brennan') {
            const targetNames = p.validTargets.map(t => ({ label: 'Take ' + t.cardName + ' from ' + this.state.players[t.playerIdx].name, ...t }));
            return {
              type: 'draw_choice', message: 'Pat Brennan: Draw from deck or take an in-play card?',
              options: [{ label: 'Draw from deck' }, ...targetNames],
            };
          }
          return { type: 'draw_choice', message: 'Choose your draw:', options: [{ label: 'Draw from deck' }] };

        case 'kit_carlson':
          return p.playerIdx === playerIdx ? {
            type: 'kit_carlson',
            cards: p.cards.filter(c => c !== null),
            pickedCount: p.picked.length,
          } : { type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing cards (Kit Carlson)...' };

        case 'lucky_duke':
          return p.playerIdx === playerIdx ? {
            type: 'lucky_duke',
            cards: p.cards,
            reason: p.reason,
          } : { type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing (Lucky Duke)...' };

        case 'vera_custer':
          return p.playerIdx === playerIdx ? {
            type: 'vera_custer',
            characters: p.validTargets.map(i => ({
              idx: i,
              name: this.state.players[i].character.name,
              ability: this.state.players[i].character.ability,
            })),
          } : { type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is choosing a character to copy...' };

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
          } : { type: 'waiting', msg: this.state.players[p.playerIdx].name + ' is discarding...' };

        case 'brawl_response': {
          if (p.respondents[p.currentIdx] !== playerIdx) {
            return { type: 'waiting', msg: 'Waiting for ' + this.state.players[p.respondents[p.currentIdx]].name + ' to respond to Brawl...' };
          }
          const respPlayer = this.state.players[playerIdx];
          return {
            type: 'brawl_response',
            source: p.sourceIdx,
            sourceName: this.state.players[p.sourceIdx].name,
            inPlayCards: respPlayer.inPlay.map(c => ({ id: c.id, name: c.name })),
            hasHand: respPlayer.hand.length > 0,
          };
        }

        default:
          return null;
      }
    },
  },
};

exports.BangViewsMixin = ViewsMixin;
})(window);
