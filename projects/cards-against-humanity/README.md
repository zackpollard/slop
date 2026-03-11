# Cards Against Humanity

A peer-to-peer browser-based Cards Against Humanity party game. One player creates a game and shares the code — others join directly via WebRTC (PeerJS). No server needed beyond the signaling service.

## How to play

1. Open the page and enter your name
2. **Create** a game or **Join** with a game code
3. Need 3+ players to start
4. Each round, one player is the Card Czar who reads the black card
5. Other players pick white cards to fill in the blanks
6. The Czar picks the funniest answer — that player scores a point
7. First to the score limit wins

## Tech

- Static HTML/CSS/JS (no build step)
- PeerJS (CDN) for WebRTC peer-to-peer connections
- 1,322 cards (275 black, 1,047 white) from the Cards Against Humanity dataset
- Cards Against Humanity is distributed under CC BY-NC-SA 4.0
