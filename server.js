const express = require("express");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

// ── Security headers ──
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "connect-src 'self' wss: ws:; " +
    "media-src *; " +
    "img-src 'self' data:;"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// ── Strict CORS: only allow same-origin and Tailscale ──
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      // Allow no-origin (same-origin requests) and localhost/tailscale ranges
      if (!origin) return cb(null, true);
      const allowed = /^https?:\/\/(localhost|127\.0\.0\.1|100\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin);
      cb(allowed ? null : new Error("Origin not allowed"), allowed);
    },
    methods: ["GET", "POST"],
  },
});

// ── Constants ──
const MAX_NAME_LEN    = 24;
const MAX_ROOM_NAME   = 32;
const MAX_MSG_LEN     = 500;
const MAX_ROOMS       = 50;
const MAX_USERS_ROOM  = 20;
const RATE_WINDOW_MS  = 5000;
const RATE_MAX_EVENTS = 30; // max events per socket per 5s window

// ── Input sanitisation ──
function sanitiseName(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s || s.length > MAX_NAME_LEN) return null;
  // Block prototype pollution keys
  if (["__proto__", "constructor", "prototype", "toString", "valueOf"].includes(s)) return null;
  return s;
}

function sanitiseRoomName(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s || s.length > MAX_ROOM_NAME) return null;
  if (["__proto__", "constructor", "prototype", "toString", "valueOf"].includes(s)) return null;
  return s;
}

function sanitiseText(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > MAX_MSG_LEN) return null;
  return s;
}

// ── Persistent channels ──
const CHANNELS_FILE = path.join(__dirname, "channels.json");

function loadChannels() {
  try {
    if (!fs.existsSync(CHANNELS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
    if (!Array.isArray(raw)) return [];
    // Sanitise every name on load
    return raw
      .map(n => sanitiseRoomName(n))
      .filter(Boolean)
      .slice(0, MAX_ROOMS);
  } catch (e) {
    console.error("Failed to load channels:", e.message);
    return [];
  }
}

function saveChannels() {
  try {
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(Object.keys(rooms), null, 2));
  } catch (e) {
    console.error("Failed to save channels:", e.message);
  }
}

// ── State ──
// rooms: Map<roomId, { users: Map<socketId, userObj>, messages: [], owner: string|null }>
const rooms = Object.create(null); // null prototype prevents prototype pollution
const typingUsers = Object.create(null);

for (const name of loadChannels()) {
  rooms[name] = { users: new Map(), messages: [], owner: null };
  typingUsers[name] = new Set();
}
console.log(`[~] Loaded ${Object.keys(rooms).length} channel(s):`, Object.keys(rooms));

function getRoomList() {
  return Object.entries(rooms).map(([id, room]) => ({
    id, name: id, count: room.users.size,
    users: Array.from(room.users.values()),
    owner: room.owner,
  }));
}

function getRoomUsers(roomId) {
  const room = rooms[roomId];
  if (!room) return [];
  return Array.from(room.users.values());
}

// ── Per-socket rate limiter ──
function makeRateLimiter() {
  let count = 0, resetAt = Date.now() + RATE_WINDOW_MS;
  return function check() {
    const now = Date.now();
    if (now > resetAt) { count = 0; resetAt = now + RATE_WINDOW_MS; }
    return ++count <= RATE_MAX_EVENTS;
  };
}

// ── Connection handler ──
io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);
  socket.emit("room-list", getRoomList());

  const rateCheck = makeRateLimiter();

  // Middleware: rate-limit and validate every event
  const guard = (fn) => (...args) => {
    if (!rateCheck()) {
      console.warn(`[!] Rate limit exceeded: ${socket.id}`);
      socket.emit("error-msg", "Too many requests — slow down.");
      return;
    }
    try { fn(...args); } catch (e) { console.error("Handler error:", e.message); }
  };

  // ── Create room ──
  socket.on("create-room", guard(({ roomName }, cb) => {
    if (typeof cb !== "function") return;
    const name = sanitiseRoomName(roomName);
    if (!name) return cb({ error: "Invalid channel name" });
    if (rooms[name]) return cb({ error: "Channel already exists" });
    if (Object.keys(rooms).length >= MAX_ROOMS) return cb({ error: "Maximum channels reached" });

    rooms[name] = { users: new Map(), messages: [], owner: null };
    typingUsers[name] = new Set();
    saveChannels();
    io.emit("room-list", getRoomList());
    cb({ ok: true });
  }));

  // ── Join room ──
  socket.on("join-room", guard(({ roomId, userName }) => {
    const cleanRoom = sanitiseRoomName(roomId);
    const cleanName = sanitiseName(userName);
    if (!cleanRoom || !cleanName) return;

    if (socket.currentRoom) leaveRoom(socket);

    if (!rooms[cleanRoom]) {
      if (Object.keys(rooms).length >= MAX_ROOMS) return;
      rooms[cleanRoom] = { users: new Map(), messages: [], owner: null };
      typingUsers[cleanRoom] = new Set();
    }
    if (!typingUsers[cleanRoom]) typingUsers[cleanRoom] = new Set();

    const room = rooms[cleanRoom];
    if (room.users.size >= MAX_USERS_ROOM) return;

    const existingUsers = Array.from(room.users.keys());
    if (!room.owner) room.owner = cleanName;

    room.users.set(socket.id, { name: cleanName, muted: false, socketId: socket.id });
    socket.currentRoom = cleanRoom;
    socket.userName = cleanName;
    socket.join(cleanRoom);

    socket.emit("room-joined", {
      roomId: cleanRoom,
      peers: existingUsers,
      users: getRoomUsers(cleanRoom),
      messages: room.messages.slice(-50),
      owner: room.owner,
    });

    socket.to(cleanRoom).emit("user-joined", {
      socketId: socket.id, name: cleanName,
      users: getRoomUsers(cleanRoom),
      owner: room.owner,
    });

    io.emit("room-list", getRoomList());
    console.log(`[~] ${cleanName} joined: ${cleanRoom}`);
  }));

  // ── Chat message ──
  socket.on("chat-message", guard(({ text }) => {
    if (!socket.currentRoom || !rooms[socket.currentRoom]) return;
    const cleanText = sanitiseText(text);
    if (!cleanText) return;

    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      socketId: socket.id,
      name: socket.userName,
      text: cleanText,
      ts: Date.now(),
    };

    rooms[socket.currentRoom].messages.push(msg);
    if (rooms[socket.currentRoom].messages.length > 200)
      rooms[socket.currentRoom].messages.shift();

    if (typingUsers[socket.currentRoom])
      typingUsers[socket.currentRoom].delete(socket.userName);

    io.to(socket.currentRoom).emit("chat-message", msg);
    io.to(socket.currentRoom).emit("typing-update", {
      users: Array.from(typingUsers[socket.currentRoom] || [])
    });
  }));

  // ── Typing ──
  socket.on("typing", guard(({ isTyping }) => {
    if (!socket.currentRoom || !typingUsers[socket.currentRoom]) return;
    if (typeof isTyping !== "boolean") return;
    if (isTyping) typingUsers[socket.currentRoom].add(socket.userName);
    else typingUsers[socket.currentRoom].delete(socket.userName);
    socket.to(socket.currentRoom).emit("typing-update", {
      users: Array.from(typingUsers[socket.currentRoom]).filter(n => n !== socket.userName)
    });
  }));

  // ── Kick user (owner only) ──
  socket.on("kick-user", guard(({ targetSocketId }, cb) => {
    if (typeof cb !== "function") return;
    const roomId = socket.currentRoom;
    if (!roomId || !rooms[roomId]) return cb({ error: "Not in a room" });
    if (rooms[roomId].owner !== socket.userName) return cb({ error: "Not authorised" });
    if (typeof targetSocketId !== "string") return cb({ error: "Invalid target" });
    if (targetSocketId === socket.id) return cb({ error: "Cannot kick yourself" });

    // Verify target is actually in the same room
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket || targetSocket.currentRoom !== roomId) return cb({ error: "User not found in this channel" });

    const targetName = targetSocket.userName;
    targetSocket.emit("kicked", { roomId, by: socket.userName });
    leaveRoom(targetSocket);
    io.to(roomId).emit("user-kicked", {
      name: targetName,
      users: getRoomUsers(roomId),
      owner: rooms[roomId]?.owner,
    });
    cb({ ok: true });
  }));

  // ── Rename channel (owner only) ──
  socket.on("rename-channel", guard(({ roomId, newName }, cb) => {
    if (typeof cb !== "function") return;
    const cleanOld = sanitiseRoomName(roomId);
    const cleanNew = sanitiseRoomName(newName);
    if (!cleanOld || !cleanNew) return cb({ error: "Invalid name" });
    if (!rooms[cleanOld]) return cb({ error: "Channel not found" });
    if (rooms[cleanOld].owner !== socket.userName) return cb({ error: "Not authorised" });
    if (cleanOld === cleanNew) return cb({ error: "Name is the same" });
    if (rooms[cleanNew]) return cb({ error: "Name already taken" });

    rooms[cleanNew] = { ...rooms[cleanOld], users: rooms[cleanOld].users, messages: rooms[cleanOld].messages };
    delete rooms[cleanOld];
    if (typingUsers[cleanOld]) {
      typingUsers[cleanNew] = typingUsers[cleanOld];
      delete typingUsers[cleanOld];
    }

    for (const [, s] of io.sockets.sockets) {
      if (s.currentRoom === cleanOld) s.currentRoom = cleanNew;
    }

    saveChannels();
    io.emit("room-list", getRoomList());
    io.to(cleanNew).emit("channel-renamed", { oldId: cleanOld, newId: cleanNew });
    cb({ ok: true });
  }));

  // ── Delete channel (owner only) ──
  socket.on("delete-channel", guard(({ roomId }, cb) => {
    if (typeof cb !== "function") return;
    const cleanRoom = sanitiseRoomName(roomId);
    if (!cleanRoom) return cb({ error: "Invalid channel name" });
    if (!rooms[cleanRoom]) return cb({ error: "Channel not found" });
    if (rooms[cleanRoom].owner !== socket.userName) return cb({ error: "Not authorised" });

    io.to(cleanRoom).emit("channel-deleted", { roomId: cleanRoom });
    delete rooms[cleanRoom];
    if (typingUsers[cleanRoom]) delete typingUsers[cleanRoom];
    saveChannels();
    io.emit("room-list", getRoomList());
    cb({ ok: true });
  }));

  // ── WebRTC signaling — room membership enforced ──
  socket.on("offer", guard(({ to, offer }) => {
    if (typeof to !== "string" || !offer || typeof offer !== "object") return;
    const targetSocket = io.sockets.sockets.get(to);
    // Only relay if both sockets are in the same room
    if (!targetSocket || targetSocket.currentRoom !== socket.currentRoom) return;
    io.to(to).emit("offer", { from: socket.id, offer });
  }));

  socket.on("answer", guard(({ to, answer }) => {
    if (typeof to !== "string" || !answer || typeof answer !== "object") return;
    const targetSocket = io.sockets.sockets.get(to);
    if (!targetSocket || targetSocket.currentRoom !== socket.currentRoom) return;
    io.to(to).emit("answer", { from: socket.id, answer });
  }));

  socket.on("ice-candidate", guard(({ to, candidate }) => {
    if (typeof to !== "string") return;
    const targetSocket = io.sockets.sockets.get(to);
    if (!targetSocket || targetSocket.currentRoom !== socket.currentRoom) return;
    io.to(to).emit("ice-candidate", { from: socket.id, candidate });
  }));

  // ── Mute ──
  socket.on("toggle-mute", guard(({ muted }) => {
    if (!socket.currentRoom || !rooms[socket.currentRoom]) return;
    if (typeof muted !== "boolean") return;
    const user = rooms[socket.currentRoom].users.get(socket.id);
    if (user) {
      user.muted = muted;
      io.to(socket.currentRoom).emit("user-muted", {
        socketId: socket.id, muted,
        users: getRoomUsers(socket.currentRoom),
      });
    }
  }));

  // ── Leave / disconnect ──
  socket.on("leave-room", guard(() => leaveRoom(socket)));
  socket.on("disconnect", () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    leaveRoom(socket);
  });

  function leaveRoom(socket) {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const leavingName = socket.userName;
    room.users.delete(socket.id);

    if (typingUsers[roomId]) {
      typingUsers[roomId].delete(leavingName);
      socket.to(roomId).emit("typing-update", { users: Array.from(typingUsers[roomId]) });
    }

    if (room.owner === leavingName && room.users.size > 0) {
      const nextUser = Array.from(room.users.values())[0];
      room.owner = nextUser.name;
      io.to(roomId).emit("owner-changed", { owner: room.owner, users: getRoomUsers(roomId) });
    } else if (room.users.size === 0) {
      room.owner = null;
    }

    socket.leave(roomId);
    socket.currentRoom = null;

    if (room.users.size > 0) {
      socket.to(roomId).emit("user-left", {
        socketId: socket.id,
        users: getRoomUsers(roomId),
        owner: room.owner,
      });
    }
    io.emit("room-list", getRoomList());
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎙  Squawk running on http://0.0.0.0:${PORT}\n`);
});