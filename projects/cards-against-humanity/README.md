# Cards Against Humanity

A peer-to-peer browser-based Cards Against Humanity party game. One player creates a game and shares the code — others join directly via WebRTC (PeerJS). No server needed beyond the signaling service.

## How to play

1. Open the page and enter your name
2. **Create** a game or **Join** with a game code
3. Need 3+ players to start
4. Each round, one player is the Card Czar who reads the black card
5. Other players pick white cards to fill in the blanks
6. The Czar picks the funniest answer — that player scores a point
7. First to the score limit wins

## Dropping out and coming back

- A player whose phone locks, or who walks out of range, is shown as **(away)** rather than
  removed. Their score, their hand and any cards they already played this round are kept, and
  the round finishes without waiting for them.
- If the **Card Czar** goes away, the crown moves on to the next player who is present, and
  the host can also pick the winner while the czar is missing.
- Reloading the page, or reopening the game on another device, gives you your own seat back —
  same score, same hand, same round — as long as you use the same name. The tab you left is
  told the game is open on another device and goes back to the join form, so you never appear
  at the table twice.
- Names are unique per game: joining with a name someone at the table is *currently* using is
  refused with a message saying so. A name only becomes free again once that player is shown
  as away — which can take up to about twenty seconds after a tab dies without closing
  cleanly, so if you are refused your own name, wait a moment and try again.
- The seat behind a name is not first-come-first-served, though. Once the game has told your
  tab that a name belongs to somebody else, that tab cannot pick the seat up when its owner
  goes away — it is refused again, and joins under a different name instead. So two people
  who both type "Mum" get a seat each, and neither ends up playing the other's hand: an
  absent player's score, cards and turn as Czar are still theirs when they come back.
- Somebody can join in the middle of a game. They are dealt a hand straight away and may play
  the round in progress, but that round is **not** held up waiting for them — the players who
  were already in it finish it on their own. From the next round they are an ordinary player.
- If the host ends the game (**New Game** on the podium, or closing the tab), everyone is told
  the host ended it instead of being left reconnecting.
- Trade-off worth knowing: the round stops waiting for a player the moment they are marked
  away, so a twenty-second blip while you are still choosing cards costs you that round. Your
  score and your hand are untouched, and you are dealt back in for the next one.

## Host controls

The host sees two extra buttons on the game screen, so a stuck round never means reloading
the room and losing every score:

- **Start judging now** — go to judging with the answers that have been played (enabled once
  at least one player has submitted).
- **Skip round** — abandon the current black card and deal the next round. It takes two taps
  (the button asks you to confirm) because it throws away cards the table has already played.
  The confirmation lapses after three seconds — including on a round where nothing else is
  happening, which is exactly the round this button is for.

The host also sees the live submitted counter, and picks the winner for a czar who is away.

## Tech

- Static HTML/CSS/JS (no build step)
- PeerJS (CDN) for WebRTC peer-to-peer connections, via the shared `lib/slopnet` +
  `lib/sloplobby` (reconnection, seat tokens, message queueing)
- The host is authoritative: every command is checked against the sender, the phase and the
  round number, and cards are validated against the hand the host dealt
- Judging is anonymous on the wire as well as on screen — the answers are broadcast under a
  fresh per-round key, never under the id of the player who wrote them
- Players are named on the wire by an alias the host mints, never by the connection id their
  browser stores. That id is what proves a seat is yours when you come back, so no other page
  at the table is ever shown one — not even the host's
- Nothing that arrives over the wire can speak as the host: the host's own taps are marked
  with a value that cannot be serialised
- 1,322 cards (275 black, 1,047 white) from the Cards Against Humanity dataset
- Cards Against Humanity is distributed under CC BY-NC-SA 4.0

## Tests

`lib/slopnet/__tests__/app-cah.test.js`,
`lib/slopnet/__tests__/app-cah-doors-and-controls.test.js` (the Create/Join doors, the seat
behind a name, and the host's own buttons) and
`lib/slopnet/__tests__/repro-6-cah-one-human-two-seats-deadlocks-round.test.js` load this
page's real inline script against a DOM stub and the mock peer transport:

```bash
cd lib/slopnet && npm install && npx vitest run
```
