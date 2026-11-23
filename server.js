// Servidor de salas, chaveamento e partidas online 8 Ball Tournament.
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET','POST'] } });
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const matches = new Map();
const FORMATS = new Set([2,4,8,16]);
// ALTERADO AQUI - histórico permanente de confrontos por identidade dos jogadores.
// Em hospedagem com disco persistente, configure HISTORY_FILE para o caminho desse disco.
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname,'data','rivalry-history.json');
// ALTERADO AQUI - estatísticas oficiais dos perfis, persistidas por identidade entre aparelhos e reinicializações.
const PROFILE_STATS_FILE = process.env.PROFILE_STATS_FILE || path.join(__dirname,'data','profile-stats.json');
// ALTERADO AQUI - cadastro persistente das ligas; ligas encerradas/removidas são apagadas definitivamente.
const LEAGUES_FILE = process.env.LEAGUES_FILE || path.join(__dirname,'data','leagues.json');
let leagues = {};
try { if(fs.existsSync(LEAGUES_FILE)){ const parsed=JSON.parse(fs.readFileSync(LEAGUES_FILE,'utf8')); if(parsed&&typeof parsed==='object')leagues=parsed; } } catch(error){ console.error('Falha ao carregar ligas:',error.message); }
function persistLeagues(){ try { fs.mkdirSync(path.dirname(LEAGUES_FILE),{recursive:true}); const temp=LEAGUES_FILE+'.tmp'; fs.writeFileSync(temp,JSON.stringify(leagues)); fs.renameSync(temp,LEAGUES_FILE); } catch(error){ console.error('Falha ao salvar ligas:',error.message); } }
function publicLeague(league){ return {id:league.id,name:league.name,maxPlayers:league.maxPlayers,players:league.players.map(p=>({playerKey:p.playerKey,name:p.name,profilePhoto:p.profilePhoto||''})),settings:league.settings,createdAt:league.createdAt,hostKey:league.hostKey,status:league.status}; }
function leagueList(){ return Object.values(leagues).filter(l=>l.status==='open'&&l.players.length<l.maxPlayers).map(publicLeague); }
// ALTERADO AQUI - classificação e registro permanente dos resultados da Liga.
function ensureLeagueData(league){
 if(!Array.isArray(league.matches))league.matches=[];
 league.players.forEach(p=>{if(!p.stats)p.stats={points:0,v8:0,wins:0,tc:0,ts:0,saldo:0,draws:0,losses:0};});
}
function leagueStandings(league){
 ensureLeagueData(league);
 return [...league.players].sort((a,b)=>(b.stats.points-a.stats.points)||(b.stats.v8-a.stats.v8)||(b.stats.wins-a.stats.wins)||(b.stats.tc-a.stats.tc)||(a.stats.ts-b.stats.ts)||(b.stats.saldo-a.stats.saldo))
 .map((p,i)=>({position:i+1,playerKey:p.playerKey,name:p.name,stats:{...p.stats}}));
}
function publicLeagueRoom(league){league.settings={...normalizeTournamentSettings(league.settings),timeMode:'tempo'};return {...publicLeague(league),standings:leagueStandings(league),matches:league.matches||[]};}
function recordLeagueResult(room,match,result){
 if(!room?.leagueId||match?.leagueResultRecorded)return;
 const league=leagues[room.leagueId];if(!league)return;ensureLeagueData(league);
 const a=match.participants?.[0],b=match.participants?.[1];if(!a?.playerKey||!b?.playerKey)return;
 const pa=league.players.find(p=>p.playerKey===a.playerKey),pb=league.players.find(p=>p.playerKey===b.playerKey);if(!pa||!pb)return;
 const scoreA=Math.max(0,Number(result.scoreA)||0),scoreB=Math.max(0,Number(result.scoreB)||0),winnerSlot=Number(result.winnerSlot),type=String(result.type||'score');
 pa.stats.tc+=scoreA;pa.stats.ts+=scoreB;pa.stats.saldo=pa.stats.tc-pa.stats.ts;
 pb.stats.tc+=scoreB;pb.stats.ts+=scoreA;pb.stats.saldo=pb.stats.tc-pb.stats.ts;
 if(type==='forfeit'){if(winnerSlot===0){pa.stats.points+=3;pa.stats.wins++;pb.stats.losses++;}else if(winnerSlot===1){pb.stats.points+=3;pb.stats.wins++;pa.stats.losses++;}}
 else if(winnerSlot===0||winnerSlot===1){const w=winnerSlot===0?pa:pb,l=winnerSlot===0?pb:pa;if(Math.max(scoreA,scoreB)>=8&&Math.min(scoreA,scoreB)===0){w.stats.points+=10;w.stats.v8++;}else w.stats.points+=5;w.stats.wins++;l.stats.losses++;}
 else{pa.stats.points++;pb.stats.points++;pa.stats.draws++;pb.stats.draws++;}
 match.leagueResultRecorded=true;league.matches.push({id:match.id,date:new Date().toISOString(),playerA:a.name,playerB:b.name,scoreA,scoreB,winnerSlot:Number.isInteger(winnerSlot)?winnerSlot:null,type});
 persistLeagues();io.to(league.id).emit('league:updated',publicLeagueRoom(league));
}


let savedProfileStats = {};
try { if(fs.existsSync(PROFILE_STATS_FILE)){ const parsed=JSON.parse(fs.readFileSync(PROFILE_STATS_FILE,'utf8')); if(parsed&&typeof parsed==='object')savedProfileStats=parsed; } } catch(error){ console.error('Falha ao carregar estatísticas dos perfis:',error.message); }
function persistProfileStats(){ try { fs.mkdirSync(path.dirname(PROFILE_STATS_FILE),{recursive:true}); const temp=PROFILE_STATS_FILE+'.tmp'; fs.writeFileSync(temp,JSON.stringify(savedProfileStats)); fs.renameSync(temp,PROFILE_STATS_FILE); } catch(error){ console.error('Falha ao salvar estatísticas dos perfis:',error.message); } }
function profileStatsFor(playerKey,fallback={}){ return normalizeProfileStats(savedProfileStats[String(playerKey||'')]||fallback); }
function sendProfileStats(socket,player){ if(player?.playerKey)socket.emit('profile:stats:update',{playerKey:player.playerKey,stats:profileStatsFor(player.playerKey,player.profileStats||{})}); }
let rivalryHistory = {};
try { if(fs.existsSync(HISTORY_FILE)){ const parsed=JSON.parse(fs.readFileSync(HISTORY_FILE,'utf8')); if(parsed&&typeof parsed==='object')rivalryHistory=parsed; } } catch(error){ console.error('Falha ao carregar histórico de confrontos:',error.message); }
function persistRivalryHistory(){
 try { fs.mkdirSync(path.dirname(HISTORY_FILE),{recursive:true}); const temp=HISTORY_FILE+'.tmp'; fs.writeFileSync(temp,JSON.stringify(rivalryHistory)); fs.renameSync(temp,HISTORY_FILE); }
 catch(error){ console.error('Falha ao salvar histórico de confrontos:',error.message); }
}
function normalizeProfileStats(value={}){
 const keys=['tournamentWins','tournamentLosses','wins1v1','losses1v1','first','second','third','streak'];const out={};
 keys.forEach(key=>{const n=Number(value[key]);out[key]=Number.isFinite(n)&&n>=0?Math.floor(n):0;});return out;
}
function rivalryPairKey(keyA,keyB){return [String(keyA||''),String(keyB||'')].sort().join('::');}
function recordRivalryMatch(match,{scoreA=0,scoreB=0,winnerSlot=null,type='score'}={}){
 if(!match||match.historyRecorded)return;
 const a=match.participants?.[0],b=match.participants?.[1];
 if(!a?.playerKey||!b?.playerKey||a.playerKey===b.playerKey)return;
 const pair=rivalryPairKey(a.playerKey,b.playerKey);
 const sameOrder=String(a.playerKey)<=String(b.playerKey);
 const record={id:crypto.randomBytes(8).toString('hex'),date:new Date().toISOString(),playerA:sameOrder?a.name:b.name,playerB:sameOrder?b.name:a.name,playerKeyA:sameOrder?a.playerKey:b.playerKey,playerKeyB:sameOrder?b.playerKey:a.playerKey,scoreA:sameOrder?(Number(scoreA)||0):(Number(scoreB)||0),scoreB:sameOrder?(Number(scoreB)||0):(Number(scoreA)||0),winnerKey:winnerSlot===0?a.playerKey:winnerSlot===1?b.playerKey:null,type,code:match.code,bracketMatchId:match.bracketMatchId};
 if(!Array.isArray(rivalryHistory[pair]))rivalryHistory[pair]=[];
 rivalryHistory[pair].push(record);match.historyRecorded=true;persistRivalryHistory();
}

app.get('/health', (_req,res) => res.json({ ok:true, service:'8ball-tournament', rooms:rooms.size, matches:matches.size, rivalryPairs:Object.keys(rivalryHistory).length }));
app.use(express.static(path.join(__dirname,'public')));
function code(){ let value; do { value=crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase(); } while(rooms.has(value)); return value; }
function safeName(value){ const name=String(value || 'JOGADOR').trim().replace(/[<>]/g,'').slice(0,18); return name || 'JOGADOR'; }
// ALTERADO AQUI - valida e limita a foto de perfil enviada ao torneio.
function safeProfilePhoto(value){
 const photo=String(value||"").trim();
 if(photo.length>450000)return "";
 if(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(photo))return photo;
 return photo.length<=2048&&/^https:\/\/[^\s"'<>]+$/i.test(photo)?photo:"";
}
// ALTERADO AQUI - normaliza a duração uma única vez no servidor para todos os participantes.
function normalizeTournamentSettings(settings={}){
 const timeMode=settings.timeMode==='tempo'?'tempo':'individual';
 const rawMinutes=Number(settings.minutes);
 const minutes=Number.isInteger(rawMinutes)?Math.max(1,Math.min(60,rawMinutes)):10;
 return {timeMode,minutes,guide:settings.guide!==false};
}
function publicRoom(room){ return { code:room.code, size:room.size, hostId:room.hostId, players:room.players.map(p=>({id:p.id,name:p.name,playerKey:p.playerKey||'',profileStats:normalizeProfileStats(p.profileStats),profilePhoto:p.profilePhoto||''})), started:room.started, bracket:room.bracket, settings:room.settings }; }
// ALTERADO AQUI - mantém o socket atual ligado ao participante estável após reconexão.
function rebindRoomPlayer(room,playerKey,socket){
 if(!playerKey)return null;
 const player=room.players.find(p=>p.playerKey===playerKey);
 if(!player)return null;
 const oldId=player.id;player.id=socket.id;socket.join(room.code);
 if(room.hostId===oldId)room.hostId=socket.id;
 const updateBracket=entry=>{
  if(!entry||typeof entry!=="object")return;
  if(entry.playerKey===playerKey)entry.id=socket.id;
  Object.values(entry).forEach(value=>{if(Array.isArray(value))value.forEach(updateBracket);else if(value&&typeof value==="object")updateBracket(value);});
 };
 updateBracket(room.bracket);
 return player;
}
function broadcast(room){ io.to(room.code).emit('tournament:room-update',publicRoom(room)); }
function makeBracket(players){
 const shuffled=players.map(p=>({id:p.id,name:p.name,playerKey:p.playerKey||"",profileStats:normalizeProfileStats(p.profileStats),profilePhoto:p.profilePhoto||""}));
 for(let i=shuffled.length-1;i>0;i--){const j=crypto.randomInt(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
 const rounds=[];let current=shuffled;let roundIndex=0;
 while(current.length>=2){
  const matchesInRound=[];
  for(let i=0;i<current.length;i+=2){
   const a=current[i],b=current[i+1];
   matchesInRound.push({matchId:`R${roundIndex}M${i/2}`,a,b,winner:null});
  }
  rounds.push({matches:matchesInRound});
  current=matchesInRound.map((_,i)=>({id:null,name:'Vencedor '+(i+1)}));
  roundIndex++;
 }
 return rounds;
}
function replyError(ack,message){ if(typeof ack==='function')ack({ok:false,error:{message}}); }
function getRoom(codeValue){return rooms.get(String(codeValue||'').trim().toUpperCase());}
function findBracketMatch(room,matchId){
 if(!room?.bracket)return null;
 for(let roundIndex=0;roundIndex<room.bracket.length;roundIndex++){
  const round=room.bracket[roundIndex];
  const matchIndex=(round.matches||[]).findIndex(item=>item.matchId===matchId);
  if(matchIndex>=0)return {match:round.matches[matchIndex],roundIndex,matchIndex};
 }
 return null;
}
function emitBracket(room){if(room)io.to(room.code).emit('tournament:bracket-update',{code:room.code,bracket:room.bracket});}
function awardFinalTournamentStats(room,match,winnerSlot){
 if(!room||!match||match.statsAwarded||winnerSlot!==0&&winnerSlot!==1)return;
 const sides=[match.a,match.b];
 sides.forEach((participant,slot)=>{
  const key=String(participant?.playerKey||'');if(!key)return;
  const roomPlayer=room.players.find(p=>p.playerKey===key);
  const stats=profileStatsFor(key,roomPlayer?.profileStats||participant.profileStats||{});
  if(slot===winnerSlot){stats.tournamentWins++;stats.first++;stats.streak++;}
  else{stats.tournamentLosses++;stats.second++;stats.streak=0;}
  savedProfileStats[key]=stats;
  if(roomPlayer)roomPlayer.profileStats=stats;
  participant.profileStats=stats;
  const targetId=roomPlayer?.id||participant.id;
  if(targetId)io.to(targetId).emit('profile:stats:update',{playerKey:key,stats});
 });
 match.statsAwarded=true;
 persistProfileStats();
}
function completeBracketMatch(room,match,roundIndex,matchIndex,options={}){
 if(!room||!match||match.completed)return null;
 const winnerSlot=options.winnerSlot===0||options.winnerSlot===1?options.winnerSlot:null;
 const winner=winnerSlot===null?null:match[winnerSlot===0?'a':'b'];
 match.winner=winner?{...winner}:null;
 match.winnerId=winner?.id??null;
 match.winnerName=winner?.name??null;
 if(options.scoreA!==undefined&&options.scoreA!==null)match.scoreA=Number(options.scoreA)||0;
 if(options.scoreB!==undefined&&options.scoreB!==null)match.scoreB=Number(options.scoreB)||0;
 match.status=String(options.status||(winner?'FINALIZADA':'ENCERRADA'));
 match.reason=options.reason||'';
 match.completed=true;match.ended=true;
 match.result={type:options.type||'score',winnerSlot,loserSlot:options.loserSlot??(winnerSlot===null?null:1-winnerSlot),scoreA:match.scoreA??null,scoreB:match.scoreB??null};
 // ALTERADO AQUI - estatísticas oficiais só são contabilizadas ao encerrar a FINAL do torneio.
 if(roundIndex===room.bracket.length-1&&winnerSlot!==null)awardFinalTournamentStats(room,match,winnerSlot);
 if(winner&&roundIndex+1<room.bracket.length){
  const nextRound=room.bracket[roundIndex+1];
  const nextMatch=nextRound.matches[Math.floor(matchIndex/2)];
  if(nextMatch){const side=matchIndex%2===0?'a':'b';nextMatch[side]={...winner};}
 }
 emitBracket(room);
 return {winner:match.winner,bracket:room.bracket,result:match.result};
}
// ALTERADO AQUI - controla 60 segundos de inatividade por participante, no relógio do servidor.
const INACTIVITY_LIMIT_MS=60000;
function clearMatchInactivity(match){
 if(!match?.inactivityTimers)return;
 match.inactivityTimers.forEach(timer=>{if(timer)clearTimeout(timer);});
 match.inactivityTimers=[null,null];
}
function finishMatchByInactivity(match,loserSlot){
 if(!match||match.ended)return;
 const now=Date.now(),winnerSlot=loserSlot===0?1:0;
 const bothInactive=now-(match.lastActivity?.[winnerSlot]||0)>=INACTIVITY_LIMIT_MS;
 match.ended=true;clearMatchInactivity(match);
 const scoreA=Array.isArray(match.state?.pottedBy?.[0])?match.state.pottedBy[0].length:0;
 const scoreB=Array.isArray(match.state?.pottedBy?.[1])?match.state.pottedBy[1].length:0;
 recordRivalryMatch(match,{scoreA,scoreB,winnerSlot:bothInactive?null:winnerSlot,type:'forfeit'});
 const room=getRoom(match.code);
 let completed=null;
 if(room){
  const found=findBracketMatch(room,match.bracketMatchId);
  if(found)completed=completeBracketMatch(room,found.match,found.roundIndex,found.matchIndex,{
   winnerSlot:bothInactive?null:winnerSlot,type:'forfeit',status:bothInactive?'ENCERRADA POR INATIVIDADE':'ENCERRADA POR DESISTÊNCIA',
   reason:bothInactive?'Ambos os jogadores ficaram inativos.':'DESISTÊNCIA',loserSlot,
   scoreA:Array.isArray(match.state?.pottedBy?.[0])?match.state.pottedBy[0].length:0,
   scoreB:Array.isArray(match.state?.pottedBy?.[1])?match.state.pottedBy[1].length:0
  });
 }
 const result={matchId:match.id,bracketMatchId:match.bracketMatchId,code:match.code,loserSlot,winnerSlot:bothInactive?null:winnerSlot,winner:completed?.winner||null,bothInactive,bracket:room?.bracket||null};
 if(room?.leagueId)recordLeagueResult(room,match,{scoreA,scoreB,winnerSlot:bothInactive?null:winnerSlot,type:'forfeit'});
 if(room?.leagueId)recordLeagueResult(room,match,{scoreA,scoreB,winnerSlot:bothInactive?null:winnerSlot,type:'forfeit'});
 match.forfeit=result;
 io.to(match.id).emit('match:forfeit',result);
}
function resetMatchInactivity(match,slot){
 if(!match||match.ended||!match.started||slot<0||slot>1)return;
 if(!Array.isArray(match.lastActivity))match.lastActivity=[Date.now(),Date.now()];
 if(!Array.isArray(match.inactivityTimers))match.inactivityTimers=[null,null];
 match.lastActivity[slot]=Date.now();
 if(match.inactivityTimers[slot])clearTimeout(match.inactivityTimers[slot]);
 match.inactivityTimers[slot]=setTimeout(()=>finishMatchByInactivity(match,slot),INACTIVITY_LIMIT_MS);
}
io.on('connection',socket=>{
 // ALTERADO AQUI - lista pública das ligas abertas e disponíveis para entrada.
 socket.on('league:list',(_data={},ack)=>{ const items=leagueList(); if(typeof ack==='function')ack({ok:true,leagues:items}); socket.emit('league:list:update',items); });
 // ALTERADO AQUI - presença online e dados da classificação ao abrir a Liga.
 socket.on('league:open',(data={},ack)=>{
  const league=leagues[String(data.id||'')],key=String(data.playerKey||'');
  if(!league||!league.players.some(p=>p.playerKey===key))return replyError(ack,'Você não participa desta liga.');
  const member=league.players.find(p=>p.playerKey===key);member.socketId=socket.id;socket.join(league.id);ensureLeagueData(league);persistLeagues();
  if(typeof ack==='function')ack({ok:true,league:publicLeagueRoom(league),challenges:(league.challenges||[]).filter(c=>c.toKey===key&&c.status==='pending')});
 });
 // ALTERADO AQUI - envio de desafios entre membros da mesma Liga.
 socket.on('league:challenge',(data={},ack)=>{
  const league=leagues[String(data.id||'')],fromKey=String(data.playerKey||''),toKey=String(data.toKey||'');
  if(!league||!league.players.some(p=>p.playerKey===fromKey)||!league.players.some(p=>p.playerKey===toKey)||fromKey===toKey)return replyError(ack,'Participantes inválidos para o desafio.');
  const target=league.players.find(p=>p.playerKey===toKey);if(!target.socketId)return replyError(ack,'O jogador escolhido não está conectado à Liga.');
  if(!Array.isArray(league.challenges))league.challenges=[];
  const c={id:'C'+crypto.randomBytes(6).toString('hex'),fromKey,toKey,fromName:safeName(data.name),status:'pending',createdAt:new Date().toISOString()};
  league.challenges.push(c);persistLeagues();io.to(target.socketId).emit('league:challenge:incoming',{id:c.id,leagueId:league.id,leagueName:league.name,fromName:c.fromName});
  if(typeof ack==='function')ack({ok:true});
 });
 // ALTERADO AQUI - aceite do desafio cria uma sala online que usa o fluxo de mesa já existente.
 socket.on('league:challenge:respond',(data={},ack)=>{
  const league=leagues[String(data.leagueId||'')],key=String(data.playerKey||''),c=league?.challenges?.find(x=>x.id===String(data.challengeId||''));
  if(!league||!c||c.toKey!==key||c.status!=='pending')return replyError(ack,'Desafio indisponível.');
  c.status=data.accept?'accepted':'ignored';
  if(!data.accept){persistLeagues();if(typeof ack==='function')ack({ok:true,ignored:true});return;}
  const a=league.players.find(p=>p.playerKey===c.fromKey),b=league.players.find(p=>p.playerKey===c.toKey);
  if(!a?.socketId||!b?.socketId)return replyError(ack,'Um dos jogadores não está conectado. Envie o desafio novamente.');
  const roomCode=code(),participants=[{id:a.socketId,name:a.name,playerKey:a.playerKey,profilePhoto:a.profilePhoto||''},{id:b.socketId,name:b.name,playerKey:b.playerKey,profilePhoto:b.profilePhoto||''}];
  const room={code:roomCode,size:2,hostId:a.socketId,players:participants.map(x=>({...x,profileStats:{}})),started:true,bracket:makeBracket(participants),settings:league.settings,leagueId:league.id};
  room.bracket[0].matches[0].matchId='R0M0';rooms.set(roomCode,room);
  const payload={code:roomCode,players:room.players.map(x=>({id:x.id,name:x.name,playerKey:x.playerKey})),bracket:room.bracket,settings:room.settings,leagueId:league.id};
  io.to(a.socketId).emit('league:match:ready',payload);io.to(b.socketId).emit('league:match:ready',payload);persistLeagues();
  if(typeof ack==='function')ack({ok:true,started:true});
 });

 // ALTERADO AQUI - cria liga com o criador inscrito automaticamente e vagas limitadas.
 socket.on('league:create',(data={},ack)=>{
  const maxPlayers=Number(data.maxPlayers);
  // ALTERADO AQUI - permite criar ligas com 2 participantes, mantendo o limite máximo de 16.
  if(!Number.isInteger(maxPlayers)||maxPlayers<2||maxPlayers>16)return replyError(ack,'A liga deve ter de 2 a 16 participantes.');
  const playerKey=String(data.playerKey||'').slice(0,100);if(!playerKey)return replyError(ack,'Identidade do criador não encontrada.');
  if(Object.values(leagues).some(l=>l.status!=='deleted'&&l.players.some(p=>p.playerKey===playerKey)))return replyError(ack,'Você já participa de uma liga ativa.');
  const id='L'+crypto.randomBytes(6).toString('hex').toUpperCase();
  const league={id,name:String(data.name||'LIGA').replace(/[<>]/g,'').trim().slice(0,32)||'LIGA',maxPlayers,hostKey:playerKey,players:[{playerKey,name:safeName(data.namePlayer),profilePhoto:safeProfilePhoto(data.profilePhoto)}],settings:{...normalizeTournamentSettings(data.settings),timeMode:'tempo'},createdAt:new Date().toISOString(),status:'open'};
  leagues[id]=league;persistLeagues();if(typeof ack==='function')ack({ok:true,league:publicLeague(league)});io.emit('league:list:update',leagueList());
 });
 // ALTERADO AQUI - entrada direta pela lista; o servidor impede vagas excedentes e duplicidade.
 socket.on('league:join',(data={},ack)=>{
  const league=leagues[String(data.id||'')],playerKey=String(data.playerKey||'').slice(0,100);
  if(!league||league.status!=='open')return replyError(ack,'Liga indisponível ou já encerrada.');
  if(!playerKey)return replyError(ack,'Identidade do jogador não encontrada.');
  if(league.players.some(p=>p.playerKey===playerKey))return replyError(ack,'Você já participa desta liga.');
  if(Object.values(leagues).some(l=>l.id!==league.id&&l.status!=='deleted'&&l.players.some(p=>p.playerKey===playerKey)))return replyError(ack,'Você já participa de outra liga ativa.');
  if(league.players.length>=league.maxPlayers)return replyError(ack,'Esta liga já está completa.');
  league.players.push({playerKey,name:safeName(data.name),profilePhoto:safeProfilePhoto(data.profilePhoto)});
  if(league.players.length===league.maxPlayers)league.status='full';
  persistLeagues();if(typeof ack==='function')ack({ok:true,league:publicLeague(league)});io.emit('league:list:update',leagueList());
 });
 // ALTERADO AQUI - encerramento ou remoção exclui a liga do armazenamento permanentemente.
 socket.on('league:delete',(data={},ack)=>{
  const league=leagues[String(data.id||'')];if(!league)return replyError(ack,'Liga não encontrada.');
  if(league.hostKey!==String(data.playerKey||''))return replyError(ack,'Somente o criador pode remover ou finalizar a liga.');
  delete leagues[league.id];persistLeagues();if(typeof ack==='function')ack({ok:true,deleted:true});io.emit('league:list:update',leagueList());
 });

 socket.on('tournament:create',(data={},ack)=>{
  const size=Number(data.size); if(!FORMATS.has(size))return replyError(ack,'Formato de torneio inválido.');
  const roomCode=code();const creatorKey=String(data.playerKey||"");const room={code:roomCode,size,hostId:socket.id,players:[{id:socket.id,name:safeName(data.name),playerKey:creatorKey,profileStats:profileStatsFor(creatorKey,data.profileStats),profilePhoto:safeProfilePhoto(data.profilePhoto)}],started:false,bracket:null,settings:normalizeTournamentSettings(data.settings)};
  rooms.set(roomCode,room);socket.join(roomCode);sendProfileStats(socket,room.players[0]);if(typeof ack==='function')ack({ok:true,room:publicRoom(room)});broadcast(room);
 });
 socket.on('tournament:join',(data={},ack)=>{
  const room=getRoom(data.code);if(!room)return replyError(ack,'Sala não encontrada. Confira o código.');
  const existing=room.players.find(p=>p.id===socket.id);
  if(existing){socket.join(room.code);if(typeof ack==='function')ack({ok:true,room:publicRoom(room)});return;}
  if(room.started){
   const rebound=rebindRoomPlayer(room,String(data.playerKey||""),socket);
   if(!rebound)return replyError(ack,'Este torneio já foi iniciado ou este aparelho não pertence à sala.');
   sendProfileStats(socket,rebound);
   if(typeof ack==='function')ack({ok:true,room:publicRoom(room)});
   broadcast(room);return;
  }
  if(room.players.length>=room.size)return replyError(ack,'Esta sala já está cheia.');
  const joiningKey=String(data.playerKey||"");room.players.push({id:socket.id,name:safeName(data.name),playerKey:joiningKey,profileStats:profileStatsFor(joiningKey,data.profileStats),profilePhoto:safeProfilePhoto(data.profilePhoto)});socket.join(room.code);
  sendProfileStats(socket,room.players[room.players.length-1]);
  if(typeof ack==='function')ack({ok:true,room:publicRoom(room)});broadcast(room);
 });
 socket.on('tournament:start',(data={},ack)=>{
  const room=getRoom(data.code);if(!room)return replyError(ack,'Sala não encontrada.');
  if(room.hostId!==socket.id)return replyError(ack,'Somente o criador pode iniciar o torneio.');
  if(room.started)return replyError(ack,'Este torneio já foi iniciado.');
  if(room.players.length!==room.size)return replyError(ack,'Aguarde preencher todas as vagas.');
  room.started=true;room.bracket=makeBracket(room.players);const payload={players:room.players.map(p=>({id:p.id,name:p.name})),bracket:room.bracket,settings:room.settings};
  io.to(room.code).emit('tournament:started',payload);if(typeof ack==='function')ack({ok:true,bracket:room.bracket});
 });
 // ALTERADO AQUI - cria uma sala de partida exclusiva para os dois finalistas e identifica seus lugares.
 socket.on('match:join',(data={},ack)=>{
  const room=getRoom(data.code);if(!room||!room.started)return replyError(ack,'Torneio não encontrado ou ainda não iniciado.');
  const bracketMatchId=String(data.matchId||'R0M0');
  const found=findBracketMatch(room,bracketMatchId);if(!found)return replyError(ack,'Confronto não encontrado no chaveamento.');
  const bracketMatch=found.match;
  if(bracketMatch.completed||bracketMatch.winner||bracketMatch.status)return replyError(ack,'Esta partida já foi encerrada.');
  if(!bracketMatch.a?.id||!bracketMatch.b?.id)return replyError(ack,'Este confronto ainda aguarda a definição dos dois participantes.');
  const playerKey=String(data.playerKey||'');
  let slot=bracketMatch.a.id===socket.id||!!playerKey&&bracketMatch.a.playerKey===playerKey?0:bracketMatch.b.id===socket.id||!!playerKey&&bracketMatch.b.playerKey===playerKey?1:-1;
  if(slot<0)return replyError(ack,'Somente os dois participantes deste confronto podem jogar.');
  const roomPlayer=room.players.find(p=>(playerKey&&p.playerKey===playerKey)||p.id===socket.id);
  if(roomPlayer&&roomPlayer.id!==socket.id){
   const oldId=roomPlayer.id;roomPlayer.id=socket.id;if(room.hostId===oldId)room.hostId=socket.id;
   const updatePlayer=entry=>{if(!entry||typeof entry!=='object')return;if(entry.playerKey===roomPlayer.playerKey)entry.id=socket.id;Object.values(entry).forEach(value=>{if(Array.isArray(value))value.forEach(updatePlayer);else if(value&&typeof value==='object')updatePlayer(value);});};
   updatePlayer(room.bracket);
  }
  const participant=bracketMatch[slot===0?'a':'b'];
  if(roomPlayer){participant.id=socket.id;participant.playerKey=roomPlayer.playerKey||participant.playerKey;participant.profilePhoto=roomPlayer.profilePhoto||participant.profilePhoto||'';participant.profileStats=profileStatsFor(roomPlayer.playerKey,roomPlayer.profileStats||participant.profileStats||{});}
  const matchId=room.code+':'+bracketMatch.matchId;
  let match=matches.get(matchId);
  if(!match){match={id:matchId,code:room.code,bracketMatchId:bracketMatch.matchId,players:[null,null],participants:[null,null],state:null,currentPlayer:0,started:false,ended:false,inactivityTimers:[null,null],lastActivity:[0,0]};matches.set(matchId,match);}
  if(match.ended){if(typeof ack==='function')ack({ok:true,matchId,slot,players:[bracketMatch.a.name,bracketMatch.b.name],state:match.state,ready:false,ended:true,forfeit:match.forfeit||null,settings:room.settings});return;}
  match.players[slot]=socket.id;match.participants[slot]={...participant};socket.join(room.code);socket.join(matchId);
  const playerNames=[bracketMatch.a.name,bracketMatch.b.name];
  if(typeof ack==='function')ack({ok:true,matchId,bracketMatchId,slot,players:playerNames,playerProfiles:[bracketMatch.a.profileStats||{},bracketMatch.b.profileStats||{}],state:match.state,ready:match.players.every(Boolean),ended:!!match.ended,forfeit:match.forfeit||null,settings:room.settings});
  io.to(matchId).emit('match:presence',{players:match.players.map(Boolean),names:playerNames});
  if(match.players.every(Boolean)){
   match.started=true;
   if(!match.lastActivity.some(Boolean)){match.lastActivity=[Date.now(),Date.now()];resetMatchInactivity(match,0);resetMatchInactivity(match,1);}
   io.to(matchId).emit('match:ready',{matchId,names:playerNames,state:match.state,currentPlayer:match.currentPlayer});
   if(!match.state)io.to(match.players[0]).emit('match:initialize-request',{matchId});
   else io.to(matchId).emit('match:state',match.state);
  }
 });
 // ALTERADO AQUI - qualquer interação na mesa renova somente o relógio invisível daquele jogador.
 socket.on('match:activity',(data={},ack)=>{
  const match=matches.get(String(data.matchId||''));
  if(!match||!match.started||match.ended)return replyError(ack,'Partida online indisponível.');
  const slot=match.players.indexOf(socket.id);
  if(slot<0)return replyError(ack,'Você não pertence a esta partida.');
  resetMatchInactivity(match,slot);
  if(typeof ack==='function')ack({ok:true});
 });
 // ALTERADO AQUI - apenas o jogador da vez pode anunciar o início de uma tacada.
 socket.on('match:shot-start',(data={},ack)=>{
  const match=matches.get(String(data.matchId||''));if(!match||!match.started||match.ended)return replyError(ack,'Partida online indisponível.');
  const slot=match.players.indexOf(socket.id);if(slot<0||slot!==match.currentPlayer)return replyError(ack,'Ainda não é sua vez de jogar.');
  // ALTERADO AQUI - valida e transmite o estado da tacada no instante do impacto.
  // O adversário recebe posições, velocidades e dados da jogada para iniciar a mesma animação.
  if(!data.state||!Array.isArray(data.state.balls)||data.state.balls.length>16)
   return replyError(ack,'Dados da tacada inválidos.');
  const motionState=data.state;
  if(!motionState.balls.every(ball=>Number.isFinite(ball.x)&&Number.isFinite(ball.y)&&Number.isFinite(ball.vx)&&Number.isFinite(ball.vy)))
   return replyError(ack,'Posições ou velocidades da tacada inválidas.');
  io.to(match.id).emit('match:opponent-shot',{slot,name:safeName(data.name)});
  io.to(match.id).emit('match:shot-motion',{slot,state:motionState});
  if(typeof ack==='function')ack({ok:true});
 });
 // ALTERADO AQUI - retransmite snapshots durante a tacada sem alterar o estado final salvo no servidor.
 socket.on('match:shot-motion',(data={},ack)=>{
  const match=matches.get(String(data.matchId||''));
  if(!match||!match.started||match.ended)return replyError(ack,'Partida online indisponível.');
  const slot=match.players.indexOf(socket.id);
  if(slot<0||slot!==match.currentPlayer)return replyError(ack,'Tacada fora da vez.');
  const motionState=data.state;
  if(!motionState||!Array.isArray(motionState.balls)||motionState.balls.length>16)return replyError(ack,'Dados do movimento inválidos.');
  if(!motionState.balls.every(ball=>Number.isFinite(ball.x)&&Number.isFinite(ball.y)&&Number.isFinite(ball.vx)&&Number.isFinite(ball.vy)))return replyError(ack,'Posições ou velocidades inválidas.');
  socket.to(match.id).emit('match:shot-motion',{slot,state:motionState});
  if(typeof ack==='function')ack({ok:true});
 });
 // ALTERADO AQUI - recebe e replica o estado completo da mesa ao terminar cada tacada.
 socket.on('match:state',(data={},ack)=>{
  const match=matches.get(String(data.matchId||''));if(!match||!match.started||match.ended)return replyError(ack,'Partida online indisponível.');
  const slot=match.players.indexOf(socket.id);if(slot<0)return replyError(ack,'Você não pertence a esta partida.');
  if(data.initial){if(slot!==0||match.state)return replyError(ack,'Estado inicial não autorizado.');}
  else if(slot!==match.currentPlayer)return replyError(ack,'Tacada fora da vez.');
  if(data.timeout&&slot!==match.currentPlayer)return replyError(ack,'Relógio enviado fora da vez.');
  if(!data.state||!Array.isArray(data.state.balls)||data.state.balls.length>16)return replyError(ack,'Estado da mesa inválido.');
  match.state=data.state;resetMatchInactivity(match,slot);match.currentPlayer=Number(data.state.currentPlayer)===1?1:0;
  if(data.state.gameOver){
   const result=data.result||{};
   const winnerSlot=Number(result.winnerSlot);
   if(winnerSlot!==0&&winnerSlot!==1)return replyError(ack,'Resultado final sem vencedor válido.');
   match.ended=true;clearMatchInactivity(match);
   recordRivalryMatch(match,{scoreA:result.scoreA,scoreB:result.scoreB,winnerSlot,type:'score'});
   const room=getRoom(match.code),found=room&&findBracketMatch(room,match.bracketMatchId);
   if(room?.leagueId)recordLeagueResult(room,match,{...result,type:'score'});
   if(room?.leagueId)recordLeagueResult(room,match,{...result,type:'score'});
   if(found){
    const completed=completeBracketMatch(room,found.match,found.roundIndex,found.matchIndex,{
     winnerSlot,scoreA:result.scoreA,scoreB:result.scoreB,type:'score',status:'FINALIZADA'
    });
    match.result=completed?.result||null;
   }
  }
  io.to(match.id).emit('match:state',match.state);
  if(typeof ack==='function')ack({ok:true});
 });
 socket.on('match:history:get',(data={},ack)=>{
  const match=matches.get(String(data.matchId||''));if(!match)return replyError(ack,'Partida não encontrada para consultar o histórico.');
  const slot=match.players.indexOf(socket.id);if(slot<0)return replyError(ack,'Somente os participantes podem consultar este histórico.');
  const a=match.participants?.[0],b=match.participants?.[1];if(!a?.playerKey||!b?.playerKey)return replyError(ack,'Identidade dos jogadores indisponível para o histórico.');
  const pair=rivalryPairKey(a.playerKey,b.playerKey);const records=Array.isArray(rivalryHistory[pair])?rivalryHistory[pair]:[];
  if(typeof ack==='function')ack({ok:true,records:[...records].sort((x,y)=>new Date(x.date)-new Date(y.date))});
 });
 socket.on('match:chat',(data={})=>{
  const match=matches.get(String(data.roomId||''));if(!match||!match.players.includes(socket.id))return;
  io.to(match.id).emit('match:chat',{roomId:match.id,name:safeName(data.name),message:String(data.message||'').slice(0,180)});
 });
 socket.on('disconnect',()=>{
  // ALTERADO AQUI - limpa presença temporária da Liga ao desconectar.
  for(const league of Object.values(leagues)){let changed=false;(league.players||[]).forEach(player=>{if(player.socketId===socket.id){player.socketId=null;changed=true;}});if(changed)persistLeagues();}
  for(const [roomCode,room] of rooms){
   if(!room.started){
    const before=room.players.length;room.players=room.players.filter(p=>p.id!==socket.id);
    if(room.players.length!==before){if(room.players.length===0){rooms.delete(roomCode);continue;}if(room.hostId===socket.id)room.hostId=room.players[0].id;broadcast(room);}
   }
  }
  for(const match of matches.values()){
   const slot=match.players.indexOf(socket.id);
   if(slot>=0)io.to(match.id).emit('match:presence',{players:match.players.map(Boolean),disconnectedSlot:slot});
  }
 });
});
server.listen(PORT,()=>console.log(`8 Ball Tournament multiplayer ativo na porta ${PORT}`));
