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
      // tell old world we left
      broadcastWorld(oldWorld, 'playerLeft', { id }, id);
      p.world = msg.world;
      p.x = msg.x || 0; p.y = msg.y || 0;
      // send peers in the new world
      send(ws, 'peers', { peers: worldPeers(p.world, id) });
      broadcastWorld(p.world, 'playerJoined', { player: pub(p) }, id);
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
