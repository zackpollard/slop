# Herd Mentality

A digital companion for the Herd Mentality party game. One person hosts and shares a room code; everyone else joins on their own phone. The host reads out the question, everybody answers privately, and the results reveal the herd (majority answer) and who is left holding the Pink Cow.

## Features

- **100+ built-in questions** across 7 categories (favourites, pop culture, animals, people, hypothetical, word association, opinions)
- **Category filters** to customise the question pool
- **Custom questions** — type your own at any time
- **Peer-to-peer play** — the host's device runs the game; players join with a room code, no server
- **Answer review** — the host can merge near-identical answers ("Dogs" / "a dog") before scoring
- **Automatic herd detection** with tie-breaking (ties = no herd)
- **Pink Cow tracking** — assigned to the odd one out each round
- **The moo** — a nudge sent to the last player still typing
- **Mobile-friendly** responsive design
- **Up to 16 players** in a room

## Host controls

- **Reveal Answers Now** (waiting screen) — closes the round on the answers already in, for a player who is never coming back. Available as soon as at least one answer is in.
- **Back to Answering** (review screen) — reopens the round for the players it originally asked. Anyone whose answer the host already holds stays put; anyone else gets their answer box back, with what they typed still in it.
- **Close Room** (lobby) — ends the room properly, so every player is told the game is over instead of reconnecting into nothing.
- **End Game** (results) — returns everyone to the lobby, keeping the room open for another game.

## Connection handling

- A player whose phone locks or loses signal is shown as **(away)** and the round keeps waiting for them; the round only moves on without them once their seat has really been given up (**(left)**). The host's progress line names whoever the round is waiting on, so it is obvious when to reach for Reveal.
- An **(away)** player's seat is theirs: nobody else can take it by typing their name while they are reconnecting. Once the seat has really been given up, the same name walks back into it from any device.
- Reconnecting — or reloading the tab — puts a player straight back into their own seat with the current question, whether or not the host ever noticed they were gone. Returning on a different phone works too: join with the same name.
- An answer submitted while offline reads **Answer Saved** and is sent on reconnect, rather than showing a tick for something that never left the phone. If the host refuses an answer — the round closed first, or it belonged to a round that is over — the player is told at once and gets their text back instead of waiting on an answer nobody holds.
- Rounds are numbered from 1 in every game on screen, but a round is never mistaken for another one behind the scenes: an answer typed in a previous game — or in a previous *sitting* of the same room, if the host's tab was reloaded or reclaimed by the browser and re-opened the same room code — can never be counted in this one, and a message about a round that is already over — results, "next round", "game over" — cannot pull a phone back onto it once the game has moved on. A phone that finds itself *behind* the table instead asks the host for the current state rather than guessing, so a missed message repairs itself within a second.
- A moo that was sent while a player was offline is not played when they reconnect: the nudge is about who everyone is waiting on right now, so a late one is dropped rather than mooing at a round that has already been scored.
- The same is true when the phone's audio is still asleep. On iOS a page that has not been tapped cannot make a sound — which is exactly the player a moo is aimed at — so the moo waits for the audio to start and then checks it is still wanted, rather than piling up silently and all going off at once the moment they touch the screen.
- If the host removes a player, or the game moves on without them, their screen says so and offers a **Rejoin** button.
- A join turned away for something the player can fix — a name somebody else is using, or a seat that is still reconnecting — is only ever about that attempt. Once they are let in under a corrected name, the refusal is spent: an ordinary reconnect later in the game cannot be answered with it.
