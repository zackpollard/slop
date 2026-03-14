# Bang! The Bullet — Game Companion

A web-based companion app for the Bang! The Bullet card game. Handles game setup, role assignment, life point tracking, distance calculation, and provides a full character and card reference.

## Features

- **Game Setup** — Add 4-8 players, select expansions (Base + Dodge City), and auto-distribute roles
- **Role Reveal** — Pass-and-peek system for secret role and character assignment
- **Interactive Table** — Circular seating view with visual HP tracking and turn indicator
- **Distance Calculator** — Automatic distance calculation accounting for eliminated players, equipment (Mustang, Scope, Hideout), and character abilities (Paul Regret, Rose Doolan)
- **Life Point Tracker** — Bullet-hole style HP display with +/- controls
- **Equipment & Weapons** — Track active equipment modifiers and weapon range per player
- **Character Reference** — All 31 characters from Base Game and Dodge City with abilities
- **Card Reference** — Searchable, filterable database of all cards by type and expansion
- **Rules Reference** — Quick-reference guide for roles, turn structure, distance, and key cards
- **Game Log** — Timestamped event history

## Local Development

```bash
python3 -m http.server 8000
```
