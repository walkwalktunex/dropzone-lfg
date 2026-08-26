const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

const clean = (value, max, fallback) => String(value || fallback).trim().slice(0, max) || fallback;
const roomInfo = (name, room) => ({
  name,
  ownerId: room.ownerId,
  ownerName: room.ownerName,
  users: room.users.size,
  locked: room.users.size === 0
});

function publicRooms() {
  return [...rooms.entries()].map(([name, room]) => roomInfo(name, room));
}

function broadcastRooms() {
  io.emit('rooms-list', { rooms: publicRooms() });
}

function deleteRoom(roomName, reason = 'deleted') {
  const room = rooms.get(roomName);
  if (!room) return;
  for (const socketId of room.users.keys()) {
    const s = io.sockets.sockets.get(socketId);
    if (s) {
      s.leave(roomName);
      s.emit('room-deleted', { room: roomName, reason });
      delete s.data.room;
    }
  }
  rooms.delete(roomName);
  broadcastRooms();
}

function leaveCurrentRoom(socket) {
  const roomName = socket.data.room;
  if (!roomName) return;
  const room = rooms.get(roomName);
  if (!room) { delete socket.data.room; return; }
  room.users.delete(socket.id);
  socket.leave(roomName);
  socket.to(roomName).emit('user-left', { id: socket.id });
  delete socket.data.room;
  if (room.users.size === 0 && roomName !== 'general') {
    deleteRoom(roomName, 'empty');
  } else {
    io.to(roomName).emit('room-users', { users: [...room.users.values()] });
    broadcastRooms();
  }
}

// Default public room.
rooms.set('general', { ownerId: null, ownerName: 'DropZone', users: new Map() });

io.on('connection', (socket) => {
  socket.on('request-rooms', () => socket.emit('rooms-list', { rooms: publicRooms() }));

  socket.on('create-room', ({ room, username }) => {
    const name = clean(room, 40, '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
    const ownerName = clean(username, 20, 'Player');
    if (!name) return socket.emit('room-error', { message: 'Give the room a name.' });
    if (rooms.has(name)) return socket.emit('room-error', { message: 'That room already exists.' });
    rooms.set(name, { ownerId: socket.id, ownerName, users: new Map() });
    broadcastRooms();
    socket.emit('room-created', { room: name });
  });

  socket.on('delete-room', ({ room }) => {
    if (!room || room === 'general') return socket.emit('room-error', { message: 'The General room cannot be deleted.' });
    const data = rooms.get(room);
    if (!data) return;
    if (data.ownerId !== socket.id) return socket.emit('room-error', { message: 'Only the room owner can delete this room.' });
    deleteRoom(room, 'owner-deleted');
  });

  socket.on('join-room', ({ room, username }) => {
    const name = clean(room, 40, 'general').toLowerCase();
    const userName = clean(username, 20, 'Player');
    const target = rooms.get(name);
    if (!target) return socket.emit('room-error', { message: 'That room no longer exists.' });

    leaveCurrentRoom(socket);
    target.users.set(socket.id, { id: socket.id, username: userName });
    socket.join(name);
    socket.data.room = name;
    socket.data.username = userName;
    socket.emit('room-state', { room: name, ownerId: target.ownerId, ownerName: target.ownerName, users: [...target.users.values()] });
    socket.to(name).emit('user-joined', { id: socket.id, username: userName });
    io.to(name).emit('room-users', { users: [...target.users.values()] });
    broadcastRooms();
  });

  socket.on('chat-message', ({ room, message }) => {
    if (socket.data.room !== room || !message?.trim()) return;
    io.to(room).emit('chat-message', {
      username: socket.data.username,
      message: message.trim().slice(0, 500),
      time: Date.now()
    });
  });

  socket.on('webrtc-offer', ({ to, offer }) => io.to(to).emit('webrtc-offer', { from: socket.id, offer }));
  socket.on('webrtc-answer', ({ to, answer }) => io.to(to).emit('webrtc-answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  socket.on('leave-room', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`DropZone is running at http://localhost:${port}`));
