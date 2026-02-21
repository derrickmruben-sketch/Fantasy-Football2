const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.static('public'));

// ─── Game State ────────────────────────────────────────────────────────────
const games = new Map(); // roomId -> gameState
const players = new Map(); // socketId -> { playerId, roomId, name }

// Generate simple room codes
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ─── Socket.io Events ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // CREATE GAME ROOM
  socket.on('createGame', (data) => {
    const roomCode = generateRoomCode();
    const gameState = {
      roomCode,
      players: {
        1: { id: socket.id, name: data.playerName || 'Player 1', ready: false },
        2: null,
        3: null,
      },
      rosters: {
        1: {},
        2: {},
        3: {},
      },
      currentTurn: 1, // Player 1 starts
      timerEndTime: null,
      TIMER_DURATION: 15, // seconds
    };

    games.set(roomCode, gameState);
    socket.join(roomCode);
    players.set(socket.id, { playerId: 1, roomId: roomCode, name: data.playerName });

    socket.emit('gameCreated', {
      roomCode,
      playerId: 1,
      gameState,
    });

    console.log(`Game created: ${roomCode}`);
  });

  // JOIN GAME ROOM
  socket.on('joinGame', (data) => {
    const { roomCode, playerName } = data;
    const gameState = games.get(roomCode);

    if (!gameState) {
      socket.emit('error', 'Room not found');
      return;
    }

    // Find first empty slot
    let playerId = null;
    for (let i = 2; i <= 3; i++) {
      if (gameState.players[i] === null) {
        playerId = i;
        break;
      }
    }

    if (playerId === null) {
      socket.emit('error', 'Room is full');
      return;
    }

    // Add player to game
    gameState.players[playerId] = {
      id: socket.id,
      name: playerName || `Player ${playerId}`,
      ready: false,
    };

    socket.join(roomCode);
    players.set(socket.id, { playerId, roomId: roomCode, name: playerName });

    socket.emit('gameJoined', {
      playerId,
      gameState,
    });

    // Notify all players in room
    io.to(roomCode).emit('playerJoined', {
      playerId,
      gameState,
    });

    console.log(`Player ${playerId} joined room ${roomCode}`);
  });

  // START GAME - Initialize first turn timer
  socket.on('startGame', (data) => {
    const { roomCode } = data;
    const gameState = games.get(roomCode);

    if (!gameState) return;

    gameState.timerEndTime = Date.now() + gameState.TIMER_DURATION * 1000;
    gameState.currentTurn = 1;

    io.to(roomCode).emit('gameStarted', {
      gameState,
      timerEndTime: gameState.timerEndTime,
    });

    console.log(`Game started in room ${roomCode}`);

    // Start timer broadcast
    startTimerBroadcast(roomCode);
  });

  // PLAYER SELECTION
  socket.on('selectPlayer', (data) => {
    const { roomCode, positionId, playerData } = data;
    const gameState = games.get(roomCode);
    const player = players.get(socket.id);

    if (!gameState || !player) return;

    const playerId = player.playerId;

    // Validate it's their turn
    if (gameState.currentTurn !== playerId) {
      socket.emit('error', 'Not your turn');
      return;
    }

    // Check position not already filled
    if (gameState.rosters[playerId][positionId]) {
      socket.emit('error', 'Position already filled');
      return;
    }

    // Store selection
    gameState.rosters[playerId][positionId] = playerData;

    // Broadcast selection to all players
    io.to(roomCode).emit('playerSelected', {
      playerId,
      positionId,
      playerData,
      rosters: gameState.rosters,
    });

    // Auto-advance turn after selection
    advanceTurn(roomCode);
  });

  // SKIP TURN (optional)
  socket.on('skipTurn', (data) => {
    const { roomCode } = data;
    const gameState = games.get(roomCode);
    const player = players.get(socket.id);

    if (!gameState || !player) return;

    if (gameState.currentTurn === player.playerId) {
      advanceTurn(roomCode);
      io.to(roomCode).emit('turnSkipped', {
        gameState,
      });
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (player) {
      const gameState = games.get(player.roomId);
      if (gameState) {
        gameState.players[player.playerId] = null;
        io.to(player.roomId).emit('playerDisconnected', {
          playerId: player.playerId,
          gameState,
        });
      }
      players.delete(socket.id);
    }
    console.log(`Player disconnected: ${socket.id}`);
  });
});

// ─── Helper Functions ──────────────────────────────────────────────────────
function advanceTurn(roomCode) {
  const gameState = games.get(roomCode);
  if (!gameState) return;

  // Cycle to next player: 1->2->3->1
  gameState.currentTurn = gameState.currentTurn === 3 ? 1 : gameState.currentTurn + 1;

  // Reset timer for new player
  gameState.timerEndTime = Date.now() + gameState.TIMER_DURATION * 1000;

  io.to(roomCode).emit('turnChanged', {
    currentTurn: gameState.currentTurn,
    timerEndTime: gameState.timerEndTime,
  });

  console.log(`Turn advanced to Player ${gameState.currentTurn} in room ${roomCode}`);
}

function startTimerBroadcast(roomCode) {
  const interval = setInterval(() => {
    const gameState = games.get(roomCode);

    if (!gameState || !gameState.timerEndTime) {
      clearInterval(interval);
      return;
    }

    const timeRemaining = Math.max(0, gameState.timerEndTime - Date.now());

    io.to(roomCode).emit('timerUpdate', {
      timeRemaining,
      currentTurn: gameState.currentTurn,
    });

    // When timer expires, auto-advance
    if (timeRemaining <= 0) {
      advanceTurn(roomCode);
    }
  }, 100); // Update every 100ms for smooth countdown
}

// ─── Start Server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
