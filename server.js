// Servidor de salas e lobby de torneios 8 Ball Tournament.
// O estado das salas fica na memória: reiniciar o processo encerra as salas abertas.
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET','POST'] } });
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const FORMATS = new Set([2,4,8,16]);
app.get('/health', (_req,res) => res.json({ ok:true, service:'8ball-tournament', rooms:rooms.size }));
app.use(express.static(path.join(__dirname,'public')));
function code(){ let value; do { value=crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase(); } while(rooms.has(value)); return value; }
function safeName(value){ const name=String(value || 'JOGADOR').trim().replace(/[<>]/g,'').slice(0,18); return name || 'JOGADOR'; }
function publicRoom(room){ return { code:room.code, size:room.size, hostId:room.hostId, players:room.players.map(p=>({id:p.id,name:p.name})), started:room.started, bracket:room.bracket }; }
function broadcast(room){ io.to(room.code).emit('tournament:room-update',publicRoom(room)); }
function makeBracket(players){ const names=players.map(p=>p.name); for(let i=names.length-1;i>0;i--){const j=crypto.randomInt(i+1);[names[i],names[j]]=[names[j],names[i]];} const rounds=[];let current=names.slice();while(current.length>=2){const matches=[];for(let i=0;i<current.length;i+=2)matches.push({a:current[i],b:current[i+1],winner:null});rounds.push({matches});current=matches.map((_,i)=>'Vencedor '+(i+1));}return rounds; }
function replyError(ack,message){ if(typeof ack==='function')ack({ok:false,error:{message}}); }
io.on('connection',socket=>{
 socket.on('tournament:create',(data={},ack)=>{
  const size=Number(data.size); if(!FORMATS.has(size))return replyError(ack,'Formato de torneio inválido.');
  const roomCode=code();const room={code:roomCode,size,hostId:socket.id,players:[{id:socket.id,name:safeName(data.name)}],started:false,bracket:null};
  rooms.set(roomCode,room);socket.join(roomCode);if(typeof ack==='function')ack({ok:true,room:publicRoom(room)});broadcast(room);
 });
 socket.on('tournament:join',(data={},ack)=>{
  const room=rooms.get(String(data.code||'').trim().toUpperCase());if(!room)return replyError(ack,'Sala não encontrada. Confira o código.');
  if(room.started)return replyError(ack,'Este torneio já foi iniciado.');
  if(room.players.length>=room.size)return replyError(ack,'Esta sala já está cheia.');
  if(room.players.some(p=>p.id===socket.id))return replyError(ack,'Você já está nesta sala.');
  room.players.push({id:socket.id,name:safeName(data.name)});socket.join(room.code);
  if(typeof ack==='function')ack({ok:true,room:publicRoom(room)});broadcast(room);
 });
 socket.on('tournament:start',(data={},ack)=>{
  const room=rooms.get(String(data.code||'').trim().toUpperCase());if(!room)return replyError(ack,'Sala não encontrada.');
  if(room.hostId!==socket.id)return replyError(ack,'Somente o criador pode iniciar o torneio.');
  if(room.started)return replyError(ack,'Este torneio já foi iniciado.');
  if(room.players.length!==room.size)return replyError(ack,'Aguarde preencher todas as vagas.');
  room.started=true;room.bracket=makeBracket(room.players);const payload={players:room.players.map(p=>({id:p.id,name:p.name})),bracket:room.bracket};
  io.to(room.code).emit('tournament:started',payload);if(typeof ack==='function')ack({ok:true,bracket:room.bracket});
 });
 socket.on('disconnect',()=>{
  for(const [roomCode,room] of rooms){const before=room.players.length;room.players=room.players.filter(p=>p.id!==socket.id);
   if(room.players.length!==before){if(room.players.length===0){rooms.delete(roomCode);continue;}if(room.hostId===socket.id)room.hostId=room.players[0].id;if(!room.started)broadcast(room);}
  }
 });
});
server.listen(PORT,()=>console.log(`8 Ball Tournament multiplayer ativo na porta ${PORT}`));
