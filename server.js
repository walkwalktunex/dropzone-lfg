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
const server = http.createServer(app);
const io = new Server(server);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } });
const PgSession = connectPgSimple(session);

const sessionMiddleware = session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-only-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 30 }
});
app.use(express.json({ limit: '256kb' }));
app.use(sessionMiddleware);
app.use(express.static('public'));
io.engine.use(sessionMiddleware);

const PORT = Number(process.env.PORT || 10000);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const turnUrls = (process.env.TURN_URLS || '').split(',').map(v => v.trim()).filter(Boolean);
const rtcConfig = { iceServers: [] };
if (turnUrls.length) rtcConfig.iceServers.push({ urls: turnUrls, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
rtcConfig.iceServers.push({ urls: ['stun:stun.l.google.com:19302'] });

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(32) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    banned_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
    id UUID PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(240) NOT NULL DEFAULT '',
    max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 64),
    is_private BOOLEAN NOT NULL DEFAULT FALSE,
    password_hash TEXT,
    mode VARCHAR(32) NOT NULL DEFAULT 'Battle Royale',
    region VARCHAR(32) NOT NULL DEFAULT 'NA-West',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
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
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);`);
}

function userSafe(row) { return { id: row.id, username: row.username, role: row.role }; }
function publicRoom(row, playerCount = 0) {
  return { id: row.id, name: row.name, description: row.description, maxPlayers: row.max_players, playerCount, isPrivate: row.is_private, mode: row.mode, region: row.region, ownerId: row.owner_id, createdAt: row.created_at };
}
async function ensureGuest(req, res, next) {
  if (req.session.user) return next();
  try {
    let base = String(req.headers['x-dropzone-name'] || req.body?.username || '').trim().replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 24);
    if (!base || base.length < 3) base = 'Guest-' + Math.floor(1000 + Math.random() * 9000);
    let username = base;
    for (let i = 0; i < 8; i++) {
      try {
        const email = `guest-${crypto.randomUUID()}@local.invalid`;
        const passwordHash = await bcrypt.hash(crypto.randomUUID(), 10);
        const { rows } = await pool.query(
          'INSERT INTO users(username,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING *',
          [username, email, passwordHash, 'user']
        );
        req.session.user = userSafe(rows[0]);
        return next();
      } catch (e) {
        if (e.code !== '23505') throw e;
        username = (base.slice(0, 19) + '-' + Math.floor(100 + Math.random() * 900)).slice(0, 24);
      }
    }
    return res.status(500).json({ error: 'Could not create a guest session.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Could not start a guest session.' });
  }
}
function requireAdmin(req, res, next) { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Moderator access required.' }); next(); }
async function getUserById(id) { const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]); return rows[0]; }
async function getRoom(id) { const { rows } = await pool.query('SELECT * FROM rooms WHERE id=$1', [id]); return rows[0]; }

app.get('/api/config', (req,res)=>res.json({ rtcConfig }));
app.post('/api/guest', async (req,res)=> {
  try {
    let username = String(req.body.username || '').trim().replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 24);
    if (!username) username = 'Guest-' + Math.floor(1000 + Math.random() * 9000);
    if (username.length < 3) username = 'Guest-' + Math.floor(1000 + Math.random() * 9000);
    const email = `guest-${crypto.randomUUID()}@local.invalid`;
    const passwordHash = await bcrypt.hash(crypto.randomUUID(), 10);
    const { rows } = await pool.query(
      'INSERT INTO users(username,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING *',
      [username, email, passwordHash, 'user']
    );
    req.session.user = userSafe(rows[0]);
    res.json({ user: req.session.user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not start a guest session.' });
  }
});

app.get('/api/me', async (req,res)=> {
  if (!req.session.user) return res.json({ user:null });
  const row = await getUserById(req.session.user.id);
  if (!row) { req.session.destroy(()=>{}); return res.json({ user:null }); }
  const banned = row.banned_until && new Date(row.banned_until) > new Date();
  if (banned) return res.status(403).json({ error:'Account temporarily banned until '+new Date(row.banned_until).toISOString() });
  res.json({ user:userSafe(row) });
});

app.post('/api/register', async (req,res)=> {
  try {
    const username = String(req.body.username||'').trim();
    const email = String(req.body.email||'').trim().toLowerCase();
    const password = String(req.body.password||'');
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) return res.status(400).json({error:'Username must be 3-32 letters, numbers, or underscores.'});
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({error:'Enter a valid email.'});
    if (password.length < 8) return res.status(400).json({error:'Password must be at least 8 characters.'});
    const passwordHash = await bcrypt.hash(password, 12);
    const role = email === ADMIN_EMAIL && ADMIN_EMAIL ? 'admin' : 'user';
    const { rows } = await pool.query('INSERT INTO users(username,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING *', [username,email,passwordHash,role]);
    req.session.user = userSafe(rows[0]);
    res.json({ user:req.session.user });
  } catch (e) { if (e.code === '23505') return res.status(409).json({error:'Username or email is already in use.'}); console.error(e); res.status(500).json({error:'Registration failed.'}); }
});

app.post('/api/login', async (req,res)=> {
  const email = String(req.body.email||'').trim().toLowerCase();
  const password = String(req.body.password||'');
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  const row = rows[0];
  if (!row || !(await bcrypt.compare(password,row.password_hash))) return res.status(401).json({error:'Invalid email or password.'});
  if (row.banned_until && new Date(row.banned_until) > new Date()) return res.status(403).json({error:'Your account is temporarily banned.'});
  req.session.user = userSafe(row); res.json({ user:req.session.user });
});
app.post('/api/logout', (req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get('/api/rooms', async (req,res)=> {
  const { rows } = await pool.query('SELECT * FROM rooms ORDER BY created_at DESC LIMIT 100');
  const counts = await Promise.all(rows.map(async r => [r.id, io.sockets.adapter.rooms.get(`room:${r.id}`)?.size || 0]));
  const countMap = new Map(counts);
  res.json({ rooms: rows.map(r=>publicRoom(r,countMap.get(r.id)||0)) });
});

app.post('/api/rooms', ensureGuest, async (req,res)=> {
  const name = String(req.body.name||'').trim();
  const description = String(req.body.description||'').trim().slice(0,240);
  const maxPlayers = Number(req.body.maxPlayers||4);
  const isPrivate = Boolean(req.body.isPrivate);
  const password = String(req.body.password||'');
  const mode = String(req.body.mode||'Battle Royale').slice(0,32);
  const region = String(req.body.region||'NA-West').slice(0,32);
  if (!name || name.length > 80) return res.status(400).json({error:'Room name is required and must be 80 characters or less.'});
  if (!Number.isInteger(maxPlayers) || maxPlayers<2 || maxPlayers>64) return res.status(400).json({error:'Player limit must be 2-64.'});
  if (isPrivate && password.length < 4) return res.status(400).json({error:'Private rooms need a password of at least 4 characters.'});
  const id = crypto.randomUUID(); const passwordHash = isPrivate ? await bcrypt.hash(password,12) : null;
  const { rows } = await pool.query('INSERT INTO rooms(id,owner_id,name,description,max_players,is_private,password_hash,mode,region) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [id,req.session.user.id,name,description,maxPlayers,isPrivate,passwordHash,mode,region]);
  res.json({ room: publicRoom(rows[0],0) });
  io.emit('rooms:update');
});

app.patch('/api/rooms/:id', ensureGuest, async (req,res)=> {
  const room = await getRoom(req.params.id); if (!room) return res.status(404).json({error:'Room not found.'});
  if (room.owner_id !== req.session.user.id && req.session.user.role !== 'admin') return res.status(403).json({error:'Only the room owner or moderator can edit this room.'});
  const name = String(req.body.name ?? room.name).trim().slice(0,80);
  const description = String(req.body.description ?? room.description).trim().slice(0,240);
  const maxPlayers = Number(req.body.maxPlayers ?? room.max_players);
  const mode = String(req.body.mode ?? room.mode).slice(0,32);
  const region = String(req.body.region ?? room.region).slice(0,32);
  if (!Number.isInteger(maxPlayers) || maxPlayers<2 || maxPlayers>64) return res.status(400).json({error:'Player limit must be 2-64.'});
  const count = io.sockets.adapter.rooms.get(`room:${room.id}`)?.size || 0; if (maxPlayers < count) return res.status(400).json({error:'Player limit cannot be below the current player count.'});
  await pool.query('UPDATE rooms SET name=$1,description=$2,max_players=$3,mode=$4,region=$5,updated_at=NOW() WHERE id=$6',[name,description,maxPlayers,mode,region,room.id]);
  io.emit('rooms:update'); res.json({ok:true});
});

app.delete('/api/rooms/:id', ensureGuest, async (req,res)=> {
  const room = await getRoom(req.params.id); if (!room) return res.status(404).json({error:'Room not found.'});
  if (room.owner_id !== req.session.user.id && req.session.user.role !== 'admin') return res.status(403).json({error:'Only the room owner or moderator can delete this room.'});
  await pool.query('DELETE FROM rooms WHERE id=$1',[room.id]);
  io.emit('room:deleted', room.id); io.emit('rooms:update'); res.json({ok:true});
});

app.post('/api/reports', ensureGuest, async (req,res)=> {
  const targetUserId = req.body.targetUserId ? Number(req.body.targetUserId) : null;
  const roomId = req.body.roomId ? String(req.body.roomId) : null;
  const reason = String(req.body.reason||'Other').slice(0,80);
  const details = String(req.body.details||'').slice(0,500);
  if (targetUserId === req.session.user.id) return res.status(400).json({error:'You cannot report yourself.'});
  await pool.query('INSERT INTO reports(reporter_id,target_user_id,room_id,reason,details) VALUES($1,$2,$3,$4,$5)',[req.session.user.id,targetUserId,roomId,reason,details]);
  res.json({ok:true});
});
app.get('/api/mod/reports', requireAdmin, async (req,res)=> {
  const { rows } = await pool.query(`SELECT r.*, u.username reporter, tu.username target_username FROM reports r JOIN users u ON u.id=r.reporter_id LEFT JOIN users tu ON tu.id=r.target_user_id WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 200`);
  res.json({reports:rows});
});
app.post('/api/mod/reports/:id/resolve', requireAdmin, async (req,res)=> { await pool.query("UPDATE reports SET status='resolved',resolved_at=NOW() WHERE id=$1",[req.params.id]); res.json({ok:true}); });
app.post('/api/mod/users/:id/ban', requireAdmin, async (req,res)=> { const minutes=Math.max(1,Math.min(10080,Number(req.body.minutes||60))); await pool.query('UPDATE users SET banned_until=NOW()+($1 * INTERVAL \'1 minute\') WHERE id=$2',[minutes,req.params.id]); res.json({ok:true}); });

io.use((socket,next)=>{ if (!socket.request.session?.user) return next(new Error('Unauthorized')); next(); });
const membership = new Map();

io.on('connection', socket=> {
  const user = socket.request.session.user;
  socket.emit('rtc:config', rtcConfig);
  socket.emit('user:me', user);
  socket.on('room:join', async ({roomId,password})=> {
    try {
      const room = await getRoom(roomId); if (!room) return socket.emit('room:error','Room no longer exists.');
      const bannedUser = await getUserById(user.id); if (bannedUser?.banned_until && new Date(bannedUser.banned_until)>new Date()) return socket.emit('room:error','Your account is banned.');
      const channel = `room:${room.id}`; const existing = io.sockets.adapter.rooms.get(channel)?.size || 0;
      if (existing >= room.max_players) return socket.emit('room:error','This room is full.');
      if (room.is_private && !(await bcrypt.compare(String(password||''),room.password_hash||''))) return socket.emit('room:error','Incorrect room password.');
      const prior = membership.get(socket.id); if (prior) socket.leave(`room:${prior}`);
      socket.join(channel); membership.set(socket.id,room.id);
      socket.emit('room:joined', publicRoom(room, (io.sockets.adapter.rooms.get(channel)?.size||0)));
      io.to(channel).emit('room:presence', listRoomUsers(room.id));
    } catch (e) { console.error(e); socket.emit('room:error','Unable to join room.'); }
  });
  socket.on('room:leave', async ()=>leaveCurrent(socket));
  socket.on('chat:send', ({text})=> { const roomId = membership.get(socket.id); const clean=String(text||'').trim().slice(0,500); if(!roomId||!clean)return; io.to(`room:${roomId}`).emit('chat:message',{id:crypto.randomUUID(),username:user.username,userId:user.id,text:clean,at:new Date().toISOString()}); });
  socket.on('voice:signal', ({to, data})=> { if (to) io.to(to).emit('voice:signal',{from:socket.id,data}); });
  socket.on('voice:ready', ()=> { const roomId=membership.get(socket.id); if(roomId) socket.to(`room:${roomId}`).emit('voice:peer', {id:socket.id,username:user.username}); });
  socket.on('voice:leave', ()=> { const roomId=membership.get(socket.id); if(roomId) socket.to(`room:${roomId}`).emit('voice:peer-left',socket.id); });
  socket.on('disconnect',()=>leaveCurrent(socket));
});

async function leaveCurrent(socket){ const roomId=membership.get(socket.id); if(!roomId)return; membership.delete(socket.id); socket.leave(`room:${roomId}`); const channel=`room:${roomId}`; const room=await getRoom(roomId); if(room){ const count=io.sockets.adapter.rooms.get(channel)?.size||0; io.to(channel).emit('room:presence',listRoomUsers(roomId)); if(count===0 && room.name !== 'General') { await pool.query('DELETE FROM rooms WHERE id=$1',[roomId]); io.emit('room:deleted',roomId); io.emit('rooms:update'); }} }
function listRoomUsers(roomId){ const channel=`room:${roomId}`; const ids=[...(io.sockets.adapter.rooms.get(channel)||[])]; return ids.map(id=>{const s=io.sockets.sockets.get(id); return s ? {socketId:id,userId:s.request.session.user.id,username:s.request.session.user.username,role:s.request.session.user.role} : null}).filter(Boolean); }

async function start(){
  await initDb();
  server.listen(PORT,'0.0.0.0',()=>console.log(`DropZone LFG running on port ${PORT}`));
}
start().catch(err=>{console.error(err);process.exit(1);});
