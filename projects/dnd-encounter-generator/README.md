# D&D Encounter Generator

A combat encounter generator using the **D&D 2024 Dungeon Master's Guide** XP budget system.

## Features

- **XP Budget System** — Uses the official 2024 DMG Low / Moderate / High difficulty tiers
- **Party Configuration** — Set party size (1–10) and level (1–20)
- **Environment Filtering** — Filter monsters by terrain (Arctic, Forest, Dungeon, etc.)
- **Creature Type Filtering** — Filter by type (Beast, Undead, Fiend, Dragon, etc.)
- **Encounter Themes** — Pre-built thematic groups like Goblinoid Warband, Undead Rising, Dragon's Lair
- **Smart Warnings** — Alerts when encounter includes creatures with CR above party level or excessive creature counts

## Local Development

No build step required. Serve the directory with any static file server:

```bash
python3 -m http.server 8000
# or
npx serve .
```

Then open `http://localhost:8000` in your browser.

## How It Works

1. Set the number of players, party level, and desired difficulty
2. Optionally filter by environment, creature type, or encounter theme
3. Click **Generate Encounter** to build a balanced encounter within the XP budget
4. Re-click to get a different encounter with the same parameters

The generator follows the 2024 DMG rules: XP budget = per-character budget × number of characters. Monsters are selected to fill the budget without exceeding it.
