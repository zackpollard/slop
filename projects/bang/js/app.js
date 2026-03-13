// Bang! The Bullet — Application Bootstrap
// Lobby management, host/client message routing, game lifecycle
(function() {
'use strict';

const { $, esc, toast, showScreen } = SlopLobby;

let lobby = null;
let engine = null;
let isHost = false;
let myId = null;
let myIdx = -1;
let playerOrder = [];
let useDodgeCity = false;

// ── Room code copy-on-click ──
document.getElementById('room-code').addEventListener('click', function() {
  const code = this.textContent.trim();
  if (code && code !== '----') {
    navigator.clipboard.writeText(code).then(() => toast('Room code copied!'));
  }
});

// ── Back to lobby ──
document.getElementById('btn-back-lobby').addEventListener('click', function() {
  window.location.reload();
});

// ── Lobby setup ──
function setupLobby() {
  $('btn-create').onclick = async () => {
    const name = $('input-name').value.trim();
    if (!name) return toast('Enter your name');
    useDodgeCity = $('dodge-city-toggle').checked;

    try {
      lobby = new SlopLobby.SlopLobby({
        roomPrefix: 'bang-',
        storageKey: 'bang-client-id',
        onHostData: handleHostMessage,
        onPlayerJoined: handlePlayerJoined,
        onPlayerRejoined: handlePlayerRejoined,
        onPlayerLeft: handlePlayerLeft,
      });

      const code = await lobby.createRoom(name);
      isHost = true;
      myId = 'host-' + Date.now() + Math.random().toString(36).slice(2, 5);

      BangUI.init(lobby);
      BangUI.isHost = true;

      $('room-code').textContent = code;
      $('waiting-dodge-city').checked = useDodgeCity;
      showScreen('waiting');
      updateWaitingRoom();

      $('waiting-dodge-city').onchange = () => {
        useDodgeCity = $('waiting-dodge-city').checked;
        broadcastWaitingRoom();
      };

      $('btn-start').onclick = () => startGame();
    } catch (err) {
      console.error('Create room failed:', err);
      toast('Failed to create room: ' + (err.message || err));
    }
  };

  $('btn-join').onclick = async () => {
    const name = $('input-name').value.trim();
    const code = $('input-code').value.trim().toUpperCase();
    if (!name) return toast('Enter your name');
    if (!code) return toast('Enter room code');

    lobby = new SlopLobby.SlopLobby({
      roomPrefix: 'bang-',
      storageKey: 'bang-client-id',
      onClientData: handleClientMessage,
      onStateChange: handleStateChange,
    });

    await lobby.joinRoom(code, name);
    isHost = false;
    myId = lobby.clientId;

    BangUI.init(lobby);
    BangUI.isHost = false;

    $('host-controls').classList.add('hidden');
    $('non-host-status').classList.remove('hidden');

    showScreen('waiting');
  };

  $('input-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('input-code').focus();
  });

  $('input-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-join').click();
  });
}

// ── Host: player events ──
function handlePlayerJoined(clientId, meta) {
  updateWaitingRoom();
  lobby.send(clientId, {
    type: 'waiting_room',
    players: getPlayerList(),
    useDodgeCity,
  });
  broadcastWaitingRoom();
}

function handlePlayerRejoined(clientId, meta) {
  if (engine && engine.state && engine.state.phase === 'playing') {
    const idx = playerOrder.indexOf(clientId);
    if (idx >= 0) {
      lobby.send(clientId, { type: 'game_view', view: engine.getPlayerView(idx) });
    }
  } else {
    broadcastWaitingRoom();
  }
}

function handlePlayerLeft(clientId, meta) {
  updateWaitingRoom();
  broadcastWaitingRoom();
}

function handleHostMessage(clientId, data) {
  if (data.type === 'action') {
    const idx = playerOrder.indexOf(clientId);
    if (idx < 0) return;
    processAction(idx, data);
  }
}

// ── Client: message handling ──
function handleClientMessage(data) {
  switch (data.type) {
    case 'waiting_room':
      useDodgeCity = data.useDodgeCity;
      BangUI.renderWaiting(data.players, false);
      break;
    case 'game_view':
      BangUI.gameView = data.view;
      BangUI.myIdx = data.view.yourIndex;
      if (data.view.winner) {
        BangUI.renderGameOver(data.view);
        showScreen('gameover');
      } else {
        BangUI.renderGame(data.view);
        showScreen('game');
      }
      break;
    case 'toast':
      toast(data.msg);
      break;
  }
}

function handleStateChange(status) {
  if (status === 'disconnected') toast('Disconnected from host...');
  if (status === 'reconnected') toast('Reconnected!');
}

// ── Host: game management ──
function startGame() {
  const players = getPlayerList();
  if (players.length < 4 || players.length > 8) {
    return toast('Need 4-8 players');
  }

  playerOrder = players.map(p => p.id);
  engine = new BangEngine();
  engine.initGame(players, useDodgeCity);

  BangUI.engine = engine;
  myIdx = playerOrder.indexOf(myId);
  BangUI.myIdx = myIdx;

  broadcastGameState();

  BangUI.gameView = engine.getPlayerView(myIdx);
  BangUI.renderGame(BangUI.gameView);
  showScreen('game');
}

function processAction(playerIdx, action) {
  try {
    engine.handleAction(playerIdx, action);
  } catch (e) {
    console.error('Action error:', e);
    const clientId = playerOrder[playerIdx];
    if (clientId && clientId !== myId) {
      lobby.send(clientId, { type: 'toast', msg: e.message || 'Invalid action' });
    } else {
      toast(e.message || 'Invalid action');
    }
    return;
  }
  broadcastGameState();
}

function broadcastGameState() {
  if (!engine) return;
  for (let i = 0; i < playerOrder.length; i++) {
    const view = engine.getPlayerView(i);
    const clientId = playerOrder[i];
    if (clientId === myId) {
      BangUI.gameView = view;
      BangUI.myIdx = i;
      if (view.winner) {
        BangUI.renderGameOver(view);
        showScreen('gameover');
      } else {
        BangUI.renderGame(view);
      }
    } else {
      lobby.send(clientId, { type: 'game_view', view });
    }
  }
}

// ── Exposed globals for BangUI ──
window.bangProcessAction = function(action) {
  if (isHost) {
    processAction(myIdx, action);
  } else {
    lobby.sendToHost({ type: 'action', ...action });
  }
};

window.bangStartGame = startGame;

// ── Play again (host) ──
document.getElementById('btn-play-again').addEventListener('click', function() {
  if (!isHost || !engine) return;
  const players = getPlayerList();
  if (players.length < 4 || players.length > 8) return toast('Need 4-8 players');
  playerOrder = players.map(p => p.id);
  engine = new BangEngine();
  engine.initGame(players, useDodgeCity);
  BangUI.engine = engine;
  myIdx = playerOrder.indexOf(myId);
  BangUI.myIdx = myIdx;
  broadcastGameState();
  BangUI.gameView = engine.getPlayerView(myIdx);
  BangUI.renderGame(BangUI.gameView);
  showScreen('game');
});

// ── Helpers ──
function getPlayerList() {
  const players = [];
  if (isHost && myId) {
    players.push({ id: myId, name: lobby.hostName || $('input-name').value.trim() });
  }
  if (lobby && lobby.players) {
    for (const [id, meta] of lobby.players) {
      players.push({ id, name: meta.name || meta });
    }
  }
  return players;
}

function updateWaitingRoom() {
  const players = getPlayerList();
  BangUI.renderWaiting(players, isHost);

  const startBtn = $('btn-start');
  if (startBtn) {
    startBtn.disabled = players.length < 4 || players.length > 8;
    startBtn.textContent = players.length < 4
      ? 'Need ' + (4 - players.length) + ' more player' + (4 - players.length !== 1 ? 's' : '')
      : players.length > 8
        ? 'Too many players (max 8)'
        : '\u2733 Start Game (' + players.length + ' players)';
  }
}

function broadcastWaitingRoom() {
  if (!lobby) return;
  const data = { type: 'waiting_room', players: getPlayerList(), useDodgeCity };
  for (const [id] of lobby.players) {
    if (id !== myId) lobby.send(id, data);
  }
}

// ── Boot ──
setupLobby();
})();
