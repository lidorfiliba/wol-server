// ════════════════════════════════════════════════════════════════
//  World of Legends — Real-Time Multiplayer Server
//  Shared world (live player positions) + global chat + PvP duels.
//  Runs anywhere: locally, Render, Railway, Fly.io, or your own VPS.
//
//  Start:  npm install  &&  npm start
//  Port:   process.env.PORT || 8080
// ════════════════════════════════════════════════════════════════
import http from 'http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8080;

// ── In-memory state ───────────────────────────────────────────────
// players: id -> { id, name, cls, level, evoStage, world, x, y, facing, hp, maxHp, ws, lastSeen, partyId }
const players = new Map();
// parties: partyId -> { id, leader, members:Set<id> }
const parties = new Map();
let nextPartyId = 1;

let nextId = 1;
const now = () => Date.now();

// ── Helpers ───────────────────────────────────────────────────────
function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}
function broadcast(type, data, exceptId = null) {
  const msg = JSON.stringify({ type, ...data });
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  }
}
// Broadcast only to players in the same world (so you see who's near you)
function broadcastWorld(world, type, data, exceptId = null) {
  const msg = JSON.stringify({ type, ...data });
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.world !== world) continue;
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  }
}
// Public snapshot of a player (no ws handle)
function pub(p) {
  return { id: p.id, name: p.name, cls: p.cls, level: p.level,
           evoStage: p.evoStage, world: p.world, x: p.x, y: p.y,
           facing: p.facing, hp: p.hp, maxHp: p.maxHp, partyId: p.partyId || null };
}
function worldPeers(world, exceptId) {
  const list = [];
  for (const p of players.values()) {
    if (p.world === world && p.id !== exceptId) list.push(pub(p));
  }
  return list;
}

// ── HTTP server (health check + info page) ────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      players: players.size,
      parties: parties.size,
      uptime: Math.round(process.uptime()),
    }));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ── WebSocket server ──────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const id = nextId++;
  ws._wolId = id;
  // The player isn't "joined" until they send a join message.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(ws, id, msg);
  });

  ws.on('close', () => handleDisconnect(id));
  ws.on('error', () => handleDisconnect(id));

  // Tell the client its assigned id
  send(ws, 'welcome', { id });
});

function handleMessage(ws, id, msg) {
  switch (msg.type) {
    case 'join': {
      // msg: { name, cls, level, evoStage, world, x, y }
      const p = {
        id,
        name: (msg.name || 'גיבור').slice(0, 16),
        cls: msg.cls || 'warrior',
        level: msg.level || 1,
        evoStage: msg.evoStage || 0,
        world: msg.world || 'meadow',
        x: msg.x || 0, y: msg.y || 0, facing: 1,
        hp: msg.hp || 100, maxHp: msg.maxHp || 100,
        ws, lastSeen: now(),
      };
      players.set(id, p);
      // Send the new player the list of everyone already in their world
      send(ws, 'peers', { peers: worldPeers(p.world, id) });
      // Tell others in the world that a new player joined
      broadcastWorld(p.world, 'playerJoined', { player: pub(p) }, id);
      // ── Shared monsters: set the world tier and send the current monster list ──
      if(!NON_SHARED.has(p.world)){
        const st = worldState(p.world);
        if(msg.worldTier) st.tier = msg.worldTier;
        send(ws, 'monstersSpawn', { monsters: [...st.monsters.values()].map(m=>({mid:m.mid,x:m.x,y:m.y,hp:m.hp,maxHp:m.maxHp,level:m.level,kind:m.kind})), full:true });
        const wb = worldBosses.get(p.world);
        if(wb) send(ws, 'worldBossSpawn', { bid:wb.bid, x:wb.x, y:wb.y, hp:wb.hp, maxHp:wb.maxHp, level:wb.level, name:wb.name });
      }
      // System chat
      broadcast('chat', { from: 'מערכת', text: `${p.name} התחבר לעולם`, sys: true });
      console.log(`[+] ${p.name} (#${id}) joined ${p.world}. Online: ${players.size}`);
      break;
    }

    case 'move': {
      // msg: { x, y, facing }
      const p = players.get(id); if (!p) break;
      p.x = msg.x; p.y = msg.y; p.facing = msg.facing ?? p.facing;
      p.hp = msg.hp ?? p.hp; p.lastSeen = now();
      // Relay to others in the same world (lightweight, no echo back)
      broadcastWorld(p.world, 'peerMove',
        { id, x: p.x, y: p.y, facing: p.facing, hp: p.hp }, id);
      break;
    }

    case 'changeWorld': {
      const p = players.get(id); if (!p) break;
      const oldWorld = p.world;
      broadcastWorld(oldWorld, 'playerLeft', { id }, id);
      p.world = msg.world;
      p.x = msg.x || 0; p.y = msg.y || 0;
      send(ws, 'peers', { peers: worldPeers(p.world, id) });
      broadcastWorld(p.world, 'playerJoined', { player: pub(p) }, id);
      // shared monsters for the new world
      if(!NON_SHARED.has(p.world)){
        const st = worldState(p.world);
        if(msg.worldTier) st.tier = msg.worldTier;
        send(ws, 'monstersSpawn', { monsters: [...st.monsters.values()].map(m=>({mid:m.mid,x:m.x,y:m.y,hp:m.hp,maxHp:m.maxHp,level:m.level,kind:m.kind})), full:true });
      }
      break;
    }

    case 'monsterHit': {
      // a player damaged a shared monster: { mid, damage }
      const p = players.get(id); if (!p) break;
      if(NON_SHARED.has(p.world)) break;
      const st = worldState(p.world);
      const m = st.monsters.get(msg.mid);
      if(!m || m.hp<=0) break;
      m.hp -= Math.max(0, msg.damage|0);
      if(m.hp<=0){
        st.monsters.delete(msg.mid);
        // base XP for this monster (server-authoritative, scales with level)
        const baseXp = Math.round(20 + (m.level||1)*12);
        // who shares the XP? the killer's party members in the SAME world, else just the killer.
        let recipients = [id];
        let bonus = 1;
        if(p.partyId && parties.has(p.partyId)){
          const party = parties.get(p.partyId);
          const inWorld = [...party.members].filter(mid=>{ const mp=players.get(mid); return mp && mp.world===p.world; });
          if(inWorld.length>0) recipients = inWorld;
          // party-size XP bonus: 2→1.15, 3→1.3, 4+ (with distinct classes) →1.5
          const sz = inWorld.length;
          const classes = new Set(inWorld.map(mid=>players.get(mid)?.cls));
          if(sz>=4 && classes.size>=4) bonus = 1.5;
          else if(sz>=4) bonus = 1.4;
          else if(sz===3) bonus = 1.3;
          else if(sz===2) bonus = 1.15;
        }
        const sharedXp = Math.round(baseXp * bonus);
        const sharedGold = Math.round((5 + (m.level||1)*3) * bonus);
        // tell everyone it died (for the death animation + kill credit)
        broadcastWorld(p.world, 'monsterDead', { mid: msg.mid, byId: id, byName: p.name, x:Math.round(m.x), y:Math.round(m.y), level:m.level });
        // grant shared XP + gold to each recipient individually
        recipients.forEach(mid=>{
          const mp = players.get(mid);
          if(mp) send(mp.ws, 'partyXp', { xp: sharedXp, gold: sharedGold, bonus, partySize: recipients.length, from: p.name });
        });
      } else {
        broadcastWorld(p.world, 'monsterHp', { mid: msg.mid, hp: m.hp });
      }
      break;
    }

    case 'monsterMove': {
      // lightweight: a client (the "host" nearest) nudges a monster's position
      const p = players.get(id); if (!p || NON_SHARED.has(p.world)) break;
      const st = worldState(p.world);
      const m = st.monsters.get(msg.mid);
      if(m){ m.x = msg.x; m.y = msg.y; }
      break;
    }

    case 'worldBossHit': {
      const p = players.get(id); if(!p) break;
      const boss = worldBosses.get(p.world);
      if(!boss || boss.bid!==msg.bid || boss.hp<=0) break;
      boss.hp -= Math.max(0, msg.damage|0);
      // track contributors for reward eligibility
      if(!boss._hitters) boss._hitters = new Set();
      boss._hitters.add(id);
      if(boss.hp<=0){
        worldBosses.delete(p.world);
        const st = worldState(p.world); st._lastBoss = Date.now();
        // BIG rewards to everyone who helped + is still in the world
        const baseXp = 2000 + (boss.level||1)*200;
        const baseGold = 5000 + (boss.level||1)*300;
        for(const hid of boss._hitters){
          const hp_ = players.get(hid);
          if(hp_ && hp_.world===p.world){
            send(hp_.ws, 'worldBossReward', { xp:baseXp, gold:baseGold, name:boss.name, killer:p.name });
          }
        }
        broadcastWorld(p.world, 'worldBossDead', { bid:boss.bid, byName:p.name, x:Math.round(boss.x), y:Math.round(boss.y) });
        broadcast('chat', { from:'מערכת', text:`🏆 ${boss.name} הובס! ${p.name} נתן את המכה הסופית. כל העוזרים תוגמלו!`, sys:true });
      } else {
        broadcastWorld(p.world, 'worldBossHp', { bid:boss.bid, hp:boss.hp });
      }
      break;
    }

    case 'chat': {
      const p = players.get(id); if (!p) break;
      const text = (msg.text || '').slice(0, 200);
      if (!text.trim()) break;
      broadcast('chat', { from: p.name, level: p.level, text, fromId: id });
      break;
    }

    case 'stats': {
      // periodic level/hp/evolution update
      const p = players.get(id); if (!p) break;
      if (msg.level != null) p.level = msg.level;
      if (msg.evoStage != null) p.evoStage = msg.evoStage;
      if (msg.maxHp != null) p.maxHp = msg.maxHp;
      broadcastWorld(p.world, 'peerStats',
        { id, level: p.level, evoStage: p.evoStage, maxHp: p.maxHp }, id);
      break;
    }

    // ── REAL-TIME PvP: attacker tells server "I hit player X for N".
    //    Server relays to the victim, who applies damage locally and
    //    broadcasts their new HP (or death) to the world. ──
    case 'pvpHit': {
      // msg: { targetId, damage, knockX, knockY }
      const attacker = players.get(id);
      const victim = players.get(msg.targetId);
      if (!attacker || !victim) break;
      if (attacker.world !== victim.world) break;          // must be same map
      // no friendly fire within a party
      if (attacker.partyId && attacker.partyId === victim.partyId) break;
      const dmg = Math.max(1, Math.min(999999, msg.damage | 0));
      send(victim.ws, 'pvpHurt', {
        fromId: id, fromName: attacker.name, damage: dmg,
        knockX: msg.knockX || 0, knockY: msg.knockY || 0,
      });
      break;
    }
    // Victim reports their HP after taking damage (so others' bars update)
    case 'pvpHp': {
      const p = players.get(id); if (!p) break;
      p.hp = msg.hp;
      broadcastWorld(p.world, 'peerHp', { id, hp: p.hp, maxHp: p.maxHp }, id);
      break;
    }
    // Victim died — tell the world (killer gets credit)
    case 'pvpDeath': {
      const p = players.get(id); if (!p) break;
      broadcastWorld(p.world, 'peerDeath', { id, killerId: msg.killerId || null }, id);
      const killer = players.get(msg.killerId);
      if (killer) {
        send(killer.ws, 'pvpKill', { victimId: id, victimName: p.name });
        broadcast('chat', { from: 'מערכת', text: `⚔️ ${killer.name} חיסל את ${p.name}!`, sys: true });
      }
      break;
    }

    // ── PARTIES ──────────────────────────────────────────────────
    case 'partyCreate': {
      const p = players.get(id); if (!p || p.partyId) break;
      const pid = nextPartyId++;
      parties.set(pid, { id: pid, leader: id, members: new Set([id]) });
      p.partyId = pid;
      send(p.ws, 'partyUpdate', partyInfo(pid));
      broadcastWorld(p.world, 'peerParty', { id, partyId: pid }, id);
      break;
    }
    case 'partyInvite': {
      const p = players.get(id), target = players.get(msg.targetId);
      if (!p || !target || !p.partyId) break;
      send(target.ws, 'partyInvited', { fromId: id, fromName: p.name, partyId: p.partyId });
      break;
    }
    case 'partyJoin': {
      const p = players.get(id); const party = parties.get(msg.partyId);
      if (!p || !party || p.partyId) break;
      party.members.add(id); p.partyId = party.id;
      broadcastWorld(p.world, 'peerParty', { id, partyId: party.id }, id);
      for (const mid of party.members) {
        const mp = players.get(mid); if (mp) send(mp.ws, 'partyUpdate', partyInfo(party.id));
      }
      break;
    }
    case 'partyLeave': {
      leaveParty(id);
      break;
    }
  }
}

function partyInfo(pid) {
  const party = parties.get(pid);
  if (!party) return { partyId: null, members: [] };
  const members = [];
  for (const mid of party.members) {
    const mp = players.get(mid);
    if (mp) members.push({ id: mp.id, name: mp.name, level: mp.level, hp: mp.hp, maxHp: mp.maxHp, leader: mid === party.leader });
  }
  return { partyId: pid, leader: party.leader, members };
}

function leaveParty(id) {
  const p = players.get(id);
  if (!p || !p.partyId) return;
  const party = parties.get(p.partyId);
  const oldPid = p.partyId;
  p.partyId = null;
  if (party) {
    party.members.delete(id);
    if (party.leader === id && party.members.size > 0) {
      party.leader = party.members.values().next().value; // promote someone
    }
    if (party.members.size === 0) {
      parties.delete(oldPid);
    } else {
      for (const mid of party.members) {
        const mp = players.get(mid); if (mp) send(mp.ws, 'partyUpdate', partyInfo(oldPid));
      }
    }
  }
  send(p.ws, 'partyUpdate', { partyId: null, members: [] });
  broadcastWorld(p.world, 'peerParty', { id, partyId: null }, id);
}

function handleDisconnect(id) {
  const p = players.get(id);
  if (!p) return;
  leaveParty(id);
  broadcastWorld(p.world, 'playerLeft', { id }, id);
  broadcast('chat', { from: 'מערכת', text: `${p.name} התנתק`, sys: true });
  players.delete(id);
  console.log(`[-] ${p.name} (#${id}) left. Online: ${players.size}`);
}

// ════════════════════════════════════════════════════════════════
//  SHARED MONSTERS — the server owns monsters per world so every
//  player in a world sees and fights the SAME monsters together.
//  Only "social" overworld zones share monsters (not dungeon/pvp/town).
// ════════════════════════════════════════════════════════════════
const WORLD_W = 3000, WORLD_H = 3000;
// monster archetypes scale by world tier (sent by client on join as worldTier)
const sharedWorlds = new Map(); // world -> { monsters:Map<mid,{...}>, lastSpawn }
let nextMid = 1;
// worlds that are NOT shared (handled fully client-side)
const NON_SHARED = new Set(['town','arena','forge_dungeon']);

function worldState(world){
  if(!sharedWorlds.has(world)) sharedWorlds.set(world, { monsters:new Map(), tier:1 });
  return sharedWorlds.get(world);
}
function playersInWorld(world){ let n=0; for(const p of players.values()) if(p.world===world) n++; return n; }

function spawnMonsterFor(world, tier){
  const st = worldState(world);
  const mid = 'm'+(nextMid++);
  // HP/level scale with the world tier the client reported
  const lvl = 1 + tier*8 + Math.floor(Math.random()*tier*4);
  const maxHp = Math.round((40 + tier*tier*30) * (1 + Math.random()*0.5));
  const m = {
    mid, x: 200+Math.random()*(WORLD_W-400), y: 200+Math.random()*(WORLD_H-400),
    hp: maxHp, maxHp, level: lvl, tier,
    kind: Math.floor(Math.random()*4), // visual variant for the client
    vx:0, vy:0,
  };
  st.monsters.set(mid, m);
  return m;
}

// Spawn + broadcast loop: keep each populated shared world stocked.
const MONSTER_CAP = 14;
setInterval(()=>{
  for(const [world, st] of sharedWorlds){
    if(NON_SHARED.has(world)) continue;
    const pc = playersInWorld(world);
    if(pc===0){ st.monsters.clear(); continue; } // no players → clear to save memory
    // spawn up to the cap
    let spawned=[];
    while(st.monsters.size < MONSTER_CAP){
      spawned.push(spawnMonsterFor(world, st.tier||1));
    }
    if(spawned.length){
      broadcastWorld(world, 'monstersSpawn', { monsters: spawned.map(m=>({mid:m.mid,x:m.x,y:m.y,hp:m.hp,maxHp:m.maxHp,level:m.level,kind:m.kind})) });
    }
  }
}, 2000);

// Periodic light position sync (monsters drift toward nearest player handled client-side;
// server just keeps authoritative HP + presence and resyncs positions occasionally).
setInterval(()=>{
  for(const [world, st] of sharedWorlds){
    if(NON_SHARED.has(world) || st.monsters.size===0) continue;
    if(playersInWorld(world)===0) continue;
    const snap = [...st.monsters.values()].map(m=>({mid:m.mid,x:Math.round(m.x),y:Math.round(m.y),hp:m.hp}));
    broadcastWorld(world, 'monstersSync', { monsters: snap });
  }
}, 1000);

// ════════════════════════════════════════════════════════════════
//  WORLD BOSS — a giant shared boss with massive HP. Spawns when 2+
//  players share a world; needs a group to defeat. Everyone in the
//  world who helped gets big rewards.
// ════════════════════════════════════════════════════════════════
const worldBosses = new Map(); // world -> { bid, hp, maxHp, level, x, y, name, spawnedAt, lastSpawn }
let nextBid = 1;
const BOSS_NAMES = ['גולגולת התהום','לויתן הצללים','מלך הדרקונים','האל השבור','טיטאן הקדמון'];

setInterval(()=>{
  for(const [world, st] of sharedWorlds){
    if(NON_SHARED.has(world)) continue;
    const pc = playersInWorld(world);
    const existing = worldBosses.get(world);
    // clear boss if world emptied
    if(pc===0){ if(existing) worldBosses.delete(world); continue; }
    // spawn a world boss if 2+ players and none active and cooldown passed
    if(pc>=2 && !existing){
      const last = st._lastBoss||0;
      if(Date.now()-last > 90000){ // at most one every 90s
        const tier = st.tier||1;
        const maxHp = Math.round((8000 + tier*tier*4000) * pc); // scales with players
        const boss = { bid:'B'+(nextBid++), hp:maxHp, maxHp, level:5+tier*10,
          x:WORLD_W/2, y:WORLD_H/2, name:BOSS_NAMES[Math.floor(Math.random()*BOSS_NAMES.length)],
          spawnedAt:Date.now() };
        worldBosses.set(world, boss);
        st._lastBoss = Date.now();
        broadcastWorld(world, 'worldBossSpawn', { bid:boss.bid, x:boss.x, y:boss.y, hp:boss.hp, maxHp:boss.maxHp, level:boss.level, name:boss.name });
        broadcast('chat', { from:'מערכת', text:`⚠️ בוס עולם הופיע: ${boss.name}! התאגדו כדי להביסו!`, sys:true });
      }
    }
    // boss despawns if not killed in 5 minutes
    if(existing && Date.now()-existing.spawnedAt > 300000){
      worldBosses.delete(world);
      broadcastWorld(world, 'worldBossGone', { bid:existing.bid });
    }
  }
}, 3000);

// ── Heartbeat: drop dead connections ──────────────────────────────
const heartbeat = setInterval(() => {
  for (const p of players.values()) {
    const ws = p.ws;
    if (ws.isAlive === false) { ws.terminate(); handleDisconnect(p.id); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  console.log(`\n🗡️  World of Legends multiplayer server`);
  console.log(`    listening on port ${PORT}`);
  console.log(`    WebSocket: ws://localhost:${PORT}`);
  console.log(`    Health:    http://localhost:${PORT}/health\n`);
});
