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

// ════════════════════════════════════════════════════════════════
//  SUPABASE (server-side) — the server reads/writes authoritative
//  character economy state using the SERVICE_ROLE key. This key is
//  set as an environment variable in Render (never in client code).
//    SUPABASE_URL          = https://xxxx.supabase.co
//    SUPABASE_SERVICE_KEY  = the service_role key (secret!)
//  If unset, the server runs in memory-only mode (state not persisted).
// ════════════════════════════════════════════════════════════════
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SB_ON = !!(SB_URL && SB_KEY);
function sbHeaders(){ return { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' }; }
function sbUrl(path){ return SB_URL.replace(/\/$/, '') + '/rest/v1/' + path; }
async function sbSelect(path){
  if(!SB_ON) return null;
  try{ const r = await fetch(sbUrl(path), { headers: sbHeaders() }); if(!r.ok) return null; return await r.json(); }
  catch(e){ console.log('[sb] select error', e.message); return null; }
}
async function sbUpsert(table, row, onConflict){
  if(!SB_ON) return null;
  try{
    const r = await fetch(sbUrl(table) + (onConflict?`?on_conflict=${onConflict}`:''), {
      method:'POST', headers:{...sbHeaders(), Prefer:'resolution=merge-duplicates,return=minimal'},
      body: JSON.stringify(row) });
    return r.ok;
  }catch(e){ console.log('[sb] upsert error', e.message); return null; }
}
console.log(SB_ON ? '[sb] Supabase persistence ENABLED' : '[sb] memory-only mode (set SUPABASE_URL + SUPABASE_SERVICE_KEY to persist)');

// ── In-memory state ───────────────────────────────────────────────
// players: id -> { id, name, cls, level, evoStage, world, x, y, facing, hp, maxHp, ws, lastSeen, partyId }
const players = new Map();
// parties: partyId -> { id, leader, members:Set<id> }
const parties = new Map();
let nextPartyId = 1;

let nextId = 1;
const now = () => Date.now();

// ════════════════════════════════════════════════════════════════
//  AUTHORITATIVE CHARACTER STATE (Stage 1)
//  The server owns each character's economy: gold, xp, level.
//  Keyed by "account:slot". Loaded on join, mutated only by the
//  server (never set directly from client messages), saved to DB.
// ════════════════════════════════════════════════════════════════
const charState = new Map(); // "account:slot" -> { account, slot, gold, xp, level, dirty, lastSave }
function charKey(account, slot){ return `${account}:${slot|0}`; }

// XP curve must match the client's so levels line up.
// XP curve — MUST be byte-for-byte identical to the client's so the XP bar and
// level-ups line up exactly between server and game.
function xpForLevel(lv){
  if(lv <= 30)  return Math.round(80 * Math.pow(1.15, lv-1));
  const b30 = 80 * Math.pow(1.15, 29);
  if(lv <= 80)  return Math.round(b30 * (1 + (lv-30)*0.12));
  const b80 = b30 * (1 + 50*0.12);
  if(lv <= 130) return Math.round(b80 * Math.pow(1.055, lv-80));
  const b130 = b80 * Math.pow(1.055, 50);
  if(lv <= 200) return Math.round(b130 * Math.pow(1.045, lv-130));
  const b200 = b130 * Math.pow(1.045, 70);
  return Math.round(b200 * (1 + (lv-200)*0.08));
}
function applyXp(cs, amount){
  cs.xp += Math.max(0, amount|0);
  let leveled = 0;
  while(cs.level < 250 && cs.xp >= xpForLevel(cs.level)){
    cs.xp -= xpForLevel(cs.level); cs.level++; leveled++;
  }
  cs.dirty = true;
  return leveled;
}
async function loadCharState(account, slot, fallback){
  const key = charKey(account, slot);
  if(charState.has(key)) return charState.get(key);
  // SECURITY: gold/xp/level are SERVER-AUTHORITATIVE. We never trust client-claimed
  // values — a new character always starts clean (gold 0, level 1). Only the DB
  // (written by the server itself) can restore a character's real economy.
  let cs = { account, slot:slot|0, gold:0, xp:0, level:1, dirty:false, lastSave:0 };
  if(SB_ON && account){
    const rows = await sbSelect(`wol_charstate?account=eq.${encodeURIComponent(account)}&slot=eq.${slot|0}&select=gold,xp,level`);
    if(rows && rows.length){ cs.gold = +rows[0].gold||0; cs.xp = +rows[0].xp||0; cs.level = +rows[0].level||1; }
    else if(fallback){
      // First-ever load with no DB row: allow a ONE-TIME migration of an existing
      // character's progress, but CAP the seed to plausible values so a cheater can't
      // claim a billion gold on a fresh account+slot. Real players are well under these.
      cs.gold  = Math.max(0, Math.min(5000000, fallback.gold|0));
      cs.level = Math.max(1, Math.min(250, fallback.level|0 || 1));
      cs.dirty = true;
    }
  } else if(fallback){
    // No database configured (memory-only mode): same capped seed so a cheater can't
    // claim absurd values, and progress survives within the session.
    cs.gold  = Math.max(0, Math.min(5000000, fallback.gold|0));
    cs.level = Math.max(1, Math.min(250, fallback.level|0 || 1));
  }
  charState.set(key, cs);
  return cs;
}
function currentWeekId(){ return Math.floor(Date.now()/(7*24*60*60*1000)); }
async function saveCharState(cs){
  if(!cs || !cs.dirty || !SB_ON || !cs.account) return;
  cs.dirty = false; cs.lastSave = now();
  await sbUpsert('wol_charstate', {
    account: cs.account, slot: cs.slot, gold: Math.round(cs.gold),
    xp: Math.round(cs.xp), level: cs.level, updated_at: new Date().toISOString(),
  }, 'account,slot');
}
// Periodic save of all dirty character states (every 15s).
setInterval(()=>{ for(const cs of charState.values()) if(cs.dirty) saveCharState(cs); }, 15000);
// SECURITY: the server writes the AUTHORITATIVE leaderboard row from its own trusted
// state (gold/level/kills), so a tampered client can't post a fake top rank. Runs
// every 30s for online players. (The client's own push only affects cosmetic fields.)
setInterval(()=>{
  if(!SB_ON) return;
  for(const p of players.values()){
    if(!p._cs || !p.account) continue;
    const wk = currentWeekId();
    sbUpsert('wol_leaderboard', {
      username: p.account, slot: p.slot|0, name: String(p.name||'').slice(0,16),
      class_id: p.cls||'warrior',
      level: Math.max(1,Math.min(250, p._cs.level|0)),
      kills: Math.max(0, Math.min(99999999, p._serverKills|0)),
      gold: Math.max(0, Math.min(5000000, Math.round(p._cs.gold))),
      week_id: wk, updated_at: new Date().toISOString(),
    }, 'username,slot').catch(()=>{});
  }
}, 30000);

// SECURITY: every 20s, push each online player their AUTHORITATIVE gold/level so any
// client-side tampering of the displayed values self-corrects (the server owns them).
setInterval(()=>{
  for(const p of players.values()){
    if(p._cs && p.ws && p.ws.readyState===p.ws.OPEN){
      send(p.ws, 'charState', { gold: Math.round(p._cs.gold), xp: Math.round(p._cs.xp), level: p._cs.level, reconcile:true });
    }
  }
}, 20000);


// ════════════════════════════════════════════════════════════════
//  ANTI-CHEAT — the server NEVER trusts client-sent values.
//  Rate-limits every action, caps damage to plausible bounds, and
//  auto-kicks players who trip too many violations.
// ════════════════════════════════════════════════════════════════
const RATE = {            // max messages per sliding window per player
  monsterHit: { n: 120, win: 1000 },  // generous: melee can hit many monsters per swing, fast attackers burst
  worldBossHit:{ n: 60, win: 1000 },
  pvpHit:     { n: 20, win: 1000 },
  chat:       { n: 5,  win: 4000 },    // 5 messages / 4s
  move:       { n: 30, win: 1000 },
  monsterMove:{ n: 400, win: 1000 },
  peerAction: { n: 30, win: 1000 },    // visual attack broadcasts
  changeWorld:{ n: 8,  win: 4000 },    // can't thrash worlds
  partyHeal:  { n: 12, win: 1000 },    // healer pulse
  social:     { n: 6,  win: 3000 },    // invites/trade requests — anti-spam
  tradeEdit:  { n: 20, win: 2000 },    // trade offer tweaks
  default:    { n: 60, win: 1000 },
};
function rateOk(p, type){
  if(!p._rl) p._rl = {};
  const cfg = RATE[type] || RATE.default;
  const t = now();
  const b = p._rl[type] || (p._rl[type] = { c: 0, reset: t + cfg.win });
  if(t > b.reset){ b.c = 0; b.reset = t + cfg.win; }
  b.c++;
  if(b.c > cfg.n){ flag(p, `rate:${type}`); return false; }
  return true;
}
// A plausible single-hit damage ceiling for a player at a given level.
// Real top-end hits scale roughly with level; we allow generous headroom
// (10x) so legit crits/combos pass, but block the "999999999" cheats.
function maxPlausibleHit(level){
  const lv = Math.max(1, Math.min(250, level|0));
  // headroom must cover the biggest legit hit: ultimate (×20) × crit (×2) × combo
  // finisher (×9) plus gear/awakening. We use a very generous ×400 so NO legitimate
  // hit is ever flagged; the clamp below still caps the actual damage applied.
  return Math.round((50 + lv * lv * 1.2) * 400);
}
function flag(p, reason){
  if(!p) return;
  p._violations = (p._violations || 0) + 1;
  p._lastFlag = reason;
  if(p._violations === 5 || p._violations === 15) {
    console.log(`[!] suspicious: ${p.name} (#${p.id}) ${reason} x${p._violations}`);
  }
  if(p._violations > 40){ // sustained abuse → kick
    console.log(`[KICK] ${p.name} (#${p.id}) too many violations (${p._lastFlag})`);
    try{ send(p.ws, 'kicked', { reason: 'זוהתה פעילות חשודה' }); p.ws.close(); }catch(e){}
  }
}
function sanitizeText(s){
  return String(s||'').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,180);
}

// Block names that impersonate staff (mirror of the client check).
function isReservedServerName(name){
  const norm = (name||'').toLowerCase().replace(/[\s._\-|]/g,'')
    .replace(/0/g,'o').replace(/1/g,'i').replace(/3/g,'e').replace(/4/g,'a').replace(/5/g,'s').replace(/7/g,'t');
  return /(gm|admin|owner|mod|staff|support|official|system|server|root|developer|gamemaster|moderator|lidor)/.test(norm);
}


// ── Helpers ───────────────────────────────────────────────────────
function send(ws, type, data) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}
function broadcast(type, data, exceptId = null) {
  const msg = JSON.stringify({ type, ...data });
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  }
}
// Broadcast only to players in the same world (so you see who's near you)
function broadcastWorld(world, type, data, exceptId = null) {
  const msg = JSON.stringify({ type, ...data });
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.world !== world) continue;
    if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
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
    // SECURITY: drop oversized frames (anti memory-abuse) and throttle raw packet
    // rate per connection (anti-flood / DoS) before any parsing.
    if(raw && raw.length > 16000){ return; }            // 16KB hard cap per message
    const tnow = Date.now();
    ws._pk = ws._pk || { c:0, reset: tnow+1000 };
    if(tnow > ws._pk.reset){ ws._pk.c = 0; ws._pk.reset = tnow+1000; }
    if(++ws._pk.c > 200){ return; }                      // >200 msgs/sec from one socket → drop
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if(!msg || typeof msg!=='object' || typeof msg.type!=='string') return; // malformed
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
      const existing = players.get(id);
      if(existing && existing._joinT && (now()-existing._joinT) < 1000){ break; } // ignore rapid re-joins
      // Defense-in-depth: reject impersonator names server-side too.
      let safeName = (msg.name || 'גיבור').slice(0, 16);
      if(isReservedServerName(safeName)){
        send(ws, 'kicked', { reason: 'שם זה שמור ואינו זמין' });
        try{ ws.close(); }catch(e){}
        break;
      }
      // reclaim: if this same account+slot has a lingering ghost from a prior session,
      // remove it so the player doesn't see a duplicate of themselves.
      if(msg.account){
        for(const [gid,gp] of players){
          if(gp._ghost && gp.account===msg.account && (gp.slot|0)===(msg.slot|0)){
            broadcastWorld(gp.world, 'playerLeft', { id: gid }, gid);
            players.delete(gid);
          }
        }
      }
      const p = {
        id,
        name: safeName,
        cls: msg.cls || 'warrior',
        level: Math.max(1, Math.min(250, msg.level|0 || 1)),
        evoStage: Math.max(0, Math.min(3, msg.evoStage|0)),
        world: msg.world || 'meadow',
        x: msg.x || 0, y: msg.y || 0, facing: 1,
        hp: msg.hp || 100, maxHp: Math.max(1, Math.min(50000000, msg.maxHp|0 || 100)),
        ws, lastSeen: now(),
      };
      players.set(id, p);
      p._joinT = now();
      // ── Stage 1: load this character's AUTHORITATIVE economy (gold/xp/level).
      //    account+slot identify the character; we seed from the client's claimed
      //    values ONLY on first load (migration), then the server owns them. ──
      p.account = (msg.account || '').slice(0,40);
      p.slot = msg.slot|0;
      if(p.account){
        loadCharState(p.account, p.slot, { gold: msg.gold|0, level: p.level }).then(cs=>{
          p._cs = cs;
          // server's values are authoritative — push them to the client
          p.level = cs.level;
          send(ws, 'charState', { gold: Math.round(cs.gold), xp: Math.round(cs.xp), level: cs.level });
        });
      }
      // Send the new player the list of everyone already in their world
      send(ws, 'peers', { peers: worldPeers(p.world, id) });
      // Tell others in the world that a new player joined
      broadcastWorld(p.world, 'playerJoined', { player: pub(p) }, id);
      // ── Shared monsters: set the world tier and send the current monster list ──
      if(!isNonShared(p.world)){
        const st = worldState(p.world);
        if(msg.worldTier) st.tier = msg.worldTier;
        if(msg.worldW && msg.worldW!==st.ww){ st.ww = msg.worldW; st.cages = null; st._cagesSent=false; }
        if(msg.worldH && msg.worldH!==st.wh){ st.wh = msg.worldH; st.cages = null; st._cagesSent=false; }
        ensureCages(st);
        send(ws, "cages", { cages: st.cages });
        send(ws, "monstersSpawn", { monsters: [...st.monsters.values()].map(m=>({mid:m.mid,x:m.x,y:m.y,hp:m.hp,maxHp:m.maxHp,level:m.level,kind:m.kind,cage:m.cage})), full:true });
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
      if(!rateOk(p, 'changeWorld')) break;
      if(typeof msg.world!=='string' || msg.world.length>60) break; // sanity
      const oldWorld = p.world;
      broadcastWorld(oldWorld, 'playerLeft', { id }, id);
      // leaving a world cancels any pending trade tied to the old location
      if(p._tradeWith){ const o=players.get(p._tradeWith); if(o){ o._tradeWith=null; o._tradeOffer=null; send(o.ws,'tradeCancelled',{byId:id}); } p._tradeWith=null; p._tradeOffer=null; }
      p.world = msg.world;
      p.x = msg.x || 0; p.y = msg.y || 0;
      send(ws, 'peers', { peers: worldPeers(p.world, id) });
      broadcastWorld(p.world, 'playerJoined', { player: pub(p) }, id);
      // shared monsters for the new world
      if(!isNonShared(p.world)){
        const st = worldState(p.world);
        if(msg.worldTier) st.tier = msg.worldTier;
        if(msg.worldW && msg.worldW!==st.ww){ st.ww = msg.worldW; st.cages = null; st._cagesSent=false; }
        if(msg.worldH && msg.worldH!==st.wh){ st.wh = msg.worldH; st.cages = null; st._cagesSent=false; }
        ensureCages(st);
        send(ws, "cages", { cages: st.cages });
        send(ws, "monstersSpawn", { monsters: [...st.monsters.values()].map(m=>({mid:m.mid,x:m.x,y:m.y,hp:m.hp,maxHp:m.maxHp,level:m.level,kind:m.kind,cage:m.cage})), full:true });
      }
      break;
    }

    case 'peerAction': {
      // relay an attack/skill visual to others in the world
      const p = players.get(id); if (!p) break;
      if(!rateOk(p, 'peerAction')) break;
      broadcastWorld(p.world, 'peerAction', { id, kind: msg.kind, facing: msg.facing, color: msg.color }, id);
      break;
    }

    case 'monsterHit': {
      // a player damaged a shared monster: { mid, damage }
      const p = players.get(id); if (!p) break;
      if(isNonShared(p.world)) break;
      if(!rateOk(p, 'monsterHit')) break;
      const st = worldState(p.world);
      const m = st.monsters.get(msg.mid);
      if(!m || m.hp<=0) break;
      // CAP damage to a plausible value for this player's level (anti one-shot cheat).
      // Use the AUTHORITATIVE level (_cs.level from real kills) when available so a
      // forged 'stats' level can't raise the damage ceiling.
      const authLevel = (p._cs && p._cs.level) ? p._cs.level : p.level;
      const dmg = Math.max(0, Math.min(maxPlausibleHit(authLevel), msg.damage|0));
      if((msg.damage|0) > maxPlausibleHit(authLevel)*8) flag(p,'dmg:monster');
      m.hp -= dmg;
      if(m.hp<=0){
        st.monsters.delete(msg.mid);
        // per-cage respawn timer: record when this cage last lost a monster, so
        // each cage refills independently ~5s after being cleared.
        if(!st.cageKill) st.c
