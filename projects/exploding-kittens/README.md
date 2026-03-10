# Exploding Kittens Assistant

Game tracker, card reference encyclopedia, and real-time draw probability calculator for **Exploding Kittens** — supporting all expansions.

## Features

- **Game Setup** — Select expansions (Imploding Kittens, Streaking Kittens, Barking Kittens), add players, and see full deck composition
- **Turn Tracker** — Track current player, turn direction, attack chains, skip/reverse actions, and player elimination
- **Card Reference** — Searchable encyclopedia of every card across base game and all expansions, including cat card combo rules
- **Probability Calculator** — Real-time odds of drawing an Exploding/Imploding Kitten, multi-draw survival odds, and deck statistics
- **Event Log** — Timestamped history of all game actions with undo support
- **Persistent State** — Game state saved to localStorage so you can refresh without losing progress

## Running locally

```bash
python3 -m http.server 8000
```
