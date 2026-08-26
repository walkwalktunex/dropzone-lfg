const socket = io();
let username = localStorage.getItem('dz-name') || prompt('Choose your player name') || 'Player';
username = username.trim().slice(0, 20) || 'Player';
localStorage.setItem('dz-name', username);
let currentRoom = 'general';
let currentOwnerId = null;
let inVoice = false;
const peers = new Map();
let localStream = null;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function addMsg(u, m, t = Date.now()) {
  const d = document.createElement('div');
  d.className = 'msg';
  d.innerHTML = `<b>${esc(u)}</b><time>${new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time><p>${esc(m)}</p>`;
  $('messages').appendChild(d);
  $('messages').scrollTop = $('messages').scrollHeight;
}
function addSystem(m) {
  const d = document.createElement('div');
  d.className = 'system'; d.textContent = m; $('messages').appendChild(d);
}
function renderPeople(users) {
  $('people').innerHTML = '';
  users.forEach(u => {
    const d = document.createElement('div'); d.className = 'person'; d.dataset.id = u.id;
    d.innerHTML = `<div class="avatar">${esc(u.username[0]?.toUpperCase() || '?')}</div><div><b>${esc(u.username)}</b><small>${u.id === socket.id ? 'You' : 'In room'}</small></div>`;
    $('people').appendChild(d);
  });
  $('count').textContent = users.length;
}
function renderRooms(list) {
  $('rooms').innerHTML = '';
  list.forEach(r => {
    const card = document.createElement('div');
    card.className = 'room-card' + (r.name === currentRoom ? ' active' : '');
    card.dataset.room = r.name;
    card.innerHTML = `<button class="room" title="Join ${esc(r.name)}"><span class="room-dot"></span><div class="room-main"><strong>${esc(r.name)}</strong><small>${r.users} ${r.users === 1 ? 'player' : 'players'} · ${esc(r.ownerName || 'Public')}</small></div></button>${r.ownerId === socket.id ? `<button class="room-delete" title="Delete room">×</button>` : ''}`;
    card.querySelector('.room').onclick = () => joinRoom(r.name);
    card.querySelector('.room-delete')?.addEventListener('click', e => { e.stopPropagation(); if (confirm(`Delete #${r.name}?`)) socket.emit('delete-room', { room: r.name }); });
    $('rooms').appendChild(card);
  });
  if (!list.some(r => r.name === currentRoom)) joinRoom('general');
}
function joinRoom(room) {
  if (!room) return;
  currentRoom = room;
  $('roomTitle').textContent = '# ' + room;
  $('messages').innerHTML = '';
  $('deleteCurrent').classList.add('hidden');
  socket.emit('join-room', { room, username });
}
function closeVoice() {
  localStream?.getTracks().forEach(t => t.stop());
  peers.forEach(p => p.close()); peers.clear();
  document.querySelectorAll('audio[id^="audio-"]').forEach(a => a.remove());
  inVoice = false; $('voiceBtn').textContent = 'Join voice'; $('muteBtn').textContent = '🎙️ Mute';
}

socket.on('rooms-list', ({ rooms }) => renderRooms(rooms));
socket.on('room-state', ({ room, ownerId, ownerName, users }) => {
  currentRoom = room; currentOwnerId = ownerId;
  $('roomTitle').textContent = '# ' + room;
  $('roomMeta').textContent = `Owned by ${ownerName}${ownerId === socket.id ? ' · You own this room' : ''}`;
  $('deleteCurrent').classList.toggle('hidden', !ownerId || ownerId !== socket.id || room === 'general');
  renderPeople(users); addSystem(`Welcome to #${currentRoom}. Find a teammate and squad up.`);
});
socket.on('room-users', ({ users }) => renderPeople(users));
socket.on('chat-message', x => addMsg(x.username, x.message, x.time));
socket.on('user-joined', x => addSystem(`${x.username} joined the room.`));
socket.on('user-left', x => { peers.get(x.id)?.close(); peers.delete(x.id); addSystem('A player left the room.'); });
socket.on('room-created', ({ room }) => joinRoom(room));
socket.on('room-deleted', ({ room, reason }) => { closeVoice(); addSystem(reason === 'empty' ? `#${room} closed because everyone left.` : `#${room} was deleted by the owner.`); currentRoom = 'general'; joinRoom('general'); });
socket.on('room-error', ({ message }) => alert(message));

$('chatForm').onsubmit = e => { e.preventDefault(); const m = $('message').value.trim(); if (m) { socket.emit('chat-message', { room: currentRoom, message: m }); $('message').value = ''; } };
$('createRoom').onclick = () => { $('modal').classList.remove('hidden'); $('newRoom').focus(); };
$('cancelRoom').onclick = () => $('modal').classList.add('hidden');
$('confirmRoom').onclick = () => { const room = $('newRoom').value.trim(); if (!room) return; socket.emit('create-room', { room, username }); $('modal').classList.add('hidden'); $('newRoom').value = ''; };
$('newRoom').onkeydown = e => { if (e.key === 'Enter') $('confirmRoom').click(); if (e.key === 'Escape') $('cancelRoom').click(); };
$('deleteCurrent').onclick = () => { if (currentOwnerId === socket.id && currentRoom !== 'general' && confirm(`Delete #${currentRoom}?`)) socket.emit('delete-room', { room: currentRoom }); };
$('voiceBtn').onclick = async () => { if (inVoice) return; try { localStream = await navigator.mediaDevices.getUserMedia({audio:true}); inVoice = true; $('voiceBtn').textContent = '✓ In voice'; const ids = [...document.querySelectorAll('.person')].map(x => x.dataset.id).filter(Boolean); for (const id of ids) if (id !== socket.id) await makePeer(id, true); addSystem('You joined voice chat.'); } catch (e) { alert('Microphone permission is required for voice chat.'); } };
$('muteBtn').onclick = () => { if (!localStream) return; const track = localStream.getAudioTracks()[0]; track.enabled = !track.enabled; $('muteBtn').textContent = track.enabled ? '🎙️ Mute' : '🔇 Unmute'; };
$('leaveBtn').onclick = () => { closeVoice(); socket.emit('leave-room'); joinRoom('general'); };

async function makePeer(id, offer = false) {
  const pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
  peers.set(id, pc);
  localStream?.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = e => e.candidate && socket.emit('ice-candidate', {to:id, candidate:e.candidate});
  pc.ontrack = e => { let a = document.getElementById('audio-' + id); if (!a) { a = document.createElement('audio'); a.id = 'audio-' + id; a.autoplay = true; document.body.appendChild(a); } a.srcObject = e.streams[0]; };
  if (offer) { const o = await pc.createOffer(); await pc.setLocalDescription(o); socket.emit('webrtc-offer', {to:id, offer:o}); }
  return pc;
}
socket.on('webrtc-offer', async ({from, offer}) => { if (!inVoice) return; const pc = await makePeer(from); await pc.setRemoteDescription(offer); const a = await pc.createAnswer(); await pc.setLocalDescription(a); socket.emit('webrtc-answer', {to:from, answer:a}); });
socket.on('webrtc-answer', async ({from, answer}) => { const pc = peers.get(from); if (pc) await pc.setRemoteDescription(answer); });
socket.on('ice-candidate', async ({from, candidate}) => { const pc = peers.get(from); if (pc) try { await pc.addIceCandidate(candidate); } catch {} });

socket.emit('request-rooms');
joinRoom('general');
