const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const {
  createRoom, addPlayer, findPlayerByToken, kickPlayer, startRound,
  isValidSubmission, playCards, finalizeTrick, publicStateFor,
} = require('./game');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Bura server is running ✅'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 20000,
  pingTimeout: 60000,
});

const rooms = {}; // code -> room
const tokenToRoom = {}; // playerToken -> room code

const CLEANUP_DELAY_MS = 10 * 60 * 1000; // комната живёт 10 минут после того, как все отключились
const TRICK_PAUSE_MS = 1400; // пауза перед добором карт, чтобы было видно кто что скинул и кто забрал
const ROUND_END_PAUSE_MS = 1800; // доп. пауза перед показом итогов раздачи

function genCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 6).toUpperCase();
  } while (rooms[code]);
  return code;
}

function broadcastRoom(room) {
  for (const p of room.players) {
    io.to(p.id).emit('room_update', publicStateFor(room, p.id));
  }
}

function scheduleCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const stillEmpty = room.players.every((p) => !p.connected);
    if (stillEmpty) {
      for (const p of room.players) delete tokenToRoom[p.token];
      delete rooms[room.code];
    }
  }, CLEANUP_DELAY_MS);
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name, token }) => {
    if (!token) return;
    const code = genCode();
    const room = createRoom(code, socket.id, token, name || 'Игрок');
    rooms[code] = room;
    tokenToRoom[token] = code;
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.token = token;
    broadcastRoom(room);
  });

  socket.on('join_room', ({ code, name, token }) => {
    if (!token) return;
    const room = rooms[(code || '').toUpperCase()];
    if (!room) {
      socket.emit('error_msg', 'Комната не найдена');
      return;
    }
    if (room.phase !== 'lobby' && room.phase !== 'round_end') {
      socket.emit('error_msg', 'Игра уже идёт');
      return;
    }
    const ok = addPlayer(room, socket.id, token, name || 'Игрок');
    if (!ok) {
      socket.emit('error_msg', 'Комната заполнена (максимум 4)');
      return;
    }
    tokenToRoom[token] = room.code;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.token = token;
    broadcastRoom(room);
  });

  socket.on('resume_session', ({ token }) => {
    if (!token) return;
    const code = tokenToRoom[token];
    const room = code ? rooms[code] : null;
    if (!room) {
      socket.emit('error_msg', 'Сессия не найдена, начни заново');
      return;
    }
    const player = findPlayerByToken(room, token);
    if (!player) {
      socket.emit('error_msg', 'Сессия не найдена, начни заново');
      return;
    }
    player.id = socket.id;
    player.connected = true;
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.token = token;
    broadcastRoom(room);
  });

  socket.on('kick_player', ({ playerId }) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const requester = findPlayerByToken(room, socket.data.token);
    if (!requester || requester.token !== room.hostToken) return;
    if (room.phase !== 'lobby') return;
    if (playerId === socket.id) return;

    const target = room.players.find((p) => p.id === playerId);
    if (!target) return;

    kickPlayer(room, playerId);
    delete tokenToRoom[target.token];

    io.to(playerId).emit('kicked');
    const kickedSocket = io.sockets.sockets.get(playerId);
    if (kickedSocket) {
      kickedSocket.leave(room.code);
      kickedSocket.data.roomCode = null;
      kickedSocket.data.token = null;
    }
    broadcastRoom(room);
  });

  socket.on('start_game', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const player = findPlayerByToken(room, socket.data.token);
    if (!player || player.token !== room.hostToken) return;
    if (room.players.length < 3) {
      socket.emit('error_msg', 'Нужно минимум 3 игрока');
      return;
    }
    startRound(room);
    broadcastRoom(room);
  });

  socket.on('next_round', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const player = findPlayerByToken(room, socket.data.token);
    if (!player || player.token !== room.hostToken) return;
    startRound(room);
    broadcastRoom(room);
  });

  // Игрок скидывает 1 или несколько карт одной масти за ход
  socket.on('play_card', ({ cards }) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (!isValidSubmission(room, socket.id, cards)) {
      socket.emit('error_msg', 'Недопустимый ход: если открываешь взятку — все карты одной масти; если отвечаешь — нужно ровно столько карт, сколько кинул лидер (или все, что остались)');
      return;
    }
    const result = playCards(room, socket.id, cards);

    if (result) {
      // Взятка укомплектована - показываем итог всем, потом с паузой добираем карты и чистим стол
      room.phase = 'resolving';
      io.to(room.code).emit('trick_result', {
        trick: result.trick,
        winnerId: result.winnerId,
        winnerName: result.winnerName,
        trickPoints: result.trickPoints,
        columns: result.columns,
      });
      setTimeout(() => {
        finalizeTrick(room, result.winnerId);
        if (room.phase === 'round_end') {
          // Даём время доиграть анимацию последней взятки перед экраном итогов раздачи
          setTimeout(() => broadcastRoom(room), ROUND_END_PAUSE_MS);
        } else {
          broadcastRoom(room);
        }
      }, TRICK_PAUSE_MS);
    } else {
      broadcastRoom(room);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (player) player.connected = false;
    broadcastRoom(room);
    const anyoneLeft = room.players.some((p) => p.connected);
    if (!anyoneLeft) scheduleCleanup(room);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Bura server listening on ${PORT}`));
