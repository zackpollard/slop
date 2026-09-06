# Flip 7 Scoreboard

A score tracker for the Flip 7 press-your-luck card game. Track players, rounds, and scoring across a full game to 200 points. Supports both the original game and the standalone sequel **Flip 7: With a Vengeance** (including its optional Brutal Mode).

## Features

- Add 2–10 players
- Choose a ruleset before the game: **Classic** or **With a Vengeance**
- Per-round scoring with tap-to-select number cards
- Automatic Flip 7 bonus detection (+15 for 7 unique cards)
- Bust tracking

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
