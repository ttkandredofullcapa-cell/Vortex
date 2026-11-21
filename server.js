
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.get("/", (req, res) => {
  res.json({
    game: "VORTEX LEGENDS",
    status: "online",
    service: "multiplayer-api",
    version: "1.0.0"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", rooms: rooms.size });
});

function makeId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    mode: room.mode,
    host: room.host,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      ready: p.ready
    })),
    count: room.players.size,
    maxPlayers: room.maxPlayers,
    hasPassword: !!room.passwordHash,
    status: room.status
  };
}

function sendRoom(room) {
  io.to("room:" + room.id).emit("room:update", publicRoom(room));
  io.emit("rooms:list", getRooms());
}

function getRooms() {
  return Array.from(rooms.values()).map(publicRoom);
}

function removeRoom(room) {
  rooms.delete(room.id);
  io.to("room:" + room.id).emit("room:closed");
  io.emit("rooms:list", getRooms());
}

function removePlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return;

  room.players.delete(playerId);

  const memberSocket = io.sockets.sockets.get(playerId);
  if (memberSocket) {
    memberSocket.leave("room:" + room.id);
    memberSocket.roomId = null;
  }

  if (room.players.size === 0) {
    removeRoom(room);
    return;
  }

  if (room.host === playerId) {
    room.host = room.players.keys().next().value;
  }

  sendRoom(room);
}

io.on("connection", (socket) => {
  socket.roomId = null;
  socket.playerName = "Jogador";

  socket.emit("server:welcome", {
    message: "Conectado ao VORTEX LEGENDS",
    id: socket.id
  });

  socket.emit("rooms:list", getRooms());

  socket.on("rooms:search", (query = "") => {
    const term = String(query).toLowerCase().trim();

    const result = getRooms().filter(room =>
      room.name.toLowerCase().includes(term) ||
      room.id.toLowerCase().includes(term)
    );

    socket.emit("rooms:searchResult", result);
  });

  socket.on("room:create", (data = {}, callback = () => {}) => {
    if (socket.roomId) {
      return callback({ ok: false, error: "Você já está em uma sala." });
    }

    const name = String(data.name || "Sala").trim().slice(0, 30);
    const playerName = String(data.playerName || "Jogador").trim().slice(0, 20);
    const password = String(data.password || "");
    const maxPlayers = Number(data.maxPlayers || 4);
    const mode = String(data.mode || "normal").slice(0, 20);

    if (![2, 4, 6, 8].includes(maxPlayers)) {
      return callback({ ok: false, error: "Limite de jogadores inválido." });
    }

    if (password.length > 32) {
      return callback({ ok: false, error: "Senha muito longa." });
    }

    let id;
    do {
      id = makeId();
    } while (rooms.has(id));

    const salt = password ? crypto.randomBytes(16).toString("hex") : null;

    const room = {
      id,
      name,
      mode,
      host: socket.id,
      maxPlayers,
      players: new Map(),
      passwordSalt: salt,
      passwordHash: password ? hashPassword(password, salt) : null,
      status: "waiting",
      createdAt: Date.now()
    };

    room.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      ready: false
    });

    rooms.set(id, room);
    socket.roomId = id;
    socket.playerName = playerName;
    socket.join("room:" + id);

    sendRoom(room);
    callback({ ok: true, room: publicRoom(room) });
  });

  socket.on("room:join", (data = {}, callback = () => {}) => {
    if (socket.roomId) {
      return callback({ ok: false, error: "Você já está em uma sala." });
    }

    const room = rooms.get(String(data.id || "").toUpperCase());

    if (!room) {
      return callback({ ok: false, error: "Sala não encontrada." });
    }

    if (room.status !== "waiting") {
      return callback({ ok: false, error: "A partida já começou." });
    }

    if (room.players.size >= room.maxPlayers) {
      return callback({ ok: false, error: "Sala cheia." });
    }

    const password = String(data.password || "");

    if (room.passwordHash) {
      const supplied = hashPassword(password, room.passwordSalt);

      if (supplied !== room.passwordHash) {
        return callback({ ok: false, error: "Senha incorreta." });
      }
    }

    const playerName = String(data.playerName || "Jogador").trim().slice(0, 20);

    room.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      ready: false
    });

    socket.roomId = room.id;
    socket.playerName = playerName;
    socket.join("room:" + room.id);

    sendRoom(room);
    callback({ ok: true, room: publicRoom(room) });
  });

  socket.on("room:ready", (callback = () => {}) => {
    const room = rooms.get(socket.roomId);
    if (!room) return callback({ ok: false, error: "Você não está em uma sala." });

    const player = room.players.get(socket.id);
    if (!player) return callback({ ok: false, error: "Jogador não encontrado." });

    player.ready = !player.ready;
    sendRoom(room);
    callback({ ok: true, ready: player.ready });
  });

  socket.on("room:start", (callback = () => {}) => {
    const room = rooms.get(socket.roomId);
    if (!room) return callback({ ok: false, error: "Sala não encontrada." });

    if (room.host !== socket.id) {
      return callback({ ok: false, error: "Somente o host pode iniciar." });
    }

    if (room.players.size < 2) {
      return callback({ ok: false, error: "É preciso pelo menos 2 jogadores." });
    }

    const allReady = Array.from(room.players.values()).every(p => p.ready);

    if (!allReady) {
      return callback({ ok: false, error: "Todos precisam estar prontos." });
    }

    room.status = "playing";
    sendRoom(room);

    io.to("room:" + room.id).emit("game:start", {
      roomId: room.id,
      players: publicRoom(room).players,
      mode: room.mode
    });

    callback({ ok: true });
  });

  socket.on("room:kick", (playerId, callback = () => {}) => {
    const room = rooms.get(socket.roomId);
    if (!room) return callback({ ok: false, error: "Sala não encontrada." });

    if (room.host !== socket.id) {
      return callback({ ok: false, error: "Somente o host pode expulsar." });
    }

    if (playerId === room.host) {
      return callback({ ok: false, error: "Não pode expulsar o host." });
    }

    if (!room.players.has(playerId)) {
      return callback({ ok: false, error: "Jogador não encontrado." });
    }

    const target = io.sockets.sockets.get(playerId);

    if (target) {
      target.emit("room:kicked");
    }

    removePlayer(room, playerId);
    callback({ ok: true });
  });

  socket.on("room:leave", (callback = () => {}) => {
    const room = rooms.get(socket.roomId);
    if (room) removePlayer(room, socket.id);
    callback({ ok: true });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.roomId);
    if (room) removePlayer(room, socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("VORTEX API online na porta " + PORT);
});
