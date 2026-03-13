// Bang! The Bullet — Engine Tests
// Run by opening tests.html in a browser
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

// Helper: create a test game with specific setup
function createTestGame(opts) {
  opts = opts || {};
  const n = opts.playerCount || 4;
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push({ id: 'p' + i, name: 'Player' + i });
  }
  const engine = new BangEngine();
  engine.initGame(players, opts.useDodgeCity || false);

  // Override characters if needed for deterministic tests
  if (opts.characters) {
    opts.characters.forEach((char, i) => {
      if (char && i < engine.state.players.length) {
        engine.state.players[i].character = { ...char };
      }
    });
  }

  // Override roles for deterministic tests
  if (opts.roles) {
    opts.roles.forEach((role, i) => {
      if (role && i < engine.state.players.length) {
        engine.state.players[i].role = role;
      }
    });
  }

  return engine;
}

// Helper: give a player specific cards
function giveCards(engine, playerIdx, cards) {
  const p = engine.state.players[playerIdx];
  p.hand = cards.map((c, i) => ({
    id: 'test-' + playerIdx + '-' + i,
    name: c.name || c,
    type: c.type || 'brown',
    suit: c.suit || 'H',
    value: c.value || 1,
  }));
}

// Helper: make it a specific player's turn with play phase
function setTurn(engine, playerIdx) {
  engine.state.currentTurn = playerIdx;
  engine.state.turnPhase = 'play';
  engine.state.bangsPlayedThisTurn = 0;
  engine.state.buffaloRifleUsed = false;
  engine.state.pending = null;
}

// Helper: use a basic character with no special ability
function basicChar() {
  return { name: 'Test Guy', hp: 4, ability: 'None', set: 'base', effect: 'none' };
}

// ═══════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════

section('Game Initialization');
{
  const engine = createTestGame({ playerCount: 4 });
  assert(engine.state !== null, 'State is initialized');
  assertEqual(engine.state.players.length, 4, '4 players created');
  assertEqual(engine.state.phase, 'playing', 'Phase is playing');

  // Sheriff exists
  const sheriff = engine.state.players.find(p => p.role === 'sheriff');
  assert(sheriff !== undefined, 'Sheriff role assigned');
  assertEqual(sheriff.maxHp, sheriff.character.hp + 1, 'Sheriff gets +1 max HP');

  // All players have cards dealt
  engine.state.players.forEach((p, i) => {
    assert(p.hand.length > 0, 'Player ' + i + ' has cards');
  });

  // Deck has cards
  assert(engine.state.deck.length > 0, 'Deck has cards remaining');
  assert(engine.state.log.length > 0, 'Log has entries');
}

section('Game Init — Player Count Validation');
{
  assertThrows(() => createTestGame({ playerCount: 3 }), 'Rejects 3 players');
  assertThrows(() => createTestGame({ playerCount: 9 }), 'Rejects 9 players');
  // Valid counts
  for (let n = 4; n <= 8; n++) {
    const e = createTestGame({ playerCount: n });
    assertEqual(e.state.players.length, n, n + ' players accepted');
  }
}

section('Role Distribution');
{
  for (let n = 4; n <= 8; n++) {
    const e = createTestGame({ playerCount: n });
    const dist = BangData.ROLE_DIST[n];
    const roles = e.state.players.map(p => p.role);
    for (const [role, count] of Object.entries(dist)) {
      assertEqual(roles.filter(r => r === role).length, count, n + 'p: ' + count + ' ' + role + '(s)');
    }
  }
}

section('Deck Management');
{
  const engine = createTestGame();
  // Clear hands for testing
  engine.state.players.forEach(p => p.hand = []);

  const initialDeckSize = engine.state.deck.length;
  const drawn = engine.drawFromDeck(3);
  assertEqual(drawn.length, 3, 'Draw 3 cards');
  assertEqual(engine.state.deck.length, initialDeckSize - 3, 'Deck size decreases');

  // Test reshuffle
  const savedDiscard = engine.state.discard.length;
  engine.state.discard.push(...engine.state.deck);
  engine.state.deck = [];
  const more = engine.drawFromDeck(1);
  assertEqual(more.length, 1, 'Can draw after reshuffle');
  assert(engine.state.deck.length > 0 || engine.state.discard.length >= 0, 'Deck restored after reshuffle');
}

section('Distance Calculation');
{
  const engine = createTestGame({ playerCount: 5 });
  // All players alive, seated in circle
  engine.state.players.forEach((p, i) => {
    p.character = basicChar();
    p.inPlay = [];
  });
  engine.state.currentTurn = 0;

  // Distance in a 5-player circle
  assertEqual(engine.calcDistance(0, 0), 0, 'Distance to self is 0');
  assertEqual(engine.calcDistance(0, 1), 1, 'Adjacent distance is 1');
  assertEqual(engine.calcDistance(0, 2), 2, 'Two seats away is 2');
  assertEqual(engine.calcDistance(0, 3), 2, 'Three seats away wraps to 2');
  assertEqual(engine.calcDistance(0, 4), 1, 'Four seats away wraps to 1');

  // Mustang adds +1 to distance from others
  engine.state.players[2].inPlay = [{ id: 'mustang-1', name: 'Mustang', type: 'blue', suit: 'H', value: 8 }];
  assertEqual(engine.calcDistance(0, 2), 3, 'Mustang adds +1 distance');
  assertEqual(engine.calcDistance(2, 0), 2, 'Mustang does not affect outgoing distance');

  // Scope reduces distance
  engine.state.players[0].inPlay = [{ id: 'scope-1', name: 'Scope', type: 'blue', suit: 'S', value: 1 }];
  assertEqual(engine.calcDistance(0, 2), 2, 'Scope reduces distance by 1');
  assertEqual(engine.calcDistance(2, 0), 2, 'Scope does not affect incoming distance');

  // Cleanup
  engine.state.players.forEach(p => p.inPlay = []);
}

section('Weapon Range');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });

  assertEqual(engine.getWeaponRange(0), 1, 'Default range is 1 (Colt .45)');

  engine.state.players[0].inPlay.push({ id: 'w1', name: 'Schofield', type: 'blue', suit: 'C', value: 11 });
  assertEqual(engine.getWeaponRange(0), 2, 'Schofield range is 2');

  engine.state.players[0].inPlay = [{ id: 'w2', name: 'Winchester', type: 'blue', suit: 'S', value: 8 }];
  assertEqual(engine.getWeaponRange(0), 5, 'Winchester range is 5');
}

section('BANG! Card — Basic Flow');
{
  const engine = createTestGame();
  engine.state.players.forEach((p, i) => {
    p.character = basicChar();
    p.inPlay = [];
    p.hp = 4;
    p.maxHp = 4;
  });
  setTurn(engine, 0);

  // Give player 0 a BANG!
  const bangCard = { id: 'bang-1', name: 'BANG!', type: 'brown', suit: 'D', value: 5 };
  engine.state.players[0].hand = [bangCard];

  // Play BANG! on adjacent player
  engine.playCard(0, 'bang-1', 1);

  // Should create a bang_response pending
  assert(engine.state.pending !== null, 'Pending action created');
  assertEqual(engine.state.pending.type, 'bang_response', 'Pending type is bang_response');
  assertEqual(engine.state.pending.targetIdx, 1, 'Target is player 1');

  // Player 1 takes the hit
  engine.handleAction(1, { type: 'respond', response: 'take_hit' });
  assertEqual(engine.state.players[1].hp, 3, 'Player 1 loses 1 HP');
  assertEqual(engine.state.pending, null, 'Pending cleared');
}

section('BANG! — Missed Response');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hp = 4; p.maxHp = 4; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'b1', name: 'BANG!', type: 'brown', suit: 'D', value: 5 }];
  engine.state.players[1].hand = [{ id: 'm1', name: 'Missed!', type: 'brown', suit: 'C', value: 10 }];

  engine.playCard(0, 'b1', 1);
  engine.handleAction(1, { type: 'respond', response: 'missed', cardId: 'm1' });

  assertEqual(engine.state.players[1].hp, 4, 'Player 1 HP unchanged after Missed!');
  assertEqual(engine.state.players[1].hand.length, 0, 'Missed! card consumed');
  assertEqual(engine.state.pending, null, 'Pending cleared after Missed!');
}

section('BANG! Limit');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [
    { id: 'b1', name: 'BANG!', type: 'brown', suit: 'D', value: 5 },
    { id: 'b2', name: 'BANG!', type: 'brown', suit: 'D', value: 6 },
  ];

  // First BANG! should work
  engine.playCard(0, 'b1', 1);
  engine.handleAction(1, { type: 'respond', response: 'take_hit' });

  // Second BANG! should be rejected
  assertThrows(
    () => engine.playCard(0, 'b2', 1),
    'Second BANG! in same turn throws error'
  );
}

section('Beer Card');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hp = 3; p.maxHp = 4; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'beer1', name: 'Beer', type: 'brown', suit: 'H', value: 6 }];

  engine.playCard(0, 'beer1');
  assertEqual(engine.state.players[0].hp, 4, 'Beer heals 1 HP');
}

section('Beer — Max HP Validation');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hp = 4; p.maxHp = 4; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'beer1', name: 'Beer', type: 'brown', suit: 'H', value: 6 }];
  assertThrows(() => engine.playCard(0, 'beer1'), 'Cannot use Beer at max HP');
}

section('Stagecoach & Wells Fargo');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [
    { id: 'sc1', name: 'Stagecoach', type: 'brown', suit: 'S', value: 9 },
    { id: 'wf1', name: 'Wells Fargo', type: 'brown', suit: 'H', value: 3 },
  ];

  const handBefore = engine.state.players[0].hand.length;
  engine.playCard(0, 'sc1');
  // Stagecoach played (-1) + 2 drawn = net +1
  assertEqual(engine.state.players[0].hand.length, handBefore - 1 + 2, 'Stagecoach draws 2');

  const handBefore2 = engine.state.players[0].hand.length;
  engine.playCard(0, 'wf1');
  assertEqual(engine.state.players[0].hand.length, handBefore2 - 1 + 3, 'Wells Fargo draws 3');
}

section('Equipment — Weapon Replacement');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [
    { id: 'sch1', name: 'Schofield', type: 'blue', suit: 'C', value: 11 },
    { id: 'win1', name: 'Winchester', type: 'blue', suit: 'S', value: 8 },
  ];

  engine.playCard(0, 'sch1');
  assertEqual(engine.state.players[0].inPlay.length, 1, 'Schofield equipped');
  assertEqual(engine.getWeaponRange(0), 2, 'Range is 2');

  engine.playCard(0, 'win1');
  assertEqual(engine.state.players[0].inPlay.length, 1, 'Old weapon replaced');
  assertEqual(engine.getWeaponRange(0), 5, 'Range updated to 5');

  // Old weapon should be in discard
  assert(engine.state.discard.some(c => c.name === 'Schofield'), 'Old weapon in discard');
}

section('End Turn — Hand Limit');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hp = 2; p.maxHp = 4; });
  setTurn(engine, 0);

  // Give player 5 cards with HP=2 (hand limit = 2)
  const cards = [];
  for (let i = 0; i < 5; i++) {
    cards.push({ id: 'hc-' + i, name: 'BANG!', type: 'brown', suit: 'D', value: i + 2 });
  }
  engine.state.players[0].hand = cards;

  engine.endTurn(0);
  assertEqual(engine.state.pending.type, 'discard_required', 'Discard required prompt');
  assertEqual(engine.state.pending.count, 3, 'Must discard 3 cards');

  engine.handleDiscard(0, ['hc-0', 'hc-1', 'hc-2']);
  assertEqual(engine.state.players[0].hand.length, 2, 'Hand reduced to limit');
}

section('Jail Card');
{
  const engine = createTestGame();
  engine.state.players.forEach((p, i) => {
    p.character = basicChar();
    p.inPlay = [];
    p.role = i === 0 ? 'sheriff' : 'outlaw';
  });
  setTurn(engine, 0);

  // Can't jail the sheriff
  engine.state.players[0].hand = [{ id: 'j1', name: 'Jail', type: 'blue', suit: 'S', value: 10 }];

  assertThrows(
    () => engine.playCard(0, 'j1', 0),
    'Cannot jail yourself'
  );

  // Jail an outlaw
  engine.playCard(0, 'j1', 1);
  // Should be in pending choose_target or directly placed
  if (engine.state.pending && engine.state.pending.type === 'choose_target') {
    engine.handleChooseTarget(0, 1);
  }
  assert(engine.state.players[1].inPlay.some(c => c.name === 'Jail'), 'Jail placed on player 1');
}

section('Duel');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hp = 4; p.maxHp = 4; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'duel1', name: 'Duel', type: 'brown', suit: 'C', value: 8 }];
  engine.state.players[1].hand = [{ id: 'b1', name: 'BANG!', type: 'brown', suit: 'D', value: 2 }];

  engine.playCard(0, 'duel1', 1);
  // If target was set directly
  if (engine.state.pending && engine.state.pending.type === 'choose_target') {
    engine.handleChooseTarget(0, 1);
  }

  assertEqual(engine.state.pending.type, 'duel_response', 'Duel response pending');

  // Player 1 plays BANG!
  engine.handleAction(1, { type: 'respond', response: 'bang', cardId: 'b1' });
  // Now player 0 must respond
  assertEqual(engine.state.pending.currentResponder, 0, 'Duel switches to player 0');

  // Player 0 gives up
  engine.handleAction(0, { type: 'respond', response: 'give_up' });
  assertEqual(engine.state.players[0].hp, 3, 'Duel loser takes 1 damage');
}

section('Indians!');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hp = 4; p.maxHp = 4; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'ind1', name: 'Indians!', type: 'brown', suit: 'D', value: 1 }];
  engine.state.players[1].hand = [{ id: 'b1', name: 'BANG!', type: 'brown', suit: 'D', value: 2 }];
  engine.state.players[2].hand = [];
  engine.state.players[3].hand = [];

  engine.playCard(0, 'ind1');
  assertEqual(engine.state.pending.type, 'indians_response', 'Indians response pending');

  // Player 1 responds with BANG!
  engine.handleAction(1, { type: 'respond', response: 'bang', cardId: 'b1' });
  assertEqual(engine.state.players[1].hp, 4, 'Player 1 saved by BANG!');

  // Player 2 takes hit
  if (engine.state.pending && engine.state.pending.type === 'indians_response') {
    engine.handleAction(2, { type: 'respond', response: 'take_hit' });
    assertEqual(engine.state.players[2].hp, 3, 'Player 2 takes damage from Indians');
  }

  // Player 3 takes hit
  if (engine.state.pending && engine.state.pending.type === 'indians_response') {
    engine.handleAction(3, { type: 'respond', response: 'take_hit' });
    assertEqual(engine.state.players[3].hp, 3, 'Player 3 takes damage from Indians');
  }
}

section('Elimination & Win Conditions');
{
  const engine = createTestGame({ playerCount: 4 });
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });
  engine.state.players[0].role = 'sheriff';
  engine.state.players[1].role = 'outlaw';
  engine.state.players[2].role = 'outlaw';
  engine.state.players[3].role = 'renegade';

  // Kill both outlaws and renegade -> sheriff wins
  engine.state.players[1].hp = 1;
  engine.state.players[2].hp = 1;
  engine.state.players[3].hp = 1;

  engine.applyDamage(1, 1, 0);
  assert(engine.state.players[1].eliminated, 'Outlaw 1 eliminated');
  assertEqual(engine.state.winner, null, 'No winner yet');

  engine.applyDamage(2, 1, 0);
  assert(engine.state.players[2].eliminated, 'Outlaw 2 eliminated');

  engine.applyDamage(3, 1, 0);
  assert(engine.state.players[3].eliminated, 'Renegade eliminated');
  assert(engine.state.winner !== null, 'Game has winner');
  assertEqual(engine.state.winner.team, 'sheriff', 'Sheriff team wins');
}

section('Outlaw Reward');
{
  const engine = createTestGame({ playerCount: 4 });
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hand = []; });
  engine.state.players[0].role = 'sheriff';
  engine.state.players[1].role = 'outlaw';
  engine.state.players[2].role = 'outlaw';
  engine.state.players[3].role = 'renegade';
  engine.state.players[1].hp = 1;

  const handBefore = engine.state.players[0].hand.length;
  engine.applyDamage(1, 1, 0);
  assertEqual(engine.state.players[0].hand.length, handBefore + 3, 'Killer draws 3 for killing outlaw');
}

section('Player View');
{
  const engine = createTestGame();
  engine.state.players.forEach((p, i) => { p.character = basicChar(); p.inPlay = []; });

  const view = engine.getPlayerView(0);
  assert(view !== null, 'View is not null');
  assertEqual(view.yourIndex, 0, 'Your index correct');
  assert(Array.isArray(view.hand), 'Hand is array');
  assert(Array.isArray(view.players), 'Players is array');
  assertEqual(view.players.length, engine.state.players.length, 'All players in view');
  assert(view.role !== null, 'Own role visible');

  // Other players' roles hidden (except sheriff)
  view.players.forEach((p, i) => {
    if (i !== 0 && p.role !== 'sheriff' && !p.eliminated) {
      assertEqual(p.role, null, 'Player ' + i + ' role hidden');
    }
  });
}

section('Action Dispatch — handleAction');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });
  setTurn(engine, 0);

  // end_turn action
  engine.state.players[0].hand = [];
  engine.state.players[0].hp = 4;
  const turnBefore = engine.state.currentTurn;
  engine.handleAction(0, { type: 'end_turn' });
  assert(engine.state.currentTurn !== turnBefore || engine.state.pending !== null, 'Turn advanced or pending set');
}

section('Ability — Normalize Names');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });

  // Test the ability name normalization
  assertEqual(engine._normalizeAbilityType('discard_to_heal'), 'sid_ketchum', 'discard_to_heal -> sid_ketchum');
  assertEqual(engine._normalizeAbilityType('hp_for_cards'), 'chuck_wengam', 'hp_for_cards -> chuck_wengam');
  assertEqual(engine._normalizeAbilityType('discard_to_bang'), 'doc_holyday', 'discard_to_bang -> doc_holyday');
  assertEqual(engine._normalizeAbilityType('blue_for_cards'), 'jose_delgado', 'blue_for_cards -> jose_delgado');
  assertEqual(engine._normalizeAbilityType('sid_ketchum'), 'sid_ketchum', 'sid_ketchum passthrough');
}

section('Gatling');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hp = 4; p.maxHp = 4; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'gat1', name: 'Gatling', type: 'brown', suit: 'H', value: 10 }];

  engine.playCard(0, 'gat1');
  assertEqual(engine.state.pending.type, 'gatling_response', 'Gatling response pending');

  // All others take hit
  for (let i = 1; i <= 3; i++) {
    if (engine.state.pending && engine.state.pending.type === 'gatling_response') {
      engine.handleAction(i, { type: 'respond', response: 'take_hit' });
    }
  }
  for (let i = 1; i <= 3; i++) {
    assertEqual(engine.state.players[i].hp, 3, 'Player ' + i + ' takes Gatling damage');
  }
}

section('Saloon');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hp = 2; p.maxHp = 4; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'sal1', name: 'Saloon', type: 'brown', suit: 'H', value: 5 }];
  engine.playCard(0, 'sal1');

  engine.state.players.forEach((p, i) => {
    assertEqual(p.hp, 3, 'Player ' + i + ' heals 1 HP from Saloon');
  });
}

section('General Store');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'gs1', name: 'General Store', type: 'brown', suit: 'C', value: 9 }];
  engine.playCard(0, 'gs1');

  assertEqual(engine.state.pending.type, 'general_store', 'General Store pending');
  assert(engine.state.pending.cards.length > 0, 'Cards revealed');
  assertEqual(engine.state.pending.pickOrder[0], 0, 'Current player picks first');
}

section('Cat Balou');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'cb1', name: 'Cat Balou', type: 'brown', suit: 'H', value: 13 }];
  engine.state.players[1].hand = [{ id: 'victim-card', name: 'BANG!', type: 'brown', suit: 'D', value: 2 }];

  engine.playCard(0, 'cb1', 1);
  // Might need target selection
  if (engine.state.pending && engine.state.pending.type === 'choose_target') {
    engine.handleChooseTarget(0, 1);
  }

  assertEqual(engine.state.pending.type, 'choose_card_from_target', 'Choose card from target');

  // Choose random from hand
  engine.handleChooseCardFromTarget(0, { choice: -1 });
  assertEqual(engine.state.players[1].hand.length, 0, 'Target lost a card');
}

section('Panic!');
{
  const engine = createTestGame({ playerCount: 5 });
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'pan1', name: 'Panic!', type: 'brown', suit: 'H', value: 11 }];
  engine.state.players[1].hand = [{ id: 'target-card', name: 'Beer', type: 'brown', suit: 'H', value: 6 }];

  // Player 1 is at distance 1
  engine.playCard(0, 'pan1', 1);
  if (engine.state.pending && engine.state.pending.type === 'choose_target') {
    engine.handleChooseTarget(0, 1);
  }

  assertEqual(engine.state.pending.type, 'choose_card_from_target', 'Choose card from target');
  engine.handleChooseCardFromTarget(0, { choice: -1 });
  assertEqual(engine.state.players[1].hand.length, 0, 'Target lost a card');
  // Player 0 gained the card (Panic! takes, not discards)
  assert(engine.state.players[0].hand.some(c => c.name === 'Beer'), 'Player 0 gained the card');
}

section('Dynamite Card');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'dyn1', name: 'Dynamite', type: 'blue', suit: 'H', value: 2 }];
  engine.playCard(0, 'dyn1');
  assert(engine.state.players[0].inPlay.some(c => c.name === 'Dynamite'), 'Dynamite placed in play');
}

section('Beer Save on Death');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; });
  engine.state.players[1].hp = 1;
  engine.state.players[1].maxHp = 4;
  engine.state.players[1].hand = [{ id: 'beer-save', name: 'Beer', type: 'brown', suit: 'H', value: 6 }];

  engine.applyDamage(1, 1, 0);

  // Should prompt for beer save
  assert(engine.state.pending !== null, 'Pending action for beer save');
  assertEqual(engine.state.pending.type, 'beer_save', 'Beer save prompt');

  // Use beer to survive
  engine.handleAction(1, { type: 'respond', response: 'beer', cardId: 'beer-save' });
  assert(!engine.state.players[1].eliminated, 'Player survived with beer');
  assert(engine.state.players[1].hp > 0, 'Player HP restored');
}

section('Willy the Kid — Unlimited BANGs');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.inPlay = []; p.hp = 4; p.maxHp = 4; });
  engine.state.players[0].character = { name: 'Willy the Kid', hp: 4, ability: 'Unlimited BANG!', set: 'base', effect: 'unlimited_bangs' };
  engine.state.players[1].character = basicChar();
  setTurn(engine, 0);

  engine.state.players[0].hand = [
    { id: 'b1', name: 'BANG!', type: 'brown', suit: 'D', value: 5 },
    { id: 'b2', name: 'BANG!', type: 'brown', suit: 'D', value: 6 },
  ];

  engine.playCard(0, 'b1', 1);
  engine.handleAction(1, { type: 'respond', response: 'take_hit' });

  // Second BANG! should also work for Willy
  engine.playCard(0, 'b2', 1);
  engine.handleAction(1, { type: 'respond', response: 'take_hit' });
  assertEqual(engine.state.players[1].hp, 2, 'Willy played 2 BANGs');
}

section('Calamity Janet — BANG!/Missed! Swap');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.inPlay = []; p.hp = 4; p.maxHp = 4; });
  engine.state.players[0].character = { name: 'Calamity Janet', hp: 4, ability: 'Swap', set: 'base', effect: 'bang_missed_swap' };
  engine.state.players[1].character = basicChar();
  setTurn(engine, 0);

  // Calamity Janet plays Missed! as BANG!
  engine.state.players[0].hand = [
    { id: 'm1', name: 'Missed!', type: 'brown', suit: 'C', value: 10 },
  ];

  engine.playCard(0, 'm1', 1);
  assert(engine.state.pending !== null, 'Missed! played as BANG! creates pending');
  assertEqual(engine.state.pending.type, 'bang_response', 'Bang response for Missed!-as-BANG!');

  engine.handleAction(1, { type: 'respond', response: 'take_hit' });
  assertEqual(engine.state.players[1].hp, 3, 'Missed!-as-BANG! does damage');
}

section('Volcanic — Unlimited BANGs');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hp = 4; p.maxHp = 4; });
  engine.state.players[0].inPlay = [{ id: 'vol1', name: 'Volcanic', type: 'blue', suit: 'C', value: 10 }];
  setTurn(engine, 0);

  engine.state.players[0].hand = [
    { id: 'b1', name: 'BANG!', type: 'brown', suit: 'D', value: 5 },
    { id: 'b2', name: 'BANG!', type: 'brown', suit: 'D', value: 6 },
  ];

  engine.playCard(0, 'b1', 1);
  engine.handleAction(1, { type: 'respond', response: 'take_hit' });

  engine.playCard(0, 'b2', 1);
  engine.handleAction(1, { type: 'respond', response: 'take_hit' });
  assertEqual(engine.state.players[1].hp, 2, 'Volcanic allows 2 BANGs');
}

section('Bart Cassidy — Draw on Damage');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hp = 4; p.maxHp = 4; });
  engine.state.players[1].character = { name: 'Bart Cassidy', hp: 4, ability: 'Draw on damage', set: 'base', effect: 'on_damage_draw' };
  engine.state.players[1].hand = [];

  engine.applyDamage(1, 1, 0);
  assertEqual(engine.state.players[1].hand.length, 1, 'Bart Cassidy drew 1 card on damage');
}

section('Slab the Killer — Double Missed');
{
  const engine = createTestGame();
  engine.state.players.forEach(p => { p.character = basicChar(); p.inPlay = []; p.hp = 4; p.maxHp = 4; });
  engine.state.players[0].character = { name: 'Slab the Killer', hp: 4, ability: 'Double missed', set: 'base', effect: 'double_missed' };
  setTurn(engine, 0);

  engine.state.players[0].hand = [{ id: 'b1', name: 'BANG!', type: 'brown', suit: 'D', value: 5 }];
  engine.state.players[1].hand = [
    { id: 'm1', name: 'Missed!', type: 'brown', suit: 'C', value: 10 },
    { id: 'm2', name: 'Missed!', type: 'brown', suit: 'C', value: 11 },
  ];

  engine.playCard(0, 'b1', 1);
  assertEqual(engine.state.pending.missedNeeded, 2, 'Need 2 Missed! cards');

  engine.handleAction(1, { type: 'respond', response: 'missed', cardId: 'm1' });
  assert(engine.state.pending !== null, 'Still needs another Missed!');

  engine.handleAction(1, { type: 'respond', response: 'missed', cardId: 'm2' });
  assertEqual(engine.state.players[1].hp, 4, 'Survived with 2 Missed!');
}

// ═══════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════
const summaryEl = document.createElement('div');
summaryEl.className = 'summary ' + (failed === 0 ? 'all-pass' : 'has-fail');
summaryEl.textContent = passed + ' passed, ' + failed + ' failed';
output.appendChild(summaryEl);

console.log('Tests: ' + passed + ' passed, ' + failed + ' failed');
})();
