# UNO No Mercy Scoreboard

Score tracker for **UNO Show 'Em No Mercy**. Count cards remaining in opponents' hands, track Mercy Rule knockouts, and race to 1,000 points across multiple hands.

## Features

- Add 2–10 players
- Per-hand scoring with card counting (number cards, action cards, wild cards)
- Mercy Rule knockout tracking (+250 bonus per KO)
- Configurable target score and mercy card limit
- Progress bars and hand-by-hand history
- Game state persisted in localStorage

## Scoring Reference

| Card Type | Points |
|-----------|--------|
| Number cards (0–9) | Face value |
| Action cards (Skip, Reverse, Draw 2, Draw 4, Skip Everyone, Discard All) | 20 each |
| Wild cards (Wild Draw 6, Wild Draw 10, Wild Reverse Draw 4, Wild Color Roulette) | 50 each |
| Mercy Rule knockout bonus | 250 per player |

## Local Development

```bash
python3 -m http.server 8000
```
