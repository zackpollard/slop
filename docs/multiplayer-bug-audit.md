# Multiplayer bug audit

A backlog of confirmed bugs in the four peer-to-peer games. Nothing here is
speculative: every entry was found by reading the code, then survived three
independent reviewers voting on whether it was real, needing a two-of-three
majority to be recorded at all.

**This is a to-do list, not a report.** Each entry says what a player sees, what
sequence causes it, and the specific fix in this codebase.

## Where this came from

The four games share `lib/slopnet` (a PeerJS wrapper) and `lib/sloplobby` (rooms,
identity, rejoin). An audit of that shared library found 79 bugs. **The 31 in the
library are already fixed**; see `lib/slopnet/__tests__/repro-*.test.js`, which
reproduce them, and the commit that turned them green.

The 48 in this document are in the apps themselves. They were re-checked against
the *fixed* library, so the status column reflects the code as it stands today,
not as it was when the bug was found.

## The state of it

| | Count |
|---|---|
| Still broken | **35** |
| Changed by the library fix — still a bug, different trigger or shape | 11 |
| Fixed by the library fix — no app change needed | 2 |
| **Total** | **48** |

| Game | Bugs | Critical | High | Medium | Low |
|---|---|---|---|---|---|
| Cards Against Humanity | 15 | 2 | 10 | 2 | 1 |
| Herd Mentality | 14 | 2 | 9 | 1 | 2 |
| Flip 7 | 12 | 0 | 5 | 7 | 0 |
| Texas Hold'em | 7 | 1 | 2 | 3 | 1 |

## Read the themes first

The most useful thing this document can tell you is that these are not 48
separate jobs. Each game has a handful of root causes that account for most of
its entries — fix the cause and a column of symptoms goes with it. The themes
are listed per game below, before the individual bugs.

---

# Cards Against Humanity

`projects/cards-against-humanity/index.html` — 15 bugs

## Root causes

- **The app treats 'client-left' as death.** This is the single biggest one: eight of the fifteen bugs are downstream of onPlayerLeft (index.html:529-540) filtering state.players and deleting state.hands/state.submissions on an event the library documents as temporary — and now even passes final=false as a third argument that CAH ignores. That one handler is what zeroes a returning player's score, redeals their hand, moves the crown to the wrong seat, deletes a card the czar is about to pick, and changes `needed` out from under a round in progress. The library fixed its half (SlopLobby parks the player record across client-left and offers onPlayerLost); the app still bins its own. Mark the player away, keep everything, and do the real teardown in a new onPlayerLost handler.

- **Positional indices are used as identity.** state.czarIndex indexes an array that shrinks and grows under it, and 'pick-winner' names a winner by their position in state.submissionOrder, which the host mutates without re-broadcasting. Neither survives a membership change, and both fail silently — the czar's tap does nothing, or scores the wrong player. Replace with state.czarId and a per-submission id in the 'judging' payload.

- **Host commands have no guards and no idempotence.** handleHostMessage (:557) checks nothing: not that the sender is a player, not what phase the game is in, not which round the command belongs to. startJudging (:680), announceWinner (:692) and nextRound (:634) all re-run unconditionally. Six bugs are just different ways of arriving at that — a late submit, a queued tap flushed three times, a stale command from a forgotten peer, two humans with the same button. One ~20-line block of guards at :557-588 plus three one-line phase checks closes all of them, with no structural change.

- **The round-completion gate exists in exactly one place.** `got >= needed` is computed and compared only inside `case 'submit'` (:568-575), and startJudging() has one caller in the entire 1084-line file. Any change to the roster can therefore satisfy or invalidate the condition with nothing left that will ever look at it again, and there is no host override anywhere in the app — no skip player, no force judging, no kick. Every one of these ends in a table frozen on one screen whose only exit is the host reloading and losing the game. Extract maybeStartJudging(), call it from every membership change, and add a host-only escape hatch so the next gate bug is survivable.

- **The client never receives a full state snapshot.** 'game-start' does double duty as the join payload and the rejoin resync, and carries phase and czarId that the client handler at :777-785 silently discards; 'player-list' (:771) re-renders the roster but never the round; 'joined' (:766) bounces a returning player to the waiting-room screen. The library's new message queueing hides most of this for absences under 120 seconds — the client replays what it missed — which is why two of these bugs are narrower than the audit found them, but it does nothing for a reloaded or discarded tab, which starts from an empty heap. One 'resync' message, sent on both join and rejoin, replaces all of it.

- **Identity is an unverified string, minted per tab and broadcast to everyone.** clientId lives in sessionStorage, so one human with two tabs is two players; it is asserted on the wire with nothing binding it, so asserting someone else's takes their seat; and CAH puts every raw id into 'player-list' so all of them are readable from any player's page. The accidental half (duplicate tab) is what actually bites at a party; the deliberate half needs a library change to fix properly.

## Where to start

"Fix the themes, not the fifteen items — four sittings close thirteen of them.\n\n1. STOP DELETING ON client-left (Theme 1). Rewrite onPlayerLeft (:529-540) to set p.away, clear it in onPlayerRejoined (:509-516), and add an onPlayerLost option to the SlopLobby constructor at :487 that does the real teardown. This is first because it is the only fix that needs the library work that just landed, it removes the trigger for six other bugs, and it is the one players notice every single game. Trap: `needed` at :568 must exclude away players in the same commit, or you convert a stranded round into a round that waits forever.\n\n2. GUARD AND MAKE IDEMPOTENT (Theme 3). One block: membership check at :557, phase + round guards on 'submit' (:559), 'pick-winner' (:578) and 'next-round' (:585), and a one-line phase guard at the top of startJudging (:681) and announceWinner (:692). About twenty lines, no structural change, no protocol change, and it closes cah-accepts-submits-from-unknown-ids, cah-queued-czar-commands-replayed, cah-late-submit-rewinds-judging, cah-late-submit-reshuffles-judging-list, cah-next-round-applied-twice and half of cah-gameover-timer-races-next-round. Best value-per-line in the file — arguably do it first if you want one commit that is trivially safe to review.\n\n3. IDS INSTEAD OF INDICES (Theme 2) plus the gate extraction (Theme 4). czarIndex -> czarId at twelve sites, submission ids in the 'judging' payload, maybeStartJudging() called from every membership change, and the host-only \"Start judging now\" button. These two belong together because both are about what happens when the roster moves, and the gate extraction needs czarId to compute the eligible set correctly.\n\n4. ONE RESYNC MESSAGE (Theme 5), then the leftovers: the duplicate-name check at :496, the submitCards reorder at :947 (two minutes, do it any time), and the identity work last — it is the largest, needs a library change, and the accidental half of it is already covered by the duplicate-name check.\n\nWhat NOT to do: do not fix cah-one-human-two-seats-deadlocks-round by moving clientId to localStorage. That turns the second tab into a rejoin, and slopnet.js:417 then swaps existing.conn to the new socket without closing the old one — the first tab keeps rendering as connected while its data path is dead, which is worse than a visible duplicate."

## Notes

- Line numbers are unchanged from the audit: projects/cards-against-humanity/index.html has not been touched by the library commit (fc586bb), and every cited line still holds the code the audit described. All fifteen findings verified against the current file.
- Three of the fifteen moved: cah-rejoin-resync-omits-phase-and-czar, cah-accepts-submits-from-unknown-ids, cah-late-submit-reshuffles-judging-list and cah-late-submit-rewinds-judging are all narrower than reported, because PeerHost.broadcast now queues for a client inside its reconnect window and flushes before announcing the rejoin (slopnet.js:435-442, 591-593). A player returning inside 120 seconds replays what they missed and lands on the right phase. None of them is fixed: each has a live route past the 120-second window, and the app-side omissions that made them possible are untouched.
- Nothing here is fixed-by-library. The library change that most obviously targeted app bugs — announcing a post-window returner as 'client-rejoined' rather than 'client-joined' — buys CAH nothing, because CAH has no mid-game join validation to be tripped by it. It accepts anyone, at any time, in any phase. The library fix helps texas-holdem and herd-mentality far more than it helps this app.
- CAH does not pass onPlayerLost, so sloplobby.js:310 currently delivers a SECOND onPlayerLeft with final = true when the reconnect window expires. CAH's handler is idempotent (filter by id), so this is harmless today — but it stops being harmless the moment onPlayerLeft is changed to mark-don't-delete, because the final event would then only set the away flag again and the player would never actually be removed. Adding onPlayerLost is part of that edit, not an optional extra.
- One library-side improvement that is now silently load-bearing: sloplobby.js keeps its player record across client-left, so the `lobby.players.get(clientId).name` fallback at index.html:510 actually resolves now. It was dead code before — a returning player used to come back as 'Unknown'.
- Two pairs in this list are the same bug reported twice from different angles: cah-departure-strands-the-round-in-playing / cah-judging-gate-never-reevaluated-on-drop, and cah-late-submit-reshuffles-judging-list / cah-late-submit-rewinds-judging. Fixing either member closes both. That takes the honest count of distinct faults in this app from fifteen to thirteen, and the count of distinct root causes to six.
- Two dereferences will throw a TypeError once the czar index outruns the players array: index.html:999 (inside an onclick, kills the czar's ability to pick) and index.html:579-580 (inside PeerJS's data handler, propagating through TypedEmitter.emit at slopnet.js:62-69, which has no per-listener try/catch, aborting the remaining data listeners). Both are one-line guards and worth adding even before the czarId rewrite. Wrapping emit in a per-listener try/catch is a separate library change that would stop any app-layer throw taking the transport down with it.
- No test in the repo loads this app's game logic except repro-6, which is red by design (3 of its 4 assertions fail today, confirming cah-one-human-two-seats-deadlocks-round is untouched). If any of these fixes ship, that harness — it loads the real inline <script> out of index.html against a DOM stub — is the place to assert the fix, and it is already written.

## The bugs

| Severity | Status | Effort | Bug |
|---|---|---|---|
| Critical | Still broken | Medium | [A second tab seats the same human twice and the round can never complete](#cah-one-human-two-seats-deadlocks-round) |
| Critical | Still broken | Medium | [A 15-second phone lock costs the player their whole score and their whole hand](#cah-reconnect-zeroes-score-and-redeals) |
| High | Still broken | Medium | [One disconnect moves the crown to the wrong player and the judging screen freezes](#cah-czar-index-desync-deadlock) |
| High | Still broken | Small | [Taps made while the connection is down all land at once, awarding one round three times](#cah-queued-czar-commands-replayed) |
| High | Still broken | Medium | [The czar picks the card of a player who just dropped, and the game freezes for good](#cah-stale-submission-index-hardlock) |
| High | Still broken | Small | [The last player to leave after everyone else has played strands the round forever](#cah-departure-strands-the-round-in-playing) |
| High | Still broken | Small | [Tapping Next Round in the four seconds after someone wins throws the whole table onto the game-over screen mid-round](#cah-gameover-timer-races-next-round) |
| High | Still broken | Small | [Same fault as the stranded round, seen from the other side: the missing player is the one who never submitted](#cah-judging-gate-never-reevaluated-on-drop) |
| High | Changed | Medium | [A player who reloads mid-round comes back to a game screen with nothing on it](#cah-rejoin-resync-omits-phase-and-czar) |
| High | Changed | Small | [A submission from someone the host has forgotten starts judging early and dead-ends the round](#cah-accepts-submits-from-unknown-ids) |
| High | Changed | Small | [A late submission reshuffles the anonymous answers under the czar's finger and can score the wrong player](#cah-late-submit-reshuffles-judging-list) |
| High | Changed | Small | [A late submission rewinds a finished round back to judging and awards the point a second time](#cah-late-submit-rewinds-judging) |
| Medium | Still broken | Large | [Every player's identity is printed in everyone else's page, and asserting one hands over that player's seat](#clientid-is-an-unverified-bearer-token) |
| Medium | Still broken | Small | [Both the host and the czar have a Next Round button, and two taps skip a whole round](#cah-next-round-applied-twice) |
| Low | Still broken | Small | [The host's own submit paints "waiting for others" on top of the judging screen it just triggered](#cah-host-local-dispatch-overwrites-judging-screen) |

### A second tab seats the same human twice and the round can never complete

<a id="cah-one-human-two-seats-deadlocks-round"></a>

**Critical** · Still broken · Medium effort · `cah-one-human-two-seats-deadlocks-round` · line 496

**What a player sees.** Someone taps the room link a second time (or opens the game on their laptop as well) and appears in the player list twice. From then on every round sticks on "3 / 4 submitted" and never moves, and once the crown lands on the abandoned copy of them nobody can pick a winner ever again. The only way out is the host reloading, which ends the game and loses every score.

**What causes it.** Any second tab/device joining under the same name mid-game. clientId lives in sessionStorage, which is per-tab, so the second tab is a brand-new identity and takes the 'client-joined' branch.

**The fix.** Two edits. (1) In onPlayerJoined (index.html:491, before the push at :496) reject the duplicate: `const n=playerName.trim().toLowerCase(); if(state.players.some(p=>p.name.trim().toLowerCase()===n)) return 'That name is already in the game';` — SlopLobby routes a returned string to join-error + removeClient (sloplobby.js:242-248), and because the fixed library announces post-window returners as 'client-rejoined' this check can no longer bounce a genuine returning player. (2) The load-bearing half is the gate itself: extract index.html:568-575 into `maybeStartJudging()` and call it from the submit case AND from onPlayerLeft/onPlayerJoined/onPlayerRejoined, so no membership change can strand a round. Add a host-only "Start judging now" button rendered during phase 'playing' (outside result-section, which renderRound hides at :889).

**Blast radius.** local to this file, but the duplicate-name check changes who can join every game; the gate extraction is the same edit the herd-mentality/flip-7 quorum handlers need.

**Fix alongside.** `cah-judging-gate-never-reevaluated-on-drop`

### A 15-second phone lock costs the player their whole score and their whole hand

<a id="cah-reconnect-zeroes-score-and-redeals"></a>

**Critical** · Still broken · Medium effort · `cah-reconnect-zeroes-score-and-redeals` · line 515

**What a player sees.** A player locks their phone or walks into a lift for half a minute. When they come back their score on everyone's scoreboard has dropped to zero, they have a completely different set of cards, and anything they had already played this round has vanished. In a game to 7 that is the game.

**What causes it.** Any absence longer than ~20 seconds. The host's heartbeat convicts the silent tab, SlopNet emits 'client-left' (temporary), and CAH treats it as death.

**The fix.** Stop deleting on the temporary event. In onPlayerLeft (index.html:529-540) replace the filter and the two deletes at :533-535 with `const p = state.players.find(p=>p.id===clientId); if(p) p.away = true;` then broadcast/re-render as now; grey out `p.away` in renderWaitingPlayers (:840) and renderGamePlayers (:859). In onPlayerRejoined (:509-516) clear the flag on the existing entry instead of pushing a new one: `const e=state.players.find(p=>p.id===clientId); if(e){e.away=false; if(playerName!=='Unknown') e.name=playerName;} else state.players.push({id:clientId,name:playerName,score:0});` — with the hand no longer deleted, `state.hands[clientId] || dealHand(10)` at :524 only fires for a genuinely new player. Then add `onPlayerLost: (clientId, meta) => {...}` to the SlopLobby options at :487-541 and do the real teardown there (the fixed sloplobby.js:294-311 forwards it, and without an onPlayerLost CAH is currently getting a second onPlayerLeft with final=true instead). CRITICAL companion edit: `needed` at :568 must become `state.players.filter(p=>!p.away && p.id!==czarId).length` — marking a player away without excluding them from the quorum turns this into a round that waits forever.

**Blast radius.** touches both renderers, both rejoin paths and the quorum count; the same mark-don't-delete shape is wrong in texas-holdem, herd-mentality and flip-7 and should be changed in the same sitting.

### One disconnect moves the crown to the wrong player and the judging screen freezes

<a id="cah-czar-index-desync-deadlock"></a>

**High** · Still broken · Medium effort · `cah-czar-index-desync-deadlock` · line 771

**What a player sees.** Somebody's phone drops out mid-round and the crown silently jumps to a different player on everyone's screen. The real Card Czar taps a card and nothing happens; the player now wearing the crown has no cards to tap. The table sits on the judging screen forever.

**What causes it.** Any player earlier in the list than the czar dropping out during a round. onPlayerLeft shrinks state.players without touching state.czarIndex, and the client's 'player-list' handler never recomputes it.

**The fix.** Replace the positional `state.czarIndex` with `state.czarId` at every site: :435, :505, :526, :579, :615, :639, :646, :796, :858, :871, :998, :1034. Rotate in nextRound (:639) with `const i=state.players.findIndex(p=>p.id===state.czarId); state.czarId=state.players[(i+1)%state.players.length].id;`. Include czarId in the 'player-list' payload (:499, :519, :537) and have the client handler at :771-775 re-resolve it and call renderRound() when the phase is not 'lobby'. Defensively guard the two unguarded dereferences that throw a TypeError today: :999 `if(!czar || czar.id!==state.myId) return;` and :579-580 `const czar=state.players[state.czarIndex]; if(!czar || senderId!==czar.id) break;` — the second one throws out of PeerJS's data handler through TypedEmitter.emit (slopnet.js:62-69), which has no try/catch, killing the remaining listeners.

**Blast radius.** twelve call sites in this file plus the wire format of player-list/new-round; nothing outside the app.

**Fix alongside.** `cah-stale-submission-index-hardlock`

### Taps made while the connection is down all land at once, awarding one round three times

<a id="cah-queued-czar-commands-replayed"></a>

**High** · Still broken · Small effort · `cah-queued-czar-commands-replayed` · line 696

**What a player sees.** The czar's connection wobbles, they tap Pick Winner and nothing happens, so they tap it again a couple of times. When the connection returns, one player is suddenly awarded three points for a single card and the game declares itself over several rounds early with the wrong winner.

**What causes it.** Any brief drop while the judging or result screen is on-screen. PeerClient.send queues silently and returns false (slopnet.js:1121-1133) — unchanged by the library fix — SlopLobby.sendToHost throws the boolean away (sloplobby.js:430-432), and pickWinner (:1008) and triggerNextRound (:1039) never disable their button. The plain double-tap case needs no disconnect at all.

**The fix.** Make the host transitions idempotent, which covers both. At :578 add `if (state.phase !== 'judging') break;` and a round stamp (client sends `round: state.round`, host rejects a mismatch). At :585 add `if (state.phase !== 'result') break;` plus the missing sender check. Belt and braces at :692: `if (state.phase !== 'judging') return;` as the first line of announceWinner, so the `winner.score++` at :696 can never run twice for one black card. Then give the user feedback so they stop tapping: have SlopLobby.sendToHost return `this.client.send(data)` and have pickWinner/triggerNextRound hide the button and show "Sending…", re-enabled by the host's 'round-winner'/'new-round'.

**Blast radius.** the phase guards are self-contained; returning the boolean from sendToHost is a shared-library change (sloplobby.js:430) and needs a glance at the other three consumers.

**Fix alongside.** `cah-next-round-applied-twice`

### The czar picks the card of a player who just dropped, and the game freezes for good

<a id="cah-stale-submission-index-hardlock"></a>

**High** · Still broken · Medium effort · `cah-stale-submission-index-hardlock` · line 581

**What a player sees.** The czar picks their favourite answer, taps Pick Winner, and nothing happens. They tap again and again — still nothing. The whole table is stuck on the judging screen with no button anywhere that can move it on. Roughly a one-in-N chance per round once anyone has dropped, and the czar has no way to avoid it because the answers are anonymous.

**What causes it.** A player drops out during judging. onPlayerLeft (:535) deletes their submission but state.submissionOrder is left untouched and no new 'judging' is broadcast, so the czar is still looking at a card whose author no longer exists. announceWinner (:693-694) hits `if (!winner) return;` and says nothing.

**The fix.** Send identity, not position. In startJudging (:687) broadcast `submissions: state.submissionOrder.map(id => ({ id, cards: state.submissions[id] }))` — the id is opaque to the UI, which renders only sub.cards (:970-974), so anonymity holds. In pickWinner (:1016) send `{type:'pick-winner', round: state.round, playerId: state.submissionOrder[selectedSubmission].id}`; the host branch at :581 already prefers data.playerId. Add an else branch to announceWinner at :694 that replies `{type:'pick-rejected', reason}` and logs it, so a failed pick is visible instead of silent. This is largely resolved for free once onPlayerLeft stops deleting submissions (see cah-reconnect-zeroes-score-and-redeals) — the departed player's card stays judgeable — but keep the id-based pick, because the final onPlayerLost teardown can still empty a slot mid-judging.

**Blast radius.** changes the 'judging' and 'pick-winner' wire shapes plus both submission renderers (:960-993).

**Fix alongside.** `cah-czar-index-desync-deadlock`

### The last player to leave after everyone else has played strands the round forever

<a id="cah-departure-strands-the-round-in-playing"></a>

**High** · Still broken · Small effort · `cah-departure-strands-the-round-in-playing` · line 573

**What a player sees.** Everyone has played their cards except one person, whose battery dies. The round never moves on: every screen sits on "Cards submitted! Waiting for others..." with a submitted-count frozen at the old number, and the czar never gets the judging screen. There is no host control anywhere that can force it forward.

**What causes it.** Any player leaving after all the remaining players have already submitted. The `got >= needed` comparison at :573 is evaluated only inside `case 'submit'`, and startJudging() has exactly one caller in the whole file (:574) — so once no further submit can arrive, nothing re-checks the condition the departure just satisfied.

**The fix.** Extract the gate and call it from every place the roster or the submission set changes: `function maybeStartJudging(){ if(state.phase!=='playing') return; const czar=state.players.find(p=>p.id===state.czarId); const eligible=state.players.filter(p=>!p.away && p.id!==(czar&&czar.id)); const needed=eligible.length; const got=eligible.filter(p=>state.submissions[p.id]).length; lobby.broadcast({type:'submit-count',count:got,needed}); if(needed>0 && got>=needed) startJudging(); }`. Replace :568-575 with a call to it, and call it at the end of onPlayerLeft (:539), onPlayerJoined (:506) and onPlayerRejoined (:527). The `needed > 0` guard matters: a mass departure otherwise calls startJudging with an empty submissionOrder and renders a judging grid the czar can never pick from — a second deadlock. Add the host-only "Start judging now" escape hatch as a backstop.

**Blast radius.** local, but it must be sequenced with the away-flag change or the two definitions of `needed` will disagree.

**Fix alongside.** `cah-judging-gate-never-reevaluated-on-drop`

### Tapping Next Round in the four seconds after someone wins throws the whole table onto the game-over screen mid-round

<a id="cah-gameover-timer-races-next-round"></a>

**High** · Still broken · Small effort · `cah-gameover-timer-races-next-round` · line 717

**What a player sees.** Someone reaches the score limit, the result screen appears with a Next Round button still on it, and whoever taps it starts a new round for everyone. Four seconds later everybody is yanked out of that round onto the game-over screen. The cards just played are gone and the only button is New Game, which reloads and destroys the room.

**What causes it.** Any tap of Next Round in the four-second window after a winning pick. announceWinner renders the result screen at :713 (renderResult at :1036 un-hides the button for both the host and the czar) and only afterwards sets phase='gameover' at :716 and arms an untracked setTimeout at :717. `case 'next-round'` at :585 accepts the command in any phase.

**The fix.** Decide game-over before rendering: move `state.phase = winData.gameOver ? 'gameover' : 'result'` above the `renderRound()` at :713, store the timer as `state.gameOverTimer` (:717), and change :1036 to `$('btn-next-round').classList.toggle('hidden', state.phase==='gameover' || (!isCzar && !state.isHost))`. Mirror it on the client at :811-818 — set the phase before renderRound and store that 4s timer too. The load-bearing half is the host guard at :585: `case 'next-round': if (state.phase === 'gameover') break; nextRound(); break;`, since a client tap already in flight would otherwise still restart the round. While in here, either wire up `state.nextRoundTimer` (declared at :443, cleared at :635, assigned nowhere) or delete it — it currently reads as protection that does not exist.

**Blast radius.** host and client both change; keep the two four-second timers in one named field.

**Fix alongside.** `cah-next-round-applied-twice`

### Same fault as the stranded round, seen from the other side: the missing player is the one who never submitted

<a id="cah-judging-gate-never-reevaluated-on-drop"></a>

**High** · Still broken · Small effort · `cah-judging-gate-never-reevaluated-on-drop` · line 529

**What a player sees.** Three of four players have played and the fourth locks their phone while reading the black card. Everyone is left staring at "3 / 4 submitted" — the count that is now satisfied — and judging never begins. The only cure is that player coming back and playing again, from a freshly dealt hand they have never seen.

**What causes it.** Identical to cah-departure-strands-the-round-in-playing. onPlayerLeft (:529-540) drops the player and their submission, which changes `needed`, and nothing re-evaluates the gate because it lives only inside `case 'submit'`.

**The fix.** The same maybeStartJudging() extraction, called from the end of onPlayerLeft after the czar has been repaired. Repair the czar first: before the filter at :533 capture the current czar's id, and after it either re-point at that id's new position or, if the czar was the leaver, advance to the next live player and re-broadcast the round rather than leaving a czar nobody can be. Once onPlayerLeft stops deleting (see cah-reconnect-zeroes-score-and-redeals) the hand survives too, so a returning player no longer gets a strange new set of cards.

**Blast radius.** same edit as cah-departure-strands-the-round-in-playing — fix once, close both.

**Fix alongside.** `cah-departure-strands-the-round-in-playing`

### A player who reloads mid-round comes back to a game screen with nothing on it

<a id="cah-rejoin-resync-omits-phase-and-czar"></a>

**High** · Changed · Medium effort · `cah-rejoin-resync-omits-phase-and-czar` · line 777

**What a player sees.** A player reloads the page or their browser throws the tab away, and they rejoin to a screen showing the black card and the round number and nothing else — no cards, no submit button, no judging. They are locked out until the czar picks and the next round starts.

**What causes it.** Narrowed by the library fix. The host now queues broadcasts for an absent client and flushes them before announcing the rejoin (slopnet.js:435-442, 591-593), so a player whose tab kept its memory replays new-round/judging/round-winner and lands on the right phase — the old 'stale judging screen over the new round' half is gone. What remains is a fresh JS heap (reload, or an iOS tab discard) returning during a gap in which nothing was broadcast: phase is back at its initial 'lobby' (:439) and czarIndex at 0, and 'game-start' (:777-785) sets only myHand/currentBlack/round, so renderRound (:891-915) matches no branch and paints an empty screen.

**The fix.** Replace the join/rejoin 'game-start' sends at :505 and :526 with one full snapshot: `{type:'resync', players, scoreLimit, phase: state.phase, round: state.round, black: state.currentBlack, czarId, hand, submitted: !!state.submissions[clientId], submitCount, needed, submissions: state.phase==='judging' ? state.submissionOrder.map(id=>({cards:state.submissions[id]})) : null, result: state.phase==='result' ? state.revealedAuthor : null}`. Handle it on the client in one case that assigns state.phase, state.czarId, state.submissionOrder, state.revealedAuthor and state.myHand, clears state.selectedCards, then showScreen('game') + renderRound(). Also stop 'joined' (:766) unconditionally calling showScreen('waiting') when a resync follows, and give renderRound an else branch at :915 that paints a neutral "syncing…" panel so an unknown phase can never render blank.

**Blast radius.** changes the host->client protocol for join and rejoin; both handlers must ship together.

**Fix alongside.** `cah-late-submit-reshuffles-judging-list`

### A submission from someone the host has forgotten starts judging early and dead-ends the round

<a id="cah-accepts-submits-from-unknown-ids"></a>

**High** · Changed · Small effort · `cah-accepts-submits-from-unknown-ids` · line 560

**What a player sees.** Judging starts before everyone has played, and the cards of the players who hadn't finished never appear. If the czar happens to pick the ghost entry, the Pick Winner button does nothing at all, forever, with no message anywhere.

**What causes it.** Narrowed. The old route — a player still inside their 120-second window sending over a live channel — is now closed: inbound traffic revives the client and fires 'client-rejoined' synchronously before the data is delivered (slopnet.js:466-511), so CAH re-seats them first. The live route is an absence longer than 120 seconds where the WebRTC channel survives: SlopNet has deleted the client record but still answers the client's pings, so _handleData falls through to `emit('data', conn.peer, data)` (slopnet.js:484) and the submission arrives under a raw PeerJS peer id that is in nobody's player list. The same happens to a player whose seat was taken over by another tab asserting their clientId.

**The fix.** One line at the app entry point, index.html:557: `function handleHostMessage(senderId, data) { if (!state.players.find(p => p.id === senderId)) return; ... }`. Then stop deriving the round's completion condition from live membership: in nextRound (:634) capture `state.expectedSubmitters = state.players.filter(p=>p.id!==czarId).map(p=>p.id)` and at :568-573 use `const needed=state.expectedSubmitters.length; const got=state.expectedSubmitters.filter(id=>state.submissions[id]).length;`. Make announceWinner (:692) fail loudly rather than `return`ing on an unresolvable id — splice it out of state.submissionOrder, re-broadcast 'judging' and toast the czar — so a bad pool can never freeze the table.

**Blast radius.** the membership guard is one line and affects every host-side command; the expectedSubmitters change interacts with the away-flag work in cah-reconnect-zeroes-score-and-redeals, so do them together.

**Fix alongside.** `cah-late-submit-rewinds-judging`

### A late submission reshuffles the anonymous answers under the czar's finger and can score the wrong player

<a id="cah-late-submit-reshuffles-judging-list"></a>

**High** · Changed · Small effort · `cah-late-submit-reshuffles-judging-list` · line 574

**What a player sees.** The czar is mid-decision when the answers on screen silently reorder and a fourth one appears. Their highlighted choice is wiped, and if they tapped Pick Winner a moment before the reshuffle landed, the point goes to a player who did not write the card they chose.

**What causes it.** Narrowed. The library now queues host broadcasts for an absent client and flushes them before the rejoin (slopnet.js:435-442, 591-593), so a player returning inside 120 seconds receives the 'judging' broadcast they used to miss and no longer sees a live Submit button. The remaining route is an absence past the 120-second window, where the record and its queue are discarded: the returning client keeps its stale local phase 'playing' (the host's 'game-start' at :526 carries a phase the client handler at :777-785 ignores), shows a Submit button, and the accepted submit at :561 re-runs startJudging() at :574.

**The fix.** Two guards close it regardless of route. In `case 'submit'` (:559) add `if (state.phase !== 'playing') break;` and stamp the round — submitCards (:947) sends `round: state.round`, host rejects a mismatch. Make startJudging idempotent at :681: `if (state.phase !== 'playing') return;`. Then fix the actual cause of the stale screen: in `case 'game-start'` (:777) assign what the host already sends — `state.phase = data.phase; state.czarId = data.czarId; state.selectedCards = [];` — which is the same edit as cah-rejoin-resync-omits-phase-and-czar.

**Blast radius.** the two guards are local; the client-side phase assignment is shared with the resync work.

**Fix alongside.** `cah-late-submit-rewinds-judging`

### A late submission rewinds a finished round back to judging and awards the point a second time

<a id="cah-late-submit-rewinds-judging"></a>

**High** · Changed · Small effort · `cah-late-submit-rewinds-judging` · line 573

**What a player sees.** The round has been decided and everyone is looking at the result, when the whole table is snapped back to the judging screen with the answers in a different order. The czar picks again and one player quietly collects two points for a single black card — and if that crosses the score limit, the game ends on a round that was never really played.

**What causes it.** Same narrowing as cah-late-submit-reshuffles-judging-list: the ≤120-second variant is closed by the library's message queueing, the >120-second variant is live. `case 'submit'` (:559) has no phase check, no membership check and no round stamp, and startJudging (:680) and announceWinner (:692) both re-run unconditionally.

**The fix.** Three guards in handleHostMessage and the two transitions. At :559: `if (state.phase !== 'playing') break; if (!state.players.find(p=>p.id===senderId)) break; if (senderId === czarId) break; if (data.round !== state.round) break;` (with `round: state.round` stamped in submitCards at :947). At :681: `if (state.phase !== 'playing') return;`. At :692: `if (state.phase !== 'judging') return;` before `winner.score++`. That trio makes every host transition once-per-round regardless of what arrives late.

**Blast radius.** local; overlaps entirely with cah-accepts-submits-from-unknown-ids and cah-queued-czar-commands-replayed — one guard block covers all three.

**Fix alongside.** `cah-late-submit-reshuffles-judging-list`

### Every player's identity is printed in everyone else's page, and asserting one hands over that player's seat

<a id="clientid-is-an-unverified-bearer-token"></a>

**Medium** · Still broken · Large effort · `clientid-is-an-unverified-bearer-token` · line 499

**What a player sees.** Anyone at the table can read every other player's internal id — and the host's — out of their own browser, then reconnect claiming to be them. They receive that player's actual hand and seat, while the real player is left on a connection whose messages the host quietly ignores. Kicking them does nothing; they simply reconnect.

**What causes it.** Deliberate, but also the accidental case: Chrome's "Duplicate tab" copies sessionStorage, so the copy rejoins asserting the original's id and takes over its seat. The library fix did not add identity binding — slopnet.js:409 still takes `data.clientId || conn.peer` straight off the wire, and the rejoin branch at :417 still swaps `existing.conn` without closing the displaced socket.

**The fix.** Two layers. In the app: keep a host-side Map<clientId, seatId> minted at join and put only seatId into state.players / 'player-list' / 'new-round' / 'round-winner', keying state.hands and state.submissions by seatId; and reject a new join whose clientId equals state.myId or any existing player id, since the host's own 'host-…' id (:482) is not in PeerHost.clients and so takes the *join* branch, not the rejoin one — a token on the rejoin path alone would not cover it. In the library (slopnet.js:452-465): mint a random token at first join, return it in the join_ack, have PeerClient echo it, and take the rejoin branch at :417 only on a match — and close the displaced conn before `existing.conn = conn` so the victim gets a real 'disconnected' instead of an orphaned channel whose data falls through to the raw-peer-id path.

**Blast radius.** the library half touches the join handshake for all four apps and needs its own tests; the app half rewrites every wire payload that carries a player id.

**Fix alongside.** `cah-one-human-two-seats-deadlocks-round`

### Both the host and the czar have a Next Round button, and two taps skip a whole round

<a id="cah-next-round-applied-twice"></a>

**Medium** · Still broken · Small effort · `cah-next-round-applied-twice` · line 585

**What a player sees.** The round counter jumps by two, a black card nobody saw is burned, and one player is skipped as Card Czar entirely. Anyone quick enough to have played against the first new black card has their cards taken and replaced mid-thought. Nothing on screen explains it — it just looks like someone never got a turn.

**What causes it.** renderResult (:1036) shows the Next Round button to the czar AND the host, i.e. two different humans. The czar's tap produces no local feedback (:1042-1043), so during the round trip the host taps their own copy, and `case 'next-round'` (:585-588) runs nextRound() with no sender check, no phase check and no round number.

**The fix.** Do not hide the button from the czar — that would stall the game whenever the host has their phone in a pocket. Make the transition idempotent instead: `case 'next-round': { if (state.phase !== 'result') break; if (data.round !== undefined && data.round !== state.round) break; nextRound(); break; }`. nextRound sets phase='playing' at :643, so the second arrival is a no-op. Give the client local feedback in triggerNextRound (:1039): hide the button, set game-status to "Starting next round...", and send `round: state.round`. Delete the dead nextRoundTimer guard at :635 and its field at :443 so nobody mistakes it for working protection.

**Blast radius.** local; the same guard block as cah-queued-czar-commands-replayed and cah-gameover-timer-races-next-round.

**Fix alongside.** `cah-queued-czar-commands-replayed`

### The host's own submit paints "waiting for others" on top of the judging screen it just triggered

<a id="cah-host-local-dispatch-overwrites-judging-screen"></a>

**Low** · Still broken · Small effort · `cah-host-local-dispatch-overwrites-judging-screen` · line 947

**What a player sees.** When the host is the last person to play their cards, their screen shows the anonymous answers with a "Cards submitted! Waiting for others..." panel stacked on top of them. They cannot tell that judging has begun, and it stays that way for the whole judging phase, every round they submit last.

**What causes it.** Every game where the host is a player and submits last. sendToHost (:828-834) dispatches the host's own message synchronously, so startJudging and renderRound run inside the click handler, and submitCards' trailing UI writes at :954-956 then land on top of the screen its own message just produced.

**The fix.** Two options, do at least one. Narrow: make the send the last statement of submitCards (:945-958) — move `sendToHost({type:'submit', cards})` from :947 to after :957. Safe because `cards` is captured first and the host handler only touches state.hands[senderId] (:565), never state.myHand. General: at :829-831 dispatch the host's own message on a fresh task, `queueMicrotask(() => handleHostMessage(state.myId, data))` — microtask rather than setTimeout so it still runs before paint and there is no flash — which gives pick-winner and next-round the same ordering guarantee for free.

**Blast radius.** the queueMicrotask version changes the timing of every host-originated command in this file, so re-check pickWinner (:1008) and triggerNextRound (:1039) after it. texas-holdem has the identical host-dispatches-locally shape.

---

# Herd Mentality

`projects/herd-mentality/index.html` — 14 bugs

## Root causes

- Rejoin is written as a whitelist instead of a re-seat. onPlayerRejoined (index.html:903-933) has two branches and BOTH are gated on disconnectedPlayers.has(...), a set written in exactly one place (index.html:944, from onPlayerLeft). Any reconnect the host did not first observe as a departure — a fast tab reload, an unclean WebRTC drop, a lobby-phase blip that deleted the name — falls through both branches and sends nothing at all, leaving the player on a permanent spinner while the host waits for an answer they have no screen to type. Four bugs (fast-rejoin-sends-no-state, rejoin-only-works-if-the-host-noticed-you-left, lobby-blip-permanently-locks-player-out, and the join-side twin latecomer-deadlocks-answering-round) are all this one fault. One rewrite — resolve the name, re-admit unconditionally, treat disconnectedPlayers.delete as a side effect, and always send the state payload — closes all four. The fixed library helps here: sloplobby now preserves its per-client record across client-left, so nameForClientId reliably resolves inside this callback.

- No message the host receives is checked against the phase or round it was written for. handleHostMessage case 'answer' (index.html:972-978) accepts an answer in any phase, for any round, and then calls checkAllAnswered(); checkAllAnswered (index.html:1016) has no phase guard; showMergeScreen (index.html:1204) unconditionally rebuilds mergeGroups from scratch; computeAndShowResults (index.html:1260) adds +1 with no round key. A single queued answer arriving late therefore walks the whole chain and destroys the host's manual merges or scores the round twice. The 'moo' message has the same shape (no round, no phase check). Three bugs collapse into: round-stamp outgoing app messages, guard on (gamePhase, round) at ingest, and make the terminal transition idempotent.

- The app confuses 'temporarily gone' with 'gone for good', and the library has just handed it the distinction it was missing. onPlayerLeft (index.html:935-951) fires on the first dropped packet: in lobby it deletes the player outright, mid-game it immediately auto-advances the round without them. The library now passes `final` (false while the 120s seat is still held, true when released) and offers an onPlayerLost callback. Adopting it fixes the lobby lock-out and stops rounds closing on a locked screen. Note the flip side: because herd defines no onPlayerLost, its onPlayerLeft now fires TWICE per departure, so anything non-idempotent in there is a live hazard today.

- There is no teardown and no terminal failure anywhere in this file — grep for 'destroy' returns zero hits. startHost (index.html:874) and startPlayer (index.html:1365) each assign a new SlopLobby over a live one, and case 'join-error' (index.html:1472) leaves the rejected connection running. Because both lobbies share one sessionStorage clientId, the abandoned one eventually reconnects and SlopNet's rejoin branch swaps its socket into the live player's seat, after which the real tab's messages arrive with an unresolvable id and are dropped in silence. flip-7 and texas-holdem both already tear their client down; herd is the outlier. Two library faults keep this dangerous even after the app fix, and neither was addressed in the 31: slopnet.js:414-443 does not close the superseded connection before swapping, and slopnet.js:484 synthesises a clientId from a raw peer id instead of dropping an unknown message.

- The host is treated as the sole authority on a fact only the client knows. hasAnswered is read at index.html:916 and 929 at the instant client-rejoined fires — which the library guarantees is BEFORE the returning client has flushed its outbound queue — so a player who did answer is told they did not, shown a blank box, and then has their retype silently binned by the first-write-wins guard at index.html:974. Compounding it, SlopLobby.sendToHost (sloplobby.js:430-432) still discards PeerClient.send's return value, so a queued send renders as a confident submitted tick. The cure is client-side: track your own submitted round locally, and add a host ack so the client converges under any ordering.

- There is no manual control anywhere for a round that will not close. checkAllAnswered is the app's single gate and is reachable from only two places (an inbound answer and a departure); host-waiting-screen (index.html:526-533) has no buttons at all, and the merge screen has no way back to answering. So every one of the deadlock bugs above is unrecoverable except by the host reloading — which destroys the room entirely, since herd has no host rejoin (index.html:1516). A "Reveal answers now" button and a "Back to answering" button are cheap, and they turn several critical bugs into annoyances even before the underlying faults are fixed.

## Where to start

Fix in four sittings, in this order. (1) Rewrite onPlayerRejoined at index.html:903-933 as an unconditional re-seat, and in the same edit give onPlayerJoined a non-lobby branch that sends the rejoin payload (index.html:898-901). That is one contiguous block of code and it closes four bugs, three of which are total lockouts that also freeze the whole table. (2) Add the two host escape hatches — \"Reveal answers now\" on host-waiting-screen and \"Back to answering\" on the merge screen. They are pure additions, cannot regress anything, and immediately downgrade every remaining deadlock from fatal to irritating; do them before the harder logic so you are not testing the rest with a game that can wedge. (3) Do the round/phase discipline as one job: round-stamp the answer at index.html:1505, guard ingest at index.html:972-978, add the phase guard to checkAllAnswered at index.html:1016, make scoring idempotent per round in computeAndShowResults, and round-guard the moo. Then adopt the library's `final` flag in onPlayerLeft (index.html:935) so the round stops auto-advancing on a temporary drop — do this last within the sitting, because the escape hatches from step 2 are what make it safe. (4) Housekeeping: the three destroy() calls (startHost, startPlayer, join-error), the client-side myAnswer tracking plus answer-ack, and the shared AudioContext. Deliberately last: the moo bugs are the only ones a player would call cosmetic, and the destroy() fix is small but wants a careful pass over the auto-rejoin path once the rejoin rewrite has settled. Leave herd-host-blip-closes-answering-round closed — verify it by reading slopnet.js _startReconnect rather than by editing this file.

## Notes

- 14 confirmed bugs matched this file. Every cited line number is still accurate — the app file is unchanged at 1525 lines and nothing has drifted.
- Only one of the 14 is genuinely resolved by the library work (herd-host-blip-closes-answering-round). Two more changed shape rather than going away. The other 11 are untouched, because they are app-logic faults that the library was merely the trigger for.
- The 14 reports contain three near-duplicate pairs/triples: the two moo reports are the same bug, the two hasAnswered reports are the same bug, and three of the late-answer reports (reruns-merge / rescores-round / rebuilds-merge) describe one chain from different points along it. The real backlog is closer to 9 distinct defects, and the themes reduce those to 6 root causes.
- Two library faults that these bugs depend on were NOT in the 31 fixed and should be raised separately, since they affect all four apps: slopnet.js:414-443 overwrites an existing client's connection on rejoin without closing the superseded one (any peer knowing a clientId can take a live seat), and slopnet.js:484 emits a raw PeerJS peer id as a clientId when the client map misses, which is precisely what makes hijacked-seat message loss silent. Also, SlopLobby.sendToHost (sloplobby.js:430-432) still discards PeerClient.send's boolean, so no app can tell a sent message from a queued one.
- New hazard introduced by the library that is not in any of the 14 reports: herd defines no onPlayerLost, so sloplobby now calls its onPlayerLeft TWICE per departure — once at client-left (final=false) and again up to 120s later at client-lost (final=true). Herd's handler happens to be idempotent enough to survive this today (Set.add and Array.filter), but the second call also re-runs checkAllAnswered() while gamePhase is 'answering'. Adopting the `final` argument, which several fixes above need anyway, resolves it.
- Adjacent to but outside these 14, and worth a glance while in computeAndShowResults (index.html:1260): it dereferences sorted[0].players with no empty-array check, so confirming a merge with zero answers throws. Reachable today if every player is written off before anyone answers.
- Nothing in this triage was edited. All findings come from reading /home/user/slop/projects/herd-mentality/index.html, /home/user/slop/lib/slopnet/slopnet.js and /home/user/slop/lib/sloplobby/sloplobby.js as they currently stand.

## The bugs

| Severity | Status | Effort | Bug |
|---|---|---|---|
| Critical | Still broken | Medium | [onPlayerRejoined only re-seats players the host had already written off, so a fast return sends nothing at all](#herd-fast-rejoin-sends-no-state) |
| Critical | Still broken | Medium | [handleHostMessage 'answer' has no phase or round guard, so one late answer re-runs the round's terminal transition and scores it twice](#herd-late-answer-rescores-round) |
| High | Still broken | Small | [Same no-op rejoin, reached from the mid-answering-phase variant: host never marked you gone, so your reconnect is silently ignored](#herd-rejoin-only-works-if-the-host-noticed-you-left) |
| High | Still broken | Small | [A player who joins during the answering phase is counted as an answerer but never sent the question, deadlocking the round](#herd-latecomer-deadlocks-answering-round) |
| High | Still broken | Small | [checkAllAnswered() has no phase guard, so it can re-enter showMergeScreen() from any phase and wipe the host's manual merges](#herd-late-answer-reruns-merge) |
| High | Still broken | Medium | [The rejoin payload's hasAnswered is computed one round-trip before the returning client's queued answer arrives, so the player is asked to answer again and the retype is silently dropped](#herd-rejoin-asks-for-the-answer-again-then-bins-it) |
| High | Still broken | Small | [The app never calls lobby.destroy() anywhere, so an abandoned connection keeps reconnecting under the same clientId and steals the live tab's slot](#herd-never-destroys-zombie-hijacks-identity) |
| High | Still broken | Small | [case 'join-error' leaves the rejected connection alive, so it reconnects forever and the retry storm never exhausts](#herd-rejected-client-steals-seat) |
| High | Changed | Small | [A lobby-phase blip deletes the player from the roster outright, and neither rejoin branch can then put them back](#herd-lobby-blip-permanently-locks-player-out) |
| High | Changed | Medium | [onPlayerLeft auto-advances the round on a merely temporary drop, then the returning player's answer rebuilds the merge screen](#herd-late-answer-rebuilds-merge) |
| High | Fixed upstream | Small | [A host signalling hiccup used to mark every player disconnected at once and instantly end the round with only the host's answer](#herd-host-blip-closes-answering-round) |
| Medium | Still broken | Small | [Duplicate of the hasAnswered/queue-flush race, filed from the host-payload side](#herd-rejoin-hasanswered-computed-before-queue-flush) |
| Low | Still broken | Small | [playMoo builds a fresh AudioContext per call, never closes one, and never runs from a user gesture — silent on iOS, dead after a handful of moos elsewhere](#herd-moo-audiocontext-leaks-and-is-silent) |
| Low | Still broken | Small | [Duplicate report of the same AudioContext leak, without the iOS/autoplay and stale-delivery angles](#herd-moo-leaks-an-audiocontext-per-sound) |

### onPlayerRejoined only re-seats players the host had already written off, so a fast return sends nothing at all

<a id="herd-fast-rejoin-sends-no-state"></a>

**Critical** · Still broken · Medium effort · `herd-fast-rejoin-sends-no-state` · line 903

**What a player sees.** You pull-to-refresh or your phone kills the tab, the page reloads and says "Reconnected!" — and then just spins on "Connecting…" forever. You never see the question. Meanwhile everyone else is stuck on "3 of 4 answered" waiting for an answer you have no screen to type, and the round can never end for anybody. Closing the tab completely is the only escape.

**What causes it.** Tab discarded/reloaded (or a duplicate tab opened) fast enough that the host's 15s heartbeat has not yet convicted you, so no client-left ever fired. SlopNet matches the sessionStorage clientId and emits client-rejoined with no preceding client-left.

**The fix.** Rewrite onPlayerRejoined (index.html:903-933) as a single unconditional branch. Both existing branches are gated on disconnectedPlayers.has(...) (lines 909 and 922), and that set is only ever written at line 944 from onPlayerLeft — so a rejoin the host never saw as a leave falls through both and sends nothing. Replace with: resolve the name from nameForClientId(clientId) first (sloplobby now PRESERVES its record across client-left, so this reliably resolves), fall back to a case-insensitive match against `players`, then fall back to metadata.name; if still nothing, treat as a fresh join. Then always: disconnectedPlayers.delete(name); push into `players` and seed scores[name] if absent; lobby.players.set(clientId,{name}); send the existing {type:'rejoin', ...} payload; broadcastLobby(); and if gamePhase==='answering' also broadcastProgress() + checkAllAnswered() so a round that stalled while they were away is re-evaluated. disconnectedPlayers.delete must be a side effect, never a precondition.

**Blast radius.** Host-side only, but it is the single entry point for every reconnect in the app — mid-game, lobby and post-window return all funnel through it. Getting it wrong re-admits strangers mid-game or duplicates a name. The 'rejoin' payload it sends is already handled by the client at index.html:1407-1440, so no wire-format change.

**Fix alongside.** `herd-rejoin-only-works-if-the-host-noticed-you-left`

### handleHostMessage 'answer' has no phase or round guard, so one late answer re-runs the round's terminal transition and scores it twice

<a id="herd-late-answer-rescores-round"></a>

**Critical** · Still broken · Medium effort · `herd-late-answer-rescores-round` · line 972

**What a player sees.** Everyone is looking at the results. Suddenly the host is yanked back to the grouping screen with all their hand-merged groups undone, and after they redo it and confirm, two players' scores have jumped by two points for a single round. In a first-to-N game that decides who wins.

**What causes it.** A player submits while briefly offline; SlopNet queues the message on their phone. The host times them out, closes the round without them, merges by hand and confirms. They come back inside the 120s window; the queued round-N answer flushes on the join ack and lands on a host that is already in 'results'.

**The fix.** Three changes in index.html. (1) Round-stamp the send: index.html:1505 becomes lobby.sendToHost({ type: 'answer', answer, round: roundNumber }) — the client already tracks roundNumber from the 'question' broadcast (line 1443) and the 'rejoin' payload (line 1412). (2) Guard ingest at index.html:972-978: break unless gamePhase === 'answering' AND (typeof data.round !== 'number' || data.round === roundNumber) AND !answers[name]. The round check is not optional on top of the phase check — without it a queued round-N answer arriving after the host has started round N+1 (also 'answering') is accepted as the new round's answer and can close that round early for everyone. (3) Make scoring idempotent: computeAndShowResults (index.html:1260) does scores[name] = (scores[name]||0)+1 at line 1270 with no round key, so any second confirm double-credits and can move the pink cow twice off one round. Keep a module-level Set of scored round numbers, add roundNumber to it on first confirm, and on a repeat re-render only. Clear it where scores are reset (the btn-start-game handler, index.html:1059-1061).

**Blast radius.** Touches the host ingest path, the client submit line, and the scoring function — the three points every round flows through. The added `round` field is backwards-compatible if you keep the typeof check, so a client left open from an older page load is not silently muted mid-session.

**Fix alongside.** `herd-late-answer-reruns-merge`

### Same no-op rejoin, reached from the mid-answering-phase variant: host never marked you gone, so your reconnect is silently ignored

<a id="herd-rejoin-only-works-if-the-host-noticed-you-left"></a>

**High** · Still broken · Small effort · `herd-rejoin-only-works-if-the-host-noticed-you-left` · line 906

**What a player sees.** You reopen the game after glancing at a message. It says you are reconnected, but the question never appears and nothing on your screen ever changes. The host's screen says it is still waiting for you, and there is no button anywhere to move the game on without you.

**What causes it.** WebRTC drops with no clean close (backgrounded iOS tab, app switch), the host's DataConnection still reads open, so no client-left. You come back, SlopNet emits client-rejoined, and the branch at index.html:906-909 needs disconnectedPlayers.has(existingMatch) — which is empty.

**The fix.** Same single fix as herd-fast-rejoin-sends-no-state (index.html:903). Separately, and needed regardless: the host has no manual override. host-waiting-screen (index.html:526-533) is markup with no buttons at all — hw-players and hw-progress only. Add a "Reveal answers now" button there that clears mooTimeout and calls showMergeScreen() directly, so a wedged round is always recoverable by the host without reloading (which destroys the room — there is no host rejoin, see index.html:1516).

**Blast radius.** Local once the shared onPlayerRejoined rewrite lands; the host-override button is new UI on one screen and touches nothing else.

**Fix alongside.** `herd-fast-rejoin-sends-no-state`

### A player who joins during the answering phase is counted as an answerer but never sent the question, deadlocking the round

<a id="herd-latecomer-deadlocks-answering-round"></a>

**High** · Still broken · Small effort · `herd-latecomer-deadlocks-answering-round` · line 898

**What a player sees.** Someone arrives late and joins with the room code. Their phone shows the lobby and "Waiting for the host to start" — but the game is already running. Everybody else answers and then the host's screen reads "3 of 4 answered" forever. Nobody can move on. The only way out is the latecomer closing their browser, or the host reloading, which destroys the room and every score with it.

**What causes it.** Any join while gamePhase !== 'lobby'. onPlayerJoined (index.html:880-902) validates only the name and never looks at gamePhase; it pushes into `players` at line 898 and sends {type:'joined'}, which the client renders as a lobby screen.

**The fix.** In onPlayerJoined, after the accept block at index.html:898-901, branch on phase before returning: send the existing {type:'joined', ...} first (it seeds players/scores/cowHolder on the client), then if (gamePhase !== 'lobby') also send the full {type:'rejoin', name, players, scores, cowHolder, gamePhase, round: roundNumber, question: currentQuestion, hasAnswered: false} payload, then broadcastLobby(). Ordering matters — 'joined' must precede 'rejoin'. Sending 'rejoin' for every non-lobby phase (not just 'answering') is what makes it correct: the client handler at index.html:1418-1430 already routes question/merge/results to player-waiting-screen, so a latecomer arriving during merge or results is parked properly instead of shown a false lobby. Also call renderHostWaiting() from broadcastLobby (index.html:993-996), guarded to only run while host-waiting-screen is showing, or the host's progress line stays stale at "3 of 3" while a fourth tag silently appears.

**Blast radius.** Host-side, one callback; reuses a payload the client already handles, so no protocol change and no client edit. Note the library change shrinks this bug's population: a player returning after their 120s window now arrives as client-rejoined rather than client-joined, so only genuine newcomers reach here.

**Fix alongside.** `herd-fast-rejoin-sends-no-state`

### checkAllAnswered() has no phase guard, so it can re-enter showMergeScreen() from any phase and wipe the host's manual merges

<a id="herd-late-answer-reruns-merge"></a>

**High** · Still broken · Small effort · `herd-late-answer-reruns-merge` · line 977

**What a player sees.** The host is halfway through combining near-identical answers ("Dogs" with "a dog") when the cards suddenly re-shuffle under their finger and every merge they made is gone, with no undo. Or they are already on the results screen and get thrown back to grouping.

**What causes it.** Any second call to checkAllAnswered() once the phase has moved on — from the late/queued answer at index.html:977, or from onPlayerLeft at index.html:947, or from the host's own submit at index.html:1182. showMergeScreen (index.html:1204-1216) unconditionally sets gamePhase='merge' and rebuilds mergeGroups from `answers`, discarding the in-place merges the click handler made at index.html:1233-1252.

**The fix.** Add `if (gamePhase !== 'answering') return;` as the first line of checkAllAnswered (index.html:1016). This is the real backstop and is strictly better than guarding inside showMergeScreen, whose only caller is checkAllAnswered — it covers all three call sites and any future one. Also move the mooTimeout clear into showMergeScreen (index.html:1204) rather than only at index.html:1019, since the merge screen is the point at which that timer is meaningless. Note broadcastProgress (index.html:993-1013) re-arms mooTimeout on every call, so an ungated late answer also fires a stray moo at a player mid-results.

**Blast radius.** One line in one function, but it is the sole gate that advances the round — verify the normal path still closes the round (it is always called while gamePhase === 'answering'). Pair it with a host override button on host-waiting-screen so a round that legitimately cannot reach the threshold is still closable.

**Fix alongside.** `herd-late-answer-rescores-round`

### The rejoin payload's hasAnswered is computed one round-trip before the returning client's queued answer arrives, so the player is asked to answer again and the retype is silently dropped

<a id="herd-rejoin-asks-for-the-answer-again-then-bins-it"></a>

**High** · Still broken · Medium effort · `herd-rejoin-asks-for-the-answer-again-then-bins-it` · line 916

**What a player sees.** You type your answer, tap Submit and get the tick. You lose signal for a moment. When you come back the app shows you the same question with an empty box, as if you had never answered — so you type something else and submit. That second answer is thrown away without a word, and the round is scored on the hurried one you thought you had replaced.

**What causes it.** Submit while the client is already past its heartbeat timeout: PeerClient.send queues instead of sending, and SlopLobby.sendToHost (sloplobby.js:430-432) still discards the false return, so the UI shows 'submitted' regardless. On reconnect the host sends the join ack and emits client-rejoined synchronously, so herd composes {type:'rejoin', hasAnswered:false} at index.html:916 before the client has even flushed. The client's guard at index.html:1422 then re-shows a blank answer box, and the host's first-write-wins guard at index.html:974 drops whatever they retype.

**The fix.** Make the client authoritative about its own answer. (1) Add a module-level `let myAnswer = null;` near the player state (around index.html:709-721) and set myAnswer = { round: roundNumber, answer } in the submit handler (index.html:1502-1506) BEFORE the sendToHost call. (2) At index.html:1422 use `if (data.hasAnswered || (myAnswer && myAnswer.round === data.round))` to choose player-waiting-screen, so a client that already submitted this round is never handed a blank box whatever the message ordering. (3) Clear myAnswer in `case 'question'` (index.html:1443-1448) and `case 'next-round'` (index.html:1462) — a genuinely new round — but NOT in showPlayerAnswer(), which is also reached from rejoin. (4) Add a host ack so the client self-corrects in any ordering: after answers[name] is set at index.html:975, lobby.send(clientId, {type:'answer-ack', round: roundNumber}), with a matching client case that switches to the waiting screen. (5) Be honest about queued sends: make sloplobby's sendToHost return the boolean and, when false, show "Saved — will send when you reconnect" rather than the submitted tick. Do NOT fix this by letting the host overwrite answers[name] — that would let a returning player rewrite their answer after seeing everyone else's progress.

**Blast radius.** Adds client-side state and one new message type; the sendToHost return-value change is in lib/sloplobby and affects all four consumer apps, so treat that part as a separate library change. Everything else is local to herd's player path.

**Fix alongside.** `herd-rejoin-hasanswered-computed-before-queue-flush`

### The app never calls lobby.destroy() anywhere, so an abandoned connection keeps reconnecting under the same clientId and steals the live tab's slot

<a id="herd-never-destroys-zombie-hijacks-identity"></a>

**High** · Still broken · Small effort · `herd-never-destroys-zombie-hijacks-identity` · line 1365

**What a player sees.** After a failed join attempt you pick a different name and get in fine — and then every answer you type just disappears. Your screen and the host's both look perfectly connected. The host's counter never reaches the total, so the round never ends for anyone at the table.

**What causes it.** Any rejected join followed by a retry in the same tab. grep for 'destroy' in this file returns nothing: startHost (index.html:874) and startPlayer (index.html:1365) both assign a new SlopLobby over a live one, and the two lobbies read the same clientId from sessionStorage (sloplobby.js:394 -> getClientId), so the abandoned one eventually reconnects and SlopNet's rejoin branch (slopnet.js:414-443) swaps its connection into your live entry and re-keys the client map — orphaning your real tab.

**The fix.** In this file: add `if (lobby) { lobby.destroy(); lobby = null; }` at the top of startPlayer (before index.html:1365) and startHost (before index.html:874), and in the join-error handler (see herd-rejected-client-steals-seat). SlopLobby.destroy() calls client.destroy(), which sets _destroyed and short-circuits _attemptReconnect (slopnet.js:1224), killing the retry loop. Compare flip-7/index.html:1531-1536 and texas-holdem/index.html:1433, which both already tear the client down. Two residual library faults keep the worst of this alive even after the app fix and should be raised against lib/slopnet, which I confirmed is unchanged here: (a) slopnet.js:414-443 overwrites existing.conn without closing the superseded connection, so any peer that knows a clientId can take a live player's seat; (b) slopnet.js:484 synthesises a clientId from the raw peer id when clients.get(conn.peer) misses, which is what makes the orphaned tab's answers vanish silently instead of erroring — it should drop the message or reply with a resync marker.

**Blast radius.** Adding destroy() calls is three lines and local, but it is the first teardown this app has ever had — verify the host->player transition in one tab and the auto-rejoin path (index.html:1509-1520) still work. The library parts affect all four apps.

**Fix alongside.** `herd-rejected-client-steals-seat`

### case 'join-error' leaves the rejected connection alive, so it reconnects forever and the retry storm never exhausts

<a id="herd-rejected-client-steals-seat"></a>

**High** · Still broken · Small effort · `herd-rejected-client-steals-seat` · line 1472

**What a player sees.** You try to join with a name someone already used. You get "Name already taken", type a different name, and get in — but from then on your answers go nowhere, and every so often the game bounces you back to the join screen mid-round for no reason.

**What causes it.** Any rejected join. The handler at index.html:1472-1475 does showError + showScreen only. SlopNet acks the join before the app votes (slopnet.js:465 sends __slopnet_join_ack, then emits client-joined), so the rejected client has already reset _reconnectAttempts to 0; sloplobby's rejection path (sloplobby.js:242-248) only closes the connection, which the client reads as a disconnect and retries. Its data listener is still bound to the module-level handlePlayerMessage, so its own repeated join-errors can drive showScreen('join-screen') on your live session.

**The fix.** case 'join-error' (index.html:1472) becomes: showError(data.reason || 'Could not join room'); if (lobby) { lobby.destroy(); lobby = null; } showScreen('join-screen'); break. Same for case 'error' at index.html:1477. Note the rejection is only reachable at all because onPlayerJoined (index.html:884-895) rejects any name already in `players` — after the library change a post-window returner arrives as client-rejoined and no longer trips this, so what remains is genuine duplicates and a player who closed their tab (burning the sessionStorage clientId) and rejoined with the same name. The durable cure is a library one: make rejection terminal with a protocol-level reject message that sets the client's _destroyed-equivalent flag rather than a plain conn.close() that reads as a transient drop.

**Blast radius.** Three lines in one switch case; do it in the same sitting as the destroy() calls in startPlayer/startHost since they are the same defect. The library reject-protocol follow-up touches lib/slopnet and lib/sloplobby and therefore all four apps.

**Fix alongside.** `herd-never-destroys-zombie-hijacks-identity`

### A lobby-phase blip deletes the player from the roster outright, and neither rejoin branch can then put them back

<a id="herd-lobby-blip-permanently-locks-player-out"></a>

**High** · Changed · Small effort · `herd-lobby-blip-permanently-locks-player-out` · line 941

**What a player sees.** You join the lobby, your screen locks while everyone waits for one more person, and when you unlock you are simply gone: your name has vanished from the host's lobby list and your own screen is stuck on "Connecting…" with no error and no button. Reloading does not help — it puts you back in exactly the same hole. The host's Start Game button stays greyed out because the player count is one short.

**What causes it.** Any 15s+ silence during the lobby phase (locked phone, lift, tunnel). Host heartbeat convicts you, client-left fires, and index.html:938-941 takes the lobby branch: players = players.filter(p => p !== name), with no disconnectedPlayers entry recorded.

**The fix.** Two parts in onPlayerLeft (index.html:935-951). (1) The library now passes a third argument: onPlayerLeft(clientId, meta, final). `final` is false while SlopNet is still holding the seat open and true only when the reconnect window has expired. Change the signature to (clientId, meta, final) and only run the lobby-branch removal at line 941 when final === true — a temporary blip must not empty a seat the library is still holding. (Equivalently, define onPlayerLost and move the removal there.) (2) The rejoin path must still cope with a player who really was removed, so the terminal-else in the herd-fast-rejoin-sends-no-state fix is required too: it re-pushes the name into `players` and re-seeds scores. Do NOT 'fix' this by adding the name to disconnectedPlayers before the lobby filter without also changing renderLobby (index.html:1049-1055), which counts raw players.length and would let the host start a game with a phantom player.

**Blast radius.** onPlayerLeft is the only consumer of that callback; adding the third parameter is backwards-compatible. Shape changed under the new library: sloplobby no longer deletes its record on client-left, so nameForClientId now resolves after a drop — the fall-through is now purely the disconnectedPlayers precondition, not a lost name.

**Fix alongside.** `herd-fast-rejoin-sends-no-state`

### onPlayerLeft auto-advances the round on a merely temporary drop, then the returning player's answer rebuilds the merge screen

<a id="herd-late-answer-rebuilds-merge"></a>

**High** · Changed · Medium effort · `herd-late-answer-rebuilds-merge` · line 947

**What a player sees.** One player's screen locks for a quarter of a minute and the game closes the round without them — they get no chance to answer and score nothing. Then when they come back, their answer arrives anyway and the host's grouping work is rebuilt from scratch, or the results are re-awarded.

**What causes it.** Host heartbeat convicts a frozen tab after ~15s; index.html:944-947 marks them disconnected and immediately calls checkAllAnswered(), which now sees a smaller active roster and closes the round. Their queued answer flushes on return.

**The fix.** Stop treating a temporary drop as a departure. The library now passes `final` as the third argument to onPlayerLeft: change the signature at index.html:935 and only call checkAllAnswered() from line 947 when final === true (or define onPlayerLost and put the auto-advance there). While the seat is still held open, just repaint — renderHostWaiting() already renders a disconnected tag. Because that removes the automatic advance for the common case, the host needs the manual "Reveal answers now" control on host-waiting-screen described in herd-rejoin-only-works-if-the-host-noticed-you-left. Do NOT use the tempting `if (activePlayers.length < 2) return;` guard — in a legitimate host-plus-one game where that player really does leave, the round could then never be closed at all, converting a mis-scored round into a permanent hang.

**Blast radius.** Changes when the round advances, which is the app's central control-flow decision — needs playtesting of the genuine-departure path. Shape changed under the new library in two ways: the same code now runs twice (client-left with final=false, then client-lost with final=true, since herd defines no onPlayerLost), and SlopNet now also emits client-rejoined when a written-off client speaks over a still-open channel — so the app can re-admit the player and then process their answer in the same tick, reaching the merge-rebuild without any client-side queue involved.

**Fix alongside.** `herd-late-answer-rescores-round`

### A host signalling hiccup used to mark every player disconnected at once and instantly end the round with only the host's answer

<a id="herd-host-blip-closes-answering-round"></a>

**High** · Fixed upstream · Small effort · `herd-host-blip-closes-answering-round` · line 946

**What a player sees.** Was: the host switches from WiFi to mobile data and the round instantly ends on whoever had answered so far — usually just the host — with everyone else's typed answer thrown away, and the pink cow handed to the host for a network hiccup. No way back: the merge screen has no "return to answering" control.

**What causes it.** Host peer emitting 'disconnected' while players were mid-answer. Gone: _startReconnect (slopnet.js:751-763) no longer walks this.clients marking them disconnected and emitting client-left, and _doReconnect (slopnet.js:801+) now re-registers alongside the existing peer instead of destroying it — which used to close every data channel and reproduce the same fan-out one backoff tick later. The host heartbeat also now pings before convicting and counts inbound traffic as proof of life, so a throttled host timer can no longer evict a table in one pass.

**The fix.** No app change needed for the reported trigger. The app-side weakness it exposed is real and lives on under other triggers, and is covered by two other items: checkAllAnswered has no phase guard (herd-late-answer-reruns-merge) and onPlayerLeft auto-advances the round on a temporary drop (herd-late-answer-rebuilds-merge). Do not reopen this one; verify it by confirming there is no client loop in slopnet.js _startReconnect. Optional hardening once those two land: a "Back to answering" control next to merge-confirm-btn (index.html:1255) so any wrong advance is recoverable rather than terminal.

**Blast radius.** None — nothing to change here.

**Fix alongside.** `herd-late-answer-rebuilds-merge`

### Duplicate of the hasAnswered/queue-flush race, filed from the host-payload side

<a id="herd-rejoin-hasanswered-computed-before-queue-flush"></a>

**Medium** · Still broken · Small effort · `herd-rejoin-hasanswered-computed-before-queue-flush` · line 916

**What a player sees.** Same as above from the host's side: the host and the player disagree about whether that player has answered for the rest of the round — the host shows them ticked while their own phone shows an empty answer box.

**What causes it.** Identical: hasAnswered is read at index.html:916 (and index.html:929 in the second branch) at the moment client-rejoined fires, which the library guarantees is before the client has flushed its queue.

**The fix.** Fixed entirely by the herd-rejoin-asks-for-the-answer-again-then-bins-it work; do not schedule it separately. If you want the host side to be right on its own, note that BOTH rejoin branches read hasAnswered (index.html:916 and index.html:929) and both need the same treatment — but the client-side myAnswer tracking is what actually makes the ordering irrelevant, because the host physically cannot know about a message still sitting on the player's phone.

**Blast radius.** None beyond the grouped fix.

**Fix alongside.** `herd-rejoin-asks-for-the-answer-again-then-bins-it`

### playMoo builds a fresh AudioContext per call, never closes one, and never runs from a user gesture — silent on iOS, dead after a handful of moos elsewhere

<a id="herd-moo-audiocontext-leaks-and-is-silent"></a>

**Low** · Still broken · Small effort · `herd-moo-audiocontext-leaks-and-is-silent` · line 757

**What a player sees.** The moo — the nudge the game is named after, aimed at whoever everyone is waiting on — never makes a sound at all on iPhones, and on other phones it stops working permanently partway through the first game. And when it does play, it can fire minutes late for a round that finished long ago.

**What causes it.** Every moo. index.html:757 constructs a new AudioContext inside a setTimeout (host, index.html:1005-1011) or a data-channel handler (client, index.html:1454-1455) — never a user-activation stack, so on WebKit it starts suspended and nothing ever calls resume(). Nothing calls ctx.close() anywhere in the file, so after roughly 4 (WebKit) or 6 (Chrome) contexts the constructor throws into the empty catch at index.html:778 and the sound is gone for the session.

**The fix.** Three changes, all in index.html. (1) One lazily-created shared context: add `let audioCtx = null;` and a getAudioCtx() helper above index.html:755 that constructs once, calls resume() when state === 'suspended', and returns null on throw; replace line 757 with `const ctx = getAudioCtx(); if (!ctx) return;`. Snapshot `const t = ctx.currentTime` once and use it for every schedule call — with a long-lived context currentTime advances between statements. (2) Prime it from a real tap: call getAudioCtx() in the btn-create-go handler (index.html:832) and btn-join-go handler (index.html:845), and also in pa-submit-btn (index.html:1502), since a tab restored from sessionStorage via tryAutoRejoin never passes through the join button. (3) Round-guard the message: send { type: 'moo', round: roundNumber } at index.html:1010 and make index.html:1454 `if (data.round === roundNumber && gamePhase === 'answering') playMoo();`, so a moo delivered when a frozen tab thaws is dropped rather than played for a scored round. Finally replace the bare catch at index.html:778 with a console.warn — the silent swallow is what makes all of this invisible.

**Blast radius.** Purely local to playMoo and its two call sites; no networking, no state. The round field on the moo message is additive.

**Fix alongside.** `herd-moo-leaks-an-audiocontext-per-sound`

### Duplicate report of the same AudioContext leak, without the iOS/autoplay and stale-delivery angles

<a id="herd-moo-leaks-an-audiocontext-per-sound"></a>

**Low** · Still broken · Small effort · `herd-moo-leaks-an-audiocontext-per-sound` · line 757

**What a player sees.** The moo goes quiet partway through a long session with no error, and every leaked context keeps an audio output stream open — measurable battery drain on the same phone that is also carrying the WebRTC room.

**What causes it.** Roughly the seventh moo in a tab, which in practice means the same habitually-slow player being last to answer several rounds running.

**The fix.** Fully covered by herd-moo-audiocontext-leaks-and-is-silent; do not schedule separately. The shared-context approach there also fixes the leak. If a per-sound context is ever preferred instead, the minimum correct version is `osc1.onended = () => ctx.close();` after index.html:776 rather than trusting GC — but the shared context is what iOS wants anyway, since it preserves the one user-gesture unlock across the whole game.

**Blast radius.** None beyond the grouped fix.

**Fix alongside.** `herd-moo-audiocontext-leaks-and-is-silent`

---

# Flip 7

`projects/flip-7/index.html` — 12 bugs

## Root causes

- **Identity is a display name, and it comes from the payload.** The host's data handler (:1122) throws away the `clientId` argument and trusts `data.playerName`; the rejoin handler matches on `players.includes(name)`; `nameToId` folds case and punctuation while every duplicate guard is exact-match; DOM ids, roundState, peerSubmissions, hostEditingPlayers, localPlayers and disconnectedPlayers are all keyed by the typed name. This one decision produces flip7-identity-from-payload, flip7-nametoid-collapses-two-players-into-one-scorecard, the wrong-name half of flip7-stale-score-submit, and the matching fragility in flip7-lobby-blip and flip7-pregame-drop-orphans. A stable seat id minted at seat time, plus resolving every inbound message through `lobby.players.get(clientId)`, retires all of them. Worth noting the library change here: SlopLobby now keeps its per-client record across 'client-left' and parks it across 'client-lost', so `lobby.players.get(clientId)` is finally a reliable lookup — the reason this fix used to be risky is gone.

- **The rejoin path is a second, impoverished copy of the join path — and the library now uses it constantly.** `onPlayerRejoined` (:1151) handles exactly one case: mid-game, name already in `players`, not the host. Every other rejoin falls off the end and sends the client nothing at all — no join-ok, no state, no error. Meanwhile 'client-rejoined' now fires in three situations rather than one (in-window rejoin, post-window return, and a client answering a ping over a still-open channel, slopnet.js:497-512), so this handler went from an edge case to the hot path. It explains flip7-lobby-blip-creates-ghost-player, the tail of flip7-pregame-drop-orphans-client, and it is why flip7-rejoin-destroys-both-copies now fires for players who never disconnected at all. Fix the handler as a single 'reconcile this player against current phase' function and four bugs move together.

- **Host-only actions are gated inside the function, after the local mutation, instead of on the button.** Reset Game, New Game and Play Again are rendered identically on every device; each handler mutates local state first and only then checks `if (gameMode === 'host')` before broadcasting. A peer therefore gets the whole effect and none of the propagation. That is flip7-peer-play-again-forks-the-scoreboard and flip7-peer-reset-button-silently-evicts-self, and it is about twenty lines to close both — role-gate the controls at render time AND early-return in each handler, because stale DOM must not be trusted.

- **Nothing on the wire carries a round number or is idempotent.** `handleScoreSubmission` (:2197) writes `peerSubmissions[name] = scoreData` unconditionally: no round stamp, no already-submitted guard, no membership check. Any message that arrives late, twice, or from the wrong sender simply wins. This is the mechanism behind flip7-stale-score-submit, the damage half of flip7-identity-from-payload, and the blank-resubmit-clobbers-47 outcome in flip7-rejoin-destroys-both-copies. One `round` field and two guards fix all three.

- **Session state is entered but never unwound.** `cleanupMultiplayer` (:1623) resets variables but not the DOM — the host's name input is disabled at :1267 and re-enabled nowhere in the file — and one disconnect branch (:1400-1405) forgets to call it at all, leaving a live PeerClient behind. That is flip7-host-identity-locked-after-leaving-room and flip7-pregame-drop-orphans-client. The join form already does this correctly at :1049-1056; the host form and the peer disconnect path just need the same treatment.

- **There is no way to say 'the room is over', and no terminal state to receive it.** Neither slopnet nor the app has a room-closed concept, so a deliberate end and a tunnel look identical to every client, and the goodbye broadcast is destroyed by the host's own synchronous `destroy()`. Related: `updateReconnectBanner` (:1456) is still dead code because sloplobby never forwards 'reconnecting', and `sendToHost` (sloplobby.js:430) still discards the delivery boolean so the app tells players 'submitted' for messages that only got queued. These are library-shaped and affect all four apps — do them as one deliberate library change, not as flip-7 edits.

## Where to start

"Sitting 1 — host-side admission and identity (highest value per line, and everything else assumes it). Rewrite onHostData to resolve the sender by clientId, add a `!gameStarted` branch plus a not-in-roster join-error to onPlayerRejoined, add a `round` stamp and an already-submitted guard to handleScoreSubmission, and make the client's 'game-start' branch refuse a roster it is not in. That is roughly forty lines and it retires or defangs flip7-lobby-blip-creates-ghost-player, flip7-identity-from-payload, flip7-stale-score-submit and the tail of flip7-pregame-drop-orphans-client.\n\nSitting 2 — role gating (twenty lines, two high-severity bugs). Hide Reset/New Game/Play Again from peers, early-return in all three handlers, and relabel Reset as 'Leave Game' with a real leave message so peers still have an exit. Closes flip7-peer-play-again-forks and flip7-peer-reset-button-silently-evicts-self.\n\nSitting 3 — the round-score custody chain. Stop `_hostEditPlayer` deleting `peerSubmissions`, add a cancel/'use their score' affordance, and make rejoin-ok carry `submitted` + `scoreData` so the client stops blanking itself. Closes flip7-rejoin-destroys-both-copies and flip7-host-edit-permanently-voids-the-players-own-score. This is now more urgent than its 'medium' label suggests, because the library's new ping-answer rejoin means rejoin-ok reaches players who never dropped.\n\nSitting 4 — lifecycle housekeeping. Re-enable the host name inputs in cleanupMultiplayer and initHostPeer; call cleanupMultiplayer in the pre-game disconnect branch and at the top of attemptJoin. Small, self-contained, closes flip7-host-identity-locked and the duplicate-client half of flip7-pregame-drop-orphans.\n\nSitting 5 — normalise the duplicate-name guards through nameToId (small), and only then decide whether to do the full seat-id migration (large, changes the wire shape). Do not start the seat-id rewrite before sitting 1, or you will migrate identity twice.\n\nLast — the library work: room-closed protocol, the PeerClient `_connecting` flag, forwarding 'reconnecting', and returning sendToHost's boolean. These touch all four apps and the vitest suite; they should be scheduled as a library change with tests, not smuggled into a flip-7 fix."

## Notes

- Line numbers had not drifted at all — every cited location in the bug list still points at the same code today. The locations I recorded differ from the report in only one place: I anchored flip7-host-edit-permanently-voids-the-players-own-score at :1897 (`delete peerSubmissions[name]`) rather than :1898, since the delete is the defect.
- Nothing in flip-7 was fixed by the library work outright — there are no 'fixed-by-library' entries. Four bugs changed shape (flip7-lobby-blip, flip7-rejoin-destroys-both-copies, flip7-peer-reset-evicts-self, flip7-visibility-nudge); the other eight are untouched.
- The library made one flip-7 bug WORSE, and it is worth flagging to whoever picks this up. 'client-rejoined' now also fires when a client the host had written off answers a ping over a still-open channel (slopnet.js:497-512). flip-7 answers every rejoin with rejoin-ok, and its client handler at :1521-1523 blindly sets `myScoreSubmitted = false` and calls `resetRoundState()`. A player who was merely slow for twenty seconds — no disconnect, no banner, nothing on their screen — now has their half-entered scorecard wiped and their submitted flag cleared. That is a new, ordinary-conditions data loss introduced by an otherwise correct library fix.
- Two claims from the original reports are now obsolete and should not be carried into the fixes. (1) 'lobby.players is deleted on client-left' — no longer true; SlopLobby holds the record until 'client-lost' and then parks it in `_pastPlayers`, so resolving a sender via `lobby.players.get(clientId)` is now safe and needs no `_findClientByClientId` fallback. (2) 'a post-window returner arrives as client-joined and is refused by the mid-game guard' — no longer true; they arrive as 'client-rejoined', which is why the permanent lockout in flip7-peer-reset-button-silently-evicts-self is gone.
- flip-7 does not define `onPlayerLost`, so under the new SlopLobby it now receives a SECOND `onPlayerLeft` with `final = true` when a reconnect window expires. I checked both branches of flip-7's handler (:1180-1194) and both are idempotent — the pre-game branch re-filters an already-absent clientId, the in-game branch re-adds an already-present name to `disconnectedPlayers` — and `meta` is always populated because SlopLobby computes it before deleting the record. No action needed, but do not assume the callback fires once per player.
- Host->client queueing interacts with flip-7 more benignly than I expected. A player away for three rounds now gets three queued `state-update` messages flushed on return, each of which resets their round state and calls `checkWinner()` — but the flush happens before 'client-rejoined' is emitted (slopnet.js:436-442), so flip-7's rejoin-ok is delivered last and is authoritative. The visible artefact is a brief flicker of stale standings and possibly the winner banner during the flush, not a wrong final state.
- Still unfixed in the library and load-bearing for two flip-7 bugs: `_handleData` swaps `existing.conn` on a duplicate-clientId rejoin (slopnet.js:415-433) without closing the superseded connection, and the regular-data path at :485 still synthesises `clientId = conn.peer` for an unrecognised connection instead of dropping the message. flip-7 is the app that gets hurt by the second one, because it is the only consumer that accepts host-side writes without resolving the sender.
- `.hidden` is `display: none !important` in lib/slop-theme.css:261, which is copied into the project at deploy time — so the role-gating fix can rely on the class. flip-7 loads `lib/slopnet.js`, `lib/sloplobby.js` and `lib/slop-theme.css` from its own directory (index.html:11-13), and it IS in the copy lists in both deploy.yml and preview.yml.
- I did not edit any file. Everything above is from reading /home/user/slop/projects/flip-7/index.html, /home/user/slop/lib/slopnet/slopnet.js and /home/user/slop/lib/sloplobby/sloplobby.js as they currently stand.

## The bugs

| Severity | Status | Effort | Bug |
|---|---|---|---|
| High | Still broken | Small | [The host trusts the player name inside the score payload and never looks at which connection it arrived on](#flip7-identity-from-payload) |
| High | Still broken | Small | [The winner banner's Play Again / New Game are rendered for peers but their broadcast is host-gated, so a peer tapping them wipes only their own copy](#flip7-peer-play-again-forks-the-scoreboard) |
| High | Still broken | Small | [The host's name field is disabled forever after being set once, so a second hosted room can never be started](#flip7-host-identity-locked-after-leaving-room) |
| High | Changed | Medium | [onPlayerRejoined has no lobby branch, so a player who blips in the lobby is dropped from the roster but still receives game-start](#flip7-lobby-blip-creates-ghost-player) |
| High | Changed | Medium | [rejoin-ok blanks the client's submitted flag and round card while the host's Edit path deletes its own stored copy](#flip7-rejoin-destroys-both-copies-of-the-round-score) |
| Medium | Still broken | Small | [handleScoreSubmission has no round stamp and no idempotence, so a queued submission lands in whatever round is current when it arrives](#flip7-stale-score-submit-credited-to-next-round) |
| Medium | Still broken | Large | [The host's goodbye is broadcast and then thrown away by its own destroy(), and there is still no 'room closed' state anywhere](#no-room-closed-signal-on-host-destroy) |
| Medium | Still broken | Small | [A pre-game disconnect returns the player to the join form without destroying the client, so re-joining creates a second live PeerClient on the same clientId](#flip7-pregame-drop-orphans-client) |
| Medium | Still broken | Medium | [nameToId folds case and punctuation while every duplicate-name guard is exact-match, so two players share one scorecard and one set of DOM ids](#flip7-nametoid-collapses-two-players-into-one-scorecard) |
| Medium | Still broken | Medium | [Once the host taps Enter Score for a player, that player's own submission is accepted, stored, and then ignored for the rest of the round with no way to cancel](#flip7-host-edit-permanently-voids-the-players-own-score) |
| Medium | Changed | Medium | [Reset Game is shown to joined players; tapping it tears down their connection and tells the host nothing](#flip7-peer-reset-button-silently-evicts-self) |
| Medium | Changed | Medium | [The visibilitychange nudge is guarded by a flag that is stale exactly when it fires, is off in the lobby, and kills the reconnect it does fire on](#flip7-visibility-nudge-never-fires) |

### The host trusts the player name inside the score payload and never looks at which connection it arrived on

<a id="flip7-identity-from-payload"></a>

**High** · Still broken · Small effort · `flip7-identity-from-payload` · line 1124

**What a player sees.** A round score can be written for the wrong player. In practice it shows up as a score that changes by itself: the grid ticks somebody as submitted and shows a number nobody typed. Anyone in the room can also write any other player's score, because every name is printed on every screen.

**What causes it.** Any client sending {type:'score-submit', playerName:'<anyone>'}; reached accidentally by a late/queued submission from a player the host had already written off.

**The fix.** Rewrite `onHostData` (index.html:1122-1126) to resolve the sender from the connection: `const entry = lobby.players.get(clientId); const name = entry && entry.name; if (!name || !players.includes(name)) return; handleScoreSubmission(name, data.scoreData, data.round);`. Drop `data.playerName` from the trusted path entirely (leave it on the wire if you like, but never key on it). This is materially safer than when the bug was filed: SlopLobby no longer deletes the record on 'client-left' (it holds it until 'client-lost' and parks it in `_pastPlayers` after that, sloplobby.js:283-311), so `lobby.players.get(clientId)` now stays populated for a player who is merely offline — the original worry that a strict check would silently discard a live player's real submissions no longer applies.

**Blast radius.** Local to the host's data handler, but it is the choke point for every client message, so a wrong lookup silently mutes the whole table. Pair it with the round stamp below in one sitting.

**Fix alongside.** `flip7-stale-score-submit-credited-to-next-round`

### The winner banner's Play Again / New Game are rendered for peers but their broadcast is host-gated, so a peer tapping them wipes only their own copy

<a id="flip7-peer-play-again-forks-the-scoreboard"></a>

**High** · Still broken · Small effort · `flip7-peer-play-again-forks-the-scoreboard` · line 2277

**What a player sees.** A player taps Play Again on the winner screen and their phone starts a fresh game — everyone on 0, Round 1 — while the host and everyone else still see the finished game. They fill in a card, tap Submit, and land on a waiting spinner for a round that does not exist. Nothing will ever reach them again unless the host independently taps something.

**What causes it.** Any joined player tapping Play Again (or New Game) on the winner banner, which is rendered identically on every device.

**The fix.** `checkWinner()` (:2226-2265) unhides the banner for everyone; right after `winnerBanner.classList.remove('hidden')` (:2259) toggle `playAgainBtn`/`newGameBtn` hidden when `gameMode === 'peer'` (`.hidden` is `display:none!important` in lib/slop-theme.css:261, so the class is safe to use). Belt and braces, make `resetGameKeepPlayers()` (:2288) and the newGameBtn handler (:2281) start with `if (gameMode === 'peer') return;` so no future UI path can re-arm it. Give peers a real rematch path instead of a dead button: a `#request-rematch-btn` that does `lobby.sendToHost({type:'request-play-again'})`, handled in `onHostData` when `gameOver` by calling the existing host-side `resetGameKeepPlayers()`, which already broadcasts correctly.

**Blast radius.** Winner-banner rendering only, plus one new message type if you add the rematch request. Same root cause and same sitting as the Reset Game gating below.

**Fix alongside.** `flip7-peer-reset-button-silently-evicts-self`

### The host's name field is disabled forever after being set once, so a second hosted room can never be started

<a id="flip7-host-identity-locked-after-leaving-room"></a>

**High** · Still broken · Small effort · `flip7-host-identity-locked-after-leaving-room` · line 1267

**What a player sees.** A host who backs out of a room and starts a new one gets a room code that works — friends join fine — but the Start button stays greyed out no matter how many people are in, the name box is greyed with the old name in it and cannot be edited, and the lobby does not even list a host. There is no error. Only a full page reload fixes it, which throws away the code everyone was just given.

**What causes it.** Host Game → set name → Back → Host Game again.

**The fix.** `hostNameInput.disabled = true` / `hostSetNameBtn.disabled = true` (:1267-1268) are assigned at exactly those two lines and nowhere else. Re-enable them in `cleanupMultiplayer()` (:1623-1637) next to `myName = ''` (:1635), also clearing `hostNameInput.value`, its `style.borderColor`, and `hostLocalPlayerInput.value`/`borderColor` (addLocalPlayer at :1287 can leave a red border behind). Repeat the two resets at the top of `initHostPeer()` (:1116) so entering host mode always starts from a settable name however the previous session ended — mirroring what `_selectMode('join')` (:1049-1056) already does for the join form. cleanupMultiplayer is the common exit for hostBackBtn (:1313), resetAll (:2324) and the client 'game-reset' branch (:1582), so fixing it there covers every reachable trigger.

**Blast radius.** Pure DOM state in the host lobby. No wire change, no other app.

**Fix alongside.** `flip7-pregame-drop-orphans-client`

### onPlayerRejoined has no lobby branch, so a player who blips in the lobby is dropped from the roster but still receives game-start

<a id="flip7-lobby-blip-creates-ghost-player"></a>

**High** · Changed · Medium effort · `flip7-lobby-blip-creates-ghost-player` · line 1155

**What a player sees.** A player whose phone locks for half a minute in the waiting room vanishes from everyone else's lobby list, but their own phone says "Reconnected!" and then drops them straight into the game when the host starts. They score every round on a phone that never shows their name in the standings; the host never sees them submit, never sees them at all, and quietly records them as bust-0 every round. Nobody gets an error.

**What causes it.** Three players in the lobby; one phone locks for ~20 s, the host's heartbeat convicts it, then it comes back before the host taps Start.

**The fix.** In `onPlayerRejoined` (index.html:1151-1179) add a `!gameStarted` branch BEFORE the existing guard at :1155: find the entry in `lobbyPlayers` by name (client-left removed it by clientId, and a returner may carry a different clientId), refresh or re-push it with the new clientId, then `lobby.send(clientId, {type:'join-ok'})`, `broadcastLobbyUpdate()`, `renderHostLobby()`, `updateHostStartBtn()`, `return`. Add an else for the `gameStarted && !players.includes(name)` case that replies `{type:'join-error', reason:'The host started without you.'}` instead of silence. Second layer, client side: in `handlePeerMessage`'s 'game-start' branch (:1538) bail out with a join error unless `Array.isArray(data.players) && data.players.includes(myName)` — a broadcast must not be treated as an admission ticket, because slopnet's `broadcast` (slopnet.js:587-597) walks its own client map and knows nothing about `lobbyPlayers`.

**Blast radius.** Host lobby + peer game-start path in flip-7 only. Adds a message the peer must tolerate (join-error while already showing the lobby), so test the join screen as well as the game screen.

**Fix alongside.** `flip7-pregame-drop-orphans-client`

### rejoin-ok blanks the client's submitted flag and round card while the host's Edit path deletes its own stored copy

<a id="flip7-rejoin-destroys-both-copies-of-the-round-score"></a>

**High** · Changed · Medium effort · `flip7-rejoin-destroys-both-copies-of-the-round-score` · line 1522

**What a player sees.** A player who has already submitted a round is shown a blank scorecard with a live Submit button again, while the host's screen still shows their real score with a tick. Whichever they do next, one of the two numbers is lost silently — usually they resubmit a blank card and are credited 0 for a round they actually scored 47 on.

**What causes it.** Previously: a drop-and-return mid-round. Now also fires with no disconnect at all — the library emits 'client-rejoined' when a client the host had written off answers a ping over a still-open channel (slopnet.js:497-512), so a player who was merely slow for 20 s gets rejoin-ok and has their half-entered cards wiped without anything having gone wrong on their phone.

**The fix.** Two halves. (1) Make the resync authoritative instead of destructive: add `submitted: !!peerSubmissions[name], scoreData: peerSubmissions[name] || null` to the rejoin-ok payload at :1165-1171, and at :1522-1523 replace `myScoreSubmitted = false; resetRoundState();` with `myScoreSubmitted = !!data.submitted; resetRoundState(); if (data.scoreData) roundState[nameToId(myName)] = {cards:[...data.scoreData.cards], modifiers:[...data.scoreData.modifiers], x2:data.scoreData.x2, flip7:data.scoreData.flip7, bust:data.scoreData.bust};`. (2) Stop the host destroying its copy: drop the `delete peerSubmissions[name]` in `_hostEditPlayer` (:1897) and seed the edit from the stored submission instead; in `onPlayerRejoined` fold any host-typed `roundState` back into `peerSubmissions[name]` before the `hostEditingPlayers.delete(name)` at :1174, so the round is never left with no copy at all.

**Blast radius.** Changes the rejoin-ok wire shape (host and peer must ship together — they do, it is one file) and touches the host-override state machine, which `submitRoundHost` (:2114) also reads. Now that rejoin-ok can arrive at a client that never dropped, this handler must be safe as a no-op refresh, not just as a recovery.

**Fix alongside.** `flip7-host-edit-permanently-voids-the-players-own-score`

### handleScoreSubmission has no round stamp and no idempotence, so a queued submission lands in whatever round is current when it arrives

<a id="flip7-stale-score-submit-credited-to-next-round"></a>

**Medium** · Still broken · Small effort · `flip7-stale-score-submit-credited-to-next-round` · line 2199

**What a player sees.** A player's score from an earlier round is credited again as their score for the round after it, or two different scores race and the last one silently wins. The host's grid shows them ticked and unlocks Submit Round, so nothing looks wrong. The player meanwhile is asked to score the new round from an empty card and has lost the tally they already sent.

**What causes it.** Submit tapped as the signal drops; the message is queued by PeerClient.send, the host advances the round in the meantime, and the queue is flushed on the next join_ack.

**The fix.** Stamp and reject. Send `round: currentRound` in `submitScorePeer` (:2186-2190), and in `onHostData` (:1122-1126) reject a mismatch — treat a missing `round` as stale — replying `{type:'score-rejected', round: data.round}` so the peer's 'waiting for host' screen is corrected rather than left lying. Then make `handleScoreSubmission` (:2197-2200) idempotent: `if (peerSubmissions[playerName]) return;` unless the host has explicitly re-opened that player. Note the ordering is not in your favour and cannot be fixed by ordering alone: slopnet flushes the client's queue on join_ack (slopnet.js:1072) after the host has already emitted 'client-rejoined' and the app has already sent rejoin-ok, so the stale submit always arrives last. Separately, `SlopLobby.sendToHost` (sloplobby.js:430-432) still discards `PeerClient.send`'s boolean, so `myScoreSubmitted = true` at :2192 is set even when the message was only queued — worth returning that boolean and rendering a distinct 'queued, not yet delivered' state, but that is cosmetic honesty and does not replace the round stamp.

**Blast radius.** One field added to score-submit, one guard in the host handler. Touching sloplobby.js's sendToHost return value affects all four consuming apps — do that as a separate, deliberate change.

**Fix alongside.** `flip7-identity-from-payload`

### The host's goodbye is broadcast and then thrown away by its own destroy(), and there is still no 'room closed' state anywhere

<a id="no-room-closed-signal-on-host-destroy"></a>

**Medium** · Still broken · Large effort · `no-room-closed-signal-on-host-destroy` · line 2283

**What a player sees.** When the host resets or ends the game, nobody is told. Every other phone sits behind a 'Reconnecting…' banner for about three and a half minutes, burning battery and radio dialling a room that no longer exists, before finally saying 'Disconnected from host'. Their scoreboard stays frozen on the old game the whole time.

**What causes it.** Host taps New Game or Reset Game (index.html:2267-2274 and :2281-2286): broadcastToAll({type:'game-reset'}) followed by resetAll() → cleanupMultiplayer() → lobby.destroy() in the same synchronous turn.

**The fix.** Unchanged by the library work — there is still no room-closed control message in slopnet.js, and `PeerHost.destroy()` (slopnet.js:907-909) still calls a bare `client.conn.close()` in the same turn as the broadcast, with no `{flush:true}`, so the goodbye can die in PeerJS's buffer. Library part: add a `__slopnet_room_closed` control message and a `PeerHost.close(reason)` that broadcasts it, closes each conn with `close({flush:true})`, and destroys the peer on a short timer; intercept it in `PeerClient._handleData` (slopnet.js:1058) before the `emit('data')` at :1103, set a terminal flag so `_onDisconnect` (:1106) skips `_attemptReconnect`, and emit 'room-closed'; forward it through sloplobby's onStateChange vocabulary. App part: `await lobby.closeRoom('reset')` before `resetAll()` at :2271 and :2285, and handle 'room-closed' in the peer's onStateChange (:1394) as a terminal state — banner 'Host ended the game', no retry. The retry cost is now ~223 s rather than the 4-6 minutes originally measured, because the client ladder was resized (reconnectBackoffMax 15000→6000, 40 total attempts), but it is still minutes of pointless dialling.

**Blast radius.** Library change touching all four consuming apps plus the vitest suite; texas-holdem's Leave button has the identical shape with no goodbye at all. Do not attempt it as a flip-7-only edit.

**Fix alongside.** `flip7-visibility-nudge-never-fires`

### A pre-game disconnect returns the player to the join form without destroying the client, so re-joining creates a second live PeerClient on the same clientId

<a id="flip7-pregame-drop-orphans-client"></a>

**Medium** · Still broken · Small effort · `flip7-pregame-drop-orphans-client` · line 1401

**What a player sees.** A player waiting in the lobby is bounced back to the join form with 'Disconnected from host.' They retype the code and join again — and from then on the screen keeps resetting itself back to the join form every so often, and the host intermittently ignores them. Neither side is shown anything that explains it.

**What causes it.** Phone locked in the waiting room long enough for the host to convict it; the player then rejoins from the same tab.

**The fix.** Three parts, in order. (1) Call `cleanupMultiplayer()` in the `!gameStarted` branch of the peer's onStateChange (:1400-1405), matching what the connect-catch (:1428) and the join-error branch (:1535) already do. (2) Start `attemptJoin()` (:1367) with `if (lobby) cleanupMultiplayer();` before the new SlopLobby is constructed at :1388 — and note cleanupMultiplayer clears `myName`/`roomCode` (:1635-1636), so it must run before the assignments at :1381-1382. (3) Required, not optional: the lobby branch of onPlayerRejoined from flip7-lobby-blip-creates-ghost-player. Without it, (1) and (2) turn 'two zombie connections' into 'one clean connection the host silently ignores' — the rejoiner never gets join-ok and sits on the connecting spinner forever. Library defence in depth, still not done: `_handleData`'s rejoin path (slopnet.js:415-433) swaps `existing.conn` without closing the superseded connection, and the data fallback at :485 still synthesises `clientId = conn.peer` for a conn it does not recognise instead of dropping the message.

**Blast radius.** Two lines in flip-7 plus the shared onPlayerRejoined fix. The slopnet hardening would affect all four apps and should be judged separately.

**Fix alongside.** `flip7-lobby-blip-creates-ghost-player`

### nameToId folds case and punctuation while every duplicate-name guard is exact-match, so two players share one scorecard and one set of DOM ids

<a id="flip7-nametoid-collapses-two-players-into-one-scorecard"></a>

**Medium** · Still broken · Medium effort · `flip7-nametoid-collapses-two-players-into-one-scorecard` · line 1001

**What a player sees.** Two players whose names differ only in capitalisation or punctuation ('Sam'/'SAM', 'Jo Anne'/'Jo-Anne') end up sharing a single scorecard. The second one's taps silently change the first one's score, their own card never updates, and their round total and Overall figure show somebody else's numbers. The scoreboard is wrong for the rest of the game with nothing on screen to hint at it.

**What causes it.** Host shares the room code before setting their own name (initHostPeer shows the code immediately at :1198-1204 while myName is still ''), a joiner takes the same name, and the host then sets a case-variant of it.

**The fix.** Two layers. Quick: normalise every guard through `nameToId`. `onPlayerJoined` (:1136-1141) should build a Set of `nameToId` values over `lobbyPlayers`, `myName` AND `players` and test `taken.has(nameToId(name))`; the same for `hostSetNameBtn` (:1262, which currently ignores `players` entirely) and `addLocalPlayer` (:1287-1289). Keep the visible 'Name already taken' message on the joiner path so a refused case-variant is explained. Durable: the display name is the wrong key everywhere — mint an opaque seat id at seat time, store it on each `lobbyPlayers` entry and on the host's own, carry it into `players` at :1319-1321, and key `roundState`, the DOM ids and handler args in the four render*Card functions, `peerSubmissions`, `hostEditingPlayers`, `localPlayers`, `disconnectedPlayers` and the `rounds[]` records off it, with the name used only inside `esc()`. Note that `onPlayerRejoined` (:1158) also matches on the raw name, so a returning player who retypes 'sam' instead of 'Sam' is not recognised as a rejoin at all — the same normalisation decision has to be made there.

**Blast radius.** The guard normalisation is contained. The seat-id rewrite changes the rejoin-ok and game-start wire shapes and touches nearly every rendering and scoring function in the file — a day's work on its own, and it should be sequenced after the host-identity fixes so there is only one identity migration.

**Fix alongside.** `flip7-identity-from-payload`

### Once the host taps Enter Score for a player, that player's own submission is accepted, stored, and then ignored for the rest of the round with no way to cancel

<a id="flip7-host-edit-permanently-voids-the-players-own-score"></a>

**Medium** · Still broken · Medium effort · `flip7-host-edit-permanently-voids-the-players-own-score` · line 1897

**What a player sees.** An impatient host types a score in for a player who is still tapping their cards. Two seconds later that player submits for real; their phone says 'Score submitted! Waiting for other players…'. The host's chip says the score came from the host. The standings then show the host's guess. The player only finds out when the wrong number appears, and there is no undo short of the host redoing the whole round.

**What causes it.** Host taps 'Enter Score' on a waiting or disconnected player's card while that player is still entering their score.

**The fix.** Three changes. (a) `_hostEditPlayer` (:1895-1899) must stop destroying evidence — drop the `delete peerSubmissions[name]` at :1897 and seed the edit from the stored submission instead. (b) Let a genuine submission reclaim an untouched override: in `handleScoreSubmission` (:2197), if `hostEditingPlayers.has(playerName)` and the host's `roundState[nameToId(playerName)]` is still empty, `hostEditingPlayers.delete(playerName)`; otherwise store the submission and warn the host (use `SlopLobby.toast` — flip-7 never pulls `toast` into scope and has no #toast element, so the library's own fallback is what renders). (c) Give the override an exit: `hostEditingPlayers` is only ever cleared wholesale (:1174, :1631, :2144, :2214, :2295), so add a `window._hostCancelEdit = name => { hostEditingPlayers.delete(name); renderGame(); }` and a button beside the '(editing)' badge in `renderEditableCard` (:1816) labelled 'Use their score' when a submission exists. Also surface the submitted value inline in the override card and label the chip in `renderSubmissionStatus` (:1928) as '✓ (overridden)' when both flags are set, since it currently misreports which value will be used. The precedence at :1746-1751 (isHostEditing tested before hasSubmitted) is correct to keep once the host can see and cancel.

**Blast radius.** Host scoring grid and the two app-owned maps (`hostEditingPlayers`, `peerSubmissions`) that `submitRoundHost` (:2114) arbitrates between. Same maps as the rejoin bug — fix them together or they will fight.

**Fix alongside.** `flip7-rejoin-destroys-both-copies-of-the-round-score`

### Reset Game is shown to joined players; tapping it tears down their connection and tells the host nothing

<a id="flip7-peer-reset-button-silently-evicts-self"></a>

**Medium** · Changed · Medium effort · `flip7-peer-reset-button-silently-evicts-self` · line 2267

**What a player sees.** A player taps Reset Game — a button their phone shows them, with a confirm that reads like a shared action — and is dumped back to the menu. Nobody else's game resets. The host's scoreboard keeps their name and scores them 0 every round. Their room code has been wiped off their own screen, so they have to ask someone for it again.

**What causes it.** Any joined player tapping Reset Game (or New Game) during a hosted game.

**The fix.** Gate the control and the handler. Add a small `applyRoleGating()` called from `showMpBanner()` (:1596) and `renderGame()` that toggles `.hidden` on `resetGameBtn`/`newGameBtn`/`playAgainBtn` for `gameMode === 'peer'`, and guard each listener (:2267, :2277, :2281) with an early `if (gameMode === 'peer') return;`. Do not simply hide Reset Game for peers — it is currently their only way out of a room. Relabel it by role instead ('Leave Game' for peers) and branch the handler so the label matches the effect, ideally sending `lobby.sendToHost({type:'leave'})` first and handling it in `onHostData` by removing the name from `players`, `lobbyPlayers`, `disconnectedPlayers` and `peerSubmissions` and rebroadcasting a state-update — otherwise the seat becomes the same phantom.

**Blast radius.** Game-screen controls plus one new host message. Downgraded from high: the permanent lockout in the original report is gone, because slopnet now announces a post-window returner as 'client-rejoined' (slopnet.js:446-466) rather than 'client-joined', and SlopLobby parks their record in `_pastPlayers`, so the 'Game already in progress' rejection at :1132 no longer fires on them. The self-eviction, the silence toward the host and the phantom seat all remain.

**Fix alongside.** `flip7-peer-play-again-forks-the-scoreboard`

### The visibilitychange nudge is guarded by a flag that is stale exactly when it fires, is off in the lobby, and kills the reconnect it does fire on

<a id="flip7-visibility-nudge-never-fires"></a>

**Medium** · Changed · Medium effort · `flip7-visibility-nudge-never-fires` · line 1495

**What a player sees.** Mostly invisible now: unlocking the phone appears to do nothing special, and the connection heals a moment later on its own. The one remaining bite is that repeatedly unlocking the phone while it says 'Reconnecting…' makes the reconnect take longer, because each unlock restarts the attempt from scratch and kills the handshake already in flight. The 'attempt n of 20' text the app can render is never shown.

**What causes it.** (a)(b) any background/foreground cycle — now benign. (c) unlocking the phone while a genuine reconnect is negotiating, e.g. after a wifi→4G handover.

**The fix.** Defects (a) and (b) are still literally present — `lobby.client.isConnected` is `_connected` (slopnet.js:1157), which the reworked heartbeat deliberately keeps true across a throttled wake, so the guard at :1497-1500 still returns without doing anything, and `!gameStarted` still disables the handler in the lobby. They no longer cause harm, because the host now un-writes-off a client that answers a ping (`_noteClientAlive`, slopnet.js:497-512) and flushes its queued messages, so the case the nudge existed for heals itself. Defect (c) is untouched: `PeerClient.reconnect()` (slopnet.js:1268-1276) still clears the timer, zeroes the counter and re-enters `_attemptReconnect()`, whose only guard is `if (this._reconnectTimer) return` — null while an attempt is negotiating — so the new 1000 ms timer wins the race and `_createPeerAndConnect` → `_destroyPeer()` destroys the peer mid-ICE. Fix in the library: add a `_connecting` flag set at the top of `_createPeerAndConnect` (:978) and cleared on EVERY terminal path (join_ack :1060, peer error :1033, connection close/error :1022/:1027, overallTimeout :988) — clearing it only on success latches it and blocks reconnection forever — and make `reconnect()` and `_attemptReconnect()` no-op while it is set. Then add a `resume()` that re-pings rather than tearing down, register the visibilitychange handler inside sloplobby for both roles, and delete the flip-7-local handler at :1495-1503. Separately: `updateReconnectBanner` (:1456) is still dead code because sloplobby never forwards 'reconnecting' — one `client.on('reconnecting', ...)` line at sloplobby.js:413 revives it.

**Blast radius.** The `_connecting` flag and the moved handler are library changes affecting all four apps; getting the clear-on-every-path wrong permanently disables reconnection everywhere, so it needs a test per terminal path. The dead-banner fix is one line and harmless.

**Fix alongside.** `no-room-closed-signal-on-host-destroy`

---

# Texas Hold'em

`projects/texas-holdem/index.html` — 7 bugs

## Root causes

- **The headline.** The library fix has just switched this app on for the first time. The old sloplobby overwrote the app's `{name, playerId}` record one statement after onPlayerJoined wrote it (old sloplobby.js:174), so `entry.playerId` at index.html:1330 was always undefined — every remote client's action was silently dropped by game.handleAction's `pIdx === -1` guard, and every remote client's own panel never rendered because getStateForPlayer(undefined) gave them a state whose myId matched nobody. texas-holdem was effectively unplayable for anyone but the host, which means the entire remote-action backlog below (turn tokens, the turn clock, the duplicate seat, the frozen bust-out panel) was latent and has never been exercised by a real player. Fix the turn handling BEFORE anyone plays a real game on the repaired library.

- PokerGame has no timer discipline at all: three fire-and-forget setTimeouts (1137, 1160, 1201) drive the phase machine and there is not one clearTimeout in the whole 1879-line file. Nothing can be cancelled, nothing is idempotent, and _endBettingRound's if/else-if phase chain (1117-1132) has no terminal else, so a stray tick re-arms itself forever. That single omission is the whole of the critical double-payout bug and half of why a stale action can land on the wrong hand.

- The turn is a bare array index with no identity and no deadline. `currentPlayerIndex` is the only thing that says whose turn it is: it is never cleared while the app deals cards on its own (the run-out), it is never echoed back on an action so the host cannot tell a fresh tap from a stale one, and nothing ever times it out. Three separate bugs — the forked run-out, the frozen table on an unattended seat, and the double-tap applied to the next street — are the same missing concept, and one turnSeq counter plus one turn clock closes all three. Fix them in one sitting.

- There are two rosters with no shared invariant: `lobby.players` (clientId -> seat, owned by the transport layer) and `game.players` (the poker model). Join writes both, kick writes one, busting out writes only the model, and rejoin writes neither correctly. That divergence is the bust-out freeze, the phantom joiner and the readmitted stranger. A single reconcile helper — one place that adds, marks-away, busts and removes a player in both maps — would retire that whole group. It is also why the fix for the bust-out bug must NOT simply delete from lobby.players: the library now parks records for a returning player, so deleting the entry strands them permanently.

- `phase === PHASE.SHOWDOWN` is overloaded to mean three different things — 'reveal all cards', 'the hand is over, stop accepting actions', and 'show the winner overlay'. _awardPotToLastPlayer sets it purely to get the overlay (1158), which is why an uncontested pot publishes the winner's hole cards; and because it is not treated as terminal at the top of _endBettingRound, a SHOWDOWN-phase tick falls straight through the phase chain into the run-out block. Splitting it into a phase and an explicit `uncontested` / terminal flag fixes both the bluff leak and the runaway chain.

## Where to start

"1) holdem-runout-timer-forks-and-double-pays first: it is the only critical, it invents chips out of nothing, it is entirely host-local (no protocol change, no client change), and it is the only bug here with an executable regression test already written and currently red — lib/slopnet/__tests__/repro-7-holdem-runout-timer-forks-and-double-pays.test.js loads the real PokerGame straight out of the shipped index.html, so `cd lib/slopnet && npm test` is a genuine acceptance check with no build step. 2) holdem-foldout-reveals-winner-hole-cards next: a two-field change, no interactions with anything else, and it is the bug that most changes how the game actually plays. 3) Then the turn sitting — holdem-action-carries-no-turn-token together with the turn clock from holdem-duplicate-human-freezes-table. They are one root cause, they must ship together (a strict turnSeq check without a clock can deadlock a table, a clock without a token still lets stale taps through), and they are urgent specifically because the library fix has only now made remote actions reach the host. Extend the repro-7 harness to cover them. 4) Then the roster sitting — holdem-bustout-freezes-the-players-own-panel with sloplobby-readmits-rejected-joiner-as-phantom and holdem-rejected-join-reinserted-into-roster. Same two-roster root cause, and the last one is already fixed by the library so it is only tidy-up. Do the defensive `else` on renderGame's `if (me)` (1581) first within this group: it is five lines and it unfreezes the panel for every path, not just bust-out."

## Notes

- Every cited line number is unchanged — the app file has not been touched, so 867, 1137, 1272, 1339, 1341, 1460, 1581, 1624 are all current as written in the original report.
- NEW, caused by the library change, not in the 48: onPlayerLeft at index.html:1369 is declared `(clientId, meta)` and ignores the new `final` argument, and the app defines no onPlayerLost. sloplobby therefore calls it twice for every real disconnect — once temporary and once when the 120s window expires. Consequence today is cosmetic-plus: a duplicate 'X disconnected' toast two minutes later, a redundant setDisconnected(true), and a second _checkAutoActions. Adding `onPlayerLost: (clientId, meta) => { /* release the seat for good */ }` is the intended shape and is also where PokerGame.removePlayer (842, currently dead code) should finally be called.
- ALSO NEW in consequence: onPlayerLeft fires on `final === false` — a connection that dropped but whose seat slopnet is still holding — and holdem responds by calling `game._checkAutoActions()` (1376), which immediately auto-folds or auto-checks that player. A player whose phone flickers for five seconds now comes back inside their own reconnect window to find their hand already mucked. This is the holdem analogue of the still-red repro-4 test written against herd-mentality. It belongs with the turn-clock work: gate the auto-action on `final === true`, or better, let the turn clock handle it uniformly.
- A refused joiner's PeerClient now retries 20 times over ~103 seconds before emitting reconnect-failed (slopnet.js:100-134), so a single latecomer knocking on a started table produces a burst of rejection cycles, not one. That amplifies the spurious 'X disconnected' toasts described in the phantom-joiner entry.
- One claim in the phantom-joiner entry could not be verified from this repo and should be checked against peerjs@1.5.5 before betting on it: whether DataConnection.close() emits 'close' synchronously. __tests__/mock-peer.js defers it, so no test can distinguish. If PeerJS defers too, the residual half of that bug does not fire at all and only the tidy-up remains. The slopnet removeClient reorder (delete from the map, then close) is cheap and correct either way.
- The client's onClientData (1413-1435) handles `{ type: 'error' }` but has no case for `{ type: 'join-error', reason }`, which is what sloplobby.js:245 sends. Any move to the library's rejection contract must add that case in the same commit or refused players see nothing at all.
- lib/slopnet/__tests__/repro-7's loadPokerEngine() is the useful precedent for this monorepo: it slices `class PokerGame` out of the shipped index.html by line markers and evals it under vitest with a stubbed `document`. That gives the app engine real test coverage without violating the no-build-step rule — but it is anchored to source line ranges, so it will need re-anchoring after any of these fixes land.

## The bugs

| Severity | Status | Effort | Bug |
|---|---|---|---|
| Critical | Still broken | Medium | [The all-in run-out is an untracked setTimeout chain that one ordinary tap forks in two — the pot is paid twice and the chain never stops](#holdem-runout-timer-forks-and-double-pays) |
| High | Still broken | Medium | [One human can take two seats, and an unattended-but-connected seat freezes the whole table when the action reaches it](#holdem-duplicate-human-freezes-table) |
| High | Still broken | Small | [Every pot won without a showdown broadcasts the winner's hole cards, labelled with the hand they made](#holdem-foldout-reveals-winner-hole-cards) |
| Medium | Still broken | Medium | [A busted player is dropped from the game model but keeps being sent states addressed to a seat that no longer exists, freezing their own panel with no explanation](#holdem-bustout-freezes-the-players-own-panel) |
| Medium | Still broken | Medium | [Actions carry no hand or turn identifier and the buttons stay live until the host answers, so a second tap is applied to the next decision](#holdem-action-carries-no-turn-token) |
| Medium | Changed | Small | [Refusing a latecomer still routes the kick through the disconnect path: everyone is told a stranger 'disconnected', and the refused player can be readmitted later as a rejoin](#sloplobby-readmits-rejected-joiner-as-phantom) |
| Low | Fixed upstream | Small | [texas-holdem kicks a rejected joiner by hand instead of returning a rejection reason, and is the only app that does](#holdem-rejected-join-reinserted-into-roster) |

### The all-in run-out is an untracked setTimeout chain that one ordinary tap forks in two — the pot is paid twice and the chain never stops

<a id="holdem-runout-timer-forks-and-double-pays"></a>

**Critical** · Still broken · Medium effort · `holdem-runout-timer-forks-and-double-pays` · line 1137

**What a player sees.** Someone shoves, you call with chips still behind, and the board starts running out on its own. Your Fold / Check / Raise buttons are still lit the whole time, so you tap Check. The board then races through turn and river, the winner is announced and paid, the 'X wins the game' screen appears — and a second later the same pot is paid out again. The table ends the night with 4500 chips on a game that started with 3000, and the host's browser keeps re-broadcasting the finished hand every 1.2 seconds forever, dragging the stray blinds and a phantom pot into the next hand. Tap Fold instead of Check and a player who is already all-in vanishes from the table and their chips vanish with them.

**What causes it.** Any hand where every player but one is all-in (the run-out) and the one player still able to act taps a button during the 3.6s the cards are dealing out. Host-only path — no network involved, so no library defect can shield it.

**The fix.** Three edits in PokerGame, all in index.html. (1) In _endBettingRound's skipToShowdown block (1134-1138), set `this.currentPlayerIndex = -1;` before `this._broadcast();` — renderActions' `state.currentPlayerIndex >= 0` gate (1624) and handleAction's `pIdx !== this.currentPlayerIndex` gate (959) then both refuse the tap, so the fork cannot start. (2) Make the chain cancellable: store the handle as `this._runOutTimer = setTimeout(...)` at 1137, and add as the first lines of _endBettingRound (1099) `if (this.phase === PHASE.SHOWDOWN || this.phase === PHASE.WAITING) return; clearTimeout(this._runOutTimer); this._runOutTimer = null;`. Do the same for the two hand-end timers (1160 `this._nextHandTimer = setTimeout(() => this.startHand(), 3000)` and 1201 the 5000ms one), clearing both at the top of startHand (863) and _gameOver (1242) so a queued startHand cannot fire after game over. (3) Close the fall-through: end the phase chain at 1129-1132 with `} else { return; }` so a tick arriving in an unexpected phase can never drop into the skipToShowdown block and re-arm itself. The repro at lib/slopnet/__tests__/repro-7-holdem-runout-timer-forks-and-double-pays.test.js loads the real PokerGame out of the shipped index.html and is currently red on 5 of 6 tests — use it as the acceptance check.

**Blast radius.** PokerGame's phase machine on the host only. No wire-protocol change and no client change. One cosmetic side effect: during the run-out renderActions falls into its else branch and prints 'Waiting for ...' (players[-1] is undefined) — worth giving it a 'Running it out...' string while you are in there.

**Fix alongside.** `holdem-action-carries-no-turn-token`

### One human can take two seats, and an unattended-but-connected seat freezes the whole table when the action reaches it

<a id="holdem-duplicate-human-freezes-table"></a>

**High** · Still broken · Medium effort · `holdem-duplicate-human-freezes-table` · line 1341

**What a player sees.** Bob joins from his laptop, then opens the same room code on his phone so he can hold his cards. The waiting room shows two rows called 'Bob', each with a full stack. He plays on the phone. When the deal reaches the abandoned laptop seat the table simply stops: no clock, no prompt, no way for anyone to fold for him. Every player sits there with the pot and their chips frozen. The only escape is the host tapping Leave Table, which reloads the page and ends the game for everybody. The same freeze happens with no duplicate at all whenever any player just walks away from a connected tab.

**What causes it.** Two browser sessions belonging to one person (different device or a different browser = fresh sessionStorage = a fresh clientId), or any player who leaves a connected tab open and stops playing.

**The fix.** The real fix is a turn clock; the duplicate seat is only the most likely way to reach it. (1) In PokerGame add `_armTurnClock()` that clears and restarts a timer capturing `this.currentPlayerIndex` and `this.handNum`, and on expiry (45s) re-checks both still match and then calls `this.handleAction(p.id, p.currentBet >= this.currentBet ? 'check' : 'fold')`. Call it wherever currentPlayerIndex is assigned — _moveToNextPlayer (1078) and startHand's preflop assignment (919) — and clear it in _endBettingRound (1099), _showdown (1164), _awardPotToLastPlayer (1151) and _gameOver (1242). Ship the deadline in getStateForPlayer (1250-1278) so clients can render a countdown instead of being surprised by an auto-fold. Note _checkAutoActions (1084-1095) already does exactly this logic gated on `current.disconnected` — the clock is the same code without that gate. (2) Reject a duplicate name in onPlayerJoined (1334) using SlopLobby's contract, i.e. `return 'That name is already at this table';` — do NOT keep the hand-rolled send+removeClient (see the two roster bugs). (3) PokerGame.removePlayer (842) is dead code; wiring a host-side 'fold for player / remove seat' control into the game menu (1833) gives a manual escape that is not location.reload().

**Blast radius.** Every hand — a clock that is too short folds live players who are merely thinking, so pick 45-60s and show it. Touches PokerGame turn handling, the state payload and the client render. Note the fixed library removes the mask that used to hide this: sloplobby no longer clobbers the app's `{name, playerId}` record at join, so remote clients' actions actually reach game.handleAction now. Before the fix `entry.playerId` at 1330 was undefined and every remote action was silently dropped — the table froze for a different reason on every hand.

**Fix alongside.** `holdem-action-carries-no-turn-token`

### Every pot won without a showdown broadcasts the winner's hole cards, labelled with the hand they made

<a id="holdem-foldout-reveals-winner-hole-cards"></a>

**High** · Still broken · Small effort · `holdem-foldout-reveals-winner-hole-cards` · line 1272

**What a player sees.** You raise with 7-2 offsuit, everyone folds, you take the pot — and the app turns your two cards face up on every opponent's screen for three seconds with 'High Card' printed under them. It happens on every uncontested pot, which is most hands. You can never bluff and there is nothing you can do to prevent it.

**What causes it.** Any hand that ends by everyone else folding, either through handleAction's fold case (970) or _endBettingRound's one-player check (1109).

**The fix.** Separate 'the hand is over' from 'a showdown was reached'. Add `this.uncontested = false;` in the PokerGame constructor beside `this.handResults = null;` (827) and clear it in startHand beside the same line (879). In _awardPotToLastPlayer set `this.uncontested = true;` immediately before `this.phase = PHASE.SHOWDOWN;` (1158). Change the redaction test at 1272 to `(p.id === playerId || (this.phase === PHASE.SHOWDOWN && !this.uncontested && !p.folded))`. The else branch at 1274 already yields ['back','back'] for the unfolded winner, and the client's existing `p.holeCards[0] !== 'back'` guard at 1547 then suppresses the hand-name label with no client change needed. Do not key this off `handResults[0].handName === null` — _showdown legitimately produces results and that coupling is fragile.

**Blast radius.** One flag and one boolean in getStateForPlayer. Affects only what opponents see during the 3s announcement overlay. No protocol or client change required.

### A busted player is dropped from the game model but keeps being sent states addressed to a seat that no longer exists, freezing their own panel with no explanation

<a id="holdem-bustout-freezes-the-players-own-panel"></a>

**Medium** · Still broken · Medium effort · `holdem-bustout-freezes-the-players-own-panel` · line 867

**What a player sees.** You lose your last chips. Five seconds later the next hand starts and the bottom half of your screen — your name, '0' chips, the losing hole cards and whatever buttons were last drawn — freezes and never changes again, while the opponents, community cards and pot keep moving above it. Nothing tells you that you are out. You only find out when the game-over screen finally lands, possibly many hands later. If you drop and rejoin you get the same dead screen back.

**What causes it.** Any player who busts while still connected. startHand's filter at 867 deliberately keeps busted players who are disconnected, so it only ever evicts the player who is present and watching.

**The fix.** Three parts. (1) Do not delete the lobby.players entry — it is the only clientId->playerId map and sloplobby now parks records across a lost connection, so removing it strands the player on any later return. Instead, in hostGame's wiring around startHand, compute the evictees before the filter at 867, and for each set `entry.bustedOut = true` on their lobby.players record plus `lobby.send(clientId, { type: 'bustedOut' })`. (2) In broadcastState (1393-1397) send busted entries a spectator snapshot: `if (entry.bustedOut) { lobby.send(clientId, { type: 'state', state: game.getStateForPlayer(null) }); continue; }`. (3) The important half — make renderGame defensive: give `if (me) {` at 1581 an `else` branch that clears #my-cards, #my-hand-label and #actions (call renderActions(state, null) or clear directly) and paints a 'You're out — spectating' banner. That alone unfreezes the panel for any path that produces a state whose myId is absent. Add a `bustedOut` case to the client's onClientData (1413-1435) for the explicit message. Also guard getStateForPlayer (1248-1249) so `myId` is null when `me` is undefined, so the protocol can never carry an unaddressable id again.

**Blast radius.** The render path every client runs on every state message, so the defensive else must be right or it will blank live players' panels. Adds one message type and one field on the lobby record; host and client ship in the same file so there is no version skew.

**Fix alongside.** `sloplobby-readmits-rejected-joiner-as-phantom`

### Actions carry no hand or turn identifier and the buttons stay live until the host answers, so a second tap is applied to the next decision

<a id="holdem-action-carries-no-turn-token"></a>

**Medium** · Still broken · Medium effort · `holdem-action-carries-no-turn-token` · line 1460

**What a player sees.** Heads-up, you tap Check. Nothing happens for a second or two because your phone is on a slow connection, and the buttons are still lit, so you tap Check again. The first tap ends the round; the flop comes out and it is your turn again — and your second tap checks the flop for you, a street you never saw. You lose the chance to bet first. Worse: if your phone drops for a moment and you tap Fold during the stall, that fold is delivered when you reconnect and lands on a completely different hand, mucking cards you never looked at, and the only feedback is the next screen refresh showing you already folded.

**What causes it.** Any action tapped a second time before the host's next state message arrives, or any action composed while disconnected and replayed from PeerClient's outbound queue on reconnect.

**The fix.** A monotone per-decision token plus closing the UI window. (1) Add `this.turnSeq = 0;` in the PokerGame constructor beside `this.handNum = 0` (824) and bump it at each assignment of currentPlayerIndex — _moveToNextPlayer's `this.currentPlayerIndex = next;` (1078) and startHand's preflop assignment (919). _endBettingRound's `currentPlayerIndex = this.dealerIndex` (1142) is only a seed for the _moveToNextPlayer call on the next line, so it needs no bump of its own. (2) Ship it: add `turnSeq: this.turnSeq,` to getStateForPlayer (1250-1258, beside handNum and currentPlayerIndex). (3) In sendAction (1460-1467) echo it — `lobby.sendToHost({ type: 'action', action, amount, handNum: lastGameState.handNum, turnSeq: lastGameState.turnSeq })` — and immediately replace #actions with a 'Sending...' span and hide #raise-controls / #raise-presets, so no second tap is possible until the host's next snapshot re-renders. (4) In onHostData (1326-1332), before game.handleAction, add `if (data.handNum !== game.handNum || data.turnSeq !== game.turnSeq) return;`. Both halves are needed: step 3 alone misses queued replays that never passed through a button, step 4 alone leaves ghost buttons that now silently do nothing.

**Blast radius.** Every action on the table. If turnSeq is not bumped at every place the turn changes, a strict compare in onHostData will reject legitimate actions and hard-freeze the table — combine this with the turn clock from the duplicate-seat bug so a rejected action cannot deadlock. The library fixes make this newly reachable and more likely at the same time: remote actions now actually arrive at the host (the playerId clobber is gone), the client retry ladder now fits inside the host's 120s window so stalled clients genuinely come back and flush their queue (slopnet.js:1072, on join_ack, before the host's rejoin snapshot at index.html:1360), and the host now queues its own state for an absent client instead of dropping it.

**Fix alongside.** `holdem-duplicate-human-freezes-table`

### Refusing a latecomer still routes the kick through the disconnect path: everyone is told a stranger 'disconnected', and the refused player can be readmitted later as a rejoin

<a id="sloplobby-readmits-rejected-joiner-as-phantom"></a>

**Medium** · Changed · Small effort · `sloplobby-readmits-rejected-joiner-as-phantom` · line 1339

**What a player sees.** Someone types your room code while a hand is running. They are refused — but every player at the table gets a toast saying 'Dave disconnected', for a Dave who was never at the table, once per attempt, and their client retries for about a hundred seconds before giving up, so the toast repeats. Two minutes after that, another 'Dave disconnected' toast. And if he tries again after all that, the host greets him with 'Dave reconnected' and starts sending him the table.

**What causes it.** Anyone dialling the room code once the game has started, or a ninth player joining a full table.

**The fix.** The headline defect — SlopLobby re-inserting the kicked client into lobby.players one line after the app removed it — is gone: sloplobby.js now seats the player BEFORE calling onPlayerJoined (239) and the trailing block at 255-258 only fills in a missing name, so the app's own lobby.removeClient (372) sticks. What survives is the kick-as-disconnect race. In the app, replace the hand-rolled rejection at 1336-1340 with `if (game.phase !== PHASE.WAITING) return 'Game already in progress';` and 1342-1346 with `if (!game.addPlayer(playerId, playerName)) return 'Table is full';`, and add a `join-error` case to the client's onClientData (1431-1434) alongside the existing `error` case, since the library sends `{ type: 'join-error', reason }` not `{ type: 'error', message }`. That alone does not close the race — the library part must not be skipped: slopnet.js removeClient (676-685) still calls `client.conn.close()` before `this.clients.delete(client.peerId)`, so if real PeerJS emits 'close' synchronously (the test mock defers it, which is why no test can see this) _handleDisconnect finds a live entry, emits 'client-left' and arms a 120s reconnect window for a client that was deliberately kicked; that window's expiry then re-adds the kicked clientId to _pastClients (line ~547), undoing removeClient's own `_pastClients.delete`, and sloplobby parks their record in _pastPlayers on 'client-lost' — which is what lets the refused joiner come back as a 'client-rejoined'. Reorder removeClient to delete from the map first, then close, then clear the timer. Also note both the app's and the library's rejection paths send the reason and then close the connection in the same tick, so the refused player probably never sees the text either way — the send needs to be flushed or the close deferred a tick.

**Blast radius.** The join path only, plus one line of slopnet ordering that every app shares — the reorder is a strict improvement for all four consumers. The app half changes the wire message a refused joiner receives, so the client case must land in the same commit.

**Fix alongside.** `holdem-rejected-join-reinserted-into-roster`

### texas-holdem kicks a rejected joiner by hand instead of returning a rejection reason, and is the only app that does

<a id="holdem-rejected-join-reinserted-into-roster"></a>

**Low** · Fixed upstream · Small effort · `holdem-rejected-join-reinserted-into-roster` · line 1339

**What a player sees.** Nothing a player sees any more. Previously every refused join left a permanent ghost in the host's roster that the host tried to send private cards to on every single state change, for the rest of the night.

**What causes it.** Anyone refused at the join screen — mid-game latecomer or a ninth player.

**The fix.** No longer required for correctness: sloplobby.js now writes the roster record before the callback (239) and re-reads it afterwards (255) instead of overwriting from a fresh literal, so the app's `lobby.removeClient(clientId)` at 1338/1344 genuinely deletes the entry and the bare `return;` at 1339/1345 no longer resurrects it. Still worth doing as tidy-up, and it is the same edit as the phantom-joiner bug: replace 1337-1339 with `return 'Game already in progress';` and 1343-1345 with `return 'Table is full';`, and handle `join-error` in the client's onClientData (1431). texas-holdem is the only one of the four apps that self-kicks rather than returning a reason, so this is also the last place the two idioms differ.

**Blast radius.** Join path only. Purely a tidy-up now; fold it into the same sitting as the phantom-joiner fix rather than tracking it separately.

**Fix alongside.** `sloplobby-readmits-rejected-joiner-as-phantom`

---

## How this was produced

Agents read each app and the shared library, proposed findings, and every finding
was then put to three independent reviewers with distinct briefs — one tracing the
code, one trying to refute it by finding an existing guard, one judging whether a
real player could actually produce the sequence. A finding needed two of three to
call it real. Candidates that failed that bar are not in this document.

Line numbers were re-checked against the current files during triage, but they
drift with every edit — treat them as a starting point and search for the symbol.
