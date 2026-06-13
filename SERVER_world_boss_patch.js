// ════════════════════════════════════════════════════════════════════════
//  WORLD OF LEGENDS — DAILY WORLD BOSS  (server.js additions)
// ════════════════════════════════════════════════════════════════════════
//  Paste these blocks into your existing server.js on the wol-server repo
//  (the full ~1042-line server — NOT the stub version), then redeploy on Render.
//
//  What this adds:
//   • A colossal world boss that SPAWNS EVERY DAY AT 20:00 (server local time)
//   • It lives in the 'boss_arena' world and STAYS until a group kills it
//     (even across several days — no new boss spawns while one is alive,
//      and no second boss spawns the same day after it's been killed)
//   • A single shared HP pool: every player's worldBossHit reduces the same HP,
//     so it genuinely needs many players (≈5 endgame-geared or ≈20-30 normal)
//   • Broadcasts worldBossSpawn / worldBossHp / worldBossDead to everyone
//
//  IMPORTANT: set the Render service timezone so 20:00 means your time.
//  On Render → your service → Environment → add:  TZ = Asia/Jerusalem
// ════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────
// 1) STATE  — add this near the top of server.js, next to your other globals
//    (e.g. right after you create `wss` / your players map).
// ─────────────────────────────────────────────────────────────────────────
let worldBoss = null;          // the live boss object, or null if none
let lastBossDay = null;        // 'YYYY-M-D' string of the day a boss last SPAWNED

// Tune these to taste. HP is the dial that controls "how many players needed".
const WORLD_BOSS = {
  spawnHour: 20,               // 20:00 = 8 PM (server local time; set TZ env var!)
  arenaWorld: 'boss_arena',    // must match the world id in index.html
  // HP: aim so ~5 endgame players (each ~15-30k DPS over a fight) or ~20-30
  // normal players can clear it in a reasonable session. Start big; adjust later.
  baseHp: 12000000,            // 12 million HP
  level: 250,
  name: 'טיטאן העולם',          // the giant's name shown on the HP bar
  // arena centre (index.html boss_arena is 4200×4200, so centre ≈ 2100,2100)
  x: 2100, y: 2100,
};

function bossDayKey(d){ return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }


// ─────────────────────────────────────────────────────────────────────────
// 2) SPAWN + SCHEDULER  — add these functions anywhere in server.js
// ─────────────────────────────────────────────────────────────────────────
function spawnWorldBoss(){
  if(worldBoss) return; // never two at once
  worldBoss = {
    bid: 'wb_' + Date.now(),
    name: WORLD_BOSS.name,
    level: WORLD_BOSS.level,
    x: WORLD_BOSS.x,
    y: WORLD_BOSS.y,
    hp: WORLD_BOSS.baseHp,
    maxHp: WORLD_BOSS.baseHp,
    contributors: {},          // playerId -> total damage (for reward credit)
  };
  lastBossDay = bossDayKey(new Date());
  broadcastAll({
    type: 'worldBossSpawn',
    bid: worldBoss.bid, name: worldBoss.name, level: worldBoss.level,
    x: worldBoss.x, y: worldBoss.y, hp: worldBoss.hp, maxHp: worldBoss.maxHp,
  });
  console.log(`👹 World boss spawned: ${worldBoss.name} (${worldBoss.maxHp} HP)`);
}

// Check once a minute: if it's 20:00 and no boss spawned yet today, spawn one.
// If a boss is already alive (from a previous day), we DON'T spawn another.
setInterval(() => {
  const now = new Date();
  const today = bossDayKey(now);
  const isSpawnTime = now.getHours() === WORLD_BOSS.spawnHour && now.getMinutes() === 0;
  if (isSpawnTime && !worldBoss && lastBossDay !== today) {
    spawnWorldBoss();
  }
}, 60 * 1000); // every minute


// ─────────────────────────────────────────────────────────────────────────
// 3) DAMAGE HANDLER  — add a case to your message switch (where you handle
//    'move', 'chat', etc.). `ws` is the sender's socket, `data` the message,
//    and `ws.playerId` should be however you identify a player on your server.
// ─────────────────────────────────────────────────────────────────────────
//
//   case 'worldBossHit': handleWorldBossHit(ws, data); break;
//
function handleWorldBossHit(ws, data){
  if(!worldBoss || !data || data.bid !== worldBoss.bid) return;
  const dmg = Math.max(0, Math.min(1e7, Math.round(data.damage || 0))); // clamp anti-cheat
  if(dmg <= 0) return;
  worldBoss.hp -= dmg;
  // credit this player for the reward
  const pid = ws.playerId || (ws.profile && ws.profile.id) || 'anon';
  worldBoss.contributors[pid] = (worldBoss.contributors[pid] || 0) + dmg;

  if(worldBoss.hp <= 0){
    // ── BOSS DEFEATED ──
    const byName = (ws.profile && ws.profile.name) || 'גיבור';
    broadcastAll({ type: 'worldBossDead', bid: worldBoss.bid, name: worldBoss.name, byName });
    // reward everyone who dealt damage
    for(const [pid2, total] of Object.entries(worldBoss.contributors)){
      const sock = findSocketByPlayerId(pid2); // ← use your own lookup
      if(sock && sock.readyState === 1){
        sock.send(JSON.stringify({
          type: 'worldBossReward',
          name: worldBoss.name,
          xp: 500000,          // tune rewards as you like
          gold: 100000,
        }));
      }
    }
    console.log(`🏆 World boss defeated by ${byName}`);
    worldBoss = null; // it stays dead until the next 20:00 — lastBossDay already set
  } else {
    // throttle HP broadcasts a little so we don't flood (every ~250ms is plenty)
    const t = Date.now();
    if(!worldBoss._lastHpBroadcast || t - worldBoss._lastHpBroadcast > 200){
      worldBoss._lastHpBroadcast = t;
      broadcastAll({ type: 'worldBossHp', bid: worldBoss.bid, hp: Math.max(0, worldBoss.hp), maxHp: worldBoss.maxHp });
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────
// 4) SEND BOSS STATE ON JOIN  — so a player who connects mid-fight sees it.
//    Add this where you handle a new 'join' (right after you send 'welcome').
// ─────────────────────────────────────────────────────────────────────────
//
//   if (worldBoss) {
//     ws.send(JSON.stringify({
//       type: 'worldBossSpawn',
//       bid: worldBoss.bid, name: worldBoss.name, level: worldBoss.level,
//       x: worldBoss.x, y: worldBoss.y, hp: worldBoss.hp, maxHp: worldBoss.maxHp,
//     }));
//   }


// ─────────────────────────────────────────────────────────────────────────
// 5) HELPERS you may already have — adapt to your code:
// ─────────────────────────────────────────────────────────────────────────
//
//   function broadcastAll(obj){
//     const s = JSON.stringify(obj);
//     wss.clients.forEach(c => { if (c.readyState === 1) c.send(s); });
//   }
//
//   function findSocketByPlayerId(pid){
//     for (const c of wss.clients){ if (c.playerId === pid) return c; }
//     return null;
//   }
//
// ─────────────────────────────────────────────────────────────────────────
//  TESTING TIP: to test before 20:00, temporarily call spawnWorldBoss() once
//  at startup, or set WORLD_BOSS.spawnHour to the current hour. Lower baseHp
//  to ~50000 to verify the kill flow quickly, then restore it.
// ─────────────────────────────────────────────────────────────────────────
