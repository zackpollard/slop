# Phones: the host/phone contract

The quiz runs from one laptop. Phones are **dumb terminals**: they render exactly
what the host tells them to and report exactly what a thumb did. Every decision
that matters — who is on which team, whether a round is open, what anything
scored — belongs to the host and only to the host.

This file is the contract. If the phone page and the host disagree about a
message, this is the thing that is right.

## The rules that do not bend

1. **The host is the only authority.** A phone never scores, never advances a
   question, never decides a round is over.
2. **No phone is ever sent an answer.** Not a correct value, not a tile's
   correctness, not which rung is higher. A phone that gets Googled or handed
   round holds nothing worth knowing. There is no marking on a phone, so unlike
   a design where teams mark each other, the answer key never leaves the laptop
   all night.
3. **The unit of play is the table.** One submission per team, however many
   phones point at it. Extra phones mirror the same state and any of them can
   act; the host resolves by team, never by device.
4. **Only the host's clock is read.** Phones never send a timestamp and the host
   would ignore one. Nothing is ranked by arrival order.
5. **Every round must be playable without phones.** The host can enter any
   team's answer by hand. A flat battery is an inconvenience, never a blocker.

## Joining

The phone page is `play.html`, served from the same site. A player types the
room code shown on the host screen, then taps their team. A team may be claimed
by several devices.

Identity is the SlopLobby `clientId` (per browser tab). The host keeps a
`clientId -> teamId` binding. That binding, not anything in a message, decides
which team a submission belongs to — a phone claiming to be a different team in
its payload is ignored.

## Messages

Host to phone:

| `t`      | Payload | Meaning |
|----------|---------|---------|
| `hello`  | `{ teams, claimed, teamId }` | Sent on join and rejoin. `teamId` is set if this client is already bound. |
| `view`   | `{ roundId, qi, format, open, view, submitted }` | Render this. `view` is format-specific and never contains an answer. |
| `idle`   | `{ message }` | Nothing to do — between rounds, or during a written round. |
| `ack`    | `{ roundId, qi, seq }` | Your submission is recorded. |

Phone to host:

| `t`      | Payload | Meaning |
|----------|---------|---------|
| `claim`  | `{ teamId }` | Bind this device to a team. |
| `commit` | `{ roundId, qi, seq, value }` | A thumb did something. |

### Idempotence

Every `commit` carries a `seq` that increases per device. The host keeps the
last `seq` it accepted for each `(clientId, roundId, qi)` and **ignores anything
not greater than it**. This matters because SlopNet queues messages for a phone
inside its reconnect window and flushes them on return — without the sequence, a
reconnecting phone could replay a lock or bank that has already been settled.

A commit is also rejected outright if the round is closed, or if it names a
round or question that is not the live one. A late tap from the previous
question can never burn the next one.

## The `view` payloads

None of these contain a correct answer.

**`dial`** — `{ label, unit, min, max, clues: [text…], multiplier, locked, value }`
Clues are only sent once the host has revealed them. `multiplier` is what
locking *now* would be worth.

**`climb`** — `{ current: {label}, next: {label}, step, total, pile, canBank, done }`
The phone is told the two rungs being compared and what it is carrying. It is
never told which is bigger, and it is not told whether a call was right — the
reveal belongs to the room, not to a handset.

**`nobody-else`** — `{ prompt, tiles: [label…], pick, picked: [i…], locked }`
Tile correctness is not in the payload. A team's own picks come back so a
returning phone shows what the table already chose.

## Scoring

Phones submit; `js/formats.js` scores. Those functions are pure and take no game
state, so what a round scored can be re-derived from what was submitted, and
checked by eye.

Results land in `game.marks[roundId][teamId][qi]` as a **fraction** of the
question's value, so difficulty weighting, jokers and bonuses all keep working.
Hand marking still writes 1 or 0, and a host tapping a part-marked cell overrules
it to full.
