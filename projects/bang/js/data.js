// Bang! The Bullet — Game Data
// Characters, deck definitions, role distributions
(function(exports) {
'use strict';

// Suit constants
const H = 'H', D = 'D', C = 'C', S = 'S';

const SUIT_SYMBOLS = {H:'♥', D:'♦', C:'♣', S:'♠'};
const SUIT_NAMES = {H:'Hearts', D:'Diamonds', C:'Clubs', S:'Spades'};
const VALUE_NAMES = {1:'A',2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K'};
const SUIT_COLORS = {H:'#e74c3c', D:'#e74c3c', C:'#e8e4d4', S:'#e8e4d4'};

// ─── Characters ───────────────────────────────────────────
const CHARACTERS = [
  // Base Game (16 characters)
  {name:'Bart Cassidy',     hp:4, ability:'Each time he loses a life point, he draws a card.', set:'base', effect:'on_damage_draw'},
  {name:'Black Jack',       hp:4, ability:'Show 2nd drawn card: if Heart or Diamond, draw 1 more.', set:'base', effect:'draw_bonus_red'},
  {name:'Calamity Janet',   hp:4, ability:'Can use BANG! as Missed! and vice versa.', set:'base', effect:'bang_missed_swap'},
  {name:'El Gringo',        hp:3, ability:'When hit by a player, draw a card from their hand.', set:'base', effect:'on_damage_steal'},
  {name:'Jesse Jones',      hp:4, ability:'May draw 1st card from any player\'s hand.', set:'base', effect:'draw_from_player'},
  {name:'Jourdonnais',      hp:4, ability:'Built-in Barrel: "draw!" on Heart = missed.', set:'base', effect:'builtin_barrel'},
  {name:'Kit Carlson',      hp:4, ability:'Look at top 3 cards, choose 2, put 1 back.', set:'base', effect:'draw_pick_3'},
  {name:'Lucky Duke',       hp:4, ability:'For "draw!", flip 2 cards and choose one.', set:'base', effect:'lucky_draw'},
  {name:'Paul Regret',      hp:3, ability:'Others see him at distance +1 (built-in Mustang).', set:'base', effect:'builtin_mustang'},
  {name:'Pedro Ramirez',    hp:4, ability:'May draw 1st card from discard pile.', set:'base', effect:'draw_from_discard'},
  {name:'Rose Doolan',      hp:4, ability:'Sees all others at distance -1 (built-in Scope).', set:'base', effect:'builtin_scope'},
  {name:'Sid Ketchum',      hp:4, ability:'May discard 2 cards to regain 1 life point.', set:'base', effect:'discard_to_heal'},
  {name:'Slab the Killer',  hp:4, ability:'His BANG! requires 2 Missed! to cancel.', set:'base', effect:'double_missed'},
  {name:'Suzy Lafayette',   hp:4, ability:'Draws a card when her hand is empty.', set:'base', effect:'draw_on_empty'},
  {name:'Vulture Sam',      hp:4, ability:'Takes all cards from eliminated players.', set:'base', effect:'vulture'},
  {name:'Willy the Kid',    hp:4, ability:'Can play any number of BANG! cards.', set:'base', effect:'unlimited_bangs'},
  // Dodge City (15 characters)
  {name:'Apache Kid',       hp:3, ability:'Diamond cards by others have no effect on him.', set:'dodge', effect:'diamond_immune'},
  {name:'Belle Star',       hp:4, ability:'During her turn, others\' in-play cards have no effect.', set:'dodge', effect:'nullify_equipment'},
  {name:'Bill Noface',      hp:4, ability:'Draws 1 card + 1 per wound he has.', set:'dodge', effect:'draw_per_wound'},
  {name:'Chuck Wengam',     hp:4, ability:'May lose 1 HP to draw 2 cards during his turn.', set:'dodge', effect:'hp_for_cards'},
  {name:'Doc Holyday',      hp:4, ability:'May discard 2 cards to shoot a BANG! at a player.', set:'dodge', effect:'discard_to_bang'},
  {name:'Elena Fuente',     hp:3, ability:'May use any card as Missed!', set:'dodge', effect:'any_as_missed'},
  {name:'Greg Digger',      hp:4, ability:'Regains 2 HP when another player is eliminated.', set:'dodge', effect:'heal_on_eliminate'},
  {name:'Herb Hunter',      hp:4, ability:'Draws 2 extra cards when another player is eliminated.', set:'dodge', effect:'draw_on_eliminate'},
  {name:'José Delgado',     hp:4, ability:'Twice per turn, discard a blue card to draw 2.', set:'dodge', effect:'blue_for_cards'},
  {name:'Molly Stark',      hp:4, ability:'Draws a card when using a card out of turn.', set:'dodge', effect:'draw_on_react'},
  {name:'Pat Brennan',      hp:4, ability:'May draw 1 card in play from any player instead of normal draw.', set:'dodge', effect:'draw_from_inplay'},
  {name:'Pixie Pete',       hp:3, ability:'Draws 3 cards instead of 2.', set:'dodge', effect:'draw_three'},
  {name:'Sean Mallory',     hp:3, ability:'Hand limit is 10 instead of current HP.', set:'dodge', effect:'big_hand'},
  {name:'Tequila Joe',      hp:4, ability:'Beer gives him 2 life points instead of 1.', set:'dodge', effect:'super_beer'},
  {name:'Vera Custer',      hp:3, ability:'Copies another character\'s ability each turn.', set:'dodge', effect:'copy_ability'},
];

// ─── Role Distribution ───────────────────────────────────
const ROLE_DIST = {
  4: {sheriff:1, deputy:0, outlaw:2, renegade:1},
  5: {sheriff:1, deputy:1, outlaw:2, renegade:1},
  6: {sheriff:1, deputy:1, outlaw:3, renegade:1},
  7: {sheriff:1, deputy:2, outlaw:3, renegade:1},
  8: {sheriff:1, deputy:2, outlaw:3, renegade:2},
};

// ─── Deck Template ────────────────────────────────────────
// Each entry: [name, type, suit, value]
// Suits: H=Hearts, D=Diamonds, C=Clubs, S=Spades
// Values: 1=A, 2-10, 11=J, 12=Q, 13=K

function c(name, type, suit, value) { return {name, type, suit, value}; }

const BASE_DECK = [
  // BANG! x25
  c('BANG!','brown',S,1), c('BANG!','brown',D,2), c('BANG!','brown',D,3),
  c('BANG!','brown',D,4), c('BANG!','brown',D,5), c('BANG!','brown',D,6),
  c('BANG!','brown',D,7), c('BANG!','brown',D,8), c('BANG!','brown',D,9),
  c('BANG!','brown',D,10), c('BANG!','brown',D,11), c('BANG!','brown',D,12),
  c('BANG!','brown',D,13), c('BANG!','brown',D,1), c('BANG!','brown',C,2),
  c('BANG!','brown',C,3), c('BANG!','brown',C,4), c('BANG!','brown',C,5),
  c('BANG!','brown',C,6), c('BANG!','brown',C,7), c('BANG!','brown',C,8),
  c('BANG!','brown',C,9), c('BANG!','brown',H,12), c('BANG!','brown',H,13),
  c('BANG!','brown',H,1),
  // Missed! x12
  c('Missed!','brown',C,10), c('Missed!','brown',C,11), c('Missed!','brown',C,12),
  c('Missed!','brown',C,13), c('Missed!','brown',C,1), c('Missed!','brown',S,2),
  c('Missed!','brown',S,3), c('Missed!','brown',S,4), c('Missed!','brown',S,5),
  c('Missed!','brown',S,6), c('Missed!','brown',S,7), c('Missed!','brown',S,8),
  // Beer x6
  c('Beer','brown',H,6), c('Beer','brown',H,7), c('Beer','brown',H,8),
  c('Beer','brown',H,9), c('Beer','brown',H,10), c('Beer','brown',H,11),
  // Saloon x1
  c('Saloon','brown',H,5),
  // Stagecoach x2
  c('Stagecoach','brown',S,9), c('Stagecoach','brown',S,9),
  // Wells Fargo x1
  c('Wells Fargo','brown',H,3),
  // Panic! x4
  c('Panic!','brown',H,11), c('Panic!','brown',H,12), c('Panic!','brown',H,1), c('Panic!','brown',D,8),
  // Cat Balou x4
  c('Cat Balou','brown',H,13), c('Cat Balou','brown',S,11), c('Cat Balou','brown',S,12), c('Cat Balou','brown',D,9),
  // General Store x2
  c('General Store','brown',C,9), c('General Store','brown',S,12),
  // Duel x3
  c('Duel','brown',C,8), c('Duel','brown',S,11), c('Duel','brown',D,12),
  // Indians! x2
  c('Indians!','brown',D,1), c('Indians!','brown',D,1),
  // Gatling x1
  c('Gatling','brown',H,10),
  // Blue cards — Equipment
  // Barrel x2
  c('Barrel','blue',S,12), c('Barrel','blue',S,13),
  // Scope x1
  c('Scope','blue',S,1),
  // Mustang x2
  c('Mustang','blue',H,8), c('Mustang','blue',H,9),
  // Jail x3
  c('Jail','blue',S,10), c('Jail','blue',S,11), c('Jail','blue',H,4),
  // Dynamite x1
  c('Dynamite','blue',H,2),
  // Weapons
  c('Volcanic','blue',C,10), c('Volcanic','blue',S,10),
  c('Schofield','blue',C,11), c('Schofield','blue',C,12), c('Schofield','blue',S,13),
  c('Remington','blue',C,13),
  c('Rev. Carabine','blue',C,1),
  c('Winchester','blue',S,8),
];
// Total: 25+12+6+1+2+1+4+4+2+3+2+1+2+1+2+3+1+2+3+1+1+1 = 80

const DODGE_DECK = [
  // Brown cards
  c('Punch','brown',S,1), c('Punch','brown',S,10),
  c('Springfield','brown',C,13), c('Springfield','brown',S,1),
  c('Brawl','brown',S,13), c('Brawl','brown',S,12),
  c('Rag Time','brown',H,9), c('Rag Time','brown',H,10),
  c('Whisky','brown',S,1), c('Whisky','brown',S,9),
  c('Tequila','brown',C,9), c('Tequila','brown',C,10),
  c('Pony Express','brown',H,1), c('Pony Express','brown',H,2),
  // Blue cards
  c('Hideout','blue',D,7), c('Hideout','blue',D,8),
  c('Binocular','blue',D,1),
  c('Sombrero','blue',S,8), c('Ten Gallon Hat','blue',S,9),
  // Green cards
  c('Dodge','green',D,11), c('Dodge','green',D,12), c('Dodge','green',D,13),
  c('Bible','green',H,10), c('Bible','green',H,11),
  c('Iron Plate','green',S,3), c('Iron Plate','green',S,4),
  c('Derringer','green',C,1), c('Derringer','green',C,2),
  c('Howitzer','green',S,5),
  c('Pepperbox','green',C,3),
  c('Buffalo Rifle','green',S,6),
  c('Can Can','green',D,9), c('Can Can','green',D,10),
  c('Conestoga','green',H,3), c('Conestoga','green',H,4),
];

// ─── Card info for tooltips/help ──────────────────────────
const CARD_INFO = {
  'BANG!':          {desc:'Shoot a player in weapon range. 1 per turn unless ability/Volcanic.', target:'enemy_in_range'},
  'Missed!':        {desc:'Cancel a BANG! targeting you.', target:'none'},
  'Beer':           {desc:'Regain 1 HP. Not usable with only 2 players alive.', target:'self'},
  'Saloon':         {desc:'All players regain 1 HP.', target:'all'},
  'Stagecoach':     {desc:'Draw 2 cards from deck.', target:'self'},
  'Wells Fargo':    {desc:'Draw 3 cards from deck.', target:'self'},
  'Panic!':         {desc:'Draw a card from a player at distance 1.', target:'enemy_dist1'},
  'Cat Balou':      {desc:'Force any player to discard a card.', target:'any_player'},
  'General Store':  {desc:'Reveal cards = alive players. Each picks one in turn order.', target:'all'},
  'Duel':           {desc:'Challenge any player. Alternate discarding BANG!; first who can\'t loses 1 HP.', target:'any_player'},
  'Indians!':       {desc:'All others discard a BANG! or lose 1 HP.', target:'all_others'},
  'Gatling':        {desc:'All others take 1 damage.', target:'all_others'},
  'Barrel':         {desc:'"Draw!" when targeted by BANG!; Heart = missed.', target:'self_equip'},
  'Scope':          {desc:'See all others at distance -1.', target:'self_equip'},
  'Mustang':        {desc:'Others see you at distance +1.', target:'self_equip'},
  'Hideout':        {desc:'Others see you at distance +1 (stacks with Mustang).', target:'self_equip'},
  'Binocular':      {desc:'See all others at distance -1.', target:'self_equip'},
  'Jail':           {desc:'Target draws! at turn start. Heart = free, else skip. Not on Sheriff.', target:'enemy_not_sheriff'},
  'Dynamite':       {desc:'Passes each turn. Spades 2-9 = 3 damage!', target:'self_equip'},
  'Volcanic':       {desc:'Weapon (range 1). Unlimited BANG! per turn.', target:'self_weapon'},
  'Schofield':      {desc:'Weapon (range 2).', target:'self_weapon'},
  'Remington':      {desc:'Weapon (range 3).', target:'self_weapon'},
  'Rev. Carabine':  {desc:'Weapon (range 4).', target:'self_weapon'},
  'Winchester':     {desc:'Weapon (range 5).', target:'self_weapon'},
  'Sombrero':       {desc:'When you lose HP, discard to cancel it.', target:'self_equip'},
  'Ten Gallon Hat': {desc:'When you lose HP, discard to cancel it.', target:'self_equip'},
  // Dodge City brown
  'Punch':          {desc:'Like BANG! but doesn\'t count toward 1-per-turn limit.', target:'enemy_in_range'},
  'Springfield':    {desc:'Discard a card to shoot any player regardless of distance.', target:'any_player'},
  'Brawl':          {desc:'Discard a card. All others discard a card from play or lose one from hand.', target:'all_others'},
  'Rag Time':       {desc:'Force any player to discard a card, then draw a card.', target:'any_player'},
  'Whisky':         {desc:'Discard a card to regain 2 HP.', target:'self'},
  'Tequila':        {desc:'Discard a card. Any one player regains 1 HP.', target:'any_player'},
  'Pony Express':   {desc:'Draw 3 cards from deck.', target:'self'},
  // Dodge City green
  'Dodge':          {desc:'When BANG!\'d, discard: Missed! + draw a card.', target:'self_equip'},
  'Bible':          {desc:'When losing HP, discard and draw! Heart/Diamond = avoid.', target:'self_equip'},
  'Iron Plate':     {desc:'When losing HP, discard and draw! Spade/Club = avoid.', target:'self_equip'},
  'Derringer':      {desc:'Discard: BANG! at distance 1 + draw a card.', target:'self_equip'},
  'Howitzer':       {desc:'Discard: 1 damage to all others (like Gatling).', target:'self_equip'},
  'Pepperbox':      {desc:'Discard: BANG! any player regardless of distance.', target:'self_equip'},
  'Buffalo Rifle':  {desc:'Discard: BANG! any player. No other BANG! this turn.', target:'self_equip'},
  'Can Can':        {desc:'When BANG!\'d, discard: draw a card from attacker.', target:'self_equip'},
  'Conestoga':      {desc:'When BANG!\'d, discard: draw a card from player at distance 1.', target:'self_equip'},
};

const WEAPONS = {
  'Volcanic': 1, 'Schofield': 2, 'Remington': 3,
  'Rev. Carabine': 4, 'Winchester': 5,
};

const EQUIPMENT_NAMES = [
  'Barrel','Scope','Mustang','Jail','Dynamite','Hideout','Binocular',
  'Sombrero','Ten Gallon Hat',
  'Dodge','Bible','Iron Plate','Derringer','Howitzer','Pepperbox',
  'Buffalo Rifle','Can Can','Conestoga',
];

// ─── Helpers ──────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createDeck(useDodgeCity) {
  let template = [...BASE_DECK];
  if (useDodgeCity) template = template.concat(DODGE_DECK);
  let nextId = 1;
  const deck = template.map(t => ({...t, id: 'card-' + (nextId++)}));
  return shuffle(deck);
}

function cardStr(card) {
  if (!card) return '?';
  return card.name + ' ' + SUIT_SYMBOLS[card.suit] + VALUE_NAMES[card.value];
}

function cardDrawStr(card) {
  return SUIT_SYMBOLS[card.suit] + VALUE_NAMES[card.value];
}

function isHeart(card) { return card.suit === H; }
function isDiamond(card) { return card.suit === D; }
function isRed(card) { return card.suit === H || card.suit === D; }
function isSpade2to9(card) { return card.suit === S && card.value >= 2 && card.value <= 9; }

function isWeapon(card) { return card.name in WEAPONS; }
function isBang(card) { return card.name === 'BANG!' || card.name === 'Punch'; }
function isMissed(card) { return card.name === 'Missed!'; }
function isBeer(card) { return card.name === 'Beer'; }
function isEquipment(card) { return card.type === 'blue' || card.type === 'green'; }
function isBlueEquipment(card) { return card.type === 'blue'; }
function isGreenEquipment(card) { return card.type === 'green'; }

function getWeaponRange(card) { return WEAPONS[card.name] || 0; }

exports.BangData = {
  CHARACTERS, ROLE_DIST, CARD_INFO, WEAPONS, EQUIPMENT_NAMES,
  SUIT_SYMBOLS, SUIT_NAMES, VALUE_NAMES, SUIT_COLORS,
  BASE_DECK, DODGE_DECK,
  shuffle, createDeck, cardStr, cardDrawStr,
  isHeart, isDiamond, isRed, isSpade2to9,
  isWeapon, isBang, isMissed, isBeer,
  isEquipment, isBlueEquipment, isGreenEquipment,
  getWeaponRange,
};
})(window);
