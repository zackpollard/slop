# The Pub Quiz

A whole quiz night in a browser tab. It reads the questions out, plays the
music, runs the clock, takes the marks, draws the leaderboard, and fires the
confetti at the end. You just stand at the front and take the credit.

Live at **[pub-quiz.slop.zackpollard.pro](https://pub-quiz.slop.zackpollard.pro)**.

## What it does

**It hosts, you compère.**

- **Speaks everything.** Round intros, questions (twice, if you like), answers,
  fun facts and the running scores, through the browser's speech synthesiser.
  British voices are ranked to the top of the picker; speed and pitch are yours
  to fiddle with.
- **Sounds like a quiz night.** Every note of music and every sound effect is
  synthesised in the browser with the Web Audio API — no audio files, nothing to
  download. Round stings, a music bed under the thinking time, a clock that
  gets more insistent as the seconds go, a buzzer, a drum roll before each
  answer, a fanfare and a round of applause for the winners.
- **A real music round.** Questions can play a thirty-second clip of the actual
  record, streamed from Apple's preview service the moment you press play —
  nothing downloaded, nothing re-hosted, and no track name on screen to give the
  answer away. The credit and a link to the full song appear on the reveal.
  For a pub with no wifi, questions can instead play a public-domain melody
  through the synthesiser — Beethoven's Fifth, Ode to Joy, Greensleeves and
  friends — which needs no files and no connection at all.
- **Runs the clock.** A per-question countdown ring that you can pause, extend
  or skip, with an optional hands-free mode that reveals and advances by itself.
- **Runs a round the pub way.** All ten questions get asked with nothing given
  away, then the answers are read out at the end while sheets are swapped —
  one at a time, at the pace a table can actually mark at. If you would rather
  reveal each answer as you go, there is a switch for that.
- **Takes the marks.** After the answers, a grid of teams against questions:
  tap to cycle correct, wrong, blank. Bonus points, quick-fill rows, and the
  answer key one click away.
- **Picture rounds.** Questions can carry an image — a logo stripped of its
  wordmark, a photograph of a car. Pictures are files in the project, so unlike
  the music clips a picture round works with no internet at all. Every image is
  credited on screen, and the validator refuses to let a filename or alt text
  give the answer away.
- **Harder questions are worth more.** Every question carries a difficulty, and
  by default an easy one scores 1, a medium 1.5 and a hard 2 — so the team that
  gets the last question of a round is properly rewarded for it. The weights are
  editable in settings, and a switch turns the whole thing off for a flat point
  each. What a question is worth is shown as you ask it, on the marking grid, and
  on the printed answer key.
- **Jokers.** The pub-quiz classic: each team may play one joker across the
  night to double a round. Played from the marking grid, marked on the
  leaderboard, and there is a box for it on the printed answer sheets.
- **Draws the table.** Animated leaderboard between rounds with movement arrows,
  a half-time break with its own countdown and music, a closest-guess tie-break
  when the top of the table is level, and a podium at the end.
- **Prints.** Team answer sheets, the host's answer key with sources, and the
  final scores, all laid out for A4.
- **Remembers.** The quiz in progress is saved as you go, so a closed lid or an
  accidental refresh in round four costs you nothing.

## Running a quiz

1. Open it, pick a quiz pack, and choose which rounds to play (drag them into
   the order you fancy).
2. Type in the team names — or skip it and score on paper.
3. Set the voice and the volumes, then press **Test the voice** and one of the
   sound buttons. Do this *before* the pub fills up.
4. Press **F** for full screen, plug the laptop into the telly, and start.

A round runs like this: ask all ten questions, then the answers screen lists
them and reveals one at a time as you press on, so tables can swap sheets and
mark. Then the marking grid, then the leaderboard.

Handy keys while you host:

| Key | Does |
|---|---|
| `Space` / `→` | The obvious next thing: begin, next question, next answer |
| `←` | Back a question |
| `R` | Read the question again |
| `P` | Pause or resume the timer |
| `V` / `M` | Mute the voice / mute the sound |
| `F` | Full screen |
| `S` | Settings |
| `?` | The full list |
| `Esc` | Shut the voice up |

## The quiz packs

Questions live in **packs** — one file per quiz — so the site is reusable: new
quiz, new pack, no code.

Two packs ship with it.

### The Slop Mixed Bag (`quizzes/slop-mixed-02.js`)

Eighteen rounds, a hundred and eighty questions, written for a room whose ages
run from eleven to sixty: dog breeds, music, films of the 2020s, food, logos,
Formula One, geography, Disney, logic, general knowledge, modern cars,
cocktails, anatomy, board games, brands, emoji equations, a music round played
**backwards**, and one aimed squarely at the youngest player — questions she
should get and the adults should not.

Most questions draw on 2000 onwards. Where one reaches back it goes a long way
back, to before anyone in the room was born, rather than sitting in the decades
that only reward being the oldest at the table.

No answer repeats anywhere in the pack. At a thirty-second timer the whole thing
runs about three hours, so it is a bank to pick rounds from rather than one
sitting; the running order spaces the two audio rounds and the two picture
rounds well apart.

### The Slop Classic (`quizzes/slop-classic-01.js`)

Seventy questions across seven rounds — general knowledge, science, music,
sport, animals and a kids' round — plus three optional picture-and-sound rounds:
**Name That Tune** (clips of ten real records), **Guess the Logo** and **Name
That Car**.

### Both packs

Every question was drafted, then independently fact-checked against a fetched
source, then audited across the pack as a whole, and put through a pass for
British spelling, vocabulary, units and subject balance. Every question carries
the URL its answer was checked against, shown on screen when the answer is
revealed. Each round is ordered easiest first and hardest last, and each pack
has a tie-breaker for when the top of the table finishes level: a nearest-wins
numeric estimate.

Rounds are chosen on the setup screen, so a round that needs the internet — or
one that would not suit the room — is there when you want it and out of the way
when you do not.

To write your own, press **Export this pack** on the setup screen, edit the
JSON, and import it back — or drop a module into `quizzes/` and register it in
`js/packs.js`. The format is documented in
**[quizzes/SCHEMA.md](quizzes/SCHEMA.md)**.

Picture credits are listed in **[images/CREDITS.md](images/CREDITS.md)**.

## Development

No build step, no dependencies, no package manager. Serve the directory:

```bash
cd projects/pub-quiz
python3 -m http.server 8000
# then open http://localhost:8000
```

It has to be served over HTTP rather than opened as a `file://` path, because
it uses ES modules.

### The code

| File | What it is |
|---|---|
| `js/app.js` | The quizmaster: state machine, clock, keyboard, and the flow from welcome to fanfare |
| `js/screens.js` | Every screen of a running quiz, plus the words the host actually says |
| `js/setup.js` | The setup screen and the settings panel (reused as a mid-quiz overlay) |
| `js/state.js` | Settings and game state, scoring, standings, persistence |
| `js/packs.js` | Pack registry, validation and normalisation, import/export |
| `js/audio.js` | The entire sound design, synthesised — sound effects, music beds, melodies, the ticking clock |
| `js/speech.js` | The host voice: voice ranking, the Chrome fifteen-second bug, watchdogs so speech can never wedge the quiz |
| `js/media.js` | The audio and picture rounds: streams a clip of a real record, refreshes stale preview links, preloads a round ahead, and holds back a credit that would spoil the answer |
| `js/celebrate.js` | Canvas confetti, cannons, sparkles and flashes |
| `js/sheets.js` | Answer sheets, answer key and score sheet for printing |
| `js/dom.js` | Small DOM and formatting helpers |

Everything degrades: no speech synthesis, no Web Audio, no `localStorage` — the
quiz still runs, just quieter.

## Browser support

Best in Chrome or Edge, where the speech voices are the strongest. Safari and
Firefox work; their voice selection is thinner. Audio needs one click anywhere
on the page before it starts, which is the browser's rule, not ours — pressing
**Start the quiz** counts.
