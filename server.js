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
        if(!st.cageKill) st.cageKill = {};
        if(m.cage>=0) st.cageKill[m.cage] = Date.now();
        // base XP — matches the client formula (8 + lv^1.5 * 0.55) so progression
        // is identical online and offline.
        const baseXp = Math.max(4, Math.round(8 + Math.pow(m.level||1, 1.5)*0.55));
        // who shares the XP? the killer's party members in the SAME world, else just the killer.
        let recipients = [id];
        let bonus = 1;
        if(p.partyId && parties.has(p.partyId)){
          const party = parties.get(p.partyId);
          // A party member only shares the XP if they are: in the SAME world, within
          // 20 levels of the killer, AND physically near the kill (so you can't park a
          // low/idle alt across the map and leech). The killer always qualifies.
          const SHARE_RANGE = 1400;
          const inWorld = [...party.members].filter(mid=>{
            const mp=players.get(mid); if(!mp || mp.world!==p.world) return false;
            if(mid===id) return true;
            if(Math.abs((mp.level||1)-(p.level||1)) > 20) return false;
            if(Math.hypot((mp.x||0)-(m.x||0),(mp.y||0)-(m.y||0)) > SHARE_RANGE) return false;
            return true;
          });
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
        // grant shared XP + gold to each recipient — into their AUTHORITATIVE state.
        // credit the killer with an authoritative kill (used for the trusted leaderboard)
        p._serverKills = (p._serverKills|0) + 1;
        recipients.forEach(mid=>{
          const mp = players.get(mid);
          if(!mp) return;
          if(mp._cs){
            mp._cs.gold += sharedGold;
            const leveled = applyXp(mp._cs, sharedXp);
            mp.level = mp._cs.level;
            // send the new authoritative totals (client just displays them)
            send(mp.ws, 'charState', { gold: Math.round(mp._cs.gold), xp: Math.round(mp._cs.xp), level: mp._cs.level, gainXp: sharedXp, gainGold: sharedGold, bonus, leveled });
          } else {
            // no account/state yet — fall back to the old client-side grant
            send(mp.ws, 'partyXp', { xp: sharedXp, gold: sharedGold, bonus, partySize: recipients.length, from: p.name });
          }
        });
      } else {
        broadcastWorld(p.world, 'monsterHp', { mid: msg.mid, hp: m.hp });
      }
      break;
    }

    case 'monsterMove': {
      // lightweight: a client (the "host" nearest) nudges a monster's position
      const p = players.get(id); if (!p || isNonShared(p.world)) break;
      const st = worldState(p.world);
      const m = st.monsters.get(msg.mid);
      if(m){ m.x = msg.x; m.y = msg.y; }
      break;
    }

    case 'worldBossHit': {
      const p = players.get(id); if(!p) break;
      if(!rateOk(p, 'worldBossHit')) break;
      const boss = worldBosses.get(p.world);
      if(!boss || boss.bid!==msg.bid || boss.hp<=0) break;
      const dmg = Math.max(0, Math.min(maxPlausibleHit(p.level), msg.damage|0));
      if((msg.damage|0) > maxPlausibleHit(p.level)*1.5) flag(p,'dmg:boss');
      boss.hp -= dmg;
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
      if(!rateOk(p, 'chat')) break; // spam guard
      const text = sanitizeText(msg.text);
      if (!text.trim()) break;
      broadcast('chat', { from: p.name, level: p.level, text, fromId: id });
      break;
    }
    case 'whisper': {
      const p = players.get(id); if(!p) break;
      if(!rateOk(p, 'chat')) break;
      const text = sanitizeText(msg.text); if(!text.trim()) break;
      const target = players.get(msg.targetId); if(!target) break;
      // deliver to recipient and echo to sender so both see the thread
      send(target.ws, 'whisper', { fromId:id, fromName:p.name, text, mine:false });
      send(p.ws,      'whisper', { fromId:msg.targetId, fromName:target.name, text, mine:true });
      break;
    }

    case 'stats': {
      // periodic level/hp/evolution update — CLAMP to valid ranges (anti fake-rank)
      const p = players.get(id); if (!p) break;
      if (!rateOk(p, 'default')) break;
      if (msg.level != null) p.level = Math.max(1, Math.min(250, msg.level|0));
      if (msg.evoStage != null) p.evoStage = Math.max(0, Math.min(3, msg.evoStage|0));
      if (msg.maxHp != null) p.maxHp = Math.max(1, Math.min(50000000, msg.maxHp|0));
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
      if (!rateOk(attacker, 'pvpHit')) break;
      if (attacker.world !== victim.world) break;          // must be same map
      // no friendly fire within a party
      if (attacker.partyId && attacker.partyId === victim.partyId) break;
      // cap PvP damage to the attacker's plausible max (anti one-shot)
      const _alvl = (attacker._cs && attacker._cs.level) ? attacker._cs.level : attacker.level;
      const dmg = Math.max(1, Math.min(maxPlausibleHit(_alvl), msg.damage | 0));
      if((msg.damage|0) > maxPlausibleHit(_alvl)*8) flag(attacker,'dmg:pvp');
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
      if (!p || !rateOk(p,'social')) break;
      if (!target || !p.partyId) break;
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
    // ── HEALER PALADIN: relay a heal pulse to nearby party members ──
    case 'partyHeal': {
      const p = players.get(id);
      if(!p || !rateOk(p,'partyHeal')) break;
      if(!p.partyId || !parties.has(p.partyId)) break;
      const amt = Math.max(0, Math.min(99999, msg.amount|0));
      if(amt<=0) break;
      const party = parties.get(p.partyId);
      for(const mid of party.members){
        if(mid===id) continue;
        const mp = players.get(mid);
        if(mp && mp.world===p.world && Math.hypot((mp.x||0)-(p.x||0),(mp.y||0)-(p.y||0)) < 600){
          send(mp.ws, 'partyHealed', { amount: amt, from: p.name });
        }
      }
      break;
    }
    // ── PLAYER TRADE (relayed; the swap itself is confirmed on both clients) ──
    case 'tradeRequest': {
      const p = players.get(id), target = players.get(msg.targetId);
      if(!p || !rateOk(p,'social')) break;
      if(!target || p.world!==target.world) break;
      if(p._tradeWith || target._tradeWith) { send(p.ws,'tradeBusy',{}); break; }
      send(target.ws, 'tradeRequested', { fromId: id, fromName: p.name, level: p.level });
      break;
    }
    case 'tradeAccept': {
      const p = players.get(id), other = players.get(msg.fromId);
      if(!p || !other || p.world!==other.world) break;
      if(p._tradeWith || other._tradeWith){ send(p.ws,'tradeBusy',{}); break; }
      p._tradeWith = other.id; other._tradeWith = p.id;
      p._tradeOffer = {items:[],gold:0,confirm:false}; other._tradeOffer = {items:[],gold:0,confirm:false};
      send(p.ws, 'tradeStart', { withId: other.id, withName: other.name });
      send(other.ws, 'tradeStart', { withId: p.id, withName: p.name });
      break;
    }
    case 'tradeDecline': {
      const other = players.get(msg.fromId);
      if(other) send(other.ws, 'tradeDeclined', { byId: id });
      break;
    }
    case 'tradeOffer': {
      const p = players.get(id); if(!p || !rateOk(p,'tradeEdit') || !p._tradeWith) break;
      const other = players.get(p._tradeWith); if(!other) break;
      // SECURITY: clamp the offered gold to what the server says this player ACTUALLY
      // has (authoritative _cs.gold). You can't offer gold you don't own.
      const myGold = p._cs ? Math.floor(p._cs.gold) : 0;
      const offerGold = Math.max(0, Math.min(myGold, msg.gold|0));
      // updating an offer resets BOTH confirmations (anti-switch scam)
      p._tradeOffer = { items: Array.isArray(msg.items)?msg.items.slice(0,12):[], gold: offerGold, confirm:false };
      if(other._tradeOffer) other._tradeOffer.confirm = false;
      send(p.ws,    'tradeUpdate', { mine: p._tradeOffer, theirs: other._tradeOffer||{items:[],gold:0,confirm:false} });
      send(other.ws,'tradeUpdate', { mine: other._tradeOffer||{items:[],gold:0,confirm:false}, theirs: p._tradeOffer });
      break;
    }
    case 'tradeConfirm': {
      const p = players.get(id); if(!p || !p._tradeWith) break;
      const other = players.get(p._tradeWith); if(!other) break;
      if(p._tradeOffer) p._tradeOffer.confirm = true;
      // when BOTH confirmed → execute
      if(p._tradeOffer && other._tradeOffer && p._tradeOffer.confirm && other._tradeOffer.confirm){
        // SECURITY: re-validate both gold offers against authoritative balances, then
        // move the gold SERVER-SIDE so the economy can't be duped client-side.
        const pGold = Math.max(0, Math.min(p._cs?Math.floor(p._cs.gold):0,    p._tradeOffer.gold|0));
        const oGold = Math.max(0, Math.min(other._cs?Math.floor(other._cs.gold):0, other._tradeOffer.gold|0));
        if(p._cs){ p._cs.gold = p._cs.gold - pGold + oGold; p._cs.dirty=true; }
        if(other._cs){ other._cs.gold = other._cs.gold - oGold + pGold; other._cs.dirty=true; }
        p._tradeOffer.gold = pGold; other._tradeOffer.gold = oGold;
        // items are still applied client-side (client owns inventory), but gold is now
        // authoritative — send each side the corrected balances.
        send(p.ws,    'tradeComplete', { give: p._tradeOffer, receive: other._tradeOffer, newGold: p._cs?Math.round(p._cs.gold):undefined });
        send(other.ws,'tradeComplete', { give: other._tradeOffer, receive: p._tradeOffer, newGold: other._cs?Math.round(other._cs.gold):undefined });
        p._tradeWith=null; p._tradeOffer=null; other._tradeWith=null; other._tradeOffer=null;
      } else {
        send(p.ws,    'tradeUpdate', { mine: p._tradeOffer, theirs: other._tradeOffer||{items:[],gold:0,confirm:false} });
        send(other.ws,'tradeUpdate', { mine: other._tradeOffer||{items:[],gold:0,confirm:false}, theirs: p._tradeOffer });
      }
      break;
    }
    case 'tradeCancel': {
      const p = players.get(id); if(!p) break;
      const other = p._tradeWith ? players.get(p._tradeWith) : null;
      p._tradeWith=null; p._tradeOffer=null;
      if(other){ other._tradeWith=null; other._tradeOffer=null; send(other.ws, 'tradeCancelled', { byId: id }); }
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
  if (p._cs) saveCharState(p._cs); // persist authoritative economy on leave
  // cancel any in-progress trade so the partner isn't left hanging
  if(p._tradeWith){ const other=players.get(p._tradeWith); if(other){ other._tradeWith=null; other._tradeOffer=null; send(other.ws,'tradeCancelled',{byId:id}); } }
  leaveParty(id);
  // ANTI-EXPLOIT: instead of vanishing instantly, the character LINGERS at its last
  // position as a vulnerable "ghost" so a player can't disconnect to dodge death or to
  // park in a forbidden spot. It's removed once killed or after a short grace period.
  // (Skip lingering in non-shared/instanced worlds, where it has no multiplayer effect.)
  if(p.world && !isNonShared(p.world) && !p._ghost){
    p._ghost = true; p._ghostUntil = Date.now() + 60000; // up to 60s
    p.ws = null; // no socket anymore
    broadcastWorld(p.world, 'peerGhost', { id }, id); // tell others it's now an AFK ghost
    console.log(`[~] ${p.name} (#${id}) disconnected → lingering ghost. Online: ${players.size-1}`);
    return; // keep the entity in `players` for now
  }
  broadcastWorld(p.world, 'playerLeft', { id }, id);
  broadcast('chat', { from: 'מערכת', text: `${p.name} התנתק`, sys: true });
  players.delete(id);
  console.log(`[-] ${p.name} (#${id}) left. Online: ${players.size}`);
}
// Remove lingering ghosts once their grace period expires.
setInterval(()=>{
  const now=Date.now();
  for(const [id,p] of players){
    if(p._ghost && (now > p._ghostUntil)){
      broadcastWorld(p.world, 'playerLeft', { id }, id);
      players.delete(id);
    }
  }
}, 5000);

// ════════════════════════════════════════════════════════════════
//  SHARED MONSTERS — the server owns monsters per world so every
//  player in a world sees and fights the SAME monsters together.
//  Only "social" overworld zones share monsters (not dungeon/pvp/town).
// ════════════════════════════════════════════════════════════════
const WORLD_W = 9000, WORLD_H = 9000;
// monster archetypes scale by world tier (sent by client on join as worldTier)
const sharedWorlds = new Map(); // world -> { monsters:Map<mid,{...}>, lastSpawn }
let nextMid = 1;
// worlds that are NOT shared (handled fully client-side)
const NON_SHARED = new Set(['town','arena','forge_dungeon','nest_goblin','nest_shadow','nest_titan']);
// A world id may carry an instance tag for private nests ("nest_goblin#party:42").
// Strip it to test the base id. All nests are non-shared (server doesn't spawn
// their monsters — they're fully client-instanced), but peer routing still uses
// the FULL instanced id so each party/solo player only sees their own instance.
function baseWorld(w){ const i=(w||'').indexOf('#'); return i<0 ? w : w.slice(0,i); }
function isNonShared(w){ return NON_SHARED.has(baseWorld(w)); }

function worldState(world){
  if(!sharedWorlds.has(world)) sharedWorlds.set(world, { monsters:new Map(), tier:1, ww:9000, wh:9000 });
  return sharedWorlds.get(world);
}
function playersInWorld(world){ let n=0; for(const p of players.values()) if(p.world===world) n++; return n; }

function ensureCages(st){
  if(st.cages) return st.cages;
  const ww = st.ww || 9000, wh = st.wh || 9000;
  const margin = 600;
  st.cages=[];
  const minSep = Math.min(1800, Math.max(700, Math.min(ww,wh)/4));
  const SPAWN_CLEAR = 700; // keep cages away from the center spawn outpost (~280r + buffer)
  const cxC = ww/2, cyC = wh/2;
  const nCages = 6;
  for(let i=0;i<nCages;i++){
    let cx,cy,tries=0;
    do{ cx=margin+Math.random()*(ww-margin*2); cy=margin+Math.random()*(wh-margin*2); tries++; }
    while(tries<40 && ( st.cages.some(c=>Math.hypot(c.x-cx,c.y-cy)<minSep) || Math.hypot(cx-cxC,cy-cyC)<SPAWN_CLEAR ));
    st.cages.push({x:cx,y:cy});
  }
  return st.cages;
}
// Spawn a monster into a SPECIFIC cage (cageIdx). Used by the per-cage respawn.
function spawnMonsterForCage(world, tier, cageIdx){
  const st = worldState(world);
  const ww = st.ww || 9000, wh = st.wh || 9000;
  const mid = 'm'+(nextMid++);
  const lvl = Math.max(1, Math.round(tier*tier*0.9 + tier*6) + Math.floor(Math.random()*12));
  const variety = 0.85 + Math.random()*0.5;
  const baseMul = Math.min(2.2, 0.85 + lvl*0.055);
  const lateMul = 1 + Math.max(0, lvl-30) * 0.012; // matches client late-game ramp
  const hpMul = baseMul * lateMul;
  const maxHp = Math.round((35 + lvl*lvl*0.5 + lvl*16) * variety * hpMul); // matches client
  const CAGE_R = 280;
  ensureCages(st);
  let x, y;
  if(cageIdx>=0 && cageIdx<st.cages.length){
    const c=st.cages[cageIdx];
    const a=Math.random()*Math.PI*2, r=Math.random()*CAGE_R;
    x=Math.max(150,Math.min(ww-150, c.x+Math.cos(a)*r));
    y=Math.max(150,Math.min(wh-150, c.y+Math.sin(a)*r));
  } else {
    const margin=600;
    x=margin/2+Math.random()*(ww-margin); y=margin/2+Math.random()*(wh-margin);
  }
  const m = { mid, x, y, hp: maxHp, maxHp, level: lvl, tier, kind: Math.floor(Math.random()*4), vx:0, vy:0, cage:cageIdx };
  st.monsters.set(mid, m);
  return m;
}
// Spawn into the EMPTIEST cage (used for initial population).
function spawnMonsterFor(world, tier){
  const st = worldState(world);
  ensureCages(st);
  let cageIdx = -1;
  if(st.cages.length){
    const counts = new Array(st.cages.length).fill(0);
    for(const mm of st.monsters.values()){ if(mm.cage>=0 && mm.cage<counts.length) counts[mm.cage]++; }
    let best=0; for(let i=1;i<counts.length;i++){ if(counts[i]<counts[best]) best=i; }
    cageIdx = best;
  }
  return spawnMonsterForCage(world, tier, cageIdx);
}

// Monster density: ~18 per cage (engaging but not a mindless swarm). Tougher HP
// (×2.2 in spawn) means each one is a real fight. Snappy ~4s per-cage respawn.
const MONSTER_BASE = 108;    // ~18 per cage across 6 cages
const MONSTER_PER_PLAYER = 10;
const MONSTER_CAP_MAX = 170;
const CAGE_RESPAWN_MS = 4000; // a cage starts refilling 4s after it was reduced
setInterval(()=>{
  for(const [world, st] of sharedWorlds){
    if(isNonShared(world)) continue;
    const pc = playersInWorld(world);
    if(pc===0){ st.monsters.clear(); continue; } // no players → clear to save memory
    ensureCages(st);
    const nCages = st.cages.length || 6;
    const cap = Math.min(MONSTER_CAP_MAX, MONSTER_BASE + pc*MONSTER_PER_PLAYER);
    const perCage = Math.max(8, Math.floor(cap / nCages)); // target monsters per cage
    if(!st.cageKill) st.cageKill = {};
    const nowMs = Date.now();

    // count current population per cage
    const counts = new Array(nCages).fill(0);
    for(const mm of st.monsters.values()){
      if(mm.cage>=0 && mm.cage<nCages) counts[mm.cage]++;
    }

    // refill each cage INDEPENDENTLY toward its target, ~4s after it was reduced.
    // This is INFINITE: every tick that a cage is below target (and past its lull),
    // it tops up — so cleared cages always come back.
    let spawned=[];
    for(let ci=0; ci<nCages; ci++){
      if(counts[ci] >= perCage) continue;                 // this cage is full
      const lastKill = st.cageKill[ci] || 0;
      if(lastKill && (nowMs - lastKill) < CAGE_RESPAWN_MS) continue; // brief lull
      // top this cage up toward its target (smooth burst per tick)
      let budget = 8;
      while(counts[ci] < perCage && budget-- > 0){
        spawned.push(spawnMonsterForCage(world, st.tier||1, ci));
        counts[ci]++;
      }
      st.cageKill[ci] = 0; // refilled this cage — clear its timer so it can refill again next time it's reduced
    }
    if(spawned.length){
      broadcastWorld(world, 'monstersSpawn', { monsters: spawned.map(m=>({mid:m.mid,x:m.x,y:m.y,hp:m.hp,maxHp:m.maxHp,level:m.level,kind:m.kind,cage:m.cage})) });
      if(st.cages && !st._cagesSent){ st._cagesSent=true; broadcastWorld(world, 'cages', { cages: st.cages }); }
    }
  }
}, 1000);

// Periodic light position sync (monsters drift toward nearest player handled client-side;
// server just keeps authoritative HP + presence and resyncs positions occasionally).
setInterval(()=>{
  for(const [world, st] of sharedWorlds){
    if(isNonShared(world) || st.monsters.size===0) continue;
    if(playersInWorld(world)===0) continue;
    // FULL reconciliation: send enough for the client to add monsters it's missing
    // and drop ones the server no longer has. This self-heals any desync (e.g. a
    // client optimistically removed a monster whose hit got dropped).
    const snap = [...st.monsters.values()].map(m=>({mid:m.mid,x:Math.round(m.x),y:Math.round(m.y),hp:m.hp,maxHp:m.maxHp,level:m.level,kind:m.kind,cage:m.cage}));
    broadcastWorld(world, 'monstersSync', { monsters: snap, reconcile:true });
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
    if(isNonShared(world)) continue;
    const pc = playersInWorld(world);
    const existing = worldBosses.get(world);
    // clear boss if world emptied
    if(pc===0){ if(existing) worldBosses.delete(world); continue; }
    // spawn a world boss if 1+ players, none active, and the 1-hour cooldown passed
    if(pc>=1 && !existing){
      const last = st._lastBoss||0;
      if(Date.now()-last > 3600000){ // ONE boss per hour per world
        const tier = st.tier||1;
        // HP scales with players; solo is beatable with skills/combo, groups face a tankier boss
        const maxHp = Math.round((6000 + tier*tier*3000) * Math.max(1, pc*0.8));
        const ww = st.ww||9000, wh = st.wh||9000;
        const boss = { bid:'B'+(nextBid++), hp:maxHp, maxHp, level:5+tier*10,
          x: ww*0.5, y: wh*0.5, name:BOSS_NAMES[Math.floor(Math.random()*BOSS_NAMES.length)],
          spawnedAt:Date.now() };
        worldBosses.set(world, boss);
        st._lastBoss = Date.now();
        broadcastWorld(world, 'worldBossSpawn', { bid:boss.bid, x:boss.x, y:boss.y, hp:boss.hp, maxHp:boss.maxHp, level:boss.level, name:boss.name });
        broadcast('chat', { from:'מערכת', text:`⚠️ בוס הופיע: ${boss.name}!`, sys:true });
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
    if (!ws) continue; // lingering ghost (no socket) — handled by its own timeout
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
