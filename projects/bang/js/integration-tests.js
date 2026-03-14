// Bang! The Bullet — Integration Tests
// Full multiplayer game simulation mirroring app.js host/client flow.
// Run by opening integration-tests.html in a browser.
(function() {
'use strict';

const output = document.getElementById('output');
let passed = 0;
let failed = 0;
let currentSection = null;

function section(name) {
  currentSection = document.createElement('div');
  currentSection.className = 'section';
  currentSection.innerHTML = '<div class="section-title">' + name + '</div>';
  output.appendChild(currentSection);
}

function assert(condition, msg) {
  const el = document.createElement('div');
  if (condition) {
    el.className = 'pass';
    el.textContent = '  PASS: ' + msg;
    passed++;
  } else {
    el.className = 'fail';
    el.textContent = '  FAIL: ' + msg;
    failed++;
    console.error('FAIL:', msg);
  }
  (currentSection || output).appendChild(el);
}

function assertEqual(a, b, msg) {
  assert(a === b, msg + ' (expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a) + ')');
}

function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch(e) { threw = true; }
  assert(threw, msg);
}

// ═══════════════════════════════════════════════════════════
// GameSimulator — mirrors app.js host behavior exactly
// ═══════════════════════════════════════════════════════════

class GameSimulator {
  constructor(playerNames, useDodgeCity) {
    this.playerInfos = playerNames.map((name, i) => ({
      id: i === 0 ? 'host-' + name.toLowerCase() : 'client-' + name.toLowerCase(),
      name: name,
    }));
    this.playerOrder = this.playerInfos.map(p => p.id);
    this.engine = new BangEngine();
    this.engine.initGame(this.playerInfos, useDodgeCity || false);
    this.views = {};
    this.errors = {};
    this.broadcastState();
  }

  get n() { return this.playerInfos.length; }
  get state() { return this.engine.state; }

  // Mirror app.js broadcastGameState
  broadcastState() {
    this.views = {};
    for (let i = 0; i < this.playerOrder.length; i++) {
      this.views[i] = this.engine.getPlayerView(i);
    }
  }

  // Mirror app.js processAction
  act(playerIdx, action) {
    this.errors[playerIdx] = null;
    try {
      this.engine.handleAction(playerIdx, action);
    } catch (e) {
      this.errors[playerIdx] = e.message;
      return false;
    }
    this.broadcastState();
    return true;
  }

  // Get a player's current view
  view(playerIdx) {
    return this.views[playerIdx];
  }

  // Find the sheriff's index
  get sheriffIdx() {
    return this.state.players.findIndex(p => p.role === 'sheriff');
  }

  // Current turn player index
  get currentTurn() {
    return this.state.currentTurn;
  }

  // Whose turn is it? (name)
  get currentTurnName() {
    return this.state.players[this.state.currentTurn].name;
  }

  // Set up a deterministic game state for testing
  setupDeterministic() {
    const bc = { name: 'Test Character', hp: 4, ability: 'None', set: 'base', effect: 'none' };
    this.state.players.forEach((p, i) => {
      p.character = { ...bc };
      p.inPlay = [];
      p.hand = [];
      if (p.role === 'sheriff') {
        p.hp = 5; p.maxHp = 5;
      } else {
        p.hp = 4; p.maxHp = 4;
      }
    });
    this.state.pending = null;
    this.state.turnPhase = 'play';
    this.state.bangsPlayedThisTurn = 0;
    this.state.buffaloRifleUsed = false;
    this.broadcastState();
  }

  // Give a player specific cards
  giveCards(playerIdx, cards) {
    this.state.players[playerIdx].hand = cards.map((c, i) => ({
      id: 'sim-' + playerIdx + '-' + i,
      name: c.name || c,
      type: c.type || 'brown',
      suit: c.suit || 'H',
      value: c.value || 1,
      ...(typeof c === 'object' ? c : {}),
    }));
    this.broadcastState();
  }

  // Make a card with the right structure
  card(name, opts) {
    return { name, type: 'brown', suit: 'H', value: 1, ...(opts || {}) };
  }

  blueCard(name, opts) {
    return { name, type: 'blue', suit: 'S', value: 1, ...(opts || {}) };
  }
}

// ═══════════════════════════════════════════════════════════
// INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════

section('Setup: Game Creation & Player Identity');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);

  // Player order preserved
  for (let i = 0; i < 4; i++) {
    assertEqual(sim.state.players[i].id, sim.playerOrder[i],
      'Player ' + i + ' ID matches playerOrder');
  }

  // Each player sees their own identity
  for (let i = 0; i < 4; i++) {
    const v = sim.view(i);
    assertEqual(v.yourIndex, i, sim.playerInfos[i].name + ' yourIndex=' + i);
    assertEqual(v.players[i].name, sim.playerInfos[i].name,
      sim.playerInfos[i].name + ' sees own name');
    assert(v.role !== null, sim.playerInfos[i].name + ' can see own role');
    assert(v.hand.length > 0, sim.playerInfos[i].name + ' has cards');
  }

  // Exactly one sheriff
  const sheriffs = sim.state.players.filter(p => p.role === 'sheriff');
  assertEqual(sheriffs.length, 1, 'Exactly 1 sheriff');

  // Every player sees exactly 1 sheriff
  for (let i = 0; i < 4; i++) {
    const v = sim.view(i);
    const sheriffsSeen = v.players.filter(p => p.isSheriff || p.role === 'sheriff');
    assertEqual(sheriffsSeen.length, 1, sim.playerInfos[i].name + ' sees 1 sheriff');
  }
}

section('Setup: 5-8 Player Games');
{
  for (let n = 5; n <= 8; n++) {
    const names = [];
    for (let i = 0; i < n; i++) names.push('P' + i);
    const sim = new GameSimulator(names);

    assertEqual(sim.state.players.length, n, n + 'p: correct player count');

    for (let i = 0; i < n; i++) {
      assertEqual(sim.state.players[i].id, sim.playerOrder[i],
        n + 'p: player ' + i + ' ID matches');
    }

    const sheriffs = sim.state.players.filter(p => p.role === 'sheriff');
    assertEqual(sheriffs.length, 1, n + 'p: exactly 1 sheriff');

    const dist = BangData.ROLE_DIST[n];
    for (const [role, count] of Object.entries(dist)) {
      const actual = sim.state.players.filter(p => p.role === role).length;
      assertEqual(actual, count, n + 'p: ' + count + ' ' + role + '(s)');
    }
  }
}

section('Setup: Sheriff Gets First Turn');
{
  for (let trial = 0; trial < 10; trial++) {
    const sim = new GameSimulator(['A', 'B', 'C', 'D']);
    // The game starts a turn which may create a pending (e.g., draw choice)
    // but currentTurn should be the sheriff
    const sheriffIdx = sim.sheriffIdx;
    // After startTurn, currentTurn might have advanced if sheriff has a special draw ability
    // but the initial currentTurn in state was set to sheriffIdx
    const v = sim.view(sheriffIdx);
    // Sheriff's view should show it's either their turn or they have a prompt
    assert(v.currentTurn === sheriffIdx || v.prompt !== null,
      'Trial ' + trial + ': sheriff starts first (turn=' + v.currentTurn + ', sheriff=' + sheriffIdx + ')');
  }
}

section('View: Players See Correct Hand (Not Someone Else\'s)');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  // Give each player unique cards
  for (let i = 0; i < 4; i++) {
    sim.giveCards(i, [sim.card('Unique' + i)]);
  }

  for (let i = 0; i < 4; i++) {
    const v = sim.view(i);
    assertEqual(v.hand.length, 1, 'Player ' + i + ' has 1 card');
    assertEqual(v.hand[0].name, 'Unique' + i,
      'Player ' + i + ' sees their own card (not someone else\'s)');
  }
}

section('View: Other Players\' Hands Hidden');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();
  sim.giveCards(0, [sim.card('Secret BANG!'), sim.card('Secret Beer')]);

  const v1 = sim.view(1); // Bob's view
  // Bob should NOT see Alice's actual cards, only handSize
  assertEqual(v1.players[0].handSize, 2, 'Bob sees Alice has 2 cards');
  // Bob's view.hand should be Bob's hand, not Alice's
  assertEqual(v1.hand.length, 0, 'Bob has no cards');
}

section('View: Hidden Roles');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);

  for (let i = 0; i < 4; i++) {
    const v = sim.view(i);
    for (let j = 0; j < 4; j++) {
      if (i === j) {
        assert(v.players[j].role !== null, 'Player ' + i + ' sees own role');
      } else if (v.players[j].isSheriff) {
        assertEqual(v.players[j].role, 'sheriff', 'Sheriff always visible');
      } else {
        assertEqual(v.players[j].role, null,
          'Player ' + i + ' cannot see player ' + j + ' role');
      }
    }
  }
}

section('Turn: BANG! → Missed! → End Turn → Next Player');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const turn1 = sim.sheriffIdx;
  sim.state.currentTurn = turn1;
  sim.state.turnPhase = 'play';
  sim.state.bangsPlayedThisTurn = 0;
  const target = (turn1 + 1) % 4;

  sim.giveCards(turn1, [{ name: 'BANG!', suit: 'D', value: 5 }]);
  sim.giveCards(target, [{ name: 'Missed!', suit: 'C', value: 10 }]);

  // Sheriff plays BANG!
  const bangId = sim.state.players[turn1].hand[0].id;
  assert(sim.act(turn1, { type: 'play_card', cardId: bangId, targetIdx: target }),
    'BANG! action succeeds');

  // Verify target sees bang_response prompt
  const tv = sim.view(target);
  assert(tv.prompt !== null, 'Target has prompt');
  assertEqual(tv.prompt.type, 'bang_response', 'Target sees bang_response');

  // All other players see "waiting" prompt
  for (let i = 0; i < 4; i++) {
    if (i === target) continue;
    const v = sim.view(i);
    if (v.prompt) {
      assertEqual(v.prompt.type, 'waiting', 'Player ' + i + ' sees waiting');
    }
  }

  // Target responds with Missed!
  const missedId = sim.state.players[target].hand[0].id;
  assert(sim.act(target, { type: 'respond', response: 'missed', cardId: missedId }),
    'Missed! response succeeds');
  assertEqual(sim.state.players[target].hp, sim.state.players[target].maxHp,
    'Target HP unchanged');

  // Sheriff ends turn
  assert(sim.act(turn1, { type: 'end_turn' }), 'End turn succeeds');

  // Turn advanced
  assert(sim.state.currentTurn !== turn1 || sim.state.pending !== null,
    'Turn advanced to next player');
}

section('Turn: BANG! → Take Hit → Verify Damage in All Views');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const attacker = sim.sheriffIdx;
  sim.state.currentTurn = attacker;
  sim.state.turnPhase = 'play';
  sim.state.bangsPlayedThisTurn = 0;
  const target = (attacker + 1) % 4;

  sim.giveCards(attacker, [{ name: 'BANG!', suit: 'D', value: 5 }]);
  const bangId = sim.state.players[attacker].hand[0].id;
  const hpBefore = sim.state.players[target].hp;

  sim.act(attacker, { type: 'play_card', cardId: bangId, targetIdx: target });
  sim.act(target, { type: 'respond', response: 'take_hit' });

  assertEqual(sim.state.players[target].hp, hpBefore - 1, 'Target lost 1 HP');

  // EVERY player should see the updated HP
  for (let i = 0; i < 4; i++) {
    const v = sim.view(i);
    assertEqual(v.players[target].hp, hpBefore - 1,
      sim.playerInfos[i].name + ' sees target at ' + (hpBefore - 1) + ' HP');
  }
}

section('Turn: Multiple Card Plays in One Turn');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const pi = sim.sheriffIdx;
  sim.state.currentTurn = pi;
  sim.state.turnPhase = 'play';
  sim.state.bangsPlayedThisTurn = 0;
  const adj = (pi + 1) % 4;
  sim.state.players[pi].hp = 3;

  sim.giveCards(pi, [
    { name: 'Beer', suit: 'H', value: 6 },
    { name: 'BANG!', suit: 'D', value: 5 },
    { name: 'Stagecoach', suit: 'S', value: 9 },
  ]);

  // Play Beer
  const beerId = sim.state.players[pi].hand[0].id;
  assert(sim.act(pi, { type: 'play_card', cardId: beerId }), 'Beer played');
  assertEqual(sim.state.players[pi].hp, 4, 'Healed 1 HP');

  // Play Stagecoach
  const stageId = sim.state.players[pi].hand.find(c => c.name === 'Stagecoach').id;
  assert(sim.act(pi, { type: 'play_card', cardId: stageId }), 'Stagecoach played');
  assert(sim.state.players[pi].hand.length >= 2, 'Drew cards from Stagecoach');

  // Play BANG!
  const bangCard = sim.state.players[pi].hand.find(c => c.name === 'BANG!');
  if (bangCard) {
    assert(sim.act(pi, { type: 'play_card', cardId: bangCard.id, targetIdx: adj }),
      'BANG! played');
    sim.act(adj, { type: 'respond', response: 'take_hit' });
  }
}

section('Turn: BANG! Limit — Second BANG! Rejected');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const pi = sim.sheriffIdx;
  sim.state.currentTurn = pi;
  sim.state.turnPhase = 'play';
  sim.state.bangsPlayedThisTurn = 0;
  const adj = (pi + 1) % 4;

  sim.giveCards(pi, [
    { name: 'BANG!', suit: 'D', value: 5 },
    { name: 'BANG!', suit: 'D', value: 6 },
  ]);

  const b1 = sim.state.players[pi].hand[0].id;
  const b2 = sim.state.players[pi].hand[1].id;

  sim.act(pi, { type: 'play_card', cardId: b1, targetIdx: adj });
  sim.act(adj, { type: 'respond', response: 'take_hit' });

  // Second BANG! should fail
  const ok = sim.act(pi, { type: 'play_card', cardId: b2, targetIdx: adj });
  assert(!ok, 'Second BANG! rejected');
  assert(sim.errors[pi] !== null, 'Error message returned');
}

section('Turn: End Turn → Hand Limit → Discard → Next Turn');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const pi = sim.sheriffIdx;
  sim.state.currentTurn = pi;
  sim.state.turnPhase = 'play';
  sim.state.players[pi].hp = 2;

  // Give 5 cards (limit is 2 with 2 HP)
  const cards = [];
  for (let i = 0; i < 5; i++) cards.push({ name: 'BANG!', suit: 'D', value: i + 2 });
  sim.giveCards(pi, cards);

  sim.act(pi, { type: 'end_turn' });
  assertEqual(sim.state.pending.type, 'discard_required', 'Discard prompt');
  assertEqual(sim.state.pending.count, 3, 'Must discard 3');

  // Player sees the prompt in their view
  const v = sim.view(pi);
  assertEqual(v.prompt.type, 'discard_required', 'View shows discard prompt');
  assertEqual(v.prompt.count, 3, 'View shows correct count');

  // Discard 3
  const ids = sim.state.players[pi].hand.slice(0, 3).map(c => c.id);
  sim.act(pi, { type: 'discard', cardIds: ids });
  assertEqual(sim.state.players[pi].hand.length, 2, 'Hand at limit');

  // Turn should have advanced
  assert(sim.state.currentTurn !== pi || sim.state.pending !== null, 'Turn advanced');
}

section('Turn: Equipment Stays In Play Across Turns');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const pi = sim.sheriffIdx;
  sim.state.currentTurn = pi;
  sim.state.turnPhase = 'play';

  sim.giveCards(pi, [{ name: 'Barrel', type: 'blue', suit: 'S', value: 12 }]);
  const barrelId = sim.state.players[pi].hand[0].id;

  sim.act(pi, { type: 'play_card', cardId: barrelId });
  assert(sim.state.players[pi].inPlay.some(c => c.name === 'Barrel'), 'Barrel in play');

  // All players should see it
  for (let i = 0; i < 4; i++) {
    const v = sim.view(i);
    assert(v.players[pi].inPlay.some(c => c.name === 'Barrel'),
      sim.playerInfos[i].name + ' sees Barrel on player ' + pi);
  }

  // End turn, advance
  sim.act(pi, { type: 'end_turn' });

  // Barrel still in play
  assert(sim.state.players[pi].inPlay.some(c => c.name === 'Barrel'),
    'Barrel persists after turn ends');
}

section('Multi-turn: Indians! → All Respond');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const pi = sim.sheriffIdx;
  sim.state.currentTurn = pi;
  sim.state.turnPhase = 'play';
  sim.state.bangsPlayedThisTurn = 0;

  sim.giveCards(pi, [{ name: 'Indians!', suit: 'D', value: 1 }]);

  // Give one player a BANG! to survive, others nothing
  const others = [0, 1, 2, 3].filter(i => i !== pi);
  sim.giveCards(others[0], [{ name: 'BANG!', suit: 'D', value: 2 }]);
  sim.giveCards(others[1], []);
  sim.giveCards(others[2], []);

  const indId = sim.state.players[pi].hand[0].id;
  sim.act(pi, { type: 'play_card', cardId: indId });
  assertEqual(sim.state.pending.type, 'indians_response', 'Indians pending');

  // First respondent plays BANG!
  const resp0 = sim.state.pending.respondents[sim.state.pending.currentIdx];
  if (sim.state.players[resp0].hand.length > 0) {
    const bangId = sim.state.players[resp0].hand[0].id;
    sim.act(resp0, { type: 'respond', response: 'bang', cardId: bangId });
    assertEqual(sim.state.players[resp0].hp, sim.state.players[resp0].maxHp,
      'Respondent who played BANG! saved');
  }

  // Remaining respondents take hit
  while (sim.state.pending && sim.state.pending.type === 'indians_response') {
    const ri = sim.state.pending.respondents[sim.state.pending.currentIdx];
    sim.act(ri, { type: 'respond', response: 'take_hit' });
  }

  // Verify damage
  let damaged = 0;
  for (const i of others) {
    if (sim.state.players[i].hp < sim.state.players[i].maxHp) damaged++;
  }
  assert(damaged >= 1, 'At least 1 player took Indians damage');
}

section('Multi-turn: General Store → All Players Pick');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const pi = sim.sheriffIdx;
  sim.state.currentTurn = pi;
  sim.state.turnPhase = 'play';

  sim.giveCards(pi, [{ name: 'General Store', suit: 'C', value: 9 }]);
  const gsId = sim.state.players[pi].hand[0].id;
  const handsBefore = sim.state.players.map(p => p.hand.length);

  sim.act(pi, { type: 'play_card', cardId: gsId });
  assertEqual(sim.state.pending.type, 'general_store', 'General Store pending');

  // Each player picks in order
  while (sim.state.pending && sim.state.pending.type === 'general_store') {
    const pickerIdx = sim.state.pending.pickOrder[sim.state.pending.currentIdx];
    const cards = sim.state.pending.cards.filter(c => c !== null);
    assert(cards.length > 0, 'Cards available to pick');

    // Player sees the pick prompt
    const pv = sim.view(pickerIdx);
    assertEqual(pv.prompt.type, 'general_store', 'Picker sees general_store prompt');

    sim.act(pickerIdx, { type: 'pick_card', cardId: cards[0].id });
  }

  // Each alive player gained exactly 1 card (except sheriff who played GS)
  for (let i = 0; i < 4; i++) {
    if (i === pi) {
      // Sheriff played GS (-1) then picked (+1) = net 0
      assertEqual(sim.state.players[i].hand.length, handsBefore[i],
        'Sheriff: played GS, picked one = net 0');
    } else {
      assertEqual(sim.state.players[i].hand.length, handsBefore[i] + 1,
        'Player ' + i + ': picked 1 from General Store');
    }
  }
}

section('Multi-turn: Duel → Back and Forth');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const pi = sim.sheriffIdx;
  sim.state.currentTurn = pi;
  sim.state.turnPhase = 'play';
  const target = (pi + 1) % 4;

  sim.giveCards(pi, [
    { name: 'Duel', suit: 'C', value: 8 },
    { name: 'BANG!', suit: 'D', value: 2 },
  ]);
  sim.giveCards(target, [{ name: 'BANG!', suit: 'D', value: 3 }]);

  const duelId = sim.state.players[pi].hand[0].id;
  sim.act(pi, { type: 'play_card', cardId: duelId, targetIdx: target });
  if (sim.state.pending && sim.state.pending.type === 'choose_target') {
    sim.act(pi, { type: 'choose_target', targetIdx: target });
  }
  assertEqual(sim.state.pending.type, 'duel_response', 'Duel pending');

  // Target plays BANG!
  const tBang = sim.state.players[target].hand[0].id;
  sim.act(target, { type: 'respond', response: 'bang', cardId: tBang });
  assertEqual(sim.state.pending.currentResponder, pi, 'Duel switches to attacker');

  // Attacker plays BANG!
  const aBang = sim.state.players[pi].hand.find(c => c.name === 'BANG!');
  if (aBang) {
    sim.act(pi, { type: 'respond', response: 'bang', cardId: aBang.id });
    assertEqual(sim.state.pending.currentResponder, target, 'Duel switches back');

    // Target gives up
    sim.act(target, { type: 'respond', response: 'give_up' });
    assertEqual(sim.state.players[target].hp, sim.state.players[target].maxHp - 1,
      'Duel loser takes 1 damage');
  }
}

section('Multi-turn: Elimination → Outlaw Reward → Roles Revealed');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  // Find an outlaw
  const outlawIdx = sim.state.players.findIndex(p => p.role === 'outlaw');
  const sheriffIdx = sim.sheriffIdx;

  sim.state.players[outlawIdx].hp = 1;
  sim.state.players[sheriffIdx].hand = [];
  sim.state.currentTurn = sheriffIdx;
  sim.state.turnPhase = 'play';
  sim.state.bangsPlayedThisTurn = 0;

  sim.giveCards(sheriffIdx, [{ name: 'BANG!', suit: 'D', value: 5 }]);
  const bangId = sim.state.players[sheriffIdx].hand[0].id;

  // Check sheriff can target outlaw
  const dist = sim.engine.calcDistance(sheriffIdx, outlawIdx);
  if (dist <= 1) {
    sim.act(sheriffIdx, { type: 'play_card', cardId: bangId, targetIdx: outlawIdx });
    sim.act(outlawIdx, { type: 'respond', response: 'take_hit' });

    assert(sim.state.players[outlawIdx].eliminated, 'Outlaw eliminated');

    // Sheriff drew 3 cards as reward
    assert(sim.state.players[sheriffIdx].hand.length >= 3, 'Sheriff got outlaw reward');

    // All players see eliminated player's role
    for (let i = 0; i < 4; i++) {
      const v = sim.view(i);
      assert(v.players[outlawIdx].roleRevealed, 'Eliminated role revealed to all');
      assertEqual(v.players[outlawIdx].role, 'outlaw', 'Role shown as outlaw');
    }
  }
}

section('Multi-turn: Play to Sheriff Victory');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const sheriff = sim.sheriffIdx;

  // Kill all non-sheriff players
  const others = [0, 1, 2, 3].filter(i => i !== sheriff);
  for (const i of others) {
    sim.state.players[i].hp = 1;
    sim.state.players[i].hand = []; // No beer save
  }

  sim.engine.applyDamage(others[0], 1, sheriff);
  if (!sim.state.winner) sim.engine.applyDamage(others[1], 1, sheriff);
  if (!sim.state.winner) sim.engine.applyDamage(others[2], 1, sheriff);
  sim.broadcastState();

  assert(sim.state.winner !== null, 'Game over');
  assertEqual(sim.state.winner.team, 'sheriff', 'Sheriff wins');

  // All views should show game over
  for (let i = 0; i < 4; i++) {
    const v = sim.view(i);
    assert(v.winner !== null, sim.playerInfos[i].name + ' sees winner');
    // All roles revealed at game over
    for (let j = 0; j < 4; j++) {
      assert(v.players[j].role !== null,
        sim.playerInfos[i].name + ' sees all roles revealed');
    }
  }
}

section('Multi-turn: Play to Outlaw Victory');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const sheriff = sim.sheriffIdx;
  sim.state.players[sheriff].hp = 1;
  sim.state.players[sheriff].hand = [];

  // Find an outlaw to be the killer
  const outlawIdx = sim.state.players.findIndex(p => p.role === 'outlaw');
  sim.engine.applyDamage(sheriff, 1, outlawIdx);
  sim.broadcastState();

  assert(sim.state.winner !== null, 'Game over');
  assertEqual(sim.state.winner.team, 'outlaw', 'Outlaws win');
}

section('Multi-turn: Beer Save During Combat');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const attacker = sim.sheriffIdx;
  const target = (attacker + 1) % 4;
  sim.state.currentTurn = attacker;
  sim.state.turnPhase = 'play';
  sim.state.bangsPlayedThisTurn = 0;
  sim.state.players[target].hp = 1;

  sim.giveCards(attacker, [{ name: 'BANG!', suit: 'D', value: 5 }]);
  sim.giveCards(target, [{ name: 'Beer', suit: 'H', value: 6 }]);

  const bangId = sim.state.players[attacker].hand[0].id;
  sim.act(attacker, { type: 'play_card', cardId: bangId, targetIdx: target });
  sim.act(target, { type: 'respond', response: 'take_hit' });

  // Beer save should trigger
  assertEqual(sim.state.pending.type, 'beer_save', 'Beer save triggered');

  // Target's view shows beer_save prompt
  const tv = sim.view(target);
  assertEqual(tv.prompt.type, 'beer_save', 'Target sees beer_save prompt');

  // Other players see waiting
  for (let i = 0; i < 4; i++) {
    if (i === target) continue;
    const v = sim.view(i);
    if (v.prompt) {
      assertEqual(v.prompt.type, 'waiting', 'Player ' + i + ' sees waiting during beer_save');
    }
  }

  // Use beer to survive
  const beerId = sim.state.players[target].hand[0].id;
  sim.act(target, { type: 'respond', response: 'beer', cardId: beerId });
  assert(!sim.state.players[target].eliminated, 'Target survived');
  assert(sim.state.players[target].hp > 0, 'Target HP > 0');
}

section('Multi-turn: Cat Balou → Choose Target → Choose Card');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);
  sim.setupDeterministic();

  const pi = sim.sheriffIdx;
  sim.state.currentTurn = pi;
  sim.state.turnPhase = 'play';

  const target = (pi + 1) % 4;
  sim.giveCards(pi, [{ name: 'Cat Balou', suit: 'H', value: 13 }]);
  sim.giveCards(target, [{ name: 'BANG!', suit: 'D', value: 2 }]);
  sim.state.players[target].inPlay = [{
    id: 'target-barrel', name: 'Barrel', type: 'blue', suit: 'S', value: 12,
  }];

  const cbId = sim.state.players[pi].hand[0].id;
  sim.act(pi, { type: 'play_card', cardId: cbId });

  // Engine creates choose_target
  assertEqual(sim.state.pending.type, 'choose_target', 'Cat Balou: choose target');

  // Attacker's view shows choose_target prompt
  const av = sim.view(pi);
  assertEqual(av.prompt.type, 'choose_target', 'Attacker sees choose_target');
  assert(av.prompt.validTargets.includes(target), 'Target in valid targets');

  sim.act(pi, { type: 'choose_target', targetIdx: target });

  // Now choose card from target
  assertEqual(sim.state.pending.type, 'choose_card_from_target', 'Choose card prompt');

  const cv = sim.view(pi);
  assertEqual(cv.prompt.type, 'choose_card_from_target', 'Attacker sees choose_card_from_target');
  assert(cv.prompt.inPlayCards.some(c => c.name === 'Barrel'), 'Barrel visible for picking');

  // Choose the in-play Barrel
  sim.act(pi, { type: 'choose_card', cardId: 'target-barrel' });
  assertEqual(sim.state.players[target].inPlay.length, 0, 'Barrel removed');
}

section('Multi-turn: Weapon Changes Range → BANG! Targets');
{
  const sim = new GameSimulator(['A', 'B', 'C', 'D', 'E']);
  sim.setupDeterministic();

  const pi = 0;
  sim.state.currentTurn = pi;
  sim.state.turnPhase = 'play';
  sim.state.bangsPlayedThisTurn = 0;

  // Default range 1: can hit players 1 and 4 only
  assert(sim.engine.isInRange(0, 1), 'Range 1: can hit player 1');
  assert(!sim.engine.isInRange(0, 2), 'Range 1: cannot hit player 2');

  // Equip Winchester (range 5)
  sim.giveCards(pi, [{ name: 'Winchester', type: 'blue', suit: 'S', value: 8 }]);
  sim.act(pi, { type: 'play_card', cardId: sim.state.players[pi].hand[0].id });
  assertEqual(sim.engine.getWeaponRange(pi), 5, 'Winchester equipped');

  // Now can hit everyone
  for (let i = 1; i < 5; i++) {
    assert(sim.engine.isInRange(0, i), 'Range 5: can hit player ' + i);
  }
}

section('Multi-turn: Full 3-Turn Game (Draw → Play → End)');
{
  const sim = new GameSimulator(['Alice', 'Bob', 'Charlie', 'Dave']);

  // Play through 3 complete turns without errors
  let turnsCompleted = 0;
  let safety = 0;

  while (turnsCompleted < 3 && safety < 100 && !sim.state.winner) {
    safety++;

    const pi = sim.state.currentTurn;

    // Handle any pending prompts first
    if (sim.state.pending) {
      const p = sim.state.pending;

      if (p.type === 'vera_custer') {
        sim.act(p.playerIdx, { type: 'choose', choice: 0 });
      } else if (p.type === 'draw_choice') {
        sim.act(p.playerIdx, { type: 'choose', choice: 0 }); // draw from deck
      } else if (p.type === 'kit_carlson') {
        const cards = p.cards.filter(c => c !== null);
        if (cards.length > 0) sim.act(p.playerIdx, { type: 'pick_card', cardId: cards[0].id });
        if (sim.state.pending && sim.state.pending.type === 'kit_carlson') {
          const cards2 = sim.state.pending.cards.filter(c => c !== null);
          if (cards2.length > 0) sim.act(p.playerIdx, { type: 'pick_card', cardId: cards2[0].id });
        }
      } else if (p.type === 'discard_required') {
        const ids = sim.state.players[p.playerIdx].hand.slice(0, p.count).map(c => c.id);
        sim.act(p.playerIdx, { type: 'discard', cardIds: ids });
        turnsCompleted++;
      } else if (p.type === 'lucky_duke') {
        sim.act(p.playerIdx, { type: 'choose', choice: 0 });
      } else if (p.type === 'bang_response' || p.type === 'gatling_response') {
        sim.act(p.targetIdx || p.respondents[p.currentIdx], { type: 'respond', response: 'take_hit' });
      } else if (p.type === 'indians_response') {
        sim.act(p.respondents[p.currentIdx], { type: 'respond', response: 'take_hit' });
      } else if (p.type === 'duel_response') {
        sim.act(p.currentResponder, { type: 'respond', response: 'give_up' });
      } else if (p.type === 'beer_save') {
        const player = sim.state.players[p.playerIdx];
        const beer = player.hand.find(c => c.name === 'Beer');
        if (beer) {
          sim.act(p.playerIdx, { type: 'respond', response: 'beer', cardId: beer.id });
        } else {
          sim.act(p.playerIdx, { type: 'respond', response: 'accept_death' });
        }
      } else if (p.type === 'general_store') {
        const cards = p.cards.filter(c => c !== null);
        if (cards.length > 0) {
          sim.act(p.pickOrder[p.currentIdx], { type: 'pick_card', cardId: cards[0].id });
        }
      } else if (p.type === 'choose_target') {
        const t = p.validTargets[0];
        sim.act(p.playerIdx, { type: 'choose_target', targetIdx: t });
      } else if (p.type === 'choose_card_from_target') {
        sim.act(p.playerIdx, { type: 'choose_card', choice: 'hand' });
      } else if (p.type && p.type.endsWith('_discard')) {
        const player = sim.state.players[p.playerIdx];
        if (player.hand.length > 0) {
          sim.act(p.playerIdx, { type: 'choose', choice: player.hand[0].id });
        }
      } else if (p.type === 'brawl_response') {
        sim.act(p.respondents[p.currentIdx], { type: 'choose', choice: null });
      } else {
        break; // Unknown pending type
      }
      continue;
    }

    // In play phase: end turn
    if (sim.state.turnPhase === 'play') {
      sim.act(pi, { type: 'end_turn' });
      if (!sim.state.pending || sim.state.pending.type !== 'discard_required') {
        turnsCompleted++;
      }
    }
  }

  assert(turnsCompleted >= 3 || sim.state.winner !== null,
    'Completed 3 turns (or game ended): turns=' + turnsCompleted);
  assert(safety < 100, 'Did not hit safety limit');

  // Views still valid
  for (let i = 0; i < 4; i++) {
    const v = sim.view(i);
    assertEqual(v.yourIndex, i, 'After 3 turns: player ' + i + ' view intact');
  }
}

section('Stress: 20 Random Games Complete Without Error');
{
  let gamesCompleted = 0;
  let errors = [];

  for (let game = 0; game < 20; game++) {
    try {
      const n = 4 + (game % 5);
      const names = [];
      for (let i = 0; i < n; i++) names.push('P' + i);
      const sim = new GameSimulator(names, game % 2 === 0);

      let turns = 0;
      let steps = 0;

      while (turns < 6 && steps < 200 && !sim.state.winner) {
        steps++;
        const pi = sim.state.currentTurn;

        if (sim.state.pending) {
          const p = sim.state.pending;

          if (p.type === 'vera_custer') {
            sim.act(p.playerIdx, { type: 'choose', choice: 0 });
          } else if (p.type === 'draw_choice') {
            sim.act(p.playerIdx, { type: 'choose', choice: 0 });
          } else if (p.type === 'kit_carlson') {
            const cards = p.cards.filter(c => c !== null);
            if (cards.length > 0) sim.act(p.playerIdx, { type: 'pick_card', cardId: cards[0].id });
            if (sim.state.pending && sim.state.pending.type === 'kit_carlson') {
              const c2 = sim.state.pending.cards.filter(c => c !== null);
              if (c2.length > 0) sim.act(p.playerIdx, { type: 'pick_card', cardId: c2[0].id });
            }
          } else if (p.type === 'discard_required') {
            const ids = sim.state.players[p.playerIdx].hand.slice(0, p.count).map(c => c.id);
            sim.act(p.playerIdx, { type: 'discard', cardIds: ids });
            turns++;
          } else if (p.type === 'lucky_duke') {
            sim.act(p.playerIdx, { type: 'choose', choice: 0 });
          } else if (p.type === 'bang_response' || p.type === 'gatling_response') {
            const ri = p.type === 'bang_response' ? p.targetIdx : p.respondents[p.currentIdx];
            sim.act(ri, { type: 'respond', response: 'take_hit' });
          } else if (p.type === 'indians_response') {
            sim.act(p.respondents[p.currentIdx], { type: 'respond', response: 'take_hit' });
          } else if (p.type === 'duel_response') {
            sim.act(p.currentResponder, { type: 'respond', response: 'give_up' });
          } else if (p.type === 'beer_save') {
            const pl = sim.state.players[p.playerIdx];
            const beer = pl.hand.find(c => c.name === 'Beer');
            if (beer) sim.act(p.playerIdx, { type: 'respond', response: 'beer', cardId: beer.id });
            else sim.act(p.playerIdx, { type: 'respond', response: 'accept_death' });
          } else if (p.type === 'general_store') {
            const cards = p.cards.filter(c => c !== null);
            if (cards.length > 0) sim.act(p.pickOrder[p.currentIdx], { type: 'pick_card', cardId: cards[0].id });
            else break;
          } else if (p.type === 'choose_target') {
            sim.act(p.playerIdx, { type: 'choose_target', targetIdx: p.validTargets[0] });
          } else if (p.type === 'choose_card_from_target') {
            sim.act(p.playerIdx, { type: 'choose_card', choice: 'hand' });
          } else if (p.type && p.type.endsWith('_discard')) {
            const pl = sim.state.players[p.playerIdx];
            if (pl.hand.length > 0) sim.act(p.playerIdx, { type: 'choose', choice: pl.hand[0].id });
            else break;
          } else if (p.type === 'brawl_response') {
            sim.act(p.respondents[p.currentIdx], { type: 'choose', choice: null });
          } else {
            break;
          }
          continue;
        }

        if (sim.state.turnPhase === 'play') {
          sim.act(pi, { type: 'end_turn' });
          if (!sim.state.pending || sim.state.pending.type !== 'discard_required') {
            turns++;
          }
        }
      }

      // Verify views are consistent
      for (let i = 0; i < n; i++) {
        if (sim.state.players[i].eliminated) continue;
        const v = sim.view(i);
        if (v.yourIndex !== i) throw new Error('View mismatch for player ' + i);
      }

      gamesCompleted++;
    } catch (e) {
      errors.push('Game ' + game + ': ' + e.message);
    }
  }

  assertEqual(gamesCompleted, 20, 'All 20 games completed without crashing');
  if (errors.length > 0) {
    errors.forEach(e => assert(false, e));
  }
}

// ═══════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════
const summaryEl = document.createElement('div');
summaryEl.className = 'summary ' + (failed === 0 ? 'all-pass' : 'has-fail');
summaryEl.textContent = passed + ' passed, ' + failed + ' failed';
output.appendChild(summaryEl);

console.log('Integration Tests: ' + passed + ' passed, ' + failed + ' failed');
})();
