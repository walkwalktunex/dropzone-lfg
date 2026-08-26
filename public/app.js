let me = null;
let socket = null;
let currentRoom = null;
let currentRoomData = null;
let currentUsers = [];
let rooms = [];
let filter = 'all';
let search = '';
let rtcConfig = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
let micStream = null;
const peers = new Map();
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'Content-Type':'application/json', ...(opts.headers || {}) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}
function showWelcome(message='') { $('welcome').classList.remove('hidden'); $('app').classList.add('hidden'); $('welcomeMsg').textContent = message; }
function showApp(user) { me = user; $('welcome').classList.add('hidden'); $('app').classList.remove('hidden'); $('nameBtn').textContent = user.username; connect(); loadRooms(); }
async function boot() {
  try {
    const cfg = await api('/api/config'); rtcConfig = cfg.rtcConfig || rtcConfig;
    const m = await api('/api/me');
    if (m.user) { showApp(m.user); return; }
    $('guestUsername').value = localStorage.getItem('dropzone_name') || '';
    showWelcome();
  } catch (e) { showWelcome(e.message); }
}
async function enter() {
  const name = $('guestUsername').value.trim();
  if (name.length < 3) { $('welcomeMsg').textContent = 'Use at least 3 characters.'; return; }
  try { const r = await api('/api/guest', { method:'POST', body: JSON.stringify({ username:name }) }); localStorage.setItem('dropzone_name', r.user.username); showApp(r.user); }
  catch (e) { $('welcomeMsg').textContent = e.message; }
}
function connect() {
  socket = io({ transports:['websocket'], withCredentials:true });
  socket.on('connect', () => setOnline(true));
  socket.on('disconnect', () => setOnline(false));
  socket.on('rooms:update', loadRooms);
  socket.on('room:deleted', id => { if (currentRoom === id) leaveRoom(); loadRooms(); });
  socket.on('room:error', message => toast(message));
  socket.on('room:joined', room => { currentRoom = room.id; currentRoomData = room; renderHeader(room); $('chatInput').disabled = false; $('chatForm').querySelector('button').disabled = false; $('mic').disabled = false; addSystemMessage(`Joined ${room.name}.`); });
  socket.on('room:presence', users => { currentUsers = users; renderPresence(); updateMetrics(); });
  socket.on('chat:message', addMessage);
  socket.on('voice:peer', async peer => { try { await callPeer(peer.id, true); } catch(e){ console.error(e); } });
  socket.on('voice:peer-left', id => closePeer(id));
  socket.on('voice:signal', ({ from, data }) => handleSignal(from, data));
}
function setOnline(online){ const pill=$('.live-pill'); if(pill) pill.innerHTML=online?'<i></i><b>LIVE</b>':'<i style="background:#ff6b7f"></i><b>OFFLINE</b>'; }
function updateMetrics(){ $('heroRooms').textContent = rooms.filter(r=>passesFilters(r)).length; $('heroPlayers').textContent = rooms.reduce((s,r)=>s+r.playerCount,0); $('roomCount').textContent = rooms.filter(r=>passesFilters(r)).length; }
async function loadRooms(){
  try { rooms = (await api('/api/rooms')).rooms; renderRooms(); updateMetrics(); } catch(e) { $('roomList').innerHTML=`<div class="chat-empty"><h4>Can't load rooms.</h4><p>${esc(e.message)}</p></div>`; }
}
function passesFilters(r){ return (filter==='all' || (filter==='private' && r.isPrivate)) && (!search || `${r.name} ${r.description} ${r.mode} ${r.region}`.toLowerCase().includes(search)); }
function renderRooms(){ const visible=rooms.filter(passesFilters); $('roomList').innerHTML = visible.map(roomCard).join('') || '<div class="chat-empty" style="padding:34px 4px"><div class="empty-badge">＋</div><h4>No matching rooms</h4><p>Create the first squad room and get the lobby moving.</p></div>'; }
function roomCard(r){ const active=currentRoom===r.id; return `<article class="room-card ${active?'active':''}" onclick="selectRoom('${r.id}')"><div class="room-title-row"><span class="room-title">${esc(r.name)}</span><span class="chip">${r.isPrivate?'🔒 Private':'Public'}</span></div><div class="room-desc">${esc(r.description||'Looking for players.')}</div><div class="room-meta"><span>${r.playerCount}/${r.maxPlayers} players</span><span>${esc(r.mode)}</span><span>${esc(r.region)}</span></div></article>`; }
async function selectRoom(id){
  const room = rooms.find(r=>r.id===id); if(!room) return;
  if(currentRoom===id) return;
  if(currentRoom) await leaveRoom();
  if(room.isPrivate){ openPrompt('ROOM PASSWORD','Enter the password to join this private room.','Password', async password=>joinRoom(id,password)); }
  else joinRoom(id);
}
function joinRoom(id,password=''){ socket.emit('room:join',{roomId:id,password}); }
function renderHeader(room){ $('roomHeader').innerHTML=`<div class="room-avatar">${room.isPrivate?'🔒':'◎'}</div><div style="min-width:0;flex:1"><div class="eyebrow">${room.isPrivate?'PRIVATE ROOM':'ACTIVE ROOM'}</div><h3>${esc(room.name)}</h3><p>${esc(room.description||'No description')} · ${room.playerCount}/${room.maxPlayers} · ${esc(room.mode)} · ${esc(room.region)}</p></div><div style="display:flex;gap:7px;flex-wrap:wrap"><button class="small" onclick="editRoom('${room.id}')">Edit</button><button class="small danger" onclick="reportRoom('${room.id}')">Report</button><button class="small danger" onclick="deleteRoom('${room.id}')">Delete</button></div>`; }
function renderPresence(){ $('presence').textContent = currentUsers.length ? currentUsers.map(u=>`${u.username}${u.userId===me.id?' (you)':''}`).join(' · ') : 'No players connected.'; }
function addSystemMessage(text){ const e=document.createElement('div'); e.className='msg'; e.innerHTML=`<b>DROPZONE</b><div>${esc(text)}</div>`; $('messages').appendChild(e); scrollMessages(); }
function addMessage(m){ const empty=$('messages').querySelector('.chat-empty'); empty?.remove(); const el=document.createElement('div'); el.className='msg'; el.innerHTML=`<b>${esc(m.username)}</b><small>${new Date(m.at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</small><div>${esc(m.text)}</div>`; $('messages').appendChild(el); scrollMessages(); }
function scrollMessages(){ $('messages').scrollTop=$('messages').scrollHeight; }
async function leaveRoom(){ if(!currentRoom) return; socket?.emit('room:leave'); stopVoice(); currentRoom=null; currentRoomData=null; currentUsers=[]; $('roomHeader').innerHTML='<div class="room-avatar">◎</div><div><div class="eyebrow">YOUR SQUAD SPACE</div><h3>Select a room</h3><p>Choose a live room to see the squad, chat, and connect on voice.</p></div>'; $('presence').textContent=''; $('messages').innerHTML='<div class="chat-empty"><div class="empty-badge">✦</div><h4>Ready when you are.</h4><p>Your squad chat will appear here after you join a room.</p></div>'; $('chatInput').disabled=true; $('chatForm').querySelector('button').disabled=true; $('mic').disabled=true; renderRooms(); updateMetrics(); }
async function createRoom(e){ e.preventDefault(); const isPrivate=$('roomPrivate').checked; try{ const r=await api('/api/rooms',{method:'POST',body:JSON.stringify({name:$('roomName').value,description:$('roomDescription').value,maxPlayers:Number($('roomMax').value),mode:$('roomMode').value,region:$('roomRegion').value,isPrivate,password:$('roomPassword').value})}); $('roomDialog').close(); $('roomForm').reset(); $('roomPassword').disabled=true; await loadRooms(); await selectRoom(r.room.id); }catch(e){$('roomMsg').textContent=e.message;} }
async function editRoom(id){ const room=rooms.find(r=>r.id===id); if(!room)return; const name=prompt('Room name',room.name); if(name===null)return; const desc=prompt('Description',room.description||''); if(desc===null)return; const max=Number(prompt('Max players (2-64)',room.maxPlayers)); if(!max)return; try{await api('/api/rooms/'+id,{method:'PATCH',body:JSON.stringify({name,description:desc,maxPlayers:max,mode:room.mode,region:room.region})}); await loadRooms(); if(currentRoom===id){ currentRoomData={...room,name,description:desc,maxPlayers:max}; renderHeader(currentRoomData); }}catch(e){toast(e.message)} }
async function deleteRoom(id){ const room=rooms.find(r=>r.id===id); if(!room||room.ownerId!==me.id&&me.role!=='moderator') return toast('Only the room owner can delete this room.'); if(!confirm(`Delete “${room.name}”?`))return; try{await api('/api/rooms/'+id,{method:'DELETE'});if(currentRoom===id)await leaveRoom();await loadRooms();}catch(e){toast(e.message)} }
async function reportRoom(id){ const reason=prompt('Reason (spam, harassment, cheating, other)','Spam'); if(!reason)return; const details=prompt('Details (optional)','')||''; try{await api('/api/reports',{method:'POST',body:JSON.stringify({roomId:id,reason,details})});toast('Report sent to moderation.');}catch(e){toast(e.message)} }
$('guestForm').addEventListener('submit',e=>{e.preventDefault();enter()}); $('newRoom').onclick=()=>{$('roomMsg').textContent='';$('roomDialog').showModal()}; $('roomForm').addEventListener('submit',createRoom); $('roomPrivate').onchange=()=>{$('roomPassword').disabled=!$('roomPrivate').checked}; $('refreshRooms').onclick=loadRooms; $('roomSearch').oninput=e=>{search=e.target.value.trim().toLowerCase();renderRooms();updateMetrics()}; $('filterPublic').onclick=()=>{filter='all';document.querySelectorAll('.filter').forEach(b=>b.classList.remove('active'));$('filterPublic').classList.add('active');renderRooms();updateMetrics()}; $('filterPrivate').onclick=()=>{filter='private';document.querySelectorAll('.filter').forEach(b=>b.classList.remove('active'));$('filterPrivate').classList.add('active');renderRooms();updateMetrics()}; $('nameBtn').onclick=async()=>{const name=prompt('Change display name',me?.username||'');if(!name)return;try{await api('/api/logout',{method:'POST'});localStorage.setItem('dropzone_name',name.trim());location.reload()}catch(e){toast(e.message)}}; $('chatForm').addEventListener('submit',e=>{e.preventDefault();const text=$('chatInput').value.trim();if(text&&currentRoom){socket.emit('chat:send',{text});$('chatInput').value=''}});
$('mic').onclick=async()=>{try{if(!micStream){micStream=await navigator.mediaDevices.getUserMedia({audio:true});$('mic').classList.add('on');$('mic').textContent='🎙 Mic on';$('voiceStatus').textContent='Voice active';for(const u of currentUsers.filter(x=>x.socketId!==socket.id))await callPeer(u.socketId,true);socket.emit('voice:ready')}else stopVoice()}catch(e){toast('Microphone access was blocked. Check browser permissions.')}};
async function callPeer(id,initiator){if(peers.has(id))return;const pc=new RTCPeerConnection(rtcConfig);peers.set(id,pc);if(micStream)micStream.getTracks().forEach(t=>pc.addTrack(t,micStream));pc.onicecandidate=e=>{if(e.candidate)socket.emit('voice:signal',{to:id,data:{candidate:e.candidate}})};pc.ontrack=e=>{let a=document.getElementById('audio-'+id);if(!a){a=document.createElement('audio');a.id='audio-'+id;a.autoplay=true;a.playsInline=true;document.body.appendChild(a)}a.srcObject=e.streams[0]};pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))closePeer(id)};if(initiator){const offer=await pc.createOffer();await pc.setLocalDescription(offer);socket.emit('voice:signal',{to:id,data:{description:pc.localDescription}})}}
async function handleSignal(from,data){let pc=peers.get(from);if(!pc){await callPeer(from,false);pc=peers.get(from)}if(data.description){await pc.setRemoteDescription(data.description);if(data.description.type==='offer'){const answer=await pc.createAnswer();await pc.setLocalDescription(answer);socket.emit('voice:signal',{to:from,data:{description:pc.localDescription}})}}else if(data.candidate){try{await pc.addIceCandidate(data.candidate)}catch{}}}
function closePeer(id){peers.get(id)?.close();peers.delete(id);document.getElementById('audio-'+id)?.remove()}function stopVoice(){if(micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null}peers.forEach((_,id)=>closePeer(id));socket?.emit('voice:leave');$('mic').classList.remove('on');$('mic').textContent='🎙 Mic off';$('voiceStatus').textContent='Not connected'}
function openPrompt(title,text,placeholder,ok){$('promptEyebrow').textContent=title;$('promptText').textContent=text;$('promptInput').placeholder=placeholder;$('promptInput').value='';$('promptError').textContent='';$('promptDialog').showModal();const handler=async e=>{if(e.submitter?.value!=='default')return;e.preventDefault();try{await ok($('promptInput').value);$('promptDialog').close();$('promptForm').removeEventListener('submit',handler)}catch(err){$('promptError').textContent=err.message}};$('promptForm').onsubmit=handler}
function toast(text){const el=document.createElement('div');el.textContent=text;Object.assign(el.style,{position:'fixed',right:'18px',bottom:'18px',zIndex:99,maxWidth:'340px',padding:'12px 14px',background:'#111827',border:'1px solid #3a465f',borderRadius:'12px',color:'#eef3ff',font:'600 11px Inter',boxShadow:'0 20px 50px rgba(0,0,0,.4)'});document.body.appendChild(el);setTimeout(()=>el.remove(),3200)}
window.selectRoom=selectRoom;window.editRoom=editRoom;window.deleteRoom=deleteRoom;window.reportRoom=reportRoom;
boot();
