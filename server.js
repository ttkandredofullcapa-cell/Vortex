const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const ALLOWED=(process.env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean); // ex.: https://meujogo.com (vazio = qualquer origem)
const io = new Server(server, { cors: { origin: ALLOWED.length?ALLOWED:'*', methods: ['GET', 'POST'] }, maxHttpBufferSize: 1e6, pingInterval: 20000, pingTimeout: 40000 });
app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');next()});
// Um erro inesperado num evento não pode derrubar o servidor (e todas as salas) no Render.
process.on('uncaughtException',e=>console.error('uncaughtException',e));
process.on('unhandledRejection',e=>console.error('unhandledRejection',e));
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const MAP_COUNT = 5;
const REVIVE_RANGE = 250; // ~5 metros (50 unidades do jogo = 1 metro)
const REVIVE_SECONDS = 5;
const ROOM_CLOCK_MS = 1000;
const COLORS = ['#45e5ff','#ff5b82','#f4d35e','#8bff72','#bb86fc','#ff9e52','#62a7ff','#f5f5f5'];

app.get('/', (req,res)=>res.json({game:'VORTEX LEGENDS',status:'online',service:'multiplayer-api',version:'1.11.1'}));
app.get('/health',(req,res)=>res.json({status:'ok',rooms:rooms.size,version:'1.11.1'}));
function makeId(){return crypto.randomBytes(3).toString('hex').toUpperCase();}
function hashPassword(password,salt){return crypto.pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex');}
function playerPublic(p){return {id:p.id,name:p.name,ready:p.ready,color:p.color,x:p.x,y:p.y,angle:p.angle,characterId:p.characterId||null,mapId:p.mapId??0,downed:!!p.downed,reviveProgress:p.reviveStartedAt?Math.max(0,(Date.now()-p.reviveStartedAt)/1000):0};}
function publicRoom(room){return {id:room.id,name:room.name,mode:room.mode,host:room.host,players:Array.from(room.players.values()).map(playerPublic),count:room.players.size,maxPlayers:room.maxPlayers,hasPassword:!!room.passwordHash,status:room.status,mapId:room.mapId};}
function getRooms(){return Array.from(rooms.values()).map(publicRoom);}
function sendRoom(room){io.to('room:'+room.id).emit('room:update',publicRoom(room));io.emit('rooms:list',getRooms());}
function closeRoom(room,reason='empty'){
 if(!rooms.has(room.id))return;rooms.delete(room.id);const ch='room:'+room.id;io.to(ch).emit('room:closed',{reason});
 for(const id of room.players.keys()){const s=io.sockets.sockets.get(id);if(s){s.leave(ch);s.roomId=null;s.onlineRoomId=null;}}
 io.emit('rooms:list',getRooms());
}
function removePlayer(room,id){const p=room.players.get(id);if(!p)return;room.players.delete(id);const s=io.sockets.sockets.get(id);if(s){s.leave('room:'+room.id);s.roomId=null;s.onlineRoomId=null;}
 if(!room.players.size){closeRoom(room,'empty');return;}
 // Preserve the room when its host leaves: promote the first remaining member.
 if(room.host===id){room.host=room.players.keys().next().value;const promoted=room.players.get(room.host);if(promoted)promoted.ready=room.status==='playing'||promoted.ready;io.to('room:'+room.id).emit('host:changed',{host:room.host,previousHost:id});}
 io.to('room:'+room.id).emit('player:left',{id});sendRoom(room);
}
function validPosition(d){const x=Number(d.x),y=Number(d.y),angle=Number(d.angle||0);if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(angle)||Math.abs(x)>1e7||Math.abs(y)>1e7||Math.abs(angle)>1e6)return null;return{x,y,angle};}

/* ===== SEGURANÇA ===== */
// 1) Anti-flood: limite de eventos por conexão (balde de fichas) e por IP (conexões simultâneas)
const ipConns=new Map();
io.use((socket,next)=>{const ip=String(socket.handshake.headers['x-forwarded-for']||socket.handshake.address||'').split(',')[0].trim();socket.ip=ip;const n=ipConns.get(ip)||0;if(n>=40)return next(new Error('Muitas conexões deste IP.'));ipConns.set(ip,n+1);socket.on('disconnect',()=>{const c=(ipConns.get(ip)||1)-1;if(c<=0)ipConns.delete(ip);else ipConns.set(ip,c)});next()});
io.on('connection',socket=>{
  socket.bucket={t:300,at:Date.now(),strikes:0};
  socket.use((packet,next)=>{const b=socket.bucket,now=Date.now();b.t=Math.min(300,b.t+(now-b.at)*0.2);b.at=now; // 200 eventos/s, rajada 300
    if(b.t<1){if(++b.strikes>200){try{socket.disconnect(true)}catch(e){}}return;}
    b.t-=1;
    try{const s=JSON.stringify(packet[1]);if(s&&s.length>60000)return;}catch(e){return}
    next();});
  // 2) Login do dono validado NO SERVIDOR (a senha não fica mais no HTML). Defina OWNER_USER e OWNER_PASS no Render.
  socket.on('owner:login',(d={},cb=()=>{})=>{
    const OU=process.env.OWNER_USER,OP=process.env.OWNER_PASS;
    if(!OU||!OP)return cb({ok:false,error:'Painel do dono desativado: defina OWNER_USER e OWNER_PASS no servidor.'});
    const now=Date.now();socket.ownerTries=(socket.ownerTries||[]).filter(x=>now-x<600000);
    const g=ownerFails.get(socket.ip)||[];const gg=g.filter(x=>now-x<900000);
    if(socket.ownerTries.length>=5||gg.length>=8)return cb({ok:false,error:'Muitas tentativas. Aguarde alguns minutos.'});
    const h=x=>crypto.createHash('sha256').update(String(x||'')).digest();
    const ok=crypto.timingSafeEqual(h(d.u),h(OU))&crypto.timingSafeEqual(h(d.p),h(OP));
    if(!ok){socket.ownerTries.push(now);gg.push(now);ownerFails.set(socket.ip,gg);return cb({ok:false,error:'Acesso negado.'})}
    cb({ok:true});
  });
});
const ownerFails=new Map();

io.on('connection',socket=>{
 const _on=socket.on.bind(socket);
 socket.on=(ev,fn)=>_on(ev,(...a)=>{try{return fn(...a)}catch(e){console.error('socket handler',ev,e);const cb=a[a.length-1];if(typeof cb==='function'){try{cb({ok:false,error:'Erro interno do servidor.'})}catch(_){}}}});
 socket.roomId=null;socket.onlineRoomId=null;socket.playerName='Jogador';socket.lastPositionAt=0;socket.lastMobHitAt=0;socket.emit('server:welcome',{message:'Conectado ao VORTEX LEGENDS',id:socket.id});socket.emit('rooms:list',getRooms());
 socket.on('rooms:search',(q='')=>{const term=String(q).toLowerCase().trim();socket.emit('rooms:searchResult',getRooms().filter(r=>r.name.toLowerCase().includes(term)||r.id.toLowerCase().includes(term)));});
 socket.on('room:create',(d={},cb=()=>{})=>{
  if(socket.roomId)return cb({ok:false,error:'Você já está em uma sala.'});
  const name=String(d.name||'Sala').trim().slice(0,30),playerName=String(d.playerName||'Jogador').trim().slice(0,20),password=String(d.password||''),maxPlayers=Number(d.maxPlayers??4),mode=String(d.mode||'Normal').slice(0,20),mapId=0;
  if(!Number.isInteger(maxPlayers)||maxPlayers<0)return cb({ok:false,error:'Limite de jogadores inválido.'}); // 0 = sem limite
  if(password.length>32)return cb({ok:false,error:'Senha muito longa.'});
  if(!Number.isInteger(mapId)||mapId<0||mapId>=MAP_COUNT)return cb({ok:false,error:'Mapa inválido.'});
  let id;do{id=makeId();}while(rooms.has(id));const salt=password?crypto.randomBytes(16).toString('hex'):null;
  const room={id,name,mode,host:socket.id,maxPlayers,mapId:Number.isInteger(d.mapId)?d.mapId:0,players:new Map(),passwordSalt:salt,passwordHash:password?hashPassword(password,salt):null,status:'waiting',createdAt:Date.now(),runStartedAt:0,runElapsed:0,teamDown:false,mobSnapshot:null,orbSnapshot:[],lastMobSnapshotAt:0,lastPlayerDamageAt:0};
  if(room.mapId<0||room.mapId>=MAP_COUNT)return cb({ok:false,error:'Mapa inválido.'});
  room.players.set(socket.id,{id:socket.id,name:playerName,ready:false,color:COLORS[0],x:0,y:0,angle:0,characterId:d.characterId||null,mapId:room.mapId,charUnlocked:!!d.charUnlocked,mapUnlocked:!!d.mapUnlocked,downed:false,reviveStartedAt:0});
  rooms.set(id,room);socket.roomId=id;socket.playerName=playerName;socket.join('room:'+id);sendRoom(room);cb({ok:true,room:publicRoom(room)});
 });
 socket.on('room:join',(d={},cb=()=>{})=>{
  if(socket.roomId)return cb({ok:false,error:'Você já está em uma sala.'});
  const room=rooms.get(String(d.id||'').toUpperCase());if(!room)return cb({ok:false,error:'Sala não encontrada.'});
  if(room.maxPlayers>0&&room.players.size>=room.maxPlayers)return cb({ok:false,error:'Sala cheia.'});
  const password=String(d.password||'');if(room.passwordHash&&hashPassword(password,room.passwordSalt)!==room.passwordHash)return cb({ok:false,error:'Senha incorreta.'});if(room.status==='playing'&&(!d.charUnlocked||!d.mapUnlocked||Number(d.mapId)!==room.mapId))return cb({ok:false,error:'Desbloqueie o personagem e o mapa da sala antes de entrar em partida iniciada.'});
  const playerName=String(d.playerName||'Jogador').trim().slice(0,20),color=COLORS[room.players.size%COLORS.length];
  room.players.set(socket.id,{id:socket.id,name:playerName,ready:room.status==='playing',color,x:0,y:0,angle:0,characterId:d.characterId||null,mapId:room.status==='playing'?room.mapId:(Number.isInteger(d.mapId)?d.mapId:room.mapId),charUnlocked:!!d.charUnlocked,mapUnlocked:!!d.mapUnlocked,downed:false,reviveStartedAt:0});
  socket.roomId=room.id;socket.playerName=playerName;socket.join('room:'+room.id);sendRoom(room);
  if(room.status==='playing'){socket.emit('game:start',{roomId:room.id,players:Array.from(room.players.values()).map(playerPublic),mode:room.mode,lateJoin:true,mapId:room.mapId});socket.emit('room:clock',{roomId:room.id,elapsed:Math.max(0,(Date.now()-room.runStartedAt)/1000),teamDown:room.teamDown});if(room.mobSnapshot)socket.emit('mob:snapshot',{...room.mobSnapshot,orbs:room.orbSnapshot||[]});}
  cb({ok:true,room:publicRoom(room)});
 });
 socket.on('room:ready',(d={},cb=()=>{})=>{if(typeof d==='function'){cb=d;d={};}const room=rooms.get(socket.roomId);if(!room)return cb({ok:false,error:'Você não está em uma sala.'});if(room.status!=='waiting')return cb({ok:false,error:'A partida já começou.'});const p=room.players.get(socket.id);if(!p)return cb({ok:false,error:'Jogador não encontrado.'});if(!p.ready){const mapId=Number(d.mapId);if(!d.charUnlocked)return cb({ok:false,error:'Desbloqueie seu personagem antes de ficar pronto.'});if(!d.mapUnlocked)return cb({ok:false,error:'Desbloqueie o mapa antes de ficar pronto.'});if(!Number.isInteger(mapId)||mapId<0||mapId>=MAP_COUNT)return cb({ok:false,error:'Mapa selecionado inválido.'});if(mapId!==room.mapId)return cb({ok:false,error:'Selecione/desbloqueie o mapa escolhido pelo host no lobby.'});p.characterId=String(d.characterId||p.characterId||'').slice(0,40);p.mapId=mapId;p.charUnlocked=!!d.charUnlocked;p.mapUnlocked=!!d.mapUnlocked;p.ready=true;}else p.ready=false;sendRoom(room);cb({ok:true,ready:p.ready});});
 socket.on('room:start',(cb=()=>{})=>{const room=rooms.get(socket.roomId);if(!room)return cb({ok:false,error:'Sala não encontrada.'});if(room.host!==socket.id)return cb({ok:false,error:'Somente o host pode iniciar.'});if(room.status!=='waiting')return cb({ok:false,error:'A partida já está em andamento.'});if(!Array.from(room.players.values()).every(p=>p.ready))return cb({ok:false,error:'Todos precisam estar prontos.'});if(!Array.from(room.players.values()).every(p=>p.charUnlocked&&p.mapUnlocked&&Number.isInteger(p.mapId)))return cb({ok:false,error:'Todos precisam desbloquear personagem e mapa.'});const chosenMap=room.players.get(room.host)?.mapId??room.mapId;if(!Array.from(room.players.values()).every(p=>p.mapId===chosenMap))return cb({ok:false,error:'Todos devem selecionar o mesmo mapa do host.'});room.mapId=chosenMap;room.status='playing';room.runStartedAt=Date.now();room.runElapsed=0;room.teamDown=false;room.mobSnapshot=null;room.orbSnapshot=[];room.lastMobSnapshotAt=0;sendRoom(room);io.to('room:'+room.id).emit('game:start',{roomId:room.id,players:Array.from(room.players.values()).map(playerPublic),mode:room.mode,mapId:room.mapId});cb({ok:true});});
 socket.on('player:position',d=>{const now=Date.now();if(now-socket.lastPositionAt<50)return;socket.lastPositionAt=now;const room=rooms.get(socket.roomId);if(!room||room.status!=='playing'||String(d.roomId)!==room.id)return;const p=room.players.get(socket.id);if(!p)return;const pos=validPosition(d);if(!pos)return;p.x=pos.x;p.y=pos.y;p.angle=pos.angle;if(d.characterId!==undefined&&d.characterId!==null)p.characterId=String(d.characterId).slice(0,40);if(typeof d.downed==='boolean')p.downed=d.downed;socket.to('room:'+room.id).emit('players:position',playerPublic(p));});
 socket.on('player:down',d=>{const room=rooms.get(socket.roomId);if(!room||room.status!=='playing'||String(d?.roomId)!==room.id)return;const p=room.players.get(socket.id);if(!p)return;const pos=validPosition(d);if(pos){p.x=pos.x;p.y=pos.y;}p.downed=true;p.reviveStartedAt=0;io.to('room:'+room.id).emit('player:down',{id:p.id,x:p.x,y:p.y});sendRoom(room);if(room.players.size>1&&Array.from(room.players.values()).every(q=>q.downed)){room.teamDown=true;io.to('room:'+room.id).emit('room:allDown',{roomId:room.id,players:Array.from(room.players.values()).map(playerPublic),elapsed:Math.max(0,(Date.now()-room.runStartedAt)/1000)});}});
 socket.on('player:revived',d=>{const room=rooms.get(socket.roomId);if(!room||room.status!=='playing'||String(d?.roomId)!==room.id)return;const p=room.players.get(socket.id);if(!p)return;p.downed=false;p.reviveStartedAt=0;room.teamDown=false;io.to('room:'+room.id).emit('player:revived',{id:p.id});sendRoom(room);});
 socket.on('room:teamRevive', (cb=()=>{})=>{if(typeof cb!=='function')cb=()=>{};const room=rooms.get(socket.roomId);if(!room||room.status!=='playing')return cb({ok:false,error:'Partida online não encontrada.'});if(!room.teamDown||!Array.from(room.players.values()).every(p=>p.downed))return cb({ok:false,error:'A equipe inteira precisa estar caída para reviver todos.'});if(!room.players.get(socket.id)?.downed)return cb({ok:false,error:'Somente um jogador caído pode pedir o revive coletivo.'});room.teamDown=false;room.mobSnapshot=null;room.orbSnapshot=[];room.lastMobSnapshotAt=0;room.runStartedAt=Date.now();room.runElapsed=0;for(const p of room.players.values()){p.downed=false;p.reviveStartedAt=0;}io.to('room:'+room.id).emit('room:teamRevive',{roomId:room.id,elapsed:0,players:Array.from(room.players.values()).map(playerPublic)});sendRoom(room);cb({ok:true});});

 socket.on('mob:snapshot',d=>{
  const room=rooms.get(socket.roomId);if(!room||room.status!=='playing'||room.host!==socket.id||String(d?.roomId)!==room.id)return;
  const now=Date.now();if(now-room.lastMobSnapshotAt<120)return;room.lastMobSnapshotAt=now;if(!Array.isArray(d.mobs))return;
  const mobs=d.mobs.slice(0,40).map(m=>{const key=String(m.key||'').slice(0,40),id=String(m.id||'').slice(0,60),x=Number(m.x),y=Number(m.y),hp=Number(m.hp),mhp=Number(m.mhp);if(!key||!id||!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(hp)||!Number.isFinite(mhp))return null;const o={id,key,x,y,hp:Math.max(0,Math.min(hp,1e12)),mhp:Math.max(1,Math.min(mhp,1e12)),dead:!!m.dead};const props=['st','ct','ot','ph','sl','boss','el','bn','dmgM','spdM','final','at2','chT','chD','cx','cy','chS','chL','cdh','enr','sn','hf','fx','__vxAggroId','__vxAggroUntil','__vxTargetId'];for(const k of props){const v=m[k];if(typeof v==='number'&&Number.isFinite(v))o[k]=Math.max(-1e7,Math.min(1e7,v));else if(typeof v==='boolean'||typeof v==='string')o[k]=v;}return o;}).filter(Boolean).filter(m=>m.boss||m.final);const orbs=[];//XP orbs são locais de cada jogador; o servidor não as repassa
room.orbSnapshot=orbs;room.mobSnapshot={roomId:room.id,seq:Number(d.seq)||now,mobs};socket.to('room:'+room.id).emit('mob:snapshot',{...room.mobSnapshot,orbs});
 });
 socket.on('mob:hit',d=>{const room=rooms.get(socket.roomId);if(!room||room.status!=='playing'||String(d?.roomId)!==room.id||socket.id===room.host)return;const now=Date.now();if(now-socket.lastMobHitAt<30)return;socket.lastMobHitAt=now;const mobId=String(d.mobId||'').slice(0,60),damage=Number(d.damage);if(!mobId||!Number.isFinite(damage)||damage<=0||damage>5e5)return;{const n2=Date.now();socket.dmgW=socket.dmgW&&n2-socket.dmgW.t<1000?socket.dmgW:{t:n2,s:0};socket.dmgW.s+=damage;if(socket.dmgW.s>3e6)return;}const host=io.sockets.sockets.get(room.host);if(host)host.emit('mob:hit:apply',{roomId:room.id,mobId,damage:Math.min(5e5,damage)});});
 socket.on('player:mobDamage',d=>{const room=rooms.get(socket.roomId);if(!room||room.status!=='playing'||String(d?.roomId)!==room.id||room.host!==socket.id)return;const playerId=String(d.playerId||''),damage=Number(d.damage),victim=room.players.get(playerId);if(!victim||playerId===socket.id||victim.downed||!Number.isFinite(damage)||damage<=0||damage>1e7)return;const target=io.sockets.sockets.get(playerId);if(target)target.emit('player:mobDamage',{roomId:room.id,playerId,damage:Math.min(1e7,damage)});});
 socket.on('room:kick',(pid,cb=()=>{})=>{const room=rooms.get(socket.roomId);if(!room)return cb({ok:false,error:'Sala não encontrada.'});if(room.host!==socket.id)return cb({ok:false,error:'Somente o host pode expulsar.'});if(pid===room.host)return cb({ok:false,error:'Não pode expulsar o host.'});if(!room.players.has(pid))return cb({ok:false,error:'Jogador não encontrado.'});const target=io.sockets.sockets.get(pid);if(target)target.emit('room:kicked');removePlayer(room,pid);cb({ok:true});});
 socket.on('room:leave',(cb=()=>{})=>{const room=rooms.get(socket.roomId);if(room)removePlayer(room,socket.id);cb({ok:true});});
 // ===== VOICE CHAT SIGNALING (WebRTC, room-scoped) =====
 socket.on('voice:join',d=>{const room=rooms.get(socket.roomId);const requested=String(d?.roomId||'');if(!room||room.status!=='playing'||requested!==room.id||!room.players.has(socket.id)){socket.emit('voice:join-denied',{roomId:requested,reason:'Voz disponível somente durante uma partida online ativa.'});return;}room.voiceUsers=room.voiceUsers||new Set();if(room.voiceUsers.has(socket.id)){socket.emit('voice:joined',{roomId:room.id,alreadyJoined:true});return;}const peers=[...room.voiceUsers].filter(id=>id!==socket.id);room.voiceUsers.add(socket.id);socket.emit('voice:joined',{roomId:room.id});socket.emit('voice:peers',{roomId:room.id,peers});socket.to('room:'+room.id).emit('voice:peer-joined',{roomId:room.id,id:socket.id});});
 socket.on('voice:leave',d=>{const room=rooms.get(socket.roomId);if(!room||String(d?.roomId)!==room.id||!room.voiceUsers?.has(socket.id))return;room.voiceUsers.delete(socket.id);socket.to('room:'+room.id).emit('voice:peer-left',{roomId:room.id,id:socket.id});});
 socket.on('voice:signal',d=>{const room=rooms.get(socket.roomId);if(!room||String(d?.roomId)!==room.id||!room.voiceUsers?.has(socket.id))return;const targetId=String(d?.to||''),target=io.sockets.sockets.get(targetId),signal=d?.signal;if(!target||target.roomId!==room.id||!room.voiceUsers.has(targetId)||!signal||typeof signal!=='object')return;const payload=JSON.stringify(signal);if(payload.length>16000)return;target.emit('voice:signal',{roomId:room.id,from:socket.id,signal});});
 socket.on('voice:mute',d=>{const room=rooms.get(socket.roomId);if(!room||String(d?.roomId)!==room.id||!room.voiceUsers?.has(socket.id))return;socket.to('room:'+room.id).emit('voice:muted',{roomId:room.id,id:socket.id,muted:!!d.muted});});

 socket.on('disconnect',()=>{const room=rooms.get(socket.roomId);if(room){if(room.voiceUsers?.delete(socket.id))socket.to('room:'+room.id).emit('voice:peer-left',{roomId:room.id,id:socket.id});removePlayer(room,socket.id);}});
});
setInterval(()=>{
  const now=Date.now();
  for(const room of rooms.values()){
    if(room.status!=='playing'||!room.runStartedAt)continue;
    const elapsed=Math.max(0,(now-room.runStartedAt)/1000);
    io.to('room:'+room.id).emit('room:clock',{roomId:room.id,elapsed,teamDown:room.teamDown});
  }
},ROOM_CLOCK_MS);

setInterval(()=>{for(const room of rooms.values()){if(room.status!=='playing')continue;const alive=Array.from(room.players.values()).filter(p=>!p.downed);for(const down of room.players.values()){if(!down.downed)continue;const helper=alive.find(p=>p.id!==down.id&&Math.hypot(p.x-down.x,p.y-down.y)<=REVIVE_RANGE);if(helper){if(!down.reviveStartedAt)down.reviveStartedAt=Date.now();const elapsed=(Date.now()-down.reviveStartedAt)/1000;io.to('room:'+room.id).emit('player:revive:progress',{id:down.id,seconds:elapsed,helperId:helper.id});if(elapsed>=REVIVE_SECONDS){down.downed=false;down.reviveStartedAt=0;io.to('room:'+room.id).emit('player:revived',{id:down.id,by:helper.id});sendRoom(room);}}else if(down.reviveStartedAt){down.reviveStartedAt=0;io.to('room:'+room.id).emit('player:revive:progress',{id:down.id,seconds:0});}}}},500);
server.listen(PORT,'0.0.0.0',()=>console.log('VORTEX multiplayer API v1.11.1 online port '+PORT));
