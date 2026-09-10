# Texas Hold'em

Multiplayer Texas Hold'em poker game playable on mobile devices. Uses PeerJS for real-time peer-to-peer networking — one player hosts the table and others join with a room code.

## Features

- Full Texas Hold'em rules with proper hand evaluation
- 2–8 player multiplayer via PeerJS (WebRTC)
- Mobile-friendly touch interface
- Automatic blind rotation and dealer button
- Side pot calculations for all-in scenarios
- Disconnect/reconnect support with state recovery
- No server required — fully peer-to-peer

## At the table

- **45-second turn clock.** Whoever is to act sees a countdown in the top bar. When it
  runs out the table acts for them — check if they are facing nothing, fold if they are
  — so one player who walks away (or leaves a tab open on another device) cannot freeze
  everybody else.
- **A dropped player keeps their hand.** A phone that blinks is marked *Away* and the
  clock keeps running; their cards are only mucked when the clock expires, not the
  moment the connection wobbles.
- **Bluffs stay bluffs.** Winning a pot because everyone folded no longer turns your
  hole cards face up. Cards are only revealed at a real showdown.
- **Busted players keep watching.** Losing your last chips leaves you at the table as a
  spectator with a live view of the board, instead of a frozen screen.
- **Joining is refused with a reason.** A latecomer, a ninth player or a duplicate name
  is told why and sent back to the lobby.
- **Dropping out before the first deal costs you nothing.** If your connection dies in
  the waiting room and stays down long enough for the table to release your seat, coming
  back just sits you down again under your own name — no seat code, no "that name is
  already at this table".
- **Coming back on another device: your seat code.** When you sit down the host issues
  your seat a four-character code. It is remembered on that device, so reopening the
  table in a new tab just works; if you have to move to a *different* phone, type the
  code into **Seat Code** on the join screen and you get your own seat back — chips,
  cards and all — even in the middle of a hand. Your code is in your **Menu**, and the
  host has the whole list in theirs, so they can read yours out if your phone is dead.
  A name is not a credential: typing somebody else's name gets you nothing.

## Host controls

The host's **Menu** has three extra controls during a game:

- **Fold / Check for `<player>`** — act for whoever the table is waiting on, without
  waiting for the turn clock. The button names the seat it will act for, and refuses (with
  "The turn has already moved on") if the table moves while the menu is open.
- **Remove `<player>`** — take a seat off the table for good. They are folded out of the
  current hand, their seat is removed before the next one, and the removal sticks: a
  removed player's reconnect no longer walks them back in.
- **Seat codes** — the list of every player's rejoin code, to read out to someone who has
  lost their tab. Seats whose player is away are marked *(away)* and stay on the list:
  those are exactly the people who need their code read out. Only a seat the host has
  deliberately **removed** drops off it.

The host is also told when the table's room code stops being reachable ("New players
cannot join right now") — the game itself carries on over the connections it already has.

**Leave Table** (host) now ends the room properly: every player is told the host left
instead of reconnecting against a room that no longer exists. A player's **Leave Table**
tells the host first, so their seat is freed rather than sitting out hands as *Away*.
