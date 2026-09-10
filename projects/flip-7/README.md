# Flip 7 Scoreboard

A score tracker for the Flip 7 press-your-luck card game. Track players, rounds, and scoring across a full game to 200 points. Supports both the original game and the standalone sequel **Flip 7: With a Vengeance** (including its optional Brutal Mode).

## Features

- Add 2–10 players
- Choose a ruleset before the game: **Classic** or **With a Vengeance** — the choice is locked in when the game starts, since every round on the scoreboard is scored under it
- Per-round scoring with tap-to-select number cards
- Automatic Flip 7 bonus detection (+15 for 7 unique cards)
- Bust tracking
- Quick actions: **All Bust** (one tap to bust everyone you're scoring, tap again to undo — the undo also hands back any seats the first tap took over), **Clear All**, and a per-player **Clear**

### Classic ruleset

- Number cards 0–12
- Modifier cards (+2, +4, +6, +8, +10) and x2 multiplier
- Score = (number cards × multiplier) + modifiers + Flip 7 bonus

### With a Vengeance ruleset

- Number cards 1–13 plus the special number cards: **The Zero** (scores 0 unless you Flip 7), **Lucky 13** (a second 13 that doesn't bust) and **Unlucky 7** (counts as a 7)
- Negative modifier cards (−2, −4, −6, −8, −10) and **÷2** (halves the number-card total, rounded down, before the negatives)
- Round scores never drop below 0 in standard play
- **Brutal Mode** toggle: round scores can go negative, modifiers count against busted players, and a Flip 7 can deal −15 to a chosen opponent instead of +15 to yourself
- Rules reference covers the new action cards (Just One More, Flip Four, Swap, Steal, Discard)
- Live score breakdown and progress bars
- Running standings with round-by-round history
- Winner detection at 200+ points
- Game state saved to localStorage
- Quick rules reference built in

## Playing together

Three modes: **Single Device** (one person keeps score), **Host Game** (share a room code) and **Join Game**. Hosting and joining are peer-to-peer over `lib/slopnet` + `lib/sloplobby` — there is no server holding the game.

### For the host

- **Add Local Player** seats someone without a phone; you enter their scores.
- Each joined player's card shows their own submitted score. **Edit** (or **Enter Score** for a player who is waiting or offline) lets you type one instead. Your version is kept, their submission is not thrown away, and the card gains a **Cancel** button — **Use their score** once they have actually sent one — so an override can always be undone. Their chip reads `✓ (overridden)` while both exist. The player is told you are entering their score and can still send their own.
- If a player sends a score while you are typing theirs, you are told; whichever you keep is your choice.
- A player whose phone drops out of the lobby is greyed out as **(away)** rather than vanishing, and cannot make up the two-player minimum for Start. Tap the **×** beside an away seat to drop it if they are not coming back. Mid-game they keep their seat and their scores — you can score for them until they are back.
- A player who comes back mid-game in a **fresh tab** (browser restarted, tab closed) is re-seated under their own name instead of being turned away. If somebody else has typed that name in the meantime, the connection the seat actually belongs to gets it back when it returns — and any score sent from the seat while it was in other hands is dropped rather than scored as theirs.
- The same applies in the lobby: a seat left behind by a phone that is gone is released as soon as its owner types that name again, so nobody is refused their own name while their dead tab's seat is still being held.
- **Reloading your own tab does not end the game.** The room code is remembered, so the room comes back under it and everybody's phone reconnects; only Reset Game, New Game and Cancel say goodbye.
- If your connection to the signalling server is lost for good, the banner says so and stays saying so — the room keeps working for everyone already in it.
- **Ask for a Rematch** from a player appears on your **Play Again** button (`Play Again (Bob asked)`). Only you can actually restart the game — nobody else can wipe the final standings.
- **Reset Game**, **New Game** and **Cancel** in the lobby now close the room properly: every phone is told the host ended the game instead of spending minutes reconnecting to a room that is gone. The button says `Closing room…` for the second or so this takes.

### For a joined player

- **Reset Game** is **Leave Game** on your phone: it tells the host, so your seat is freed rather than left behind being scored 0 every round. It is a one-way door — the confirm says so, because your seat is given up.
- **Play Again** / **New Game** / **Undo Last Round** are the host's controls and are not shown. On the winner screen you get **Ask for a Rematch** instead; the host sees the request on their own Play Again button, and you can ask again after a few seconds if nothing happens.
- Submitting is confirmed by the host: your card shows *Score sent — waiting for the host…* until they have it, then *Score submitted!* — or, if the host is typing your score for you, a note saying so, because their number is the one that counts. If your phone is offline the button is disabled, and a score saved while reconnecting says so. A submission that is lost with the radio is sent again automatically when you reconnect, rather than leaving you stuck on a waiting screen.
- If the host cannot take a score — the round closed while your phone was offline — you are told (*That round is over*) rather than left thinking it counted. A refusal that arrives late never un-submits the round you are on now.
- Reconnecting no longer wipes a card you were part-way through, and a score you already sent is handed back to you rather than blanked.
- A blip in the waiting room no longer throws you out: the lobby says **Reconnecting…** and your seat is held for you. You only go back to the join form once reconnecting has genuinely failed.
- If the host's tab restarts or reloads, you are put back in their room instead of being told the game is over or left tapping a scoreboard that no longer exists.
- Once you have been told the room ended — or that the host removed you — nothing that turns up afterwards puts you back on a scoreboard that is no longer live.
- Names are unique per room, ignoring case: `Sam` and `SAM` cannot both sit at the table.
