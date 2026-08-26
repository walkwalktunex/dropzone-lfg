import 'dotenv/config';
import express from 'express';
import http from 'http';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import crypto from 'crypto';

const { Pool } = pg;
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing. Add your Render Postgres Internal Database URL in the web service Environment settings.');
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 24) {
  throw new Error('SESSION_SECRET is missing or too short. Add a random secret of at least 24 characters in Render.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
const PgSession = connectPgSimple(session);
const sessionMiddleware = session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
});

app.use(express.json({ limit: '256kb' }));
app.use(sessionMiddleware);
app.use(express.static('public'));
io.engine.use(sessionMiddleware);

const PORT = Number(process.env.PORT || 10000);
const TURN_URLS = String(process.env.TURN_URLS || '').split(',').map(v => v.trim()).filter(Boolean);
const rtcConfig = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] },
    ...(TURN_URLS.length ? [{ urls: TURN_URLS, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' }] : [])
  ],
  iceCandidatePoolSize: 6
};

const guestUser = row => ({ id: row.id, username: row.username, role: row.role });
function cleanName(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_ -]/g, '').replace(/\s+/g, ' ').slice(0, 24);
}
function cleanText(value, max = 500) { return String(value || '').trim().slice(0, max); }
async function getUserById(id) { const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]); return rows[0] || null; }
async function getRoomById(id) { const { rows } = await pool.query('SELECT * FROM rooms WHERE id=$1', [id]); return rows[0] || null; }
function roomCount(id) { return io.sockets.adapter.rooms.get(`room:${id}`)?.size || 0; }
function publicRoom(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    maxPlayers: row.max_players,
    playerCount: roomCount(row.id),
    isPrivate: row.is_private,
    mode: row.mode,
    region: row.region,
    ownerId: row.owner_id,
    createdAt: row.created_at
  };
}
function isBanned(user) { return user?.banned_until && new Date(user.banned_until) > new Date(); }

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(32) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    banned_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Migration for databases created by earlier account-enabled versions.
  // Guests no longer use email/password, so legacy email/password columns
  // must not block the system guest account from being created.
  await pool.query(`
    ALTER TABLE users
      ALTER COLUMN email DROP NOT NULL
  `).catch(async (error) => {
    // PostgreSQL throws if the legacy column does not exist; that is safe to ignore.
    if (error.code !== '42703') throw error;
  });
  await pool.query(`
    ALTER TABLE users
      ALTER COLUMN password_hash DROP NOT NULL
  `).catch(async (error) => {
    if (error.code !== '42703') throw error;
  });
  await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
    id UUID PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(240) NOT NULL DEFAULT '',
    max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 64),
    is_private BOOLEAN NOT NULL DEFAULT FALSE,
    password_hash TEXT,
    mode VARCHAR(32) NOT NULL DEFAULT 'Battle Royale',
    region VARCHAR(32) NOT NULL DEFAULT 'NA-East',
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id BIGSERIAL PRIMARY KEY,
    reporter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,
    reason VARCHAR(80) NOT NULL,
    details VARCHAR(500) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rooms_created ON rooms(created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status)`);

  const system = await pool.query(`SELECT id FROM users WHERE role='system' LIMIT 1`);
  let systemId = system.rows[0]?.id;
  if (!systemId) {
    const r = await pool.query(`INSERT INTO users(username, role) VALUES('DropZone System','system') RETURNING id`);
    systemId = r.rows[0].id;
  }
  const general = await pool.query(`SELECT id FROM rooms WHERE is_system=true LIMIT 1`);
  if (!general.rows[0]) {
    await pool.query(`INSERT INTO rooms(id, owner_id, name, description, max_players, mode, region, is_system) VALUES($1,$2,'The Lobby','The always-open DropZone lobby.',64,'All Modes','Global',true)`, [crypto.randomUUID(), systemId]);
  }
}

function setUser(req, row) { req.session.user = guestUser(row); }
async function ensureGuest(req, res, next) {
  try {
    if (req.session.user) {
      const current = await getUserById(req.session.user.id);
      if (current && !isBanned(current)) return next();
      req.session.destroy(() => {});
    }
    let username = cleanName(req.headers['x-dropzone-name'] || req.body?.username);
    if (username.length < 3) username = `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
    const { rows } = await pool.query(`INSERT INTO users(username) VALUES($1) RETURNING *`, [username]);
    setUser(req, rows[0]);
    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not start a guest session.' });
  }
}
function requireModerator(req, res, next) {
  if (req.session.user?.role !== 'moderator') return res.status(403).json({ error: 'Moderator access required.' });
  next();
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});
app.get('/api/config', (_req, res) => res.json({ rtcConfig }));
app.get('/api/me', async (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const row = await getUserById(req.session.user.id);
  if (!row || isBanned(row)) return req.session.destroy(() => res.json({ user: null }));
  res.json({ user: guestUser(row) });
});
app.post('/api/guest', async (req, res) => {
  try {
    if (req.session.user) {
      const current = await getUserById(req.session.user.id);
      if (current && !isBanned(current)) return res.json({ user: guestUser(current) });
    }
    let username = cleanName(req.body?.username);
    if (username.length < 3) username = `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
    const { rows } = await pool.query(`INSERT INTO users(username) VALUES($1) RETURNING *`, [username]);
    setUser(req, rows[0]);
    res.json({ user: guestUser(rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not start your guest session.' }); }
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.post('/api/mod/session', async (req, res) => {
  const key = String(req.body?.key || '');
  if (!process.env.MODERATOR_KEY || key !== process.env.MODERATOR_KEY) return res.status(403).json({ error: 'Invalid moderator key.' });
  await ensureGuest(req, res, () => {});
  if (!req.session.user) return res.status(500).json({ error: 'Could not create moderator session.' });
  req.session.user.role = 'moderator';
  res.json({ user: req.session.user });
});

app.get('/api/rooms', async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM rooms ORDER BY is_system DESC, updated_at DESC LIMIT 100`);
  res.json({ rooms: rows.map(publicRoom) });
});
app.post('/api/rooms', ensureGuest, async (req, res) => {
  const name = cleanText(req.body?.name, 80);
  const description = cleanText(req.body?.description, 240);
  const maxPlayers = Number(req.body?.maxPlayers ?? 4);
  const isPrivate = Boolean(req.body?.isPrivate);
  const password = cleanText(req.body?.password, 120);
  const mode = cleanText(req.body?.mode || 'Battle Royale', 32) || 'Battle Royale';
  const region = cleanText(req.body?.region || 'NA-East', 32) || 'NA-East';
  if (name.length < 2) return res.status(400).json({ error: 'Give your room a name.' });
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 64) return res.status(400).json({ error: 'Player limit must be between 2 and 64.' });
  if (isPrivate && password.length < 4) return res.status(400).json({ error: 'Private rooms need a password with at least 4 characters.' });
  const id = crypto.randomUUID();
  const passwordHash = isPrivate ? await bcrypt.hash(password, 10) : null;
  const { rows } = await pool.query(`INSERT INTO rooms(id,owner_id,name,description,max_players,is_private,password_hash,mode,region) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id, req.session.user.id, name, description, maxPlayers, isPrivate, passwordHash, mode, region]);
  io.emit('rooms:update');
  res.status(201).json({ room: publicRoom(rows[0]) });
});
app.patch('/api/rooms/:id', ensureGuest, async (req, res) => {
  const room = await getRoomById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  if (room.is_system) return res.status(403).json({ error: 'The Lobby cannot be edited.' });
  if (room.owner_id !== req.session.user.id && req.session.user.role !== 'moderator') return res.status(403).json({ error: 'Only the room owner can edit this room.' });
  const maxPlayers = Number(req.body?.maxPlayers ?? room.max_players);
  if (!Number.isInteger(maxPlayers) || maxPlayers < roomCount(room.id) || maxPlayers > 64) return res.status(400).json({ error: 'Player limit is below the current player count or above 64.' });
  const name = cleanText(req.body?.name ?? room.name, 80);
  const description = cleanText(req.body?.description ?? room.description, 240);
  const mode = cleanText(req.body?.mode ?? room.mode, 32);
  const region = cleanText(req.body?.region ?? room.region, 32);
  if (name.length < 2) return res.status(400).json({ error: 'Room name is required.' });
  await pool.query(`UPDATE rooms SET name=$1, description=$2, max_players=$3, mode=$4, region=$5, updated_at=NOW() WHERE id=$6`, [name, description, maxPlayers, mode, region, room.id]);
  io.emit('rooms:update');
  res.json({ ok: true });
});
app.delete('/api/rooms/:id', ensureGuest, async (req, res) => {
  const room = await getRoomById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  if (room.is_system) return res.status(403).json({ error: 'The Lobby cannot be deleted.' });
  if (room.owner_id !== req.session.user.id && req.session.user.role !== 'moderator') return res.status(403).json({ error: 'Only the room owner can delete this room.' });
  await pool.query(`DELETE FROM rooms WHERE id=$1`, [room.id]);
  io.emit('room:deleted', room.id); io.emit('rooms:update');
  res.json({ ok: true });
});
app.post('/api/reports', ensureGuest, async (req, res) => {
  const roomId = req.body?.roomId ? String(req.body.roomId) : null;
  const targetUserId = req.body?.targetUserId ? Number(req.body.targetUserId) : null;
  const reason = cleanText(req.body?.reason || 'Other', 80);
  const details = cleanText(req.body?.details, 500);
  if (!roomId && !targetUserId) return res.status(400).json({ error: 'Choose a room or player to report.' });
  if (targetUserId && targetUserId === Number(req.session.user.id)) return res.status(400).json({ error: 'You cannot report yourself.' });
  await pool.query(`INSERT INTO reports(reporter_id,target_user_id,room_id,reason,details) VALUES($1,$2,$3,$4,$5)`, [req.session.user.id, targetUserId, roomId, reason, details]);
  res.status(201).json({ ok: true });
});
app.get('/api/mod/reports', requireModerator, async (_req, res) => {
  const { rows } = await pool.query(`SELECT r.*, u.username reporter, tu.username target_username, rm.name room_name FROM reports r JOIN users u ON u.id=r.reporter_id LEFT JOIN users tu ON tu.id=r.target_user_id LEFT JOIN rooms rm ON rm.id=r.room_id WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 200`);
  res.json({ reports: rows });
});
app.post('/api/mod/reports/:id/resolve', requireModerator, async (req, res) => { await pool.query(`UPDATE reports SET status='resolved', resolved_at=NOW() WHERE id=$1`, [req.params.id]); res.json({ ok: true }); });
app.post('/api/mod/users/:id/ban', requireModerator, async (req, res) => {
  const minutes = Math.max(1, Math.min(10080, Number(req.body?.minutes || 60)));
  await pool.query(`UPDATE users SET banned_until=NOW()+($1 * INTERVAL '1 minute') WHERE id=$2`, [minutes, req.params.id]);
  res.json({ ok: true });
});

io.use((socket, next) => { if (!socket.request.session?.user) return next(new Error('Guest session required')); next(); });
const membership = new Map();
const lastChat = new Map();

io.on('connection', socket => {
  const user = socket.request.session.user;
  socket.emit('rtc:config', rtcConfig);
  socket.emit('user:me', user);

  socket.on('room:join', async ({ roomId, password }) => {
    try {
      const room = await getRoomById(roomId);
      if (!room) return socket.emit('room:error', 'That room no longer exists.');
      const dbUser = await getUserById(user.id);
      if (isBanned(dbUser)) return socket.emit('room:error', 'You are temporarily banned.');
      const prior = membership.get(socket.id);
      if (prior === room.id) return socket.emit('room:joined', publicRoom(room));
      if (prior) await leaveCurrent(socket);
      if (roomCount(room.id) >= room.max_players) return socket.emit('room:error', 'That room is full.');
      if (room.is_private && !(await bcrypt.compare(String(password || ''), room.password_hash || ''))) return socket.emit('room:error', 'Incorrect room password.');
      socket.join(`room:${room.id}`);
      membership.set(socket.id, room.id);
      socket.emit('room:joined', publicRoom(room));
      io.to(`room:${room.id}`).emit('room:presence', listRoomUsers(room.id));
      io.emit('rooms:update');
    } catch (e) { console.error(e); socket.emit('room:error', 'Could not join this room.'); }
  });

  socket.on('room:leave', () => leaveCurrent(socket));
  socket.on('chat:send', ({ text }) => {
    const roomId = membership.get(socket.id);
    const clean = cleanText(text, 500);
    if (!roomId || !clean) return;
    const now = Date.now();
    const prev = lastChat.get(socket.id) || 0;
    if (now - prev < 600) return;
    lastChat.set(socket.id, now);
    io.to(`room:${roomId}`).emit('chat:message', { id: crypto.randomUUID(), username: user.username, userId: user.id, text: clean, at: new Date().toISOString() });
  });
  socket.on('voice:ready', () => { const roomId = membership.get(socket.id); if (roomId) socket.to(`room:${roomId}`).emit('voice:peer', { id: socket.id, username: user.username }); });
  socket.on('voice:leave', () => { const roomId = membership.get(socket.id); if (roomId) socket.to(`room:${roomId}`).emit('voice:peer-left', socket.id); });
  socket.on('voice:signal', ({ to, data }) => { if (to) io.to(to).emit('voice:signal', { from: socket.id, data }); });
  socket.on('disconnect', () => { leaveCurrent(socket).catch(console.error); });
});

async function leaveCurrent(socket) {
  const roomId = membership.get(socket.id);
  if (!roomId) return;
  membership.delete(socket.id);
  socket.leave(`room:${roomId}`);
  const room = await getRoomById(roomId);
  if (!room) return;
  const count = roomCount(roomId);
  io.to(`room:${roomId}`).emit('room:presence', listRoomUsers(roomId));
  io.emit('rooms:update');
  if (count === 0 && !room.is_system) {
    await pool.query(`DELETE FROM rooms WHERE id=$1`, [roomId]);
    io.emit('room:deleted', roomId);
    io.emit('rooms:update');
  }
}
function listRoomUsers(roomId) {
  const ids = [...(io.sockets.adapter.rooms.get(`room:${roomId}`) || [])];
  return ids.map(id => {
    const s = io.sockets.sockets.get(id);
    if (!s) return null;
    const u = s.request.session.user;
    return { socketId: id, userId: u.id, username: u.username, role: u.role };
  }).filter(Boolean);
}

async function start() {
  await initDb();
  server.listen(PORT, '0.0.0.0', () => console.log(`DropZone running on ${PORT}`));
}
start().catch(error => { console.error(error); process.exit(1); });
