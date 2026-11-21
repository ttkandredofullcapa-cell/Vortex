
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();

const COLORS = [
  '#45e5ff',
  '#ff5b82',
  '#f4d35e',
  '#8bff72',
  '#bb86fc',
  '#ff9e52',
  '#62a7ff',
  '#f5f5f5'
];

app.get('/', (req, res) => {
  res.json({
    game: 'VORTEX LEGENDS',
    status: 'online',
    service: 'multiplayer-api',
    version: '1.3.0'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    version: '1.3.0'
  });
});

function makeId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(
    password,
    salt,
    100000,
    32,
    'sha256'
  ).toString('hex');
}

function playerPublic(p) {
  return {
    id: p.id,
    name: p.name,
    ready: p.ready,
    color: p.color,
    x: p.x,
    y: p.y,
    angle: p.angle,
    characterId: p.characterId || null
  };
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    mode: room.mode,
    host: room.host,
    players: Array.from(room.players.values()).map(playerPublic),
    count: room.players.size,
    maxPlayers: room.maxPlayers,
    hasPassword: !!room.passwordHash,
    status: room.status
  };
}

function getRooms() {
  return Array.from(rooms.values()).map(publicRoom);
}

function sendRoom(room) {
  io.to('room:' + room.id).emit(
    'room:update',
    publicRoom(room)
  );

  io.emit('rooms:list', getRooms());
}

function closeRoom(room, reason = 'host-left') {
  if (!rooms.has(room.id)) return;

  rooms.delete(room.id);

  const channel = 'room:' + room.id;

  io.to(channel).emit('room:closed', { reason });

  for (const id of room.players.keys()) {
    const s = io.sockets.sockets.get(id);

    if (s) {
      s.leave(channel);
      s.roomId = null;
      s.onlineRoomId = null;
    }
  }

  io.emit('rooms:list', getRooms());
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;

  if (room.host === id) {
    closeRoom(room, 'host-left');
    return;
  }

  room.players.delete(id);

  const s = io.sockets.sockets.get(id);

  if (s) {
    s.leave('room:' + room.id);
    s.roomId = null;
    s.onlineRoomId = null;
  }

  if (!room.players.size) {
    closeRoom(room, 'empty');
    return;
  }

  io.to('room:' + room.id).emit('player:left', {
    id: id
  });

  sendRoom(room);
}

function validPosition(d) {
  const x = Number(d.x);
  const y = Number(d.y);
  const angle = Number(d.angle || 0);

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(angle)
  ) {
    return null;
  }

  if (
    Math.abs(x) > 1e7 ||
    Math.abs(y) > 1e7 ||
    Math.abs(angle) > 1e6
  ) {
    return null;
  }

  return { x, y, angle };
}

io.on('connection', socket => {
  socket.roomId = null;
  socket.onlineRoomId = null;
  socket.playerName = 'Jogador';

  socket.emit('server:welcome', {
    message: 'Conectado ao VORTEX LEGENDS',
    id: socket.id
  });

  socket.emit('rooms:list', getRooms());

  socket.on('rooms:search', (q = '') => {
    const term = String(q).toLowerCase().trim();

    socket.emit(
      'rooms:searchResult',
      getRooms().filter(r =>
        r.name.toLowerCase().includes(term) ||
        r.id.toLowerCase().includes(term)
      )
    );
  });

  // CRIAR SALA
  socket.on('room:create', (d = {}, cb = () => {}) => {
    if (socket.roomId) {
      return cb({
        ok: false,
        error: 'Você já está em uma sala.'
      });
    }

    const name = String(d.name || 'Sala')
      .trim()
      .slice(0, 30);

    const playerName = String(d.playerName || 'Jogador')
      .trim()
      .slice(0, 20);

    const password = String(d.password || '');

    const maxPlayers = Number(d.maxPlayers || 4);

    const mode = String(d.mode || 'Normal')
      .slice(0, 20);

    if (![1, 2, 4, 6, 8].includes(maxPlayers)) {
      return cb({
        ok: false,
        error: 'Limite de jogadores inválido.'
      });
    }

    if (password.length > 32) {
      return cb({
        ok: false,
        error: 'Senha muito longa.'
      });
    }

    let id;

    do {
      id = makeId();
    } while (rooms.has(id));

    const salt = password
      ? crypto.randomBytes(16).toString('hex')
      : null;

    const room = {
      id,
      name,
      mode,
      host: socket.id,
      maxPlayers,
      players: new Map(),
      passwordSalt: salt,
      passwordHash: password
        ? hashPassword(password, salt)
        : null,
      status: 'waiting',
      createdAt: Date.now()
    };

    room.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      ready: false,
      color: COLORS[0],
      x: 0,
      y: 0,
      angle: 0,
      characterId: d.characterId || null
    });

    rooms.set(id, room);

    socket.roomId = id;
    socket.playerName = playerName;
    socket.join('room:' + id);

    sendRoom(room);

    cb({
      ok: true,
      room: publicRoom(room)
    });
  });

  // ENTRAR NA SALA
  socket.on('room:join', (d = {}, cb = () => {}) => {
    if (socket.roomId) {
      return cb({
        ok: false,
        error: 'Você já está em uma sala.'
      });
    }

    const room = rooms.get(
      String(d.id || '').toUpperCase()
    );

    if (!room) {
      return cb({
        ok: false,
        error: 'Sala não encontrada.'
      });
    }

    if (room.status !== 'waiting') {
      return cb({
        ok: false,
        error: 'A partida já começou.'
      });
    }

    if (room.players.size >= room.maxPlayers) {
      return cb({
        ok: false,
        error: 'Sala cheia.'
      });
    }

    const password = String(d.password || '');

    if (
      room.passwordHash &&
      hashPassword(password, room.passwordSalt) !== room.passwordHash
    ) {
      return cb({
        ok: false,
        error: 'Senha incorreta.'
      });
    }

    const playerName = String(d.playerName || 'Jogador')
      .trim()
      .slice(0, 20);

    const color = COLORS[
      room.players.size % COLORS.length
    ];

    room.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      ready: false,
      color,
      x: 0,
      y: 0,
      angle: 0,
      characterId: d.characterId || null
    });

    socket.roomId = room.id;
    socket.playerName = playerName;
    socket.join('room:' + room.id);

    sendRoom(room);

    cb({
      ok: true,
      room: publicRoom(room)
    });
  });

  // PRONTO / DESPRONTO
  socket.on('room:ready', (cb = () => {}) => {
    const room = rooms.get(socket.roomId);

    if (!room) {
      return cb({
        ok: false,
        error: 'Você não está em uma sala.'
      });
    }

    const p = room.players.get(socket.id);

    if (!p) {
      return cb({
        ok: false,
        error: 'Jogador não encontrado.'
      });
    }

    p.ready = !p.ready;

    sendRoom(room);

    cb({
      ok: true,
      ready: p.ready
    });
  });

  // INICIAR PARTIDA
  socket.on('room:start', (cb = () => {}) => {
    const room = rooms.get(socket.roomId);

    if (!room) {
      return cb({
        ok: false,
        error: 'Sala não encontrada.'
      });
    }

    if (room.host !== socket.id) {
      return cb({
        ok: false,
        error: 'Somente o host pode iniciar.'
      });
    }

    if (
      !Array.from(room.players.values())
        .every(p => p.ready)
    ) {
      return cb({
        ok: false,
        error: 'Todos precisam estar prontos.'
      });
    }

    room.status = 'playing';

    sendRoom(room);

    // ENVIA O ESTADO INICIAL DE TODOS OS JOGADORES
    io.to('room:' + room.id).emit('game:start', {
      roomId: room.id,
      players: Array.from(room.players.values())
        .map(playerPublic),
      mode: room.mode
    });

    cb({ ok: true });
  });

  // SINCRONIZAÇÃO DE POSIÇÃO
  socket.on('player:position', d => {
    const room = rooms.get(socket.roomId);

    if (
      !room ||
      room.status !== 'playing' ||
      String(d.roomId) !== room.id
    ) {
      return;
    }

    const p = room.players.get(socket.id);
    if (!p) return;

    const pos = validPosition(d);
    if (!pos) return;

    p.x = pos.x;
    p.y = pos.y;
    p.angle = pos.angle;

    if (
      d.characterId !== undefined &&
      d.characterId !== null
    ) {
      p.characterId = String(d.characterId)
        .slice(0, 40);
    }

    // ENVIA O JOGADOR ATUALIZADO AOS OUTROS
    socket.to('room:' + room.id).emit(
      'players:position',
      playerPublic(p)
    );
  });

  // EXPULSAR JOGADOR
  socket.on('room:kick', (pid, cb = () => {}) => {
    const room = rooms.get(socket.roomId);

    if (!room) {
      return cb({
        ok: false,
        error: 'Sala não encontrada.'
      });
    }

    if (room.host !== socket.id) {
      return cb({
        ok: false,
        error: 'Somente o host pode expulsar.'
      });
    }

    if (pid === room.host) {
      return cb({
        ok: false,
        error: 'Não pode expulsar o host.'
      });
    }

    if (!room.players.has(pid)) {
      return cb({
        ok: false,
        error: 'Jogador não encontrado.'
      });
    }

    const target = io.sockets.sockets.get(pid);

    if (target) {
      target.emit('room:kicked');
    }

    removePlayer(room, pid);

    cb({ ok: true });
  });

  // SAIR DA SALA
  socket.on('room:leave', (cb = () => {}) => {
    const room = rooms.get(socket.roomId);

    if (room) {
      removePlayer(room, socket.id);
    }

    cb({ ok: true });
  });

  // DESCONECTOU
  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomId);

    if (room) {
      removePlayer(room, socket.id);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    'VORTEX multiplayer API online port ' + PORT
  );
});
