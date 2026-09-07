// tools/smoke.mjs — headless integration smoke test for the Warpath engine layer.
//
// Not part of the shipped site. Run with:  node tools/smoke.mjs
// It stubs the few browser globals the engine touches (localStorage, timers are
// native in node), then drives a full session: new game -> build -> tick ->
// research -> train -> heal -> combat -> world map march -> officers -> save/load.
//
// Exit code 0 = every assertion passed.

// --------------------------------------------------------------------------
// Minimal browser shims (engine modules must not need anything more than this)
// --------------------------------------------------------------------------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
  get length() { return store.size; },
  key: (i) => Array.from(store.keys())[i] ?? null
};
globalThis.window = globalThis;

// --------------------------------------------------------------------------
// Tiny assertion harness
// --------------------------------------------------------------------------
let passed = 0;
const failures = [];
const section = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 58 - t.length)));
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label + (detail ? '  — ' + detail : '')); }
  else { failures.push(label + (detail ? '  — ' + detail : '')); console.log('  ✗ ' + label + (detail ? '  — ' + detail : '')); }
}
function eq(a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function noThrow(label, fn) {
  try { const r = fn(); ok(true, label); return r; }
  catch (err) { failures.push(label + ' threw: ' + (err && err.stack || err)); console.log('  ✗ ' + label + ' threw: ' + (err && err.message || err)); return undefined; }
}

// --------------------------------------------------------------------------
// Imports (relative to this file, exactly as the browser loads them)
// --------------------------------------------------------------------------
const state = await import('../js/engine/state.js');
const bonus = await import('../js/engine/bonus.js');
const economy = await import('../js/engine/economy.js');
const build = await import('../js/engine/build.js');
const research = await import('../js/engine/research.js');
const training = await import('../js/engine/training.js');
const combat = await import('../js/engine/combat.js');
const worldmap = await import('../js/engine/worldmap.js');
const officers = await import('../js/engine/officers.js');
const events = await import('../js/util/events.js');

const DATA = {
  balance: await import('../js/data/balance.js'),
  buildings: await import('../js/data/buildings.js'),
  units: await import('../js/data/units.js'),
  tech: await import('../js/data/tech.js'),
  officers: await import('../js/data/officers.js'),
  campaign: await import('../js/data/campaign.js')
};

const S = state.S;

// Event tap so we can assert the contract event names actually fire.
const seen = Object.create(null);
for (const name of ['state:changed', 'res:changed', 'build:done', 'research:done',
  'train:done', 'march:arrived', 'battle:result', 'toast', 'log', 'offline:summary']) {
  events.on(name, () => { seen[name] = (seen[name] || 0) + 1; });
}

// Deterministic-ish clock we can push forward.
let NOW = Date.UTC(2024, 0, 1, 12, 0, 0);
const realNow = Date.now;
Date.now = () => NOW;
const advance = (sec) => { NOW += sec * 1000; };

// ==========================================================================
section('data tables');
// ==========================================================================
eq(DATA.buildings.BUILDING_KEYS.length, 16, 'buildings: 16 keys');
eq(DATA.units.UNIT_KEYS.length, 32, 'units: 32 keys');
eq(DATA.tech.TECH_KEYS.length, 40, 'tech: 40 keys');
eq(DATA.officers.OFFICER_KEYS.length, 12, 'officers: 12 keys');
eq(DATA.campaign.CAMPAIGN_IDS.length, 20, 'campaign: 20 stages');
ok(DATA.buildings.BUILDING_KEYS.every((k) => DATA.buildings.getCost(k, 30) && DATA.buildings.getBuildTime(k, 30) > 0),
  'every building has a cost + time at level 30');
ok(DATA.units.UNIT_KEYS.every((k) => DATA.units.getUnit(k)), 'every unit key resolves');

// ==========================================================================
section('newGame + persistence');
// ==========================================================================
noThrow('newGame() does not throw', () => state.newGame({ name: 'Smoke', seed: 12345 }));
eq(S.player.name, 'Smoke', 'player name applied');
eq(S.player.hqLevel, 1, 'HQ starts at level 1');
eq(S.buildings.length, 1, 'exactly one starting building (HQ)');
ok(S.res.oil > 0 && S.res.gold > 0, 'starting resources granted', JSON.stringify(S.res));
ok(seen['state:changed'] > 0, "'state:changed' emitted on newGame");

state.saveNow();
const savedRaw = localStorage.getItem('warpath_save_v1');
ok(typeof savedRaw === 'string' && savedRaw.length > 100, 'save written to warpath_save_v1', savedRaw.length + ' bytes');
S.res.oil = 123456;
ok(state.load(), 'load() returns true for a valid save');
ok(S.res.oil !== 123456, 'load() replaced the live state');

// ==========================================================================
section('bonuses + power');
// ==========================================================================
const allB = noThrow('getAllBonuses() does not throw', () => bonus.getAllBonuses());
eq(Object.keys(allB).length, DATA.tech.BONUS_KEYS.length, 'all BONUS_KEYS present in the bonus map');
ok(DATA.tech.BONUS_KEYS.every((k) => typeof bonus.getBonus(k) === 'number' && Number.isFinite(bonus.getBonus(k))),
  'getBonus() is finite for every bonus key');
eq(bonus.getBonus('nonsense.key'), 0, 'unknown bonus key returns 0');
const p0 = bonus.getPower();
ok(p0 > 0, 'power > 0 with just an HQ', 'P' + p0);
eq(S.player.power, p0, 'getPower() writes S.player.power');
const bd = bonus.powerBreakdown();
ok(['buildings', 'tech', 'army', 'officers', 'total'].every((k) => k in bd), 'powerBreakdown has all sections');

// ==========================================================================
section('economy: caps, rates, accrual');
// ==========================================================================
const caps = economy.computeCaps();
ok(caps.oil >= 1000, 'oil cap computed', String(caps.oil));
const rates0 = economy.productionRates();
ok(typeof rates0.oil === 'number', 'production rates computed', JSON.stringify(rates0));
const before = { ...S.res };
const acc = economy.accrue(3600);
ok(acc && acc.gained, 'accrue(1h) returns a gain summary');
ok(S.res.food !== before.food || rates0.food === 0, 'food moved (or no farm yet)');
ok(economy.canAfford({ oil: 10 }), 'canAfford small cost');
ok(!economy.canAfford({ oil: 1e15 }), 'cannot afford absurd cost');
const spendOk = economy.spend({ oil: 100 });
ok(spendOk, 'spend() succeeds and is all-or-nothing');
economy.grant({ oil: 100 }, { silent: true });

// ==========================================================================
section('building: place, tick, complete');
// ==========================================================================
S.res.oil = S.res.steel = S.res.rare = S.res.food = 5e6;
S.res.gold = 100000;

const freeP = build.freePlots();
ok(freeP.length > 0, 'free plots available', freeP.length + ' free');

const placed = build.startBuild(freeP[0], 'oil_well');
ok(placed && placed.ok, 'startBuild(oil_well) succeeded', JSON.stringify(placed && placed.reason || ''));
eq(S.queues.build.length, 1, 'build queue has one job');
const wellRec = S.buildings.find((b) => b.key === 'oil_well');
ok(!!wellRec, 'oil_well record created');
eq(wellRec.level, 0, 'new building sits at level 0 while building');
eq(wellRec.state, 'building', "new building state is 'building'");

advance(3600 * 6);
const done = build.tickBuild(Date.now());
ok(done >= 1, 'tickBuild completed the job', done + ' completed');
eq(wellRec.level, 1, 'oil_well is level 1 after completion');
eq(wellRec.state, 'idle', 'building state back to idle');
ok(seen['build:done'] > 0, "'build:done' emitted");

const rates1 = economy.productionRates();
ok(rates1.oil > rates0.oil, 'oil production increased after the well', `${rates0.oil} -> ${rates1.oil}`);

// A couple more buildings we need downstream.
function buildNow(key) {
  const plots = build.freePlots();
  if (!plots.length) return false;
  const r = build.startBuild(plots[0], key);
  if (!r || !r.ok) return false;
  advance(3600 * 24);
  build.tickBuild(Date.now());
  return true;
}
// HQ must be high enough to gate the rest.
const hq = state.findBuilding('hq');
hq.level = 12;
S.player.hqLevel = 12;
// Order matters: barracks/lab gate hospital, academy, radar and the tank factory.
for (const k of ['farm', 'warehouse', 'barracks', 'lab']) ok(buildNow(k), 'built ' + k);
// Raise the prerequisite buildings so the gated ones become legal (this is the
// real gating rule from data/buildings.js requires{}, not a shortcut).
state.findBuilding('barracks').level = 6;
state.findBuilding('lab').level = 8;
ok(build.canPlace('hospital', build.freePlots()[0]).ok, 'hospital unlocks once barracks 5 / HQ 6 are met');
for (const k of ['hospital', 'academy', 'radar', 'tank_factory']) ok(buildNow(k), 'built ' + k);
ok(!build.canPlace('hangar', build.freePlots()[0]).ok || DATA.buildings.BUILDINGS.hangar.requires.hq <= 12,
  'hangar gating is consistent with its requires{}');
bonus.invalidateBonuses();
economy.computeCaps();
ok(bonus.getPower() > p0, 'power grew with the new buildings', 'P' + bonus.getPower());

// speed-up path
const plots2 = build.freePlots();
const q2 = build.startBuild(plots2[0], 'steel_mill');
ok(q2 && q2.ok, 'queued steel_mill for a speed-up test');
const su = build.speedUpCost(q2.id);
ok(su && typeof su.gold === 'number', 'speedUpCost returns a gold price', JSON.stringify(su));
const suRes = build.speedUp(q2.id, true);
ok(suRes && suRes.ok, 'speedUp() with gold completed the job', JSON.stringify(suRes));
eq(state.getBuilding(q2.id).level, 1, 'sped-up building reached level 1');

// ==========================================================================
section('research');
// ==========================================================================
eq(research.labLevel(), state.levelOf('lab'), 'labLevel() matches the built lab');
const rCheck = research.canResearch('eco_drilling');
ok(rCheck && rCheck.ok, 'can start eco_drilling', JSON.stringify(rCheck.reason || ''));
const rStart = research.startResearch('eco_drilling');
ok(rStart && rStart.ok, 'startResearch queued', JSON.stringify(rStart && rStart.reason || ''));
ok(research.isResearching(), 'isResearching() is true');
advance(3600 * 24);
const rDone = research.tickResearch(Date.now());
ok(rDone.length >= 1, 'tickResearch completed the order');
eq(research.getTechLevel('eco_drilling'), 1, 'eco_drilling is level 1');
ok(seen['research:done'] > 0, "'research:done' emitted");
bonus.invalidateBonuses();
ok(bonus.getBonus('prod.oil') > 0, 'tech bonus feeds getBonus(prod.oil)', String(bonus.getBonus('prod.oil')));
const rates2 = economy.productionRates();
ok(rates2.oil > rates1.oil, 'oil rate improved from research', `${rates1.oil} -> ${rates2.oil}`);

// ==========================================================================
section('training + hospital');
// ==========================================================================
S.res.oil = S.res.steel = S.res.rare = S.res.food = 5e6;
const trainable = training.getTrainableUnits();
ok(Array.isArray(trainable) && trainable.length > 0, 'getTrainableUnits() lists something', trainable.length + ' units');
const tr = training.trainUnits('inf1', 30);
ok(tr && tr.ok, 'trainUnits(inf1, 30) accepted', JSON.stringify(tr && tr.error || ''));
advance(3600 * 6);
const tDone = training.tickTraining(Date.now());
ok(Array.isArray(tDone) ? tDone.length >= 0 : true, 'tickTraining ran');
eq(state.ensureUnit('inf1').count, 30, '30 inf1 in the army');
ok(seen['train:done'] > 0, "'train:done' emitted");

training.addWounded('inf1', 10);
eq(S.army.inf1.wounded, 10, 'addWounded() recorded 10 wounded');
eq(S.army.inf1.count, 20, 'addWounded() debited the active count (pools are disjoint)');
const hcost = training.healCost('inf1', 10);
ok(hcost && typeof hcost === 'object', 'healCost() returns a cost object');
const hr = training.heal('inf1', 10);
ok(hr && hr.ok, 'heal() queued', JSON.stringify(hr && hr.error || ''));
advance(3600 * 4);
training.tickHealing(Date.now());
eq(S.army.inf1.wounded, 0, 'wounded healed back to 0');
eq(state.ensureUnit('inf1').count, 30, 'healed units returned to the count');

// Cancelling a batch refunds through training.js's own grant(); it must never
// trim a stockpile that is ALREADY over cap (build/campaign payouts overflow).
economy.computeCaps();
economy.grant({ oil: 2e5, steel: 2e5, rare: 2e5, food: 2e5 }, { overflow: true });
ok(DATA.balance.RES_ORDER.every((k) => S.res[k] > S.cap[k]),
  'stockpile pushed above every storage cap', JSON.stringify(S.res));
const cTr = training.trainUnits('inf1', 5);
ok(cTr && cTr.ok, 'trainUnits(inf1, 5) queued for the cancel test', JSON.stringify(cTr && cTr.error || ''));
const overBefore = { ...S.res };
const cRes = training.cancelTraining(cTr.entry ? cTr.entry.id : (cTr.id || ''), Date.now());
ok(cRes && cRes.ok, 'cancelTraining() accepted', JSON.stringify(cRes && cRes.error || ''));
ok(DATA.balance.RES_ORDER.concat(['gold']).every((k) => S.res[k] >= overBefore[k]),
  'cancelling a batch never trims an over-cap stockpile',
  JSON.stringify({ before: overBefore, after: S.res }));

ok(training.armyUpkeep() > 0, 'army upkeep is positive', String(training.armyUpkeep()));
ok(training.totalArmyPower() > 0, 'army power positive', String(training.totalArmyPower()));

// ==========================================================================
section('combat resolver');
// ==========================================================================
const force = (units, extra) => combat.makeForce(units, extra || {});
const atk = force({ inf1: 200, tank1: 100 }, { name: 'Attacker', bonuses: bonus.getAllBonuses() });
const def = force({ inf1: 150, air1: 40 }, { name: 'Defender', isDefender: true });
const rep = noThrow('resolveBattle() does not throw', () => combat.resolveBattle(atk, def, { seed: 'smoke-1' }));
ok(rep && ['attacker', 'defender', 'draw'].includes(rep.winner), 'battle produced a winner', rep && rep.winner);
ok(rep.rounds.length > 0 && rep.rounds.length <= 20, 'round count sane', rep.rounds.length + ' rounds');
ok(rep.rounds.every((r) => Array.isArray(r.events)), 'every round carries events');
ok(typeof rep.summary === 'string' && rep.summary.length > 0, 'battle summary text present', rep.summary);
const rep2 = combat.resolveBattle(force({ inf1: 200, tank1: 100 }, { name: 'A' }), force({ inf1: 150, air1: 40 }, { name: 'D', isDefender: true }), { seed: 'smoke-1' });
eq(JSON.stringify(rep2.attackerLosses), JSON.stringify(combat.resolveBattle(force({ inf1: 200, tank1: 100 }, { name: 'A' }), force({ inf1: 150, air1: 40 }, { name: 'D', isDefender: true }), { seed: 'smoke-1' }).attackerLosses), 'same seed = identical losses (deterministic)');

// Counter triangle, compared at EQUAL POWER (unit tiers have different base
// stats, so equal head-counts would only measure the stat sheet, not the counter).
const POWER_REF = 60000;
const atEqualPower = (k) => Math.max(1, Math.round(POWER_REF / DATA.units.getUnit(k).power));
const win = (a, d) => combat.resolveBattle(
  force({ [a]: atEqualPower(a) }, { name: 'a' }),
  force({ [d]: atEqualPower(d) }, { name: 'd', isDefender: true }),
  { seed: 'tri' }).winner;
eq(win('tank1', 'inf1'), 'attacker', 'tank beats infantry at equal power');
eq(win('inf1', 'air1'), 'attacker', 'infantry beats aircraft at equal power');
eq(win('air1', 'tank1'), 'attacker', 'aircraft beats tank at equal power');
// ...and the losing side of each matchup must not win when the roles swap.
eq(win('inf1', 'tank1'), 'defender', 'infantry loses to tank at equal power');

const sim = noThrow('simulateBattle() does not throw', () => combat.simulateBattle(atk, def, { samples: 12 }));
ok(sim && sim.winRate >= 0 && sim.winRate <= 1, 'simulate winRate in [0,1]', String(sim && sim.winRate));

const armyBefore = S.army.inf1.count;
const campRep = combat.resolveBattle(
  force({ inf1: 20 }, { name: 'Player', bonuses: bonus.getAllBonuses() }),
  force({ inf1: 10 }, { name: 'NPC', isDefender: true }),
  { seed: 'apply' });
const applied = noThrow('applyBattleResult() does not throw', () => combat.applyBattleResult(campRep, 'attacker'));
ok(applied && typeof applied.dead === 'number', 'applyBattleResult returns a loss summary', JSON.stringify(applied));
ok(S.army.inf1.count <= armyBefore, 'army count did not grow from losing units', `${armyBefore} -> ${S.army.inf1.count}`);
ok(seen['battle:result'] > 0, "'battle:result' emitted");

// ==========================================================================
section('world map + marches');
// ==========================================================================
worldmap.setBonusProvider(bonus.getBonus);
noThrow('ensureMap() does not throw', () => worldmap.ensureMap());
eq(S.map.tiles.length, worldmap.MAP_W * worldmap.MAP_H, 'map tile array is 40x40');
const specials = worldmap.allSpecialTiles();
ok(specials.length > 20, 'map has special tiles', specials.length + ' specials');
const city = worldmap.cityPos();
const cityTile = worldmap.tileAt(city.x, city.y);
eq(cityTile.type, 'city', 'player city tile placed at the centre');

const resTile = specials.find((t) => t.type === 'res');
ok(!!resTile, 'a resource node exists');
const npcTile = specials.find((t) => t.type === 'npc');
ok(!!npcTile, 'an NPC base exists');

const scout = noThrow('scoutTile() does not throw', () => worldmap.scoutTile(npcTile.x, npcTile.y));
ok(scout && scout.ok, 'scoutTile returns intel', JSON.stringify(scout && { win: scout.winChance, ep: scout.enemyPower }));

// Give ourselves an army big enough to actually win something.
state.ensureUnit('inf1').count = 500;
state.ensureUnit('tank1').count = 300;
bonus.invalidateBonuses();

eq(worldmap.getMarchCapacity() >= 1, true, 'at least one march slot');
const gather = worldmap.sendMarch({ toX: resTile.x, toY: resTile.y, kind: 'gather', units: { inf1: 100 } });
ok(gather && gather.ok, 'gather march dispatched', JSON.stringify(gather && gather.reason || ''));
eq(S.army.inf1.count, 400, 'units detached from the army on dispatch');
eq(worldmap.activeMarches().length, 1, 'one active march');

let guard = 0;
// Loot honours storage caps, so drain the stockpile first or there is no room.
economy.computeCaps();
for (const k of ['oil', 'steel', 'rare', 'food']) S.res[k] = 0;
const resBefore = { ...S.res };
while (worldmap.activeMarches().length > 0 && guard++ < 40) {
  advance(1800);
  worldmap.tickMarches(Date.now());
}
ok(guard < 40, 'gather march resolved within the guard', guard + ' half-hour steps');
eq(S.army.inf1.count, 500, 'gathering units returned to the army');
ok(RES_GAINED(resBefore), 'gather brought resources home');
function RES_GAINED(prev) {
  return ['oil', 'steel', 'rare', 'food'].some((k) => S.res[k] > prev[k]);
}
ok(seen['march:arrived'] > 0, "'march:arrived' emitted");

const attack = worldmap.sendMarch({ toX: npcTile.x, toY: npcTile.y, kind: 'attack', units: { inf1: 400, tank1: 300 } });
ok(attack && attack.ok, 'attack march dispatched', JSON.stringify(attack && attack.reason || ''));
guard = 0;
while (worldmap.activeMarches().length > 0 && guard++ < 60) {
  advance(1800);
  worldmap.tickMarches(Date.now());
}
ok(guard < 60, 'attack march resolved (battle + return leg)', guard + ' steps');
ok(S.army.inf1.count > 0, 'some infantry came home', String(S.army.inf1.count));
ok(S.stats.battlesWon + S.stats.battlesLost > 0, 'battle recorded in stats',
  `W${S.stats.battlesWon}/L${S.stats.battlesLost}`);

// recall path
const m3 = worldmap.sendMarch({ toX: npcTile.x, toY: npcTile.y, kind: 'attack', units: { inf1: 50 } });
if (m3 && m3.ok) {
  advance(5);
  const rc = worldmap.recallMarch(m3.march.id);
  ok(rc && rc.ok, 'recallMarch() accepted');
  guard = 0;
  while (worldmap.activeMarches().length > 0 && guard++ < 60) { advance(600); worldmap.tickMarches(Date.now()); }
  ok(guard < 60, 'recalled march came home');
} else { ok(false, 'recall test could not dispatch a march', JSON.stringify(m3)); }

// ruins scavenge — all-or-nothing, and capped by what the column can carry
const ruinAt = { x: city.x + 3, y: city.y };
worldmap.setTile(ruinAt.x, ruinAt.y, { x: ruinAt.x, y: ruinAt.y, type: 'ruins', ruins: { level: 6 } });
const scav = worldmap.sendMarch({ toX: ruinAt.x, toY: ruinAt.y, kind: 'gather', units: { inf1: 10 } });
ok(scav && scav.ok, 'scavenge march dispatched to a Lv6 ruin', JSON.stringify(scav && scav.reason || ''));
guard = 0;
while (scav.march.state !== 'gathering' && guard++ < 60) { advance(60); worldmap.tickMarches(Date.now()); }
eq(scav.march.state, 'gathering', 'scavenge column is on site');
worldmap.recallMarch(scav.march.id);
ok(DATA.balance.RES_ORDER.every((k) => (scav.march.payload.loot[k] || 0) === 0)
  && !scav.march.payload.loot.gold,
  'instant recall from a scavenge banks nothing', JSON.stringify(scav.march.payload.loot));
eq(worldmap.tileAt(ruinAt.x, ruinAt.y).type, 'ruins', 'an abandoned dig leaves the ruins intact');
guard = 0;
while (worldmap.activeMarches().length > 0 && guard++ < 60) { advance(600); worldmap.tickMarches(Date.now()); }

const scav2 = worldmap.sendMarch({ toX: ruinAt.x, toY: ruinAt.y, kind: 'gather', units: { inf1: 10 } });
ok(scav2 && scav2.ok, 're-dispatched to the same ruin', JSON.stringify(scav2 && scav2.reason || ''));
if (scav2 && scav2.ok) {
  const scavCap = worldmap.getLoadCapacity({ inf1: 10 });
  guard = 0;
  while (scav2.march.state !== 'gathering' && guard++ < 60) { advance(60); worldmap.tickMarches(Date.now()); }
  advance(600);
  worldmap.tickMarches(Date.now());
  const scavHaul = DATA.balance.RES_ORDER.reduce((n, k) => n + (scav2.march.payload.loot[k] || 0), 0);
  ok(scavHaul > 0, 'a completed scavenge pays out', String(scavHaul));
  ok(scavHaul <= scavCap, 'ruins haul respects the column carry capacity', scavHaul + ' <= ' + scavCap);
  ok(worldmap.tileAt(ruinAt.x, ruinAt.y).type !== 'ruins', 'a completed scavenge clears the ruin');
}
guard = 0;
while (worldmap.activeMarches().length > 0 && guard++ < 60) { advance(600); worldmap.tickMarches(Date.now()); }
eq(worldmap.activeMarches().length, 0, 'no marches left before the officer tests');

// ==========================================================================
section('officers');
// ==========================================================================
S.res.gold = 100000;
const draw = noThrow('recruit(10) does not throw', () => officers.recruit(10));
ok(draw && draw.ok && draw.results.length === 10, 'ten-draw returned 10 results', JSON.stringify(draw && draw.reason || ''));
const ownedKeys = Object.keys(S.officers.owned);
ok(ownedKeys.length > 0, 'at least one officer owned', ownedKeys.join(','));
const ok1 = ownedKeys[0];
const lvlBefore = S.officers.owned[ok1].level;
officers.grantXp(ok1, 100000);
ok(S.officers.owned[ok1].level >= lvlBefore, 'grantXp did not regress the level');
const assignRes = officers.assign(ok1, officers.GARRISON_SLOT);
ok(assignRes && (assignRes.ok !== false), 'assign() to garrison accepted', JSON.stringify(assignRes));
eq(S.officers.owned[ok1].assigned, officers.GARRISON_SLOT, 'assigned field written');
bonus.invalidateBonuses();
const obs = officers.getOfficerBonuses();
ok(obs && Object.keys(obs).length > 0, 'getOfficerBonuses() returns bonuses', Object.keys(obs).length + ' keys');
ok(bonus.powerBreakdown().officers > 0, 'officers contribute power', String(bonus.powerBreakdown().officers));
officers.addFragments(ok1, 500, true);
const promo = officers.promoteStar(ok1);
ok(promo && typeof promo === 'object', 'promoteStar() returned a result', JSON.stringify(promo));

// A march that ends must not keep its leader's command slot forever.
officers.unassign(ok1);
const slotMarch = worldmap.sendMarch({ toX: resTile.x, toY: resTile.y, kind: 'gather', units: { inf1: 50 } });
if (slotMarch && slotMarch.ok) {
  const marchSlotName = officers.marchSlot(slotMarch.march.id);
  const mAssign = officers.assign(ok1, marchSlotName);
  ok(mAssign && mAssign.ok !== false, 'assign() to a march slot accepted', JSON.stringify(mAssign));
  eq(S.officers.owned[ok1].assigned, marchSlotName, 'march slot assignment written');
  guard = 0;
  while (worldmap.activeMarches().length > 0 && guard++ < 60) { advance(600); worldmap.tickMarches(Date.now()); }
  ok(guard < 60, 'the officer-led march came home');
  officers.reconcileSlots();
  eq(S.officers.owned[ok1].assigned, null, 'a finished march releases its command slot');
  eq(officers.usedSlots(), 0, 'no command slot is left held by a dead march');
} else { ok(false, 'march slot test could not dispatch a march', JSON.stringify(slotMarch)); }

// ==========================================================================
section('offline progress + loop tick');
// ==========================================================================
const loop = await import('../js/engine/loop.js');
state.touch(Date.now());
advance(3600 * 3);
const off = noThrow('applyOffline(3h) does not throw', () => economy.applyOffline(3 * 3600 * 1000));
ok(off && off.gained && off.hours > 0, 'offline summary produced', JSON.stringify({ h: off && off.hours, capped: off && off.capped }));
const offCap = economy.applyOffline(48 * 3600 * 1000);
eq(offCap.capped, true, 'offline is capped at OFFLINE_CAP_HOURS');
ok(offCap.hours <= DATA.balance.OFFLINE_CAP_HOURS + 0.001, 'capped hours <= ' + DATA.balance.OFFLINE_CAP_HOURS);

const tick = noThrow('loop.tickOnce() does not throw', () => loop.tickOnce(Date.now()));
ok(tick && typeof tick.dt === 'number', 'tickOnce returned a result', JSON.stringify(tick));

// ==========================================================================
section('save round-trip with a live world');
// ==========================================================================
state.saveNow();
const snapshotSize = localStorage.getItem('warpath_save_v1').length;
ok(snapshotSize > 1000, 'save is substantial', Math.round(snapshotSize / 1024) + ' KB');
const powerBefore = bonus.getPower();
const armySnapshot = JSON.stringify(S.army);
const techSnapshot = JSON.stringify(S.tech);
ok(state.load(), 'reload from localStorage');
eq(JSON.stringify(S.army), armySnapshot, 'army survived the round-trip');
eq(JSON.stringify(S.tech), techSnapshot, 'tech survived the round-trip');
eq(S.map.tiles.length, 1600, 'map survived the round-trip');
bonus.invalidateBonuses();
eq(bonus.getPower(), powerBefore, 'power is identical after reload');
ok(Object.keys(S.officers.owned).length > 0, 'officers survived the round-trip');

// ==========================================================================
section('static deploy assets');
// ==========================================================================
const { existsSync, readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
ok(existsSync(ROOT + 'manifest.json'), 'manifest.json is checked in');
ok(existsSync(ROOT + 'icon.svg'), 'icon.svg is checked in');
noThrow('manifest.json is valid JSON', () => JSON.parse(readFileSync(ROOT + 'manifest.json', 'utf8')));

// ==========================================================================
section('sanity: no NaN anywhere in state');
// ==========================================================================
const nanPaths = [];
(function scan(v, path) {
  if (typeof v === 'number') { if (!Number.isFinite(v)) nanPaths.push(path); return; }
  if (!v || typeof v !== 'object') return;
  for (const k of Object.keys(v)) scan(v[k], path + '.' + k);
})(S, 'S');
ok(nanPaths.length === 0, 'no NaN/Infinity in state', nanPaths.slice(0, 8).join(', '));

// ==========================================================================
Date.now = realNow;
console.log('\n' + '='.repeat(64));
console.log(`  ${passed} passed, ${failures.length} failed`);
console.log('  events seen: ' + Object.keys(seen).map((k) => `${k}×${seen[k]}`).join(', '));
console.log('='.repeat(64));
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
process.exit(0);
