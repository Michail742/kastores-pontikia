const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── Game state store ──────────────────────────────────────────────────────────
const rooms = {}; // roomCode -> RoomState

// ── Deck builder ─────────────────────────────────────────────────────────────
function buildDeck() {
  const deck = [];
  // 0-8: 4 each = 36
  for (let v = 0; v <= 8; v++) {
    for (let i = 0; i < 4; i++) deck.push({ type: 'value', value: v });
  }
  // 9: 9 cards
  for (let i = 0; i < 9; i++) deck.push({ type: 'value', value: 9 });
  // Specials
  for (let i = 0; i < 9; i++) deck.push({ type: 'special', name: 'swap' });
  for (let i = 0; i < 7; i++) deck.push({ type: 'special', name: 'peek' });
  for (let i = 0; i < 5; i++) deck.push({ type: 'special', name: 'double' });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Room helpers ──────────────────────────────────────────────────────────────
function generateCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); }
  while (rooms[code]);
  return code;
}

function publicCard(card) {
  // What everyone can see (face-up card in discard)
  return card;
}

function hiddenCard() {
  return { type: 'hidden' };
}

// Build the view of the game state for a specific player
function stateForPlayer(room, playerId) {
  const g = room.game;
  if (!g) return null;

  const players = g.players.map((p) => {
    const isMe = p.id === playerId;
    return {
      id: p.id,
      name: p.name,
      isMe,
      cards: p.cards.map((c, idx) => {
        if (isMe && p.peekedIndices && p.peekedIndices.includes(idx)) return c;
        return hiddenCard();
      }),
      score: p.score,
      totalScore: p.totalScore,
      playedThisRound: p.playedThisRound,
    };
  });

  return {
    phase: g.phase,
    round: g.round,
    totalRounds: g.totalRounds,
    currentPlayerIndex: g.currentPlayerIndex,
    currentPlayerId: g.players[g.currentPlayerIndex]?.id,
    drawnCard: g.currentPlayerId === playerId ? g.drawnCard : null,
    discardTop: g.discard.length ? g.discard[g.discard.length - 1] : null,
    deckCount: g.deck.length,
    players,
    endCalledBy: g.endCalledBy,
    lastRoundPlayers: g.lastRoundPlayers,
    actionState: g.currentPlayerId === playerId ? g.actionState : null,
    doubleCard: g.currentPlayerId === playerId ? g.doubleCard : null,
    scores: g.scores,
    winner: g.winner,
    roundWinner: g.roundWinner,
  };
}

function broadcastState(room) {
  for (const [sid, playerId] of Object.entries(room.socketToPlayer)) {
    const view = stateForPlayer(room, playerId);
    io.to(sid).emit('gameState', view);
  }
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobby', {
    code: room.code,
    players: room.players,
    hostId: room.hostId,
  });
}

// ── Game initialization ───────────────────────────────────────────────────────
function initGame(room) {
  const playerList = room.players;
  const deck = shuffle(buildDeck());
  const numPlayers = playerList.length;

  const players = playerList.map((p) => ({
    id: p.id,
    name: p.name,
    cards: deck.splice(0, 4),
    peekedIndices: [], // temporary, cleared after state sent
    score: 0,
    totalScore: p.totalScore || 0,
    playedThisRound: false,
  }));

  const discardCard = deck.shift();
  const discard = [discardCard];

  const totalRounds = numPlayers === 2 ? 4 : numPlayers;

  room.game = {
    phase: 'peek', // peek -> playing -> lastRound -> scoring
    round: (room.game ? room.game.round + 1 : 1),
    totalRounds,
    players,
    deck,
    discard,
    currentPlayerIndex: 0,
    currentPlayerId: players[0].id,
    drawnCard: null,
    actionState: 'choose', // choose | drawn | special-peek | special-swap | special-double | special-double2
    endCalledBy: null,
    lastRoundPlayers: [],
    doubleCard: null,
    scores: null,
    winner: null,
    roundWinner: null,
  };

  // Mark peek phase: players see outer cards (0 and 3)
  players.forEach((p) => { p.peekedIndices = [0, 3]; });

  broadcastState(room);
}

// ── Draw from deck helper ─────────────────────────────────────────────────────
function drawFromDeck(game) {
  if (game.deck.length === 0) {
    // Reshuffle discard (keep top)
    const top = game.discard.pop();
    game.deck = shuffle(game.discard);
    game.discard = [top];
  }
  return game.deck.shift();
}

// ── Advance turn ──────────────────────────────────────────────────────────────
function advanceTurn(room) {
  const g = room.game;
  g.players.forEach((p) => { p.peekedIndices = []; });
  g.drawnCard = null;
  g.actionState = 'choose';
  g.doubleCard = null;

  const currentP = g.players[g.currentPlayerIndex];
  currentP.playedThisRound = true;

  if (g.phase === 'lastRound') {
    // Remove the player who just played from the remaining last-round queue
    const idx = g.lastRoundPlayers.indexOf(currentP.id);
    if (idx !== -1) g.lastRoundPlayers.splice(idx, 1);
    if (g.lastRoundPlayers.length === 0) { endRound(room); return; }

    // Find next player that's still in the queue
    let next = (g.currentPlayerIndex + 1) % g.players.length;
    let attempts = 0;
    while (!g.lastRoundPlayers.includes(g.players[next].id)) {
      next = (next + 1) % g.players.length;
      if (++attempts > g.players.length) { endRound(room); return; }
    }
    g.currentPlayerIndex = next;
    g.currentPlayerId = g.players[next].id;
  } else {
    const next = (g.currentPlayerIndex + 1) % g.players.length;
    g.currentPlayerIndex = next;
    g.currentPlayerId = g.players[next].id;
  }

  broadcastState(room);
}

// ── End round ─────────────────────────────────────────────────────────────────
function endRound(room) {
  const g = room.game;
  g.phase = 'scoring';
  g.players.forEach((p) => { p.peekedIndices = [0, 1, 2, 3]; }); // reveal all

  // Replace specials with drawn cards
  g.players.forEach((p) => {
    p.cards = p.cards.map((c) => {
      if (c.type === 'special') {
        let replacement;
        do { replacement = drawFromDeck(g); } while (replacement.type === 'special');
        return replacement;
      }
      return c;
    });
    p.score = p.cards.reduce((sum, c) => sum + (c.value || 0), 0);
    p.totalScore = (p.totalScore || 0) + p.score;
  });

  g.scores = g.players.map((p) => ({ id: p.id, name: p.name, score: p.score, totalScore: p.totalScore }));
  g.roundWinner = [...g.scores].sort((a, b) => a.score - b.score)[0];

  // Check if game over
  if (g.round >= g.totalRounds) {
    g.phase = 'gameover';
    g.winner = [...g.scores].sort((a, b) => a.totalScore - b.totalScore)[0];
  }

  // Update persistent player totals in room
  room.players.forEach((p) => {
    const gp = g.players.find((x) => x.id === p.id);
    if (gp) p.totalScore = gp.totalScore;
  });

  broadcastState(room);
}

// ── Socket.io events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayerId = null;

  // ── CREATE ROOM ──
  socket.on('createRoom', ({ name }) => {
    const code = generateCode();
    const playerId = socket.id;
    rooms[code] = {
      code,
      hostId: playerId,
      players: [{ id: playerId, name, totalScore: 0 }],
      socketToPlayer: { [socket.id]: playerId },
      game: null,
      status: 'lobby',
    };
    currentRoom = code;
    currentPlayerId = playerId;
    socket.join(code);
    socket.emit('roomJoined', { code, playerId });
    broadcastLobby(rooms[code]);
  });

  // ── JOIN ROOM ──
  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { message: 'Δεν βρέθηκε δωμάτιο με αυτόν τον κωδικό.' });
    if (room.status !== 'lobby') return socket.emit('error', { message: 'Το παιχνίδι έχει ήδη ξεκινήσει.' });
    if (room.players.length >= 6) return socket.emit('error', { message: 'Το δωμάτιο είναι γεμάτο.' });

    const playerId = socket.id;
    room.players.push({ id: playerId, name, totalScore: 0 });
    room.socketToPlayer[socket.id] = playerId;
    currentRoom = code;
    currentPlayerId = playerId;
    socket.join(code);
    socket.emit('roomJoined', { code, playerId });
    broadcastLobby(room);
  });

  // ── START GAME ──
  socket.on('startGame', () => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== currentPlayerId) return;
    if (room.players.length < 2) return socket.emit('error', { message: 'Χρειάζονται τουλάχιστον 2 παίκτες.' });
    room.status = 'playing';
    initGame(room);
  });

  // ── CONFIRM PEEK (initial) ──
  socket.on('confirmPeek', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const g = room.game;
    const player = g.players.find((p) => p.id === currentPlayerId);
    if (!player) return;
    player.peekedIndices = [];

    // Check if all players confirmed peek
    const allConfirmed = g.players.every((p) => p.peekedIndices.length === 0 && p._peekConfirmed);
    player._peekConfirmed = true;
    if (g.players.every((p) => p._peekConfirmed)) {
      g.phase = 'playing';
      g.players.forEach((p) => { p._peekConfirmed = false; p.peekedIndices = []; });
    }
    broadcastState(room);
  });

  // ── ACTION: TAKE FROM DISCARD (Ενέργεια Α) ──
  socket.on('takeDiscard', () => {
    const room = rooms[currentRoom];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayerId !== currentPlayerId) return;
    if (g.actionState !== 'choose') return;
    const top = g.discard[g.discard.length - 1];
    if (!top || top.type === 'special') return socket.emit('error', { message: 'Δεν μπορείς να πάρεις ειδική κάρτα από τα σκάρτα.' });

    g.drawnCard = { ...top, fromDiscard: true };
    g.discard.pop();
    g.actionState = 'swapOwn';
    broadcastState(room);
  });

  // ── ACTION: TAKE FROM DECK (Ενέργεια Β) ──
  socket.on('takeDeck', () => {
    const room = rooms[currentRoom];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayerId !== currentPlayerId) return;
    if (g.actionState !== 'choose') return;

    g.drawnCard = drawFromDeck(g);
    g.actionState = 'drawn';
    broadcastState(room);
  });

  // ── ACTION: DISCARD DRAWN CARD ──
  socket.on('discardDrawn', () => {
    const room = rooms[currentRoom];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayerId !== currentPlayerId) return;
    if (!['drawn', 'double2'].includes(g.actionState)) return;

    g.discard.push(g.drawnCard);

    if (g.actionState === 'double2') {
      // Must use this card — but discardDrawn shouldn't be callable in double2
      return;
    }

    g.drawnCard = null;
    g.actionState = 'choose';
    advanceTurn(room);
  });

  // ── ACTION: SWAP DRAWN WITH OWN CARD ──
  socket.on('swapWithOwn', ({ cardIndex }) => {
    const room = rooms[currentRoom];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayerId !== currentPlayerId) return;
    if (!['drawn', 'swapOwn', 'double', 'double2'].includes(g.actionState)) return;

    const player = g.players.find((p) => p.id === currentPlayerId);
    if (!player || cardIndex < 0 || cardIndex > 3) return;
    if (g.drawnCard?.type === 'special') return socket.emit('error', { message: 'Ειδική κάρτα: χρησιμοποίησέ την ή ξεσκάρτα.' });

    const old = player.cards[cardIndex];
    player.cards[cardIndex] = g.drawnCard;
    g.discard.push(old);
    g.drawnCard = null;
    g.actionState = 'choose';
    advanceTurn(room);
  });

  // ── ACTION: PLAY SPECIAL CARD ──
  socket.on('playSpecial', () => {
    const room = rooms[currentRoom];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayerId !== currentPlayerId) return;
    if (!['drawn', 'double', 'double2'].includes(g.actionState)) return;
    if (!g.drawnCard || g.drawnCard.type !== 'special') return;

    const special = g.drawnCard;
    g.discard.push(special);

    if (special.name === 'peek') {
      g.drawnCard = null;
      g.actionState = 'special-peek';
    } else if (special.name === 'swap') {
      g.drawnCard = null;
      g.actionState = 'special-swap';
      g.swapSelection = { ownIndex: null, targetId: null, targetIndex: null };
    } else if (special.name === 'double') {
      // Double: already used the drawn card; now draw another
      g.doubleCard = drawFromDeck(g);
      g.drawnCard = g.doubleCard;
      g.actionState = 'double';
    }
    broadcastState(room);
  });

  // ── ACTION: PEEK OWN CARD ──
  socket.on('peekOwnCard', ({ cardIndex }) => {
    const room = rooms[currentRoom];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayerId !== currentPlayerId) return;
    if (g.actionState !== 'special-peek') return;

    const player = g.players.find((p) => p.id === currentPlayerId);
    if (!player || cardIndex < 0 || cardIndex > 3) return;

    player.peekedIndices = [cardIndex];
    g.actionState = 'peeking';
    broadcastState(room);

    // Auto-hide after 3s
    setTimeout(() => {
      if (rooms[currentRoom]?.game?.actionState === 'peeking') {
        player.peekedIndices = [];
        g.actionState = 'choose';
        advanceTurn(room);
        broadcastState(room);
      }
    }, 3000);
  });

  // ── ACTION: SELECT SWAP CARDS ──
  socket.on('selectSwap', ({ ownIndex, targetId, targetIndex }) => {
    const room = rooms[currentRoom];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayerId !== currentPlayerId) return;
    if (g.actionState !== 'special-swap') return;

    const me = g.players.find((p) => p.id === currentPlayerId);
    const target = g.players.find((p) => p.id === targetId);
    if (!me || !target || me === target) return;
    if (ownIndex < 0 || ownIndex > 3 || targetIndex < 0 || targetIndex > 3) return;

    // Swap silently
    const tmp = me.cards[ownIndex];
    me.cards[ownIndex] = target.cards[targetIndex];
    target.cards[targetIndex] = tmp;

    g.actionState = 'choose';
    advanceTurn(room);
  });

  // ── ACTION: DOUBLE CHANCE — discard first, draw second (handled via discardDrawn/swapWithOwn) ──
  // The double special card flow:
  // 1. Player draws card (takeDeck) -> actionState: drawn
  // 2. Player plays double special (playSpecial) -> draws second card, actionState: double
  // 3. Player can swap or discard second card. If discard -> advanceTurn. If swap -> advanceTurn.
  // Actually re-reading the rules: Δυο Ευκαιρίες means:
  // - Look at top of deck. If you like it: use it (swap or play if special).
  // - If you don't: discard it, draw another one, MUST use that one.
  // So 'double' state means they already drew first card. They can discard it (->double2) or use it.
  // 'double2' means they drew second card, must use it.

  socket.on('discardDouble', () => {
    const room = rooms[currentRoom];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayerId !== currentPlayerId) return;
    if (g.actionState !== 'double') return;

    g.discard.push(g.drawnCard);
    g.drawnCard = drawFromDeck(g);
    g.actionState = 'double2'; // must use this one
    broadcastState(room);
  });

  // ── ACTION: CALL END ──
  socket.on('callEnd', () => {
    const room = rooms[currentRoom];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayerId !== currentPlayerId) return;
    if (g.phase !== 'playing') return;

    // All players must have played at least once
    if (!g.players.every((p) => p.playedThisRound)) {
      return socket.emit('error', { message: 'Όλοι πρέπει να παίξουν τουλάχιστον μία φορά πρώτα.' });
    }

    g.endCalledBy = currentPlayerId;
    g.phase = 'lastRound';
    // Everyone except caller gets one more turn
    g.lastRoundPlayers = g.players.filter((p) => p.id !== currentPlayerId).map((p) => p.id);
    broadcastState(room);
    advanceTurn(room);
  });

  // ── ACTION: NEXT ROUND ──
  socket.on('nextRound', () => {
    const room = rooms[currentRoom];
    if (!room?.game) return;
    if (room.hostId !== currentPlayerId) return;
    if (room.game.phase !== 'scoring') return;
    initGame(room);
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    delete room.socketToPlayer[socket.id];
    if (!room.game) {
      room.players = room.players.filter((p) => p.id !== currentPlayerId);
      if (room.players.length === 0) {
        delete rooms[currentRoom];
      } else {
        if (room.hostId === currentPlayerId) room.hostId = room.players[0].id;
        broadcastLobby(room);
      }
    } else {
      io.to(currentRoom).emit('playerLeft', { name: room.players.find((p) => p.id === currentPlayerId)?.name });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
