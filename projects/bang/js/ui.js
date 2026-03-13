// Bang! The Bullet — UI Rendering & Interaction
// Bridge between BangEngine and the HTML page
(function(exports) {
'use strict';

const { $, esc, toast, showScreen } = SlopLobby;
const Data = window.BangData;

// ─── Card type background colors ────────────────────────
const CARD_BG = {
  brown: '#6b4226',
  blue:  '#3a6b8c',
  green: '#3a6b3a',
};

const CARD_BG_HOVER = {
  brown: '#7d4f30',
  blue:  '#4a7d9e',
  green: '#4a7d4a',
};

// ─── Main UI module ─────────────────────────────────────
const UI = {
  engine: null,
  lobby: null,
  state: {
    selectedCard: null,
    selectedTargets: [],
    discardSelection: [],
    pickSelection: [],
    pendingAction: null,
    abilityMode: null,
  },
  myIdx: -1,
  isHost: false,
  gameView: null,

  // ──────────────────────────────────────────────────────
  // Initialization
  // ──────────────────────────────────────────────────────
  init(lobby) {
    this.lobby = lobby;
    this._resetState();
  },

  _resetState() {
    this.state = {
      selectedCard: null,
      selectedTargets: [],
      discardSelection: [],
      pickSelection: [],
      pendingAction: null,
      abilityMode: null,
    };
    this.myIdx = -1;
    this.gameView = null;
  },

  // ──────────────────────────────────────────────────────
  // Screen: Waiting Room
  // ──────────────────────────────────────────────────────
  renderWaiting(players, canStart) {
    const container = $('player-list');
    if (!container) return;

    let html = '';
    players.forEach((p, i) => {
      html += '<span class="player-tag">' + esc(p.name || p);
      if (i === 0) html += ' <small>(Host)</small>';
      html += '</span>';
    });

    container.innerHTML = html;
  },

  // ──────────────────────────────────────────────────────
  // Screen: Main Game
  // ──────────────────────────────────────────────────────
  renderGame(view) {
    if (!view) return;
    this.gameView = view;
    this.myIdx = view.yourIndex !== undefined ? view.yourIndex : this.myIdx;

    this.renderOpponents(view);
    this.renderGameInfo(view);
    this.renderActionPanel(view);
    this.renderYourArea(view);
    if (view.log) this.renderLog(view.log);
  },

  // ──────────────────────────────────────────────────────
  // Opponents row
  // ──────────────────────────────────────────────────────
  renderOpponents(view) {
    const container = $('opponents');
    if (!container) return;

    const prompt = view.prompt || null;
    const needsTarget = prompt && prompt.type === 'choose_target';
    const validTargets = (needsTarget && prompt.validTargets) ? prompt.validTargets : [];

    let html = '';
    view.players.forEach((p, i) => {
      if (i === this.myIdx) return;

      const eliminated = p.eliminated;
      const isCurrentTurn = i === view.currentTurn;
      const isTarget = !eliminated && validTargets.includes(i);

      const classes = [
        'opponent',
        eliminated ? 'eliminated' : '',
        isCurrentTurn ? 'active-turn' : '',
        isTarget ? 'valid-target' : '',
      ].filter(Boolean).join(' ');

      html += '<div class="' + classes + '"'
        + (isTarget ? ' onclick="BangUI.onTargetClick(' + i + ')" style="cursor:pointer;"' : '')
        + ' data-player-idx="' + i + '">';

      // Header
      html += '<div class="opp-header">';
      html += '<span class="opp-name">' + esc(p.name) + '</span>';
      if (p.role === 'sheriff' || p.isSheriff) {
        html += '<span class="sheriff-badge" title="Sheriff">\u2605</span>';
      }
      if (p.roleRevealed && p.role) {
        html += '<span class="role-tag role-' + esc(p.role) + '">' + esc(p.role) + '</span>';
      }
      html += '</div>';

      // Character
      if (p.character) {
        html += '<div class="opp-character">' + esc(p.character) + '</div>';
      }

      // HP
      if (!eliminated) {
        html += '<div class="opp-hp">';
        const maxHp = p.maxHp || p.hp || 0;
        const curHp = p.hp || 0;
        for (let h = 0; h < maxHp; h++) {
          html += h < curHp
            ? '<span class="hp-heart full">\u2764</span>'
            : '<span class="hp-heart empty">\u2661</span>';
        }
        html += '</div>';
      } else {
        html += '<div class="opp-hp eliminated-icon">\uD83D\uDC80</div>';
      }

      // Cards info
      html += '<div class="opp-cards">';
      html += '<span class="hand-count">\uD83C\uDCCF ' + (p.handSize != null ? p.handSize : '?') + '</span>';
      if (p.inPlay && p.inPlay.length > 0) {
        p.inPlay.forEach(card => {
          const typeClass = card.type || 'blue';
          html += '<span class="inplay-tag ' + typeClass + '"'
            + (isTarget ? ' onclick="event.stopPropagation(); BangUI.onChooseInPlayCard(' + i + ',\'' + esc(card.id) + '\')" style="cursor:pointer;"' : '')
            + '>' + esc(card.name) + '</span>';
        });
      }
      if (p.weapon && p.weapon !== 'Colt .45') {
        html += '<span class="inplay-tag weapon">' + esc(p.weapon) + '</span>';
      }
      html += '</div>';

      html += '</div>';
    });

    container.innerHTML = html;
  },

  // ──────────────────────────────────────────────────────
  // Your area (bottom)
  // ──────────────────────────────────────────────────────
  renderYourArea(view) {
    const container = $('your-area');
    if (!container) return;

    const me = view.players[this.myIdx];
    if (!me) return;

    let html = '';

    // Character & role info
    html += '<div class="your-info">';
    html += '<div class="your-identity">';
    if (me.character) {
      html += '<span class="your-character">' + esc(me.character) + '</span>';
    }
    if (me.role) {
      html += '<span class="role-tag role-' + esc(me.role) + '">' + esc(me.role) + '</span>';
    }
    if (me.role === 'sheriff' || me.isSheriff) {
      html += '<span class="sheriff-badge">\u2605</span>';
    }
    html += '</div>';

    // HP
    html += '<div class="your-hp">';
    const maxHp = me.maxHp || me.hp || 0;
    const curHp = me.hp || 0;
    for (let h = 0; h < maxHp; h++) {
      html += h < curHp
        ? '<span class="hp-heart full">\u2764</span>'
        : '<span class="hp-heart empty">\u2661</span>';
    }
    html += ' <span class="hp-text">' + curHp + '/' + maxHp + '</span>';
    html += '</div>';

    // Character ability
    if (me.characterAbility) {
      html += '<div class="your-ability">' + esc(me.characterAbility) + '</div>';
    }
    html += '</div>';

    // In-play cards
    if (me.inPlay && me.inPlay.length > 0) {
      html += '<div class="your-inplay">';
      html += '<div class="inplay-label">In Play:</div>';
      html += '<div class="inplay-cards">';
      me.inPlay.forEach(card => {
        html += this.renderCard(card, { small: true, clickable: false });
      });
      html += '</div></div>';
    }

    // Hand
    html += '<div class="your-hand" id="hand-container">';
    if (view.hand) {
      html += this.renderHand(view.hand, view);
    }
    html += '</div>';

    container.innerHTML = html;
  },

  // ──────────────────────────────────────────────────────
  // Hand rendering
  // ──────────────────────────────────────────────────────
  renderHand(hand, view) {
    if (!hand || hand.length === 0) {
      return '<div class="hand-empty">No cards in hand</div>';
    }

    const prompt = view.prompt || null;
    const isMyTurn = view.currentTurn === this.myIdx;
    const phase = view.phase || '';
    const discardMode = prompt && prompt.type === 'discard_required';
    const pickMode = prompt && (prompt.type === 'kit_carlson' || prompt.type === 'lucky_duke');

    let html = '';
    hand.forEach(card => {
      const playable = this._isCardPlayable(card, view);
      const selected = this.state.selectedCard === card.id;
      const discardSelected = discardMode && this.state.discardSelection.includes(card.id);
      const pickSelected = pickMode && this.state.pickSelection.includes(card.id);
      const highlighted = this._isCardHighlighted(card, view);

      const opts = {
        clickable: playable || discardMode || highlighted || pickMode,
        selected: selected || discardSelected || pickSelected,
        playable: playable || highlighted,
        dimmed: !playable && !discardMode && !highlighted && !pickMode && isMyTurn && !prompt,
      };

      let onclick = '';
      if (discardMode) {
        onclick = 'BangUI.onDiscardToggle(\'' + esc(card.id) + '\')';
      } else if (pickMode) {
        onclick = 'BangUI.onPickCard(\'' + esc(card.id) + '\')';
      } else if (playable || highlighted) {
        onclick = 'BangUI.onCardClick(\'' + esc(card.id) + '\')';
      }

      html += this.renderCard(card, { ...opts, onClick: onclick });
    });

    return html;
  },

  // ──────────────────────────────────────────────────────
  // Card rendering
  // ──────────────────────────────────────────────────────
  renderCard(card, options) {
    options = options || {};
    if (options.faceDown) return this.renderCardBack(options.small);

    const type = card.type || 'brown';
    const suitSymbol = Data.SUIT_SYMBOLS[card.suit] || '';
    const valueName = Data.VALUE_NAMES[card.value] || '';
    const suitColor = (card.suit === 'H' || card.suit === 'D') ? 'red' : 'light';

    const classes = [
      'game-card',
      type,
      options.small ? 'card-sm' : '',
      options.playable ? 'playable' : '',
      options.selected ? 'selected' : '',
      options.clickable ? 'clickable' : '',
      options.dimmed ? 'dimmed' : '',
    ].filter(Boolean).join(' ');

    const info = Data.CARD_INFO[card.name];
    const tooltipText = info ? esc(card.name + ': ' + info.desc) : esc(card.name);

    let html = '<div class="' + classes + '" data-card-id="' + esc(card.id) + '"'
      + ' title="' + tooltipText + '"';
    if (options.onClick) {
      html += ' onclick="' + options.onClick + '"';
      html += ' style="cursor:pointer;"';
    }
    html += '>';
    html += '<div class="card-suit ' + suitColor + '">' + suitSymbol + valueName + '</div>';
    html += '<div class="card-name">' + esc(card.name) + '</div>';
    html += '</div>';

    return html;
  },

  renderCardBack(small) {
    const cls = 'game-card card-back' + (small ? ' card-sm' : '');
    return '<div class="' + cls + '"><div class="card-back-design">?</div></div>';
  },

  // ──────────────────────────────────────────────────────
  // Game info panel (middle)
  // ──────────────────────────────────────────────────────
  renderGameInfo(view) {
    const container = $('game-info');
    if (!container) return;

    const currentName = view.players[view.currentTurn]
      ? view.players[view.currentTurn].name : '?';

    let html = '<div class="info-row">';
    html += '<div class="info-item turn-indicator">';
    html += '<span class="info-label">Turn:</span> ';
    html += '<span class="info-value">' + esc(currentName) + '</span>';
    html += '</div>';

    html += '<div class="info-item">';
    html += '<span class="info-label">Deck:</span> ';
    html += '<span class="info-value">' + (view.deckSize != null ? view.deckSize : '?') + '</span>';
    html += '</div>';

    html += '<div class="info-item">';
    html += '<span class="info-label">Discard:</span> ';
    if (view.discardTop) {
      html += '<span class="info-value discard-top">' + esc(Data.cardStr(view.discardTop)) + '</span>';
    } else {
      html += '<span class="info-value empty">empty</span>';
    }
    html += '</div>';

    if (view.phase) {
      html += '<div class="info-item">';
      html += '<span class="info-label">Phase:</span> ';
      html += '<span class="info-value">' + esc(view.phase) + '</span>';
      html += '</div>';
    }

    html += '</div>';
    container.innerHTML = html;
  },

  // ──────────────────────────────────────────────────────
  // Action panel (context-sensitive)
  // ──────────────────────────────────────────────────────
  renderActionPanel(view) {
    const container = $('action-panel');
    if (!container) return;

    const prompt = view.prompt || null;
    const isMyTurn = view.currentTurn === this.myIdx;
    const me = view.players[this.myIdx];
    let html = '';

    // If there's a prompt directed at us
    if (prompt) {
      html = this._renderPrompt(prompt, view);
    } else if (isMyTurn) {
      // Our turn, play phase, no prompt
      html += '<div class="action-msg">Your turn! Play a card or end turn.</div>';
      html += '<div class="action-buttons">';
      html += '<button class="btn btn-primary" onclick="BangUI.onEndTurn()">End Turn</button>';

      // Character abilities
      if (me && me.characterEffect) {
        html += this._renderAbilityButtons(me, view);
      }
      html += '</div>';

      // Show pending action info
      if (this.state.selectedCard) {
        const card = (view.hand || []).find(c => c.id === this.state.selectedCard);
        if (card) {
          html += '<div class="action-msg action-sub">Selected: <strong>'
            + esc(card.name) + '</strong> — choose a target or click again to cancel.</div>';
        }
      }
    } else {
      // Not our turn, no prompt
      const currentName = view.players[view.currentTurn]
        ? view.players[view.currentTurn].name : 'another player';
      html += '<div class="action-msg waiting">Waiting for ' + esc(currentName) + '...</div>';
    }

    container.innerHTML = html;
  },

  _renderPrompt(prompt, view) {
    let html = '';

    switch (prompt.type) {
      case 'bang_response': {
        const src = prompt.source != null ? esc(view.players[prompt.source].name) : 'Someone';
        html += '<div class="action-msg danger">' + src + ' shot you with BANG!! Play Missed! or take the hit.</div>';
        html += '<div class="action-buttons">';
        html += '<button class="btn btn-danger" onclick="BangUI.onResponseClick(\'take_hit\')">Take the Hit</button>';
        html += '</div>';
        break;
      }

      case 'indians_response': {
        html += '<div class="action-msg danger">Indians! Play a BANG! or take damage.</div>';
        html += '<div class="action-buttons">';
        html += '<button class="btn btn-danger" onclick="BangUI.onResponseClick(\'take_hit\')">Take the Hit</button>';
        html += '</div>';
        break;
      }

      case 'gatling_response': {
        html += '<div class="action-msg danger">Gatling! Play Missed! or take the hit.</div>';
        html += '<div class="action-buttons">';
        html += '<button class="btn btn-danger" onclick="BangUI.onResponseClick(\'take_hit\')">Take the Hit</button>';
        html += '</div>';
        break;
      }

      case 'duel_response': {
        const opp = prompt.opponent != null ? esc(view.players[prompt.opponent].name) : 'Opponent';
        html += '<div class="action-msg danger">Duel with ' + opp + '! Play BANG! or give up.</div>';
        html += '<div class="action-buttons">';
        html += '<button class="btn btn-danger" onclick="BangUI.onResponseClick(\'give_up\')">Give Up</button>';
        html += '</div>';
        break;
      }

      case 'general_store': {
        html += '<div class="action-msg">General Store: Pick a card!</div>';
        html += '<div class="general-store-cards">';
        if (prompt.cards) {
          prompt.cards.forEach(card => {
            html += this.renderCard(card, {
              clickable: true,
              onClick: 'BangUI.onPickCard(\'' + esc(card.id) + '\')',
            });
          });
        }
        html += '</div>';
        break;
      }

      case 'discard_required': {
        const needed = prompt.count || 1;
        const selected = this.state.discardSelection.length;
        html += '<div class="action-msg">Discard ' + needed + ' card(s) to reach hand limit. (' + selected + '/' + needed + ' selected)</div>';
        html += '<div class="action-buttons">';
        html += '<button class="btn btn-primary' + (selected < needed ? ' disabled' : '') + '"'
          + (selected >= needed ? ' onclick="BangUI.onDiscard()"' : ' disabled')
          + '>Confirm Discard</button>';
        html += '</div>';
        break;
      }

      case 'beer_save': {
        const hpNeeded = prompt.hpNeeded || 1;
        html += '<div class="action-msg danger">You\'re dying! Play Beer to survive! (Need ' + hpNeeded + ' more)</div>';
        html += '<div class="action-buttons">';
        html += '<button class="btn btn-danger" onclick="BangUI.onResponseClick(\'accept_death\')">Accept Death</button>';
        html += '</div>';
        break;
      }

      case 'brawl_response': {
        const brawlSrc = prompt.sourceName || 'Someone';
        html += '<div class="action-msg danger">Brawl from ' + esc(brawlSrc) + '! Choose a card to lose:</div>';
        html += '<div class="action-buttons">';
        if (prompt.hasHand) {
          html += '<button class="btn btn-danger" onclick="BangUI.onChoose(null)">Lose random hand card</button>';
        }
        if (prompt.inPlayCards) {
          prompt.inPlayCards.forEach(card => {
            html += '<button class="btn btn-secondary" onclick="BangUI.onChoose(\'' + esc(card.id) + '\')">'
              + 'Discard ' + esc(card.name) + '</button>';
          });
        }
        if (!prompt.hasHand && (!prompt.inPlayCards || prompt.inPlayCards.length === 0)) {
          html += '<button class="btn btn-danger" onclick="BangUI.onChoose(null)">No cards to lose</button>';
        }
        html += '</div>';
        break;
      }

      case 'choose_card_from_target': {
        const targetName = prompt.targetIdx != null ? esc(view.players[prompt.targetIdx].name) : 'target';
        html += '<div class="action-msg">Choose a card from ' + targetName + ':</div>';
        html += '<div class="action-buttons">';
        html += '<button class="btn btn-secondary" onclick="BangUI.onChoose(-1)">Random from hand</button>';
        if (prompt.inPlayCards) {
          prompt.inPlayCards.forEach((card, ci) => {
            html += '<button class="btn btn-secondary" onclick="BangUI.onChoose(' + ci + ')">' + esc(card.name) + '</button>';
          });
        }
        html += '</div>';
        break;
      }

      case 'draw_choice': {
        html += '<div class="action-msg">' + esc(prompt.message || 'Choose your draw:') + '</div>';
        html += '<div class="action-buttons">';
        if (prompt.options) {
          prompt.options.forEach((opt, i) => {
            html += '<button class="btn btn-secondary" onclick="BangUI.onChoose(' + i + ')">' + esc(opt.label || opt) + '</button>';
          });
        }
        html += '</div>';
        break;
      }

      case 'kit_carlson': {
        html += '<div class="action-msg">Pick 2 cards to keep: (' + this.state.pickSelection.length + '/2 selected)</div>';
        html += '<div class="kit-carlson-cards">';
        if (prompt.cards) {
          prompt.cards.forEach(card => {
            const picked = this.state.pickSelection.includes(card.id);
            html += this.renderCard(card, {
              clickable: true,
              selected: picked,
              onClick: 'BangUI.onPickCard(\'' + esc(card.id) + '\')',
            });
          });
        }
        html += '</div>';
        if (this.state.pickSelection.length === 2) {
          html += '<div class="action-buttons">';
          html += '<button class="btn btn-primary" onclick="BangUI.onConfirmPick()">Confirm</button>';
          html += '</div>';
        }
        break;
      }

      case 'lucky_duke': {
        html += '<div class="action-msg">Lucky Duke: Choose a card for the draw! check:</div>';
        html += '<div class="lucky-duke-cards">';
        if (prompt.cards) {
          prompt.cards.forEach(card => {
            html += this.renderCard(card, {
              clickable: true,
              onClick: 'BangUI.onPickCard(\'' + esc(card.id) + '\')',
            });
          });
        }
        html += '</div>';
        break;
      }

      case 'vera_custer': {
        html += '<div class="action-msg">Choose a character to copy this turn:</div>';
        html += '<div class="action-buttons vera-choices">';
        if (prompt.characters) {
          prompt.characters.forEach((ch, i) => {
            html += '<button class="btn btn-secondary" onclick="BangUI.onChoose(' + i + ')">'
              + esc(ch.name) + '<br><small>' + esc(ch.ability || '') + '</small></button>';
          });
        }
        html += '</div>';
        break;
      }

      case 'choose_target': {
        const cardName = prompt.cardName ? esc(prompt.cardName) : 'this card';
        html += '<div class="action-msg">Choose a target for ' + cardName + ':</div>';
        html += '<div class="action-buttons">';
        html += '<button class="btn btn-secondary" onclick="BangUI.cancelSelection()">Cancel</button>';
        html += '</div>';
        break;
      }

      case 'discard_for_ability': {
        const needed = prompt.count || 2;
        const selected = this.state.discardSelection.length;
        html += '<div class="action-msg">' + esc(prompt.message || 'Select ' + needed + ' card(s) to discard.') + ' (' + selected + '/' + needed + ')</div>';
        html += '<div class="action-buttons">';
        html += '<button class="btn btn-primary' + (selected < needed ? ' disabled' : '') + '"'
          + (selected >= needed ? ' onclick="BangUI.onConfirmAbilityDiscard()"' : ' disabled')
          + '>Confirm</button>';
        html += '<button class="btn btn-secondary" onclick="BangUI.cancelSelection()">Cancel</button>';
        html += '</div>';
        break;
      }

      case 'discard_for_card': {
        // Springfield, Whisky, etc. — discard a card then play
        html += '<div class="action-msg">' + esc(prompt.message || 'Discard a card to play ' + (prompt.cardName || 'this card') + '.') + '</div>';
        html += '<div class="action-buttons">';
        html += '<button class="btn btn-secondary" onclick="BangUI.cancelSelection()">Cancel</button>';
        html += '</div>';
        break;
      }

      case 'waiting': {
        html += '<div class="action-msg waiting">' + esc(prompt.msg || 'Waiting...') + '</div>';
        break;
      }

      default: {
        if (prompt.message || prompt.msg) {
          html += '<div class="action-msg">' + esc(prompt.message || prompt.msg) + '</div>';
        }
        if (prompt.options) {
          html += '<div class="action-buttons">';
          prompt.options.forEach((opt, i) => {
            html += '<button class="btn btn-secondary" onclick="BangUI.onChoose(' + i + ')">' + esc(opt.label || opt) + '</button>';
          });
          html += '</div>';
        }
        break;
      }
    }

    return html;
  },

  _renderAbilityButtons(me, view) {
    let html = '';
    const effect = me.characterEffect;

    if (effect === 'discard_to_heal') {
      // Sid Ketchum: discard 2 to heal 1
      html += '<button class="btn btn-accent" onclick="BangUI.onUseAbility(\'discard_to_heal\')">Sid Ketchum: Discard 2 to Heal</button>';
    }
    if (effect === 'hp_for_cards') {
      // Chuck Wengam: lose 1 HP to draw 2
      html += '<button class="btn btn-accent" onclick="BangUI.onUseAbility(\'hp_for_cards\')">Chuck Wengam: Lose 1 HP, Draw 2</button>';
    }
    if (effect === 'discard_to_bang') {
      // Doc Holyday: discard 2 to bang someone
      html += '<button class="btn btn-accent" onclick="BangUI.onUseAbility(\'discard_to_bang\')">Doc Holyday: Discard 2 to BANG!</button>';
    }
    if (effect === 'blue_for_cards') {
      // Jose Delgado: discard blue card to draw 2, twice per turn
      const uses = me.abilityUses != null ? me.abilityUses : 0;
      if (uses < 2) {
        html += '<button class="btn btn-accent" onclick="BangUI.onUseAbility(\'blue_for_cards\')">Jos\u00e9 Delgado: Discard Blue to Draw 2 (' + uses + '/2)</button>';
      }
    }

    return html;
  },

  // ──────────────────────────────────────────────────────
  // Game log
  // ──────────────────────────────────────────────────────
  renderLog(log) {
    const container = $('game-log');
    if (!container) return;

    const entries = Array.isArray(log) ? log : [];
    const recent = entries.slice(-15).reverse();

    let html = '<div class="log-title">Game Log</div>';
    html += '<div class="log-entries">';
    recent.forEach(entry => {
      const text = typeof entry === 'string' ? entry : (entry.text || entry.msg || '');
      html += '<div class="log-entry">' + esc(text) + '</div>';
    });
    if (recent.length === 0) {
      html += '<div class="log-entry muted">No events yet.</div>';
    }
    html += '</div>';

    container.innerHTML = html;
  },

  // ──────────────────────────────────────────────────────
  // Game Over screen
  // ──────────────────────────────────────────────────────
  renderGameOver(view) {
    // Winner text
    const winnerText = $('winner-text');
    if (winnerText && view.winner) {
      winnerText.textContent = view.winner + ' wins!';
    }
    const winnerSub = $('winner-subtitle');
    if (winnerSub && view.winnerTeam) {
      winnerSub.textContent = 'Team: ' + view.winnerTeam;
    }

    // Roles revealed
    const rolesContainer = $('final-roles');
    if (rolesContainer && view.players) {
      let html = '';
      view.players.forEach(p => {
        html += '<div class="final-role-card">';
        html += '<span class="final-name">' + esc(p.name) + '</span>';
        if (p.role) {
          html += '<span class="role-tag role-' + esc(p.role) + '">' + esc(p.role) + '</span>';
        }
        if (p.character) {
          html += '<span class="final-char">' + esc(p.character) + '</span>';
        }
        html += '<span class="final-status">' + (p.eliminated ? 'Eliminated' : 'Survived') + '</span>';
        html += '</div>';
      });
      rolesContainer.innerHTML = html;
    }

    // Show play again button for host
    const playAgainBtn = $('btn-play-again');
    if (playAgainBtn) {
      playAgainBtn.classList.toggle('hidden', !this.isHost);
    }

    showScreen('gameover');
  },

  // ──────────────────────────────────────────────────────
  // Card playability checks
  // ──────────────────────────────────────────────────────
  _isCardPlayable(card, view) {
    if (!view || view.currentTurn !== this.myIdx) return false;
    if (view.prompt) return false; // prompt active, use highlight instead

    const me = view.players[this.myIdx];
    if (!me || me.eliminated) return false;

    const name = card.name;
    const info = Data.CARD_INFO[name];
    if (!info) return false;

    // BANG! limit
    if (name === 'BANG!' && view.bangPlayedThisTurn && !view.canPlayUnlimitedBangs) {
      return false;
    }

    // Beer not usable with 2 players
    if (name === 'Beer' && view.alivePlayers <= 2) {
      return false;
    }

    // Missed! not playable actively
    if (name === 'Missed!') return false;

    // Equipment that duplicates existing one
    if (Data.isEquipment(card) && !Data.isWeapon(card)) {
      if (me.inPlay && me.inPlay.some(c => c.name === card.name)) return false;
    }

    // Jail: can't target sheriff (handled at target selection)
    // All other cards are generally playable during play phase
    return true;
  },

  _isCardHighlighted(card, view) {
    const prompt = view.prompt;
    if (!prompt) return false;

    const name = card.name;
    const me = view.players[this.myIdx];
    const effect = me ? me.characterEffect : '';

    switch (prompt.type) {
      case 'bang_response':
      case 'gatling_response': {
        if (name === 'Missed!') return true;
        // Calamity Janet: BANG! as Missed!
        if (effect === 'bang_missed_swap' && name === 'BANG!') return true;
        // Elena Fuente: any card as Missed!
        if (effect === 'any_as_missed') return true;
        return false;
      }

      case 'indians_response': {
        if (name === 'BANG!') return true;
        if (effect === 'bang_missed_swap' && name === 'Missed!') return true;
        return false;
      }

      case 'duel_response': {
        if (name === 'BANG!') return true;
        if (effect === 'bang_missed_swap' && name === 'Missed!') return true;
        return false;
      }

      case 'beer_save': {
        if (name === 'Beer') return true;
        return false;
      }

      case 'discard_for_card': {
        // Can discard any card except the one being played
        if (prompt.excludeCardId && card.id === prompt.excludeCardId) return false;
        return true;
      }

      default:
        return false;
    }
  },

  // ──────────────────────────────────────────────────────
  // Determine if card needs a target
  // ──────────────────────────────────────────────────────
  _cardNeedsTarget(card) {
    const info = Data.CARD_INFO[card.name];
    if (!info) return false;

    const target = info.target;
    return target === 'enemy_in_range'
      || target === 'enemy_dist1'
      || target === 'any_player'
      || target === 'enemy_not_sheriff';
  },

  _cardNeedsDiscard(card) {
    const name = card.name;
    return name === 'Springfield' || name === 'Whisky' || name === 'Brawl'
      || name === 'Rag Time' || name === 'Tequila';
  },

  // ──────────────────────────────────────────────────────
  // Action handlers
  // ──────────────────────────────────────────────────────
  onCardClick(cardId) {
    const view = this.gameView;
    if (!view) return;

    const prompt = view.prompt;

    // If we're in a response prompt, the card click plays the response
    if (prompt) {
      const card = (view.hand || []).find(c => c.id === cardId);
      if (!card) return;

      if (prompt.type === 'bang_response' || prompt.type === 'gatling_response') {
        this.sendAction({ type: 'respond', response: 'missed', cardId: cardId });
        this._clearSelection();
        return;
      }
      if (prompt.type === 'indians_response') {
        this.sendAction({ type: 'respond', response: 'bang', cardId: cardId });
        this._clearSelection();
        return;
      }
      if (prompt.type === 'duel_response') {
        this.sendAction({ type: 'respond', response: 'bang', cardId: cardId });
        this._clearSelection();
        return;
      }
      if (prompt.type === 'beer_save') {
        this.sendAction({ type: 'respond', response: 'beer', cardId: cardId });
        this._clearSelection();
        return;
      }
      if (prompt.type === 'discard_for_card') {
        // Discard this card for the pending play
        this.sendAction({
          type: 'play_with_discard',
          cardId: prompt.playCardId,
          discardId: cardId,
          targetIdx: prompt.targetIdx,
        });
        this._clearSelection();
        return;
      }
      return;
    }

    // Normal play phase
    if (view.currentTurn !== this.myIdx) return;

    const card = (view.hand || []).find(c => c.id === cardId);
    if (!card) return;

    // If clicking the already selected card, deselect
    if (this.state.selectedCard === cardId) {
      this._clearSelection();
      this.renderGame(view);
      return;
    }

    // Check if card needs extra discard first
    if (this._cardNeedsDiscard(card)) {
      if (this._cardNeedsTarget(card)) {
        // Needs target + discard: select card, show targets, then on target pick ask for discard
        this.state.selectedCard = cardId;
        this.state.pendingAction = 'target_then_discard';
      } else {
        // Self-target + discard (Whisky)
        this.state.selectedCard = null;
        this.state.pendingAction = null;
        // Show discard prompt in action panel via engine
        this.sendAction({ type: 'play_card', cardId: cardId, needsDiscard: true });
      }
      this.renderGame(view);
      return;
    }

    // Check if card needs a target
    if (this._cardNeedsTarget(card)) {
      this.state.selectedCard = cardId;
      this.state.pendingAction = 'choose_target';
      this.renderGame(view);
      return;
    }

    // No target needed — play immediately
    this.sendAction({ type: 'play_card', cardId: cardId });
    this._clearSelection();
  },

  onTargetClick(targetIdx) {
    const view = this.gameView;
    if (!view) return;

    const prompt = view.prompt;

    // If engine prompt is requesting target
    if (prompt && prompt.type === 'choose_target') {
      this.sendAction({ type: 'choose_target', targetIdx: targetIdx });
      this._clearSelection();
      return;
    }

    // If we selected a card that needs a target
    if (this.state.selectedCard) {
      const card = (view.hand || []).find(c => c.id === this.state.selectedCard);
      if (!card) { this._clearSelection(); return; }

      if (this.state.pendingAction === 'target_then_discard') {
        // Send action, engine will prompt for discard
        this.sendAction({
          type: 'play_card',
          cardId: this.state.selectedCard,
          targetIdx: targetIdx,
          needsDiscard: true,
        });
      } else {
        this.sendAction({
          type: 'play_card',
          cardId: this.state.selectedCard,
          targetIdx: targetIdx,
        });
      }
      this._clearSelection();
      return;
    }
  },

  onResponseClick(response) {
    const view = this.gameView;
    if (!view || !view.prompt) return;

    switch (response) {
      case 'take_hit':
        this.sendAction({ type: 'respond', response: 'take_hit' });
        break;
      case 'give_up':
        this.sendAction({ type: 'respond', response: 'give_up' });
        break;
      case 'accept_death':
        this.sendAction({ type: 'respond', response: 'accept_death' });
        break;
      default:
        this.sendAction({ type: 'respond', response: response });
    }
    this._clearSelection();
  },

  onEndTurn() {
    this.sendAction({ type: 'end_turn' });
    this._clearSelection();
  },

  onDiscardToggle(cardId) {
    const idx = this.state.discardSelection.indexOf(cardId);
    if (idx >= 0) {
      this.state.discardSelection.splice(idx, 1);
    } else {
      const prompt = this.gameView && this.gameView.prompt;
      const max = (prompt && prompt.count) || 1;
      if (this.state.discardSelection.length < max) {
        this.state.discardSelection.push(cardId);
      }
    }
    // Re-render to update selection state
    if (this.gameView) this.renderGame(this.gameView);
  },

  onDiscard() {
    if (this.state.discardSelection.length === 0) return;
    this.sendAction({ type: 'discard', cardIds: [...this.state.discardSelection] });
    this.state.discardSelection = [];
  },

  onPickCard(cardId) {
    const view = this.gameView;
    if (!view || !view.prompt) return;

    const prompt = view.prompt;

    if (prompt.type === 'general_store') {
      this.sendAction({ type: 'pick_card', cardId: cardId });
      this._clearSelection();
      return;
    }

    if (prompt.type === 'lucky_duke') {
      this.sendAction({ type: 'pick_card', cardId: cardId });
      this._clearSelection();
      return;
    }

    if (prompt.type === 'kit_carlson') {
      const idx = this.state.pickSelection.indexOf(cardId);
      if (idx >= 0) {
        this.state.pickSelection.splice(idx, 1);
      } else if (this.state.pickSelection.length < 2) {
        this.state.pickSelection.push(cardId);
      }
      this.renderGame(view);
      return;
    }
  },

  onConfirmPick() {
    if (this.state.pickSelection.length !== 2) return;
    this.sendAction({ type: 'pick_cards', cardIds: [...this.state.pickSelection] });
    this.state.pickSelection = [];
  },

  onChoose(choiceIdx) {
    this.sendAction({ type: 'choose', choiceIdx: choiceIdx });
    this._clearSelection();
  },

  onChooseInPlayCard(playerIdx, cardId) {
    const view = this.gameView;
    if (!view || !view.prompt) return;

    if (view.prompt.type === 'choose_card_from_target') {
      this.sendAction({ type: 'choose_card', targetIdx: playerIdx, cardId: cardId });
      this._clearSelection();
    }
  },

  onUseAbility(abilityType, data) {
    const view = this.gameView;
    if (!view) return;

    switch (abilityType) {
      case 'discard_to_heal': {
        // Sid Ketchum: need to select 2 cards to discard
        this.state.abilityMode = 'discard_to_heal';
        this.state.discardSelection = [];
        // Create a local prompt-like state for the action panel
        this.gameView = {
          ...view,
          prompt: {
            type: 'discard_for_ability',
            message: 'Sid Ketchum: Select 2 cards to discard and heal 1 HP.',
            count: 2,
          },
        };
        this.renderGame(this.gameView);
        break;
      }
      case 'hp_for_cards': {
        this.sendAction({ type: 'use_ability', ability: 'hp_for_cards' });
        break;
      }
      case 'discard_to_bang': {
        this.state.abilityMode = 'discard_to_bang';
        this.state.discardSelection = [];
        this.gameView = {
          ...view,
          prompt: {
            type: 'discard_for_ability',
            message: 'Doc Holyday: Select 2 cards to discard for a BANG!',
            count: 2,
          },
        };
        this.renderGame(this.gameView);
        break;
      }
      case 'blue_for_cards': {
        this.state.abilityMode = 'blue_for_cards';
        this.state.discardSelection = [];
        this.gameView = {
          ...view,
          prompt: {
            type: 'discard_for_ability',
            message: 'Jos\u00e9 Delgado: Select a blue card to discard and draw 2.',
            count: 1,
          },
        };
        this.renderGame(this.gameView);
        break;
      }
    }
  },

  onConfirmAbilityDiscard() {
    const ability = this.state.abilityMode;
    if (!ability) return;

    const cardIds = [...this.state.discardSelection];

    if (ability === 'discard_to_bang') {
      // After discarding, need to pick a target
      this.sendAction({
        type: 'use_ability',
        ability: 'discard_to_bang',
        cardIds: cardIds,
      });
    } else {
      this.sendAction({
        type: 'use_ability',
        ability: ability,
        cardIds: cardIds,
      });
    }

    this.state.abilityMode = null;
    this.state.discardSelection = [];
  },

  cancelSelection() {
    this._clearSelection();
    if (this.gameView) {
      // Remove any local prompt overrides
      delete this.gameView._localPrompt;
      this.renderGame(this.gameView);
    }
  },

  _clearSelection() {
    this.state.selectedCard = null;
    this.state.selectedTargets = [];
    this.state.pendingAction = null;
    this.state.abilityMode = null;
    // Don't clear discardSelection or pickSelection here, they have their own flow
  },

  // ──────────────────────────────────────────────────────
  // Send action to host
  // ──────────────────────────────────────────────────────
  sendAction(action) {
    // Route through the global handler which handles host/client routing
    if (window.bangProcessAction) {
      window.bangProcessAction(action);
    }
  },


  // ──────────────────────────────────────────────────────
  // Toast shortcut
  // ──────────────────────────────────────────────────────
  showToast(msg) {
    toast(msg);
  },

  // ──────────────────────────────────────────────────────
  // Utility: flash effect on element
  // ──────────────────────────────────────────────────────
  flashElement(selector, className, duration) {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el) return;
    el.classList.add(className);
    setTimeout(() => el.classList.remove(className), duration || 400);
  },

  // Flash damage on an opponent
  flashDamage(playerIdx) {
    const el = document.querySelector('.opponent[data-player-idx="' + playerIdx + '"]');
    if (el) {
      el.classList.add('damage-flash');
      setTimeout(() => el.classList.remove('damage-flash'), 500);
    }
  },

  // Flash card play highlight
  flashCardPlay(cardId) {
    const el = document.querySelector('.game-card[data-card-id="' + cardId + '"]');
    if (el) {
      el.classList.add('card-played-flash');
      setTimeout(() => el.classList.remove('card-played-flash'), 600);
    }
  },
};

exports.BangUI = UI;
})(window);
