const MOD = "dispatch-minigame";
const DATA = `modules/${MOD}/data/`;
const STATS = ["strength", "agility", "constitution", "intelligence", "wisdom", "charisma"];
const ABBR = { strength: "STR", agility: "AGI", constitution: "CON", intelligence: "INT", wisdom: "WIS", charisma: "CHA" };
const NOTICE_ASPECT = 600 / 449; // parchment.png height / width
const SEAL_ASPECT = 263 / 260; // seal.png height / width
const ASSET = `modules/${MOD}/assets/`;
const BOARD_ASPECT = 1400 / 1718; // board height / width
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const EMPTY = () => ({ heroes: {}, active: [], done: [], board: null, looks: [], treasury: { gold: 0, xp: 0 } });

let HEROES = []; // base data merged with GM level/stat overrides
let BASE_HEROES = [];
let MISSIONS = [];
let APP = null;
const SOCKET = `module.${MOD}`;

// Live "level-up card" drafts, shared so every player with the card open sees stat changes as they happen.
const LEVEL_DRAFT = {};
let LEVELUP_OPEN = null;
let RECRUIT_OPEN = null;

/** Hero assignments per mission ({ missionId: [heroId] }), shared by every client through the module socket. */
const SEL = { assign: {} };

function setSelection(assign, broadcast = true) {
  SEL.assign = assign;
  if (APP?.rendered) APP.render();
  if (broadcast) game.socket.emit(SOCKET, { type: "sel", assign });
}

function registerSocket() {
  game.socket.on(SOCKET, (data) => {
    const activeGM = game.users.activeGM?.id === game.user.id;
    const mine = data.userId === game.user.id;
    switch (data.type) {
      case "sel": return setSelection(data.assign, false);
      case "req": return game.user.isGM && game.socket.emit(SOCKET, { type: "sel", assign: SEL.assign });
      case "levelDraft":
        LEVEL_DRAFT[data.heroId] = data.gains;
        return LEVELUP_OPEN?.heroId === data.heroId && LEVELUP_OPEN.setGains(data.gains);
      case "train": return activeGM && requestTraining(data);
      case "deploy": return activeGM && requestDeployment(data);
      case "recruit": return activeGM && requestRecruit(data);
      case "retire": return activeGM && requestRetire(data);
      case "profChoice": return activeGM && requestProficiency(data);
      case "profApproved": return mine && ui.notifications.info(`${data.heroName} gained a second proficiency.`);
      case "profDenied": return mine && ui.notifications.warn(`The second proficiency for ${data.heroName} was not approved.`);
      case "retireApproved": return mine && ui.notifications.info(`${data.heroName} has retired from the roster.`);
      case "retireDenied": return mine && ui.notifications.warn(`Retiring ${data.heroName} was not approved.`);
      case "trainApproved": return mine && ui.notifications.info(`Training approved for ${data.heroName}.`);
      case "trainDenied": return mine && ui.notifications.warn(`Training was not approved for ${data.heroName}.`);
      case "deployApproved": return mine && ui.notifications.info(`Deployment approved: ${data.missionName}.`);
      case "deployDenied": return mine && ui.notifications.warn(`Deployment was not approved: ${data.missionName}.`);
      case "recruitApproved": return mine && ui.notifications.info(`${data.heroName} has been recruited.`);
      case "recruitDenied": return mine && ui.notifications.warn(`Recruiting ${data.heroName} was not approved.`);
    }
  });
}

const needApproval = () => game.settings.get(MOD, "requireApproval") !== false;

/** Ask the GM to confirm a player's request (or auto-approve when the setting is off). */
const approve = (title, content, yesLabel) =>
  needApproval()
    ? foundry.applications.api.DialogV2.confirm({
        window: { title },
        content,
        modal: false,
        rejectClose: false,
        yes: { label: yesLabel, default: true },
        no: { label: "Decline" }
      })
    : Promise.resolve(true);

/** Total XP needed to reach each level (index = level). Heroes level up on their own at these totals. */
const XP_LEVELS = [0, 0, 250, 950, 2950, 7700];
const levelForXp = (xp) => XP_LEVELS.reduce((lvl, need, i) => (i >= 1 && xp >= need ? i : lvl), 1);
/** At this much total XP a hero may pick a second proficiency. */
const XP_SECOND_PROF = 17500;
const SKILLS = ["Athletics", "Acrobatics", "Stealth", "Sleight of Hand", "Arcana", "History", "Investigation", "Nature", "Religion",
  "Animal Handling", "Insight", "Medicine", "Perception", "Survival", "Deception", "Intimidation", "Performance", "Persuasion", "Constitution"];
const heroProfs = (h) => [h?.proficiency, h?.proficiency2].filter(Boolean);

/** Name of the actor that collects the gold from successful missions (setting; default "Group Loot"). */
const lootActorName = () => String(game.settings.get(MOD, "lootActor") || "").trim() || "Group Loot";

/** GM client only: add gold to the "Group Loot" group actor. Returns a short note for the chat message. */
async function addGroupLoot(gold) {
  if (!(gold > 0)) return "";
  const LOOT_ACTOR = esc(lootActorName());
  const actor = game.actors?.getName(lootActorName());
  if (!actor) return ` <i>(No actor named "${LOOT_ACTOR}" was found, so the gold was not added.)</i>`;
  const cur = foundry.utils.getProperty(actor, "system.currency.gp");
  if (cur === undefined || cur === null) return ` <i>("${LOOT_ACTOR}" has no gold field, so the gold was not added.)</i>`;
  try {
    await actor.update({ "system.currency.gp": (Number(cur) || 0) + gold });
  } catch (err) {
    console.error(`${MOD} | could not add gold to ${lootActorName()}`, err);
    return ` <i>(The gold could not be added to "${LOOT_ACTOR}".)</i>`;
  }
  return ` <i>(Added to ${LOOT_ACTOR}.)</i>`;
}

/**
 * GM client only: give every hero in `heroes` this much XP, level them up at the XP thresholds
 * (granting stat points per level gained) and announce any hero who can now choose a second proficiency.
 */
async function awardXp(heroes, xp) {
  const per = Number(game.settings.get(MOD, "pointsPerLevel"));
  const points = Number.isFinite(per) ? per : 2;
  const ovr = JSON.parse(JSON.stringify(game.settings.get(MOD, "heroOverrides") ?? {}));
  const pending = JSON.parse(JSON.stringify(game.settings.get(MOD, "pendingPoints") ?? {}));
  const leveled = [], profReady = [];
  for (const h of heroes) {
    const cur = ovr[h.id] ?? { level: h.level, stats: {} };
    const before = Number(cur.xp ?? h.xp ?? 0) || 0;
    cur.xp = before + xp;
    cur.level ??= h.level;
    const target = Math.min(20, levelForXp(cur.xp));
    if (cur.level < target) {
      pending[h.id] = (pending[h.id] || 0) + (target - cur.level) * points;
      cur.level = target;
      leveled.push(`${esc(h.name)} (level ${target})`);
    }
    if (before < XP_SECOND_PROF && cur.xp >= XP_SECOND_PROF && !(cur.proficiency2 ?? h.proficiency2)) profReady.push(esc(h.name));
    ovr[h.id] = cur;
  }
  await game.settings.set(MOD, "heroOverrides", ovr);
  await game.settings.set(MOD, "pendingPoints", pending);
  if (leveled.length) await ChatMessage.create({ content: `<div class="dispatch-chat"><h3>Level up!</h3><p>${leveled.join(", ")} reached a new level and ${leveled.length === 1 ? "has" : "have"} stat points to spend. Click the hero card.</p></div>` });
  if (profReady.length) await ChatMessage.create({ content: `<div class="dispatch-chat"><h3>Second proficiency</h3><p>${profReady.join(", ")} can now choose a second proficiency. Open the hero's stat card and choose one.</p></div>` });
}

/** GM client only: raise heroes one level and grant each their unspent stat points. */
async function levelUp(ids) {
  if (!game.user.isGM) return;
  const per = Number(game.settings.get(MOD, "pointsPerLevel"));
  const points = Number.isFinite(per) ? per : 2;
  const overrides = JSON.parse(JSON.stringify(game.settings.get(MOD, "heroOverrides") ?? {}));
  const pending = JSON.parse(JSON.stringify(game.settings.get(MOD, "pendingPoints") ?? {}));
  const names = [];
  for (const id of ids) {
    const hero = HEROES.find((h) => h.id === id);
    if (!hero || hero.level >= 20) continue;
    const cur = overrides[id] ?? { level: hero.level, stats: {} };
    cur.level = (cur.level ?? hero.level) + 1;
    overrides[id] = cur;
    pending[id] = (pending[id] || 0) + points;
    names.push(`${esc(hero.name)} (level ${cur.level})`);
  }
  if (!names.length) return ui.notifications.info("Nobody could be levelled up.");
  await game.settings.set(MOD, "heroOverrides", overrides);
  await game.settings.set(MOD, "pendingPoints", pending);
  await ChatMessage.create({ content: `<div class="dispatch-chat"><h3>Level up!</h3><p>${names.join(", ")}</p></div>` });
}

/** No stat can be raised above this. */
const STAT_CAP = 20;
/** How many more points a hero could still put into stats before every stat is at the cap. */
const statRoom = (hero) => STATS.reduce((a, k) => a + Math.max(0, STAT_CAP - (hero?.stats?.[k] ?? 0)), 0);
/** Points that must be spent when training: all of them, unless the stats run out of room. */
const pointsToSpend = (hero, pending) => Math.min(pending, statRoom(hero));

/** Check a training request: exact point total, hero recruited and ready. Returns clean gains or null. */
function cleanTraining(heroId, gains) {
  const hero = HEROES.find((h) => h.id === heroId);
  const available = pendingFor(heroId);
  const clean = Object.fromEntries(STATS.map((k) => [k, Math.max(0, Math.floor(Number(gains?.[k]) || 0))]));
  const spent = Object.values(clean).reduce((a, b) => a + b, 0);
  if (!hero?.recruited || !available || spent !== pointsToSpend(hero, available) || heroState(getState(), heroId).status !== "ready") return null;
  if (STATS.some((k) => hero.stats[k] + clean[k] > STAT_CAP)) return null;
  return clean;
}

const PENDING_TRAIN = new Set();
const PENDING_DEPLOY = new Set();
const PENDING_RECRUIT = new Set();

/** GM client only: handle a player's "Deploy" (after the GM's approval, if required). */
async function requestDeployment({ missionId, heroIds, userId }) {
  const mission = MISSIONS.find((m) => m.id === missionId);
  if (!mission || PENDING_DEPLOY.has(missionId)) return;
  const reply = (type) => game.socket.emit(SOCKET, { type, userId, missionName: mission.name });
  const state = getState();
  const heroes = (heroIds ?? []).map((id) => HEROES.find((h) => h.id === id));
  const valid =
    heroes.length >= 1 && heroes.length <= mission.slots && // any number of heroes up to the notice's slots
    heroes.every((h) => h?.recruited && heroState(state, h.id).status === "ready") &&
    !state.active.some((e) => e.missionId === missionId) &&
    !state.done.includes(missionId);
  if (!valid) {
    ui.notifications.warn("A deployment request was rejected (the party or mission is no longer available).");
    return reply("deployDenied");
  }
  PENDING_DEPLOY.add(missionId);
  try {
    const who = game.users.get(userId)?.name ?? "A player";
    const base = calcChance(mission, heroes);
    const adv = advantageFor(mission, heroes);
    const ok = await approve(
      "Approve deployment?",
      `<p><strong>${esc(who)}</strong> wants to deploy on <strong>${esc(mission.name)}</strong> (${mission.durationHours} in-game hours):</p>
        <ul>${heroes.map((h) => `<li>${esc(h.name)}, level ${h.level} ${esc(h.class)}</li>`).join("")}</ul>
        <p><em>GM only: success chance ${adv ? `${base}%, ${withAdvantage(base)}% with advantage (${esc(mission.hiddenSkill)})` : `${base}%`}.</em></p>`,
      "Approve deployment"
    );
    if (ok) {
      await sendParty(missionId, heroes.map((h) => h.id));
      const assign = structuredClone(SEL.assign);
      delete assign[missionId];
      setSelection(assign);
      reply("deployApproved");
    } else reply("deployDenied");
  } finally {
    PENDING_DEPLOY.delete(missionId);
  }
}

/** GM client only: handle a player's training request (after approval, if required). */
async function requestTraining({ heroId, gains, userId }) {
  const hero = HEROES.find((h) => h.id === heroId);
  if (!hero || PENDING_TRAIN.has(heroId)) return;
  const reply = (type) => game.socket.emit(SOCKET, { type, userId, heroName: hero.name });
  const clean = cleanTraining(heroId, gains);
  if (!clean) {
    ui.notifications.warn("A training request was rejected (points did not match, or the hero was busy).");
    return reply("trainDenied");
  }
  PENDING_TRAIN.add(heroId);
  try {
    const hours = Number(game.settings.get(MOD, "trainingHours")) || 0;
    const who = game.users.get(userId)?.name ?? "A player";
    const list = STATS.filter((k) => clean[k]).map((k) => `<li>+${clean[k]} ${k}</li>`).join("");
    const ok = await approve(
      "Approve training?",
      `<p><strong>${esc(who)}</strong> wants <strong>${esc(hero.name)}</strong> to train for ${hours} in-game hour${hours === 1 ? "" : "s"}.</p><ul>${list}</ul><p>The hero will be unavailable until they finish.</p>`,
      "Approve training"
    );
    if (ok && (await applyTraining(heroId, clean))) reply("trainApproved");
    else reply("trainDenied");
  } finally {
    PENDING_TRAIN.delete(heroId);
  }
}

/* ---------- Recruiting ---------- */

const recruitedCount = () => HEROES.filter((h) => h.recruited).length;
const maxRecruits = () => Math.max(1, Math.round(Number(game.settings.get(MOD, "maxRecruits")) || 8));

/** GM only: change a hero's recruited / recruitable flags (stored in the world, heroes.json is untouched). */
async function setHeroFlags(id, patch) {
  if (!game.user.isGM) return;
  const flags = JSON.parse(JSON.stringify(game.settings.get(MOD, "heroFlags") ?? {}));
  flags[id] = { ...(flags[id] ?? {}), ...patch };
  await game.settings.set(MOD, "heroFlags", flags);
}

/** GM client only: handle a player's "Recruit" (after approval, if required). */
async function requestRecruit({ heroId, userId }) {
  const hero = HEROES.find((h) => h.id === heroId);
  if (!hero || PENDING_RECRUIT.has(heroId)) return;
  const reply = (type) => game.socket.emit(SOCKET, { type, userId, heroName: hero.name });
  if (hero.recruited || !hero.recruitable || recruitedCount() >= maxRecruits()) {
    ui.notifications.warn("A recruit request was rejected (the hero is unavailable or the roster is full).");
    return reply("recruitDenied");
  }
  PENDING_RECRUIT.add(heroId);
  try {
    const who = game.users.get(userId)?.name ?? "A player";
    const ok = await approve(
      "Approve recruit?",
      `<p><strong>${esc(who)}</strong> wants to recruit <strong>${esc(hero.name)}</strong> (level ${hero.level} ${esc(hero.class)}).</p><p>Roster: ${recruitedCount()} of ${maxRecruits()}.</p>`,
      "Approve recruit"
    );
    if (ok && (await applyRecruit(heroId))) reply("recruitApproved");
    else reply("recruitDenied");
  } finally {
    PENDING_RECRUIT.delete(heroId);
  }
}

const PENDING_PROF = new Set();

/** Can this hero still pick a second proficiency? */
const canPickProficiency = (h) => !!h?.recruited && (h.xp ?? 0) >= XP_SECOND_PROF && !h.proficiency2;

/** GM client only: handle a player's choice of a second proficiency (after approval, if required). */
async function requestProficiency({ heroId, skill, userId }) {
  const hero = HEROES.find((h) => h.id === heroId);
  if (!hero || PENDING_PROF.has(heroId)) return;
  const reply = (type) => game.socket.emit(SOCKET, { type, userId, heroName: hero.name });
  if (!canPickProficiency(hero) || !SKILLS.includes(skill) || skill === hero.proficiency) return reply("profDenied");
  PENDING_PROF.add(heroId);
  try {
    const who = game.users.get(userId)?.name ?? "A player";
    const ok = await approve(
      "Approve second proficiency?",
      `<p><strong>${esc(who)}</strong> wants <strong>${esc(hero.name)}</strong> to gain proficiency in <strong>${esc(skill)}</strong>.</p>`,
      "Approve"
    );
    if (ok && (await applyProficiency(heroId, skill))) reply("profApproved");
    else reply("profDenied");
  } finally {
    PENDING_PROF.delete(heroId);
  }
}

/** GM client only: record the hero's second proficiency. Returns true on success. */
async function applyProficiency(heroId, skill) {
  const hero = HEROES.find((h) => h.id === heroId);
  if (!canPickProficiency(hero) || !SKILLS.includes(skill) || skill === hero.proficiency) return false;
  const ovr = JSON.parse(JSON.stringify(game.settings.get(MOD, "heroOverrides") ?? {}));
  const cur = ovr[heroId] ?? { level: hero.level, stats: {} };
  cur.proficiency2 = skill;
  ovr[heroId] = cur;
  await game.settings.set(MOD, "heroOverrides", ovr);
  await ChatMessage.create({ content: `<div class="dispatch-chat"><h3>New proficiency</h3><p>${esc(hero.name)} is now also proficient in ${esc(skill)}.</p></div>` });
  return true;
}

const PENDING_RETIRE = new Set();

/** GM client only: handle a player's "Retire" (after approval, if required). */
async function requestRetire({ heroId, userId }) {
  const hero = HEROES.find((h) => h.id === heroId);
  if (!hero || PENDING_RETIRE.has(heroId)) return;
  const reply = (type) => game.socket.emit(SOCKET, { type, userId, heroName: hero.name });
  if (!hero.recruited || heroState(getState(), heroId).status === "away") {
    ui.notifications.warn("A retire request was rejected (the hero is not on the roster or is out on a mission).");
    return reply("retireDenied");
  }
  PENDING_RETIRE.add(heroId);
  try {
    const who = game.users.get(userId)?.name ?? "A player";
    const ok = await approve(
      "Approve retirement?",
      `<p><strong>${esc(who)}</strong> wants to retire <strong>${esc(hero.name)}</strong> (level ${hero.level} ${esc(hero.class)}) from the roster.</p>`,
      "Approve retirement"
    );
    if (ok && (await applyRetire(heroId))) reply("retireApproved");
    else reply("retireDenied");
  } finally {
    PENDING_RETIRE.delete(heroId);
  }
}

/** GM client only: remove a hero from the roster. Returns true on success. */
async function applyRetire(heroId) {
  const hero = HEROES.find((h) => h.id === heroId);
  const state = getState();
  if (!hero?.recruited || heroState(state, heroId).status === "away") return false;
  assignHero(heroId, null);
  delete state.heroes[heroId];
  await saveState(state);
  const pending = JSON.parse(JSON.stringify(game.settings.get(MOD, "pendingPoints") ?? {}));
  if (pending[heroId]) { delete pending[heroId]; await game.settings.set(MOD, "pendingPoints", pending); }
  await setHeroFlags(heroId, { recruited: false, recruitable: false });
  await ChatMessage.create({ content: `<div class="dispatch-chat"><h3>Retired</h3><p>${esc(hero.name)} leaves the roster.</p></div>` });
  return true;
}

/** GM client only: add a hero to the roster. Returns true on success. */
async function applyRecruit(heroId) {
  const hero = HEROES.find((h) => h.id === heroId);
  if (!hero || hero.recruited) return false;
  if (recruitedCount() >= maxRecruits()) {
    ui.notifications.warn("The roster is full.");
    return false;
  }
  await setHeroFlags(heroId, { recruited: true });
  await ChatMessage.create({
    content: `<div class="dispatch-chat"><h3>New recruit</h3><p>${esc(hero.name)}, level ${hero.level} ${esc(hero.class)}, joins the party.</p></div>`
  });
  return true;
}

/** GM client only: save the stat gains and send the hero off to train. Returns true on success. */
async function applyTraining(heroId, gains) {
  const clean = cleanTraining(heroId, gains);
  if (!clean) {
    ui.notifications.warn("That training request is no longer valid.");
    return false;
  }
  const hero = HEROES.find((h) => h.id === heroId);
  const state = getState();

  const overrides = JSON.parse(JSON.stringify(game.settings.get(MOD, "heroOverrides") ?? {}));
  const cur = overrides[heroId] ?? { level: hero.level, stats: {} };
  cur.stats = { ...hero.stats, ...cur.stats };
  for (const k of STATS) cur.stats[k] = Math.min(STAT_CAP, cur.stats[k] + clean[k]);
  overrides[heroId] = cur;
  await game.settings.set(MOD, "heroOverrides", overrides);

  const pending = JSON.parse(JSON.stringify(game.settings.get(MOD, "pendingPoints") ?? {}));
  delete pending[heroId];
  await game.settings.set(MOD, "pendingPoints", pending);

  const hours = Number(game.settings.get(MOD, "trainingHours")) || 0;
  if (Object.values(SEL.assign).flat().includes(heroId)) assignHero(heroId, null);
  state.heroes[heroId] = { status: "training", until: game.time.worldTime + hoursToSeconds(hours) };
  await saveState(state);

  const gained = STATS.filter((k) => clean[k]).map((k) => `+${clean[k]} ${k}`).join(", ");
  await ChatMessage.create({
    content: `<div class="dispatch-chat"><h3>Training</h3><p>${esc(hero.name)} trains (${gained}) and will be away for ${hours} hour${hours === 1 ? "" : "s"}.</p></div>`
  });
  return true;
}

/** Move a hero onto a mission (or back to the roster when missionId is null). */
function assignHero(heroId, missionId) {
  const state = getState();
  if (missionId) {
    const m = MISSIONS.find((x) => x.id === missionId);
    const busy = state.active.some((e) => e.missionId === missionId);
    const current = (SEL.assign[missionId] ?? []).filter((id) => id !== heroId);
    if (!m || busy || heroState(state, heroId).status !== "ready") return;
    if (current.length >= m.slots) return ui.notifications.warn("That notice has no free slots.");
  }
  const assign = structuredClone(SEL.assign);
  for (const k of Object.keys(assign)) {
    assign[k] = assign[k].filter((id) => id !== heroId);
    if (!assign[k].length) delete assign[k];
  }
  if (missionId) assign[missionId] = [...(assign[missionId] ?? []), heroId];
  setSelection(assign);
}

/* ---------- Data & state ---------- */

const resolveImg = (img) =>
  !img ? "icons/svg/mystery-man.svg" : /^(https?:|\/|icons\/|modules\/|systems\/|worlds\/|data:)/.test(img) ? img : `${DATA}portraits/${img}`;

async function loadData() {
  BASE_HEROES = (await (await fetch(DATA + "heroes.json")).json()).map((h) => ({ ...h, img: resolveImg(h.img) }));
  MISSIONS = await (await fetch(DATA + "missions.json")).json();
  applyOverrides();
}

/** Merge the GM's saved level/stat changes and recruit flags over the heroes in heroes.json. */
function applyOverrides() {
  const ov = game.settings.get(MOD, "heroOverrides") ?? {};
  const flags = game.settings.get(MOD, "heroFlags") ?? {};
  HEROES = BASE_HEROES.map((h) => {
    const o = ov[h.id];
    const f = flags[h.id];
    const hero = {
      ...h,
      ...(o ? { level: o.level ?? h.level, stats: { ...h.stats, ...(o.stats ?? {}) } } : {}),
      xp: Math.max(0, Math.round(Number(o?.xp ?? h.xp ?? 0)) || 0),
      proficiency2: o?.proficiency2 ?? h.proficiency2 ?? null,
      recruited: f?.recruited ?? h.recruited ?? false,
      recruitable: f?.recruitable ?? h.recruitable ?? false
    };
    for (const k of STATS) hero.stats[k] = Math.min(STAT_CAP, hero.stats[k]);
    return hero;
  });
}

const getState = () => {
  const st = JSON.parse(JSON.stringify(game.settings.get(MOD, "state")));
  st.done ??= []; // mission ids whose notice has been taken down
  return st;
};
const saveState = (s) => game.settings.set(MOD, "state", s);
const heroState = (s, id) => s.heroes[id] ?? { status: "ready" };
const hoursToSeconds = (h) => h * 3600;
const statusText = (hs, now) => {
  const hrs = hs.until ? Math.max(0, Math.ceil((hs.until - now) / 3600)) : 0;
  return hs.status === "ready" ? "Ready" : hs.status === "away" ? "On mission" : hs.status === "training" ? `Training (${hrs}h)` : hs.status === "celebrating" ? `Celebrating (${hrs}h)` : `Injured (${hrs}h)`;
};
const pendingFor = (id) => (game.settings.get(MOD, "pendingPoints") ?? {})[id] ?? 0;

function partyTotals(heroes) {
  const t = Object.fromEntries(STATS.map((k) => [k, 0]));
  for (const h of heroes) for (const k of STATS) t[k] += h.stats[k] ?? 0;
  return t;
}

/** 70% at exactly meeting requirements, scaling with surplus/deficit. Clamped 5-95. */
function calcChance(mission, heroes) {
  if (!heroes.length) return 0;
  if (mission.guaranteed) return 100; // tier 0 missions always succeed
  const totals = partyTotals(heroes);
  const reqs = Object.entries(mission.requirements);
  const avg = reqs.reduce((a, [k, need]) => a + Math.min(totals[k] / need, 1.5), 0) / reqs.length;
  return Math.max(5, Math.min(95, Math.round(avg * 70)));
}

/** Hidden mission skill: advantage on the roll if anyone in the party is proficient in it. */
const advantageFor = (mission, heroes) => !!mission.hiddenSkill && heroes.some((h) => heroProfs(h).includes(mission.hiddenSkill));
/** Chance of success when the roll is made with advantage (best of two). */
const withAdvantage = (chance) => Math.round((1 - (1 - chance / 100) ** 2) * 100);

/* ---------- Dispatch logic (GM only) ---------- */

async function sendParty(missionId, heroIds) {
  const mission = MISSIONS.find((m) => m.id === missionId);
  const heroes = heroIds.map((id) => HEROES.find((h) => h.id === id));
  const state = getState();
  const chance = calcChance(mission, heroes);
  state.active.push({
    missionId,
    heroIds,
    chance,
    returnAt: game.time.worldTime + hoursToSeconds(mission.durationHours)
  });
  for (const id of heroIds) state.heroes[id] = { status: "away", missionId };
  await saveState(state);
  // Public message: no odds. The GM gets the numbers in a private whisper.
  await ChatMessage.create({
    content: `<div class="dispatch-chat"><h3>Dispatched: ${mission.name}</h3>
      <p>${heroes.map((h) => h.name).join(", ")} set out. They return in ${mission.durationHours}h.</p></div>`
  });
  await ChatMessage.create({
    whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
    content: `<div class="dispatch-chat"><p><i>GM only:</i> ${mission.name} success chance is <b>${chance}%</b>${advantageFor(mission, heroes) ? ` (${withAdvantage(chance)}% with advantage from ${mission.hiddenSkill})` : ""}.</p></div>`
  });
}

/** Resolves one active dispatch, mutating `state`. Caller must save. */
async function resolveEntry(state, entry) {
  const mission = MISSIONS.find((m) => m.id === entry.missionId);
  const heroes = entry.heroIds.map((id) => HEROES.find((h) => h.id === id));
  const advantage = advantageFor(mission, heroes); // hidden skill: roll twice, keep the better result
  const roll = await new Roll(advantage ? "2d100kl" : "1d100").evaluate();
  const r = roll.total;
  const chance = entry.chance;
  const now = game.time.worldTime;
  // Critical success: bottom 20% of the winning range. Critical failure: top 20% of the losing range.
  const outcome =
    r <= Math.floor(chance * 0.2) ? "crit" : r <= chance ? "success" : r > chance + 0.8 * (100 - chance) ? "critfail" : "fail";

  for (const h of heroes) state.heroes[h.id] = { status: "ready" };

  let body = "";
  let victims = [], gold = 0, xp = 0, xpBonus = 1, lootNote = "", pctShown = 100, injuryHours = 0, celebrateHours = 0;
  if (outcome === "fail" || outcome === "critfail") {
    const mult = Number(game.settings.get(MOD, outcome === "critfail" ? "critFailMultiplier" : "injuryMultiplier"));
    injuryHours = Math.max(0, Math.round(mission.failure.injuryHours * (Number.isFinite(mult) ? mult : 1)));
    // A critical failure injures every hero; an ordinary failure injures one at random.
    victims = outcome === "critfail" ? [...heroes] : [heroes[Math.floor(Math.random() * heroes.length)]];
    if (injuryHours > 0) for (const v of victims) state.heroes[v.id] = { status: "injured", until: now + hoursToSeconds(injuryHours) };
    body = `<p><b>${outcome === "critfail" ? "CRITICAL FAILURE!" : "FAILURE."}</b> ${esc(mission.failure.note)}</p>${
      injuryHours > 0
        ? outcome === "critfail"
          ? `<p>Every hero was injured and needs ${injuryHours}h to recover.</p>`
          : `<p>${esc(victims[0].name)} was injured and needs ${injuryHours}h to recover.</p>`
        : ""
    }`;
  } else {
    const mult = outcome === "crit" ? 2 : 1;
    const pct = Math.max(0, Number(game.settings.get(MOD, "rewardPercent")) || 0) / 100;
    gold = Math.round(mission.rewards.gold * mult * pct);
    // Short-handed parties earn more XP each: x1.5, x2, x2.5 for 1-3 empty slots, x5 for 4.
    const missing = Math.max(0, Math.min(4, mission.slots - heroes.length));
    xpBonus = [1, 1.5, 2, 2.5, 5][missing];
    pctShown = Math.round(pct * 100);
    xp = Math.round(mission.rewards.xp * mult * xpBonus); // every hero receives the full XP; the reward percentage only affects gold
    state.treasury.gold += gold;
    lootNote = await addGroupLoot(gold);
    await awardXp(heroes, xp);
    celebrateHours = Math.max(0, Math.round(Number(game.settings.get(MOD, "celebrateHours")) || 0));
    if (celebrateHours > 0) for (const h of heroes) state.heroes[h.id] = { status: "celebrating", until: now + hoursToSeconds(celebrateHours) };
    const earner = esc(String(game.settings.get(MOD, "earnerName") || "The party"));
    body = `<p><b>${outcome === "crit" ? "CRITICAL SUCCESS!" : "SUCCESS!"}</b> Each hero gains <b>${xp} XP</b>${mult > 1 ? " (doubled)" : ""}${xpBonus > 1 ? ` (x${xpBonus} for a short-handed party)` : ""}; ${earner} earned <b>${gold} gp</b> with its <b>${pctShown}%</b> cut.${lootNote}</p>${
      celebrateHours > 0 ? `<p>The party is celebrating for ${celebrateHours}h.</p>` : ""
    }`;
  }

  state.active = state.active.filter((e) => !(e.missionId === entry.missionId && e.returnAt === entry.returnAt));
  if (!state.done.includes(mission.id)) state.done.push(mission.id); // the notice comes down, win or lose
  await ChatMessage.create({
    content: `<div class="dispatch-chat"><h3>${esc(mission.name)}: Returned</h3>
      <p>Party: ${heroes.map((h) => esc(h.name)).join(", ")}</p>${body}</div>`
  });
  await ChatMessage.create({
    whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
    content: `<div class="dispatch-chat"><p><i>GM only:</i> ${esc(mission.name)} rolled <b>${r}</b> vs ${chance}%${advantage ? ` with advantage (${esc(mission.hiddenSkill)})` : ""}.</p></div>`
  });
  await logMission({ mission, heroes, outcome, victims, gold, xp, xpBonus, injuryHours, celebrateHours });
}

/* ---------- Mission log (journal entry with a page per completed mission) ---------- */

const findLog = () => game.journal.find((j) => j.getFlag(MOD, "log"));

async function ensureLog() {
  return (
    findLog() ??
    (await JournalEntry.create({
      name: "Dispatch Mission Log",
      flags: { [MOD]: { log: true } },
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
    }))
  );
}

async function logMission({ mission, heroes, outcome, victims = [], gold, xp, xpBonus = 1, injuryHours = 0, celebrateHours = 0 }) {
  try {
    const journal = await ensureLog();
    const runs = journal.pages.filter((p) => p.getFlag(MOD, "missionId") === mission.id).length;
    const title = runs ? `${mission.name} (run ${runs + 1})` : mission.name;
    const label = { crit: "Critical Success", success: "Success", fail: "Failure", critfail: "Critical Failure" }[outcome];
    const failed = outcome === "fail" || outcome === "critfail";
    const result = failed
      ? `<p><strong>${label}.</strong> ${esc(mission.failure.note)}</p>${
          injuryHours > 0 ? `<p>${victims.map((v) => esc(v.name)).join(", ")} ${victims.length > 1 ? "were" : "was"} injured and needed ${injuryHours} hours to recover.</p>` : ""
        }`
      : `<p><strong>${label}!</strong> ${esc(String(game.settings.get(MOD, "earnerName") || "The party"))} earned <strong>${gold} gp</strong> and each hero gained <strong>${xp} XP</strong>${outcome === "crit" ? " (doubled)" : ""}${xpBonus > 1 ? ` (x${xpBonus} for a short-handed party)` : ""}.</p>${
          celebrateHours > 0 ? `<p>They celebrated for ${celebrateHours} hours.</p>` : ""
        }`;
    const content = `<h2>${esc(mission.name)}</h2>
      <p><em>${esc(mission.subtitle ?? "")}</em></p>
      <h3>Mission</h3>
      <p>${esc(mission.description)}</p>
      <ul><li>Tier ${mission.tier}</li><li>Duration: ${mission.durationHours} hours</li><li>Posted reward: ${mission.rewards.gold} gp, ${mission.rewards.xp} XP</li></ul>
      <h3>Party sent</h3>
      <ul>${heroes.map((h) => `<li><strong>${esc(h.name)}</strong>, level ${h.level} ${esc(h.class)}</li>`).join("")}</ul>
      <h3>Outcome: ${label}</h3>
      ${result}
      <p><small>Completed ${esc(new Date().toLocaleString())}</small></p>`;
    await journal.createEmbeddedDocuments("JournalEntryPage", [
      {
        name: title,
        type: "text",
        text: { content, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
        flags: { [MOD]: { missionId: mission.id } }
      }
    ]);
  } catch (err) {
    console.error(`${MOD} | could not write the mission log`, err);
  }
}

/**
 * Decide which missions are posted. Finished missions come down; if fewer than the minimum remain,
 * random missions from missions.json fill the board up to a random number between the minimum and
 * the maximum. Never more than the maximum (parties that are out always stay up). Returns true if changed.
 */
function ensureBoard(state) {
  const maxN = Math.min(SLOT_COUNT, Math.max(1, Math.round(Number(game.settings.get(MOD, "maxNotices")) || SLOT_COUNT)));
  const minN = Math.min(maxN, Math.max(0, Math.round(Number(game.settings.get(MOD, "minNotices")) || 0)));
  const fresh = !Array.isArray(state.board);
  const before = JSON.stringify(state.board ?? null);
  const prevBoard = fresh ? [] : [...state.board];
  const hidden = new Set(game.settings.get(MOD, "hiddenTiers") ?? []);
  const outIds = new Set(state.active.map((e) => e.missionId));
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => (fresh ? null : state.board[i] ?? null));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const empties = () => slots.map((v, i) => (v ? null : i)).filter((i) => i !== null);
  const count = () => slots.filter(Boolean).length;

  // Take down notices that are finished, unknown, or in a hidden tier (unless a party is out on them).
  slots.forEach((id, i) => {
    if (!id) return;
    const m = MISSIONS.find((x) => x.id === id);
    if (!m || state.done.includes(id) || (hidden.has(m.tier) && !outIds.has(id))) slots[i] = null;
  });
  // A mission with a party out must be on the board.
  for (const id of outIds) {
    if (!slots.includes(id) && empties().length) slots[pick(empties())] = id;
  }
  // Too many: take some down at random, never one that is out.
  while (count() > maxN) {
    const removable = slots.map((id, i) => (id && !outIds.has(id) ? i : null)).filter((i) => i !== null);
    if (!removable.length) break;
    slots[pick(removable)] = null;
  }
  // Too few (or a brand-new board): pull random missions from the pool.
  if (fresh || count() < minN) {
    const lo = fresh ? Math.max(1, minN) : minN;
    const target = lo + Math.floor(Math.random() * (maxN - lo + 1));
    const pool = MISSIONS.filter((m) => !slots.includes(m.id) && !state.done.includes(m.id) && !hidden.has(m.tier));
    while (count() < target && pool.length && empties().length) {
      const m = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      slots[pick(empties())] = m.id;
    }
  }
  state.board = slots;
  assignLooks(state, prevBoard);
  const changed = JSON.stringify(slots) !== before || state.looksChanged;
  delete state.looksChanged;
  return changed;
}

/**
 * Every time a mission is pinned to a spot it gets a brand-new random size, tilt, flip, nail and position
 * that avoids the notices already up. Notices that stay on the board keep their look.
 */
function assignLooks(state, prevBoard) {
  const old = JSON.stringify(state.looks ?? null);
  const looks = Array.from({ length: SLOT_COUNT }, (_, i) => (state.looks?.[i] ?? null));
  const need = [];
  state.board.forEach((id, i) => {
    if (!id) looks[i] = null;
    else if (!looks[i] || prevBoard[i] !== id) { looks[i] = null; need.push(i); }
  });
  const boxOf = (id) => {
    const p = noticeParams({ id });
    const w = NOTICE_W * p.s, h = w * NOTICE_ASPECT, t = (Math.abs(p.rot) * Math.PI) / 180;
    return { bw: w * Math.cos(t) + h * Math.sin(t) + NOTICE_GAP, bh: h * Math.cos(t) + w * Math.sin(t) + NOTICE_GAP };
  };
  const rand = () => Math.random().toString(36).slice(2, 9);
  if (need.length >= 4) {
    // Mostly new board: pack everything together at random.
    const ids = need.map((i) => `L${rand()}:${i}`);
    const pos = layoutNotices(ids.map((id) => ({ id })));
    need.forEach((i, k) => { looks[i] = { id: ids[k], ...pos.get(ids[k]), ...boxOf(ids[k]) }; });
  } else {
    const a = BOARD_AREA;
    for (const i of need) {
      let best = null, bestRoom = -Infinity;
      for (let attempt = 0; attempt < 40 && bestRoom < 0; attempt++) {
        const id = `L${rand()}:${i}`;
        const box = boxOf(id);
        for (let t = 0; t < 120; t++) {
          const c = {
            cx: a.x0 + box.bw / 2 + Math.random() * (a.x1 - a.x0 - box.bw),
            cy: a.y0 + box.bh / 2 + Math.random() * (a.y1 - a.y0 - box.bh)
          };
          const room = Math.min(
            Infinity,
            ...looks.filter(Boolean).map((o) => Math.max(Math.abs(o.cx - c.cx) - (o.bw + box.bw) / 2, Math.abs(o.cy - c.cy) - (o.bh + box.bh) / 2))
          );
          if (room > bestRoom) { bestRoom = room; best = { id, ...c, ...box }; }
          if (bestRoom >= 0) break;
        }
      }
      looks[i] = best;
    }
  }
  state.looks = looks;
  state.looksChanged = JSON.stringify(looks) !== old;
}

/** Drop hero assignments for notices that are no longer on the board. */
function pruneSelection(state) {
  const onBoard = new Set((state.board ?? []).filter(Boolean));
  const assign = structuredClone(SEL.assign);
  let changed = false;
  for (const k of Object.keys(assign)) {
    if (!onBoard.has(k)) { delete assign[k]; changed = true; }
  }
  if (changed) setSelection(assign);
}

/** GM client: re-check the board after settings or progress change. */
async function refreshBoard() {
  if (!game.user.isGM || !MISSIONS.length) return;
  try {
    const state = getState();
    if (ensureBoard(state)) await saveState(state);
    pruneSelection(state);
  } catch (err) {
    console.error(`${MOD} | refreshBoard failed`, err);
    ui.notifications.error(`Dispatch: ${err.message} (see the console, F12)`);
  }
}

async function tick() {
  try { await tickInner(); }
  catch (err) {
    console.error(`${MOD} | tick failed`, err);
    ui.notifications.error(`Dispatch: ${err.message} (see the console, F12)`);
  }
}

async function tickInner() {
  if (!game.user.isGM || !HEROES.length) return;
  const state = getState();
  const now = game.time.worldTime;
  let changed = false;
  for (const entry of [...state.active]) {
    if (entry.returnAt <= now) { await resolveEntry(state, entry); changed = true; }
  }
  for (const [id, hs] of Object.entries(state.heroes)) {
    if (["injured", "training", "celebrating"].includes(hs.status) && hs.until <= now) { state.heroes[id] = { status: "ready" }; changed = true; }
  }
  if (ensureBoard(state)) changed = true;
  if (changed) await saveState(state);
  pruneSelection(state);
}

/* ---------- Deterministic randomness (same look on every client) ---------- */

function rng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^= h >>> 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Everything is laid out in cqw (1% of the notice board's width) so it scales with the window.
// Notices are packed at random without overlapping, inside the frame of the notice board image.
const NOTICE_W = 13; // small enough that up to ten notices fit on the board
const BOARD_AREA = { x0: 6.8, x1: 93.2, y0: 13, y1: 56.5 }; // inside the frame, under the sign, above the hero row
const NOTICE_GAP = 0.5;

function noticeParams(m) {
  const r = rng("notice:" + m.id);
  return {
    s: 0.86 + r() * 0.28, // notices vary in size by about +-14%
    rot: (r() - 0.5) * 8,
    fx: r() < 0.5 ? -1 : 1,
    fy: r() < 0.5 ? -1 : 1,
    nail: {
      img: r() < 0.5 ? 1 : 2,
      flip: r() < 0.5 ? -1 : 1,
      scale: (0.85 + r() * 0.3).toFixed(2),
      left: (44 + r() * 12).toFixed(1),
      top: (-0.9 + r() * 1.0).toFixed(2),
      rot: ((r() - 0.5) * 24).toFixed(1)
    }
  };
}

/**
 * Random, non-overlapping positions (centre points in cqw) for every notice, stable for a given mission list.
 * Start from random spots, then push overlapping notices apart until none touch.
 */
function layoutNotices(list) {
  const r = rng("pack:" + list.map((m) => m.id).join(","));
  const a = BOARD_AREA;
  const items = list.map((m) => {
    const p = noticeParams(m);
    const w = NOTICE_W * p.s, h = w * NOTICE_ASPECT, t = (Math.abs(p.rot) * Math.PI) / 180;
    return { id: m.id, bw: w * Math.cos(t) + h * Math.sin(t) + NOTICE_GAP, bh: h * Math.cos(t) + w * Math.sin(t) + NOTICE_GAP };
  });
  const clamp = (it, c) => {
    c.cx = Math.min(a.x1 - it.bw / 2, Math.max(a.x0 + it.bw / 2, c.cx));
    c.cy = Math.min(a.y1 - it.bh / 2, Math.max(a.y0 + it.bh / 2, c.cy));
  };
  const overlapOf = (pts) => {
    let total = 0;
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const ox = (items[i].bw + items[j].bw) / 2 - Math.abs(pts[i].cx - pts[j].cx);
        const oy = (items[i].bh + items[j].bh) / 2 - Math.abs(pts[i].cy - pts[j].cy);
        if (ox > 0 && oy > 0) total += Math.min(ox, oy);
      }
    return total;
  };

  let best = null, bestOverlap = Infinity;
  for (let attempt = 0; attempt < 30 && bestOverlap > 0; attempt++) {
    const pts = items.map((it) => {
      const c = { cx: a.x0 + r() * (a.x1 - a.x0), cy: a.y0 + r() * (a.y1 - a.y0) };
      clamp(it, c);
      return c;
    });
    for (let step = 0; step < 500; step++) {
      let moved = false;
      for (let i = 0; i < items.length; i++)
        for (let j = i + 1; j < items.length; j++) {
          const dx = pts[j].cx - pts[i].cx, dy = pts[j].cy - pts[i].cy;
          const ox = (items[i].bw + items[j].bw) / 2 - Math.abs(dx);
          const oy = (items[i].bh + items[j].bh) / 2 - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          // Separate along the axis that needs the smaller shove.
          if (ox < oy) { const d = (ox / 2 + 0.01) * (dx >= 0 ? 1 : -1); pts[i].cx -= d; pts[j].cx += d; }
          else { const d = (oy / 2 + 0.01) * (dy >= 0 ? 1 : -1); pts[i].cy -= d; pts[j].cy += d; }
          clamp(items[i], pts[i]); clamp(items[j], pts[j]);
        }
      if (!moved) break;
    }
    const o = overlapOf(pts);
    if (o < bestOverlap) { best = pts.map((p) => ({ ...p })); bestOverlap = o; }
  }
  return new Map(items.map((it, i) => [it.id, best[i]]));
}

function noticeLook(m, pos) {
  const p = noticeParams(m);
  const w = NOTICE_W * p.s, h = w * NOTICE_ASPECT;
  return {
    style: `--left:${(pos.cx - w / 2).toFixed(2)}cqw;--top:${(pos.cy - h / 2).toFixed(2)}cqw;--s:${p.s.toFixed(3)};--rot:${p.rot.toFixed(2)}deg;--fx:${p.fx};--fy:${p.fy}`,
    nail: { img: p.nail.img, style: `left:${p.nail.left}%;top:${p.nail.top}cqw;--ns:${p.nail.scale};--nf:${p.nail.flip};--nr:${p.nail.rot}deg` }
  };
}

// The board has ten fixed spots. Each spot keeps its own size, tilt and position; a mission posted
// in a spot takes on that look, so notices never jump around when others come and go.
const SLOT_COUNT = 10;
let SLOT_LAYOUT = null;
const slotLayout = () => (SLOT_LAYOUT ??= layoutNotices(Array.from({ length: SLOT_COUNT }, (_, i) => ({ id: "slot" + i }))));

/** What players see instead of the percentage. */
function oddsFor(chance) {
  if (chance < 15) return { label: "Suicidal", cls: "suicidal" };
  if (chance < 40) return { label: "Dicey", cls: "dicey" };
  if (chance < 60) return { label: "Coin Toss", cls: "coin" };
  if (chance <= 90) return { label: "Promising", cls: "promising" };
  return { label: "Assured", cls: "assured" };
}

function heroLook(h) {
  const r = rng("hero:" + h.id);
  return `--rot:${((r() - 0.5) * 10).toFixed(1)}deg;--dy:${((r() - 0.5) * 0.8).toFixed(2)}cqw;--dx:${((r() - 0.5) * 1).toFixed(2)}cqw`;
}

/** Wax seal: ~30% of the notice's width, random spot in the top half, fully on the parchment. */
function sealLook(seed) {
  const r = rng("seal:" + seed);
  const heightPct = (30 * SEAL_ASPECT) / NOTICE_ASPECT;
  const left = 10 + r() * (90 - 30 - 10);
  const top = 8 + r() * Math.max(0, 50 - heightPct - 8);
  return `left:${left.toFixed(1)}%;top:${top.toFixed(1)}%;transform:rotate(${((r() - 0.5) * 40).toFixed(0)}deg)`;
}

/* ---------- Centred cards: level-up (spend stat points) and recruit ---------- */

let LEVELUP_CLEANUP = null;
function closeLevelUp() {
  LEVELUP_CLEANUP?.();
  LEVELUP_CLEANUP = null;
  LEVELUP_OPEN = null;
  RECRUIT_OPEN = null;
  document.querySelectorAll(".dispatch-levelup, .dispatch-levelup-backdrop").forEach((n) => n.remove());
}

const FALLBACK_IMG = `onerror="this.onerror=null;this.src='icons/svg/mystery-man.svg'"`;
const profLine = (hero) => (heroProfs(hero).length ? `<p class="prof">Proficiency: ${heroProfs(hero).map(esc).join(", ")}</p>` : "");

function mountCard(el) {
  const backdrop = document.createElement("div");
  backdrop.className = "dispatch-levelup-backdrop";
  backdrop.addEventListener("click", closeLevelUp);
  const onKey = (e) => { if (e.key === "Escape") closeLevelUp(); };
  window.addEventListener("keydown", onKey);
  LEVELUP_CLEANUP = () => window.removeEventListener("keydown", onKey);
  document.body.append(backdrop, el);
}

function openLevelUp(heroId) {
  closePopup();
  closeLevelUp();
  if (!HEROES.some((h) => h.id === heroId) || !pendingFor(heroId)) return;
  const gains = Object.fromEntries(STATS.map((k) => [k, 0]));
  const spent = () => Object.values(gains).reduce((a, b) => a + b, 0);
  const reset = () => STATS.forEach((k) => (gains[k] = 0));
  // Pick up a draft another player already started on this hero.
  const draft = LEVEL_DRAFT[heroId];
  if (draft) STATS.forEach((k) => (gains[k] = Math.max(0, Math.floor(Number(draft[k]) || 0))));
  if (spent() > pendingFor(heroId)) reset();

  const el = document.createElement("div");
  el.className = "dispatch-levelup";
  const share = () => {
    LEVEL_DRAFT[heroId] = { ...gains };
    game.socket.emit(SOCKET, { type: "levelDraft", heroId, gains: { ...gains } });
  };

  const draw = () => {
    const hero = HEROES.find((h) => h.id === heroId);
    const pending = pendingFor(heroId);
    if (!hero || !pending) return closeLevelUp();
    const need = pointsToSpend(hero, pending);
    const left = need - spent();
    el.innerHTML = `<button type="button" class="lu-close" data-act="close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      <img src="${esc(hero.img)}" alt="" ${FALLBACK_IMG}><h4>${esc(hero.name)}</h4>
      <p class="cls">Level ${hero.level} ${esc(hero.class)}</p><p class="cls hero-xp">${hero.xp ?? 0} XP</p>${profLine(hero)}
      <p class="points">Stat points to spend: <b>${left}</b>${need < pending ? ` <small>(stats are capped at ${STAT_CAP})</small>` : ""}</p>
      <ul>${STATS.map((k) => `<li><span class="k">${k}</span>
        <span class="v">${hero.stats[k]}${gains[k] ? ` <b class="gain">+${gains[k]}</b>` : ""}</span>
        <span class="ctl"><button type="button" data-act="dec" data-stat="${k}" ${gains[k] ? "" : "disabled"}>&minus;</button><button type="button" data-act="inc" data-stat="${k}" ${left && hero.stats[k] + gains[k] < STAT_CAP ? "" : "disabled"}>+</button></span></li>`).join("")}</ul>
      <button type="button" class="lu-train" data-act="train" ${left ? "disabled" : ""}>Train</button>`;
  };

  el.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const k = btn.dataset.stat;
    const pending = pendingFor(heroId);
    const h0 = HEROES.find((h) => h.id === heroId);
    const need = pointsToSpend(h0, pending);
    if (btn.dataset.act === "inc" && need - spent() > 0 && h0.stats[k] + gains[k] < STAT_CAP) { gains[k]++; share(); }
    else if (btn.dataset.act === "dec" && gains[k] > 0) { gains[k]--; share(); }
    else if (btn.dataset.act === "close") return closeLevelUp();
    else if (btn.dataset.act === "train" && spent() === need) {
      const hero = HEROES.find((h) => h.id === heroId);
      if (!game.users.activeGM) return ui.notifications.warn("A GM must be online to handle training.");
      const sent = { ...gains };
      if (game.user.isGM) applyTraining(heroId, sent); // the GM pressing Train is the approval
      else game.socket.emit(SOCKET, { type: "train", heroId, gains: sent, userId: game.user.id });
      ui.notifications.info(
        game.user.isGM ? `${hero.name} heads off to train.` : needApproval() ? "Training request sent. Waiting for the GM to approve it." : "Training request sent."
      );
      reset();
      share(); // everyone's open card goes back to zero in case the GM declines
      return closeLevelUp();
    }
    draw();
  });

  LEVELUP_OPEN = {
    heroId,
    setGains(g) { STATS.forEach((k) => (gains[k] = Math.max(0, Math.floor(Number(g?.[k]) || 0))));
      if (spent() > pendingFor(heroId)) reset();
      draw(); },
    refresh() { if (!pendingFor(heroId)) return closeLevelUp(); if (spent() > pendingFor(heroId)) reset(); draw(); }
  };
  draw();
  mountCard(el);
}

function openRecruitCard(heroId) {
  closePopup();
  closeLevelUp();
  if (!HEROES.some((h) => h.id === heroId)) return;
  const el = document.createElement("div");
  el.className = "dispatch-levelup dispatch-recruit";

  const draw = () => {
    const hero = HEROES.find((h) => h.id === heroId);
    // Close if the hero was recruited by someone else, or is no longer on offer to players.
    if (!hero || hero.recruited || (!game.user.isGM && !hero.recruitable)) return closeLevelUp();
    const full = recruitedCount() >= maxRecruits();
    el.innerHTML = `<button type="button" class="lu-close" data-act="close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      <img src="${esc(hero.img)}" alt="" ${FALLBACK_IMG}><h4>${esc(hero.name)}</h4>
      <p class="cls">Level ${hero.level} ${esc(hero.class)}</p><p class="cls hero-xp">${hero.xp ?? 0} XP</p>${profLine(hero)}
      ${hero.quirk ? `<p class="quirk">&ldquo;${esc(hero.quirk)}&rdquo;</p>` : ""}
      <ul>${STATS.map((k) => `<li><span class="k">${k}</span><span class="v">${hero.stats[k]}</span></li>`).join("")}</ul>
      <p class="points">Roster: ${recruitedCount()} of ${maxRecruits()}</p>
      <button type="button" class="lu-train" data-act="recruit" ${full ? "disabled" : ""}>${full ? "Roster full" : "Recruit"}</button>
      ${game.user.isGM ? `<button type="button" class="lu-toggle" data-act="toggle">${hero.recruitable ? "Available to recruit: click to hide" : "Hidden from players: click to offer"}</button>` : ""}`;
  };

  el.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const hero = HEROES.find((h) => h.id === heroId);
    if (btn.dataset.act === "close") return closeLevelUp();
    if (btn.dataset.act === "toggle" && game.user.isGM) return setHeroFlags(heroId, { recruitable: !hero.recruitable });
    if (btn.dataset.act === "recruit") {
      if (recruitedCount() >= maxRecruits()) return ui.notifications.warn("The roster is full.");
      if (game.user.isGM) { await applyRecruit(heroId); return closeLevelUp(); } // the GM recruiting is the approval
      if (!game.users.activeGM) return ui.notifications.warn("A GM must be online to handle recruiting.");
      game.socket.emit(SOCKET, { type: "recruit", heroId, userId: game.user.id });
      ui.notifications.info(needApproval() ? "Recruit request sent. Waiting for the GM to approve it." : "Recruit request sent.");
      closeLevelUp();
    }
  });

  RECRUIT_OPEN = { heroId, refresh: draw };
  draw();
  mountCard(el);
}

/* ---------- Stats popup (closes as soon as the mouse moves) ---------- */

let POPUP_CLEANUP = null;
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function closePopup() {
  POPUP_CLEANUP?.();
  POPUP_CLEANUP = null;
  document.querySelectorAll(".dispatch-popup").forEach((n) => n.remove());
}

function showStatsPopup(heroId, ev) {
  closePopup();
  const hero = HEROES.find((h) => h.id === heroId);
  if (!hero) return;
  const hs = heroState(getState(), heroId);
  const status = statusText(hs, game.time.worldTime);
  const el = document.createElement("div");
  el.className = "dispatch-popup";
  el.innerHTML = `<img src="${esc(hero.img)}" alt="" onerror="this.onerror=null;this.src='icons/svg/mystery-man.svg'"><h4>${esc(hero.name)}</h4>
    <p class="cls">Level ${hero.level} ${esc(hero.class)}</p><p class="cls hero-xp">${hero.xp ?? 0} XP</p>${profLine(hero)}
    ${hero.quirk ? `<p class="quirk">&ldquo;${esc(hero.quirk)}&rdquo;</p>` : ""}
    <ul>${STATS.map((k) => `<li><span>${k}</span><b>${hero.stats[k]}</b></li>`).join("")}</ul><em>${status}</em>
    ${canPickProficiency(hero) ? `<button type="button" class="pop-prof">Choose 2nd proficiency</button>` : ""}
    <button type="button" class="pop-retire" ${hs.status === "away" ? "disabled" : ""}>Retire</button>`;
  el.style.left = `${Math.max(8, Math.min(ev.clientX + 14, window.innerWidth - 280))}px`;
  el.style.top = `${Math.max(8, Math.min(ev.clientY - 20, window.innerHeight - 490))}px`;
  el.querySelector(".pop-prof")?.addEventListener("click", async () => {
    closePopup();
    const options = SKILLS.filter((k) => k !== hero.proficiency).map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join("");
    const skill = await foundry.applications.api.DialogV2.prompt({
      window: { title: `${hero.name}: second proficiency` },
      content: `<p>Choose a second proficiency for <strong>${esc(hero.name)}</strong>:</p><select name="skill" style="width:100%">${options}</select>`,
      ok: { label: "Choose", callback: (event, button) => button.form.elements.skill.value },
      rejectClose: false
    });
    if (!skill) return;
    if (game.user.isGM) return applyProficiency(heroId, skill);
    if (!game.users.activeGM) return ui.notifications.warn("A GM must be online to handle this.");
    game.socket.emit(SOCKET, { type: "profChoice", heroId, skill, userId: game.user.id });
    ui.notifications.info(needApproval() ? "Request sent. Waiting for the GM to approve it." : "Request sent.");
  });
  el.querySelector(".pop-retire").addEventListener("click", async () => {
    closePopup();
    if (!(await confirmDialog("Retire hero", `<p>Remove <strong>${esc(hero.name)}</strong> from the recruited roster?</p>`))) return;
    if (game.user.isGM) return applyRetire(heroId); // the GM retiring is the approval
    if (!game.users.activeGM) return ui.notifications.warn("A GM must be online to handle retiring.");
    game.socket.emit(SOCKET, { type: "retire", heroId, userId: game.user.id });
    ui.notifications.info(needApproval() ? "Retire request sent. Waiting for the GM to approve it." : "Retire request sent.");
  });
  document.body.append(el);

  // Stays open until a click lands somewhere other than the popup or a hero card.
  const onDown = (e) => { if (!e.target.closest(".dispatch-popup, .hero-card")) closePopup(); };
  const onKey = (e) => { if (e.key === "Escape") closePopup(); };
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey);
  POPUP_CLEANUP = () => {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey);
  };
}

/** Saved window geometry per scene, stored as fractions of the viewport so it fits any screen. */
const layoutFor = (sceneId) => {
  const L = sceneId ? game.settings.get(MOD, "layouts")?.[sceneId] : null;
  return L?.locked && L.sw ? L : null; // scene-anchored layouts only (sx, sy, sw in scene pixels)
};

/* ---------- UI ---------- */

class DispatchApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dispatch-app",
    classes: ["dispatch"],
    window: { title: "Dispatch Notice Board", resizable: true },
    position: { width: 1200, height: 1010 },
    actions: {
      send: DispatchApp.onSend,
      unassign: DispatchApp.onUnassign,
      resolveNow: DispatchApp.onResolveNow,
      bindScene: DispatchApp.onBindScene,
      lockLayout: DispatchApp.onLockLayout,
      restoreNotices: DispatchApp.onRestoreNotices,
      refreshNotices: DispatchApp.onRefreshNotices,
      addRecruits: DispatchApp.onAddRecruits,
      deploy: DispatchApp.onDeploy,
      levelUpHero: (event, target) => levelUp([target.dataset.hero]),
      levelUpEveryone: DispatchApp.onLevelUpEveryone,
      openSettings: () => openSettings(),
      openRecruit: (event, target) => openRecruitCard(target.dataset.hero),
      toggleRecruitable: (event, target) => {
        const hero = HEROES.find((h) => h.id === target.dataset.hero);
        if (hero) setHeroFlags(hero.id, { recruitable: !hero.recruitable });
      }
    }
  };
  static PARTS = { main: { template: `modules/${MOD}/templates/dispatch.hbs` } };

  async _onClose(options) {
    closePopup();
    closeLevelUp();
    return super._onClose?.(options);
  }

  async _prepareContext() {
    const state = getState();
    const now = game.time.worldTime;
    const isGM = game.user.isGM;
    const assigned = new Set(Object.values(SEL.assign).flat());

    const heroes = HEROES.filter((h) => h.recruited && !assigned.has(h.id)).map((h) => {
      const hs = heroState(state, h.id);
      if (!isGM && hs.status === "training") return null; // players do not see heroes who are training
      const pending = hs.status === "ready" ? pendingFor(h.id) : 0;
      return {
        ...h,
        look: heroLook(h),
        status: hs.status,
        statusLabel: statusText(hs, now),
        available: hs.status === "ready",
        ribbon: { celebrating: "Celebrating", injured: "Injured", training: "Training" }[hs.status] ?? null,
        pending
      };
    }).filter(Boolean);

        const layout = slotLayout();
    const missions = (state.board ?? []).map((id, slot) => {
      const m = id && !new Set(state.done).has(id) ? MISSIONS.find((x) => x.id === id) : null;
      if (!m) return null;
      const entryIndex = state.active.findIndex((e) => e.missionId === m.id);
      const entry = state.active[entryIndex];
      const party = entry
        ? entry.heroIds.map((id) => HEROES.find((h) => h.id === id)).filter(Boolean)
        : (SEL.assign[m.id] ?? [])
            .map((id) => HEROES.find((h) => h.id === id))
            .filter((h) => h && heroState(state, h.id).status === "ready");
      const totals = partyTotals(party);
      const chance = calcChance(m, party);
      const adv = advantageFor(m, party);
      const shownChance = adv ? withAdvantage(chance) : chance;
      const saved = state.looks?.[slot];
      const look = saved ? noticeLook({ id: saved.id }, saved) : noticeLook({ id: "slot" + slot }, layout.get("slot" + slot));
      return {
        ...m,
        ...look,
        stars: m.tier > 0 ? "\u2605".repeat(m.tier) : "\u2606", // one star per tier; tier 0 gets a single hollow star
        party,
        empty: entry ? [] : Array.from({ length: Math.max(0, m.slots - party.length) }),
        // Requirements and odds are for the GM only.
        reqs: isGM ? STATS.filter((k) => k in m.requirements).map((k) => ({ abbr: ABBR[k], need: m.requirements[k], have: totals[k], met: totals[k] >= m.requirements[k] })) : [],
        chance: isGM ? shownChance : null,
        chanceClass: shownChance >= 70 ? "good" : shownChance >= 40 ? "mid" : "bad",
        // Combined stats of everyone placed on the notice: visible to all players.
        totals: party.length ? STATS.map((k) => ({ abbr: ABBR[k], val: totals[k] })) : null,
        // The hidden skill is for the GM's eyes only.
        hidden: isGM ? m.hiddenSkill ?? null : null,
        hiddenHit: isGM && adv,
        // Everyone sees the wording; only the GM sees the number (chance, above).
        odds: !entry && party.length ? oddsFor(chance) : null,
        busy: !!entry,
        away: entry && {
          index: entryIndex,
          hoursLeft: Math.max(0, Math.ceil((entry.returnAt - now) / 3600)),
          sealStyle: sealLook(`${m.id}:${entry.returnAt}`)
        },
        canSend: isGM && party.length >= 1 && !entry, // partial parties are allowed
        canDeploy: party.length >= 1 && !entry
      };
    }).filter(Boolean);

    const boundId = game.settings.get(MOD, "dispatchScene");
    const scene = {
      name: game.scenes.get(boundId)?.name ?? null,
      boundHere: !!boundId && canvas.scene?.id === boundId
    };
    const recruits = HEROES.filter((h) => !h.recruited && h.recruitable).map((h) => ({ id: h.id, name: h.name, recruitable: h.recruitable }));
    return { heroes, missions, recruits, recruitedCount: recruitedCount(), maxRecruits: maxRecruits(), scene, treasury: state.treasury, isGM, locked: !!layoutFor(canvas.scene?.id), asset: ASSET, background: !!game.settings.get(MOD, "showBackground") };
  }

  /** Wire up drag & drop (native HTML5, no jQuery). */
  _onRender() {
    const el = this.element;
    this.applyLayout();
    el.querySelectorAll("[data-hero][draggable='true']").forEach((n) => {
      n.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/plain", JSON.stringify({ dispatchHero: n.dataset.hero }));
        ev.dataTransfer.effectAllowed = "move";
        el.classList.add("dragging");
      });
      n.addEventListener("dragend", () => el.classList.remove("dragging"));
    });
    el.querySelectorAll(".hero-card").forEach((card) =>
      card.addEventListener("click", (ev) => ev.target.closest("[data-action]") ? null : (Number(card.dataset.pending) > 0 ? openLevelUp(card.dataset.hero) : showStatsPopup(card.dataset.hero, ev)))
    );
    el.querySelectorAll("[data-drop]").forEach((zone) => {
      zone.addEventListener("dragover", (ev) => { ev.preventDefault(); zone.classList.add("dragover"); });
      zone.addEventListener("dragleave", (ev) => { if (!zone.contains(ev.relatedTarget)) zone.classList.remove("dragover"); });
      zone.addEventListener("drop", (ev) => {
        ev.preventDefault();
        zone.classList.remove("dragover");
        el.classList.remove("dragging");
        let data;
        try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
        if (!data?.dispatchHero) return;
        assignHero(data.dispatchHero, zone.dataset.drop === "mission" ? zone.dataset.mission : null);
      });
    });
  }

  /** Keep the board behind other windows (the stylesheet pins its z-index low). */
  bringToFront() {}

  /**
   * Locked windows are anchored to the scene: the board keeps its place on the map and
   * scales and moves as the canvas is panned or zoomed. Unlocked windows float freely.
   */
  applyLayout() {
    if (!this.rendered) return;
    const el = this.element;
    const L = layoutFor(canvas.scene?.id);
    if (!L) {
      if (el.classList.contains("locked")) {
        // Hand the window back to the GM at its current on-screen size and place.
        el.classList.remove("locked");
        const r = el.getBoundingClientRect();
        const header = el.querySelector(".window-header")?.offsetHeight ?? 0;
        this.setPosition({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height + header) });
      }
      return;
    }
    el.classList.add("locked");
    if (!canvas.ready) return;
    const t = canvas.stage.worldTransform;
    const k = t.a;
    const w = L.sw * k;
    el.style.left = `${L.sx * k + t.tx}px`;
    el.style.top = `${L.sy * k + t.ty}px`;
    el.style.width = `${w}px`;
    el.style.height = `${w * BOARD_ASPECT}px`;
  }

  static async onLockLayout() {
    if (!game.user.isGM || !canvas.scene || !canvas.ready) return;
    const layouts = JSON.parse(JSON.stringify(game.settings.get(MOD, "layouts") ?? {}));
    const id = canvas.scene.id;
    if (layouts[id]?.locked) {
      layouts[id].locked = false;
      ui.notifications.info("Dispatch board unlocked from the scene.");
    } else {
      // Convert the board's on-screen rectangle into scene coordinates.
      const b = this.element.querySelector(".board").getBoundingClientRect();
      const t = canvas.stage.worldTransform;
      layouts[id] = { sx: (b.left - t.tx) / t.a, sy: (b.top - t.ty) / t.a, sw: b.width / t.a, locked: true };
      ui.notifications.info("Dispatch board anchored to this scene.");
    }
    await game.settings.set(MOD, "layouts", layouts);
  }

  /** GM: take down every posted notice (except ones with a party out) and pin a fresh random set. */
  static async onRefreshNotices() {
    if (!game.user.isGM) return;
    const state = getState();
    const out = new Set(state.active.map((e) => e.missionId));
    state.board = Array.from({ length: SLOT_COUNT }, () => null);
    [...out].slice(0, SLOT_COUNT).forEach((id, i) => (state.board[i] = id));
    state.looks = [];
    ensureBoard(state);
    // Fresh set: avoid immediately re-posting the notices that were just taken down when other missions exist.
    await saveState(state);
    pruneSelection(state);
    ui.notifications.info("Posted missions refreshed.");
  }

  /** GM: ask how many (1-5) and put that many random, not-yet-offered heroes on the Recruits roster. */
  static async onAddRecruits() {
    if (!game.user.isGM) return;
    const pool = HEROES.filter((h) => !h.recruited && !h.recruitable);
    if (!pool.length) return ui.notifications.info("Every hero is already recruited or on the Recruits roster.");
    const raw = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Add recruits" },
      content: `<p>How many heroes should become available to recruit? (1-5, ${pool.length} left to offer)</p><input type="number" name="count" value="1" min="1" max="5" step="1" autofocus style="width:100%">`,
      ok: { label: "Add", callback: (event, button) => button.form.elements.count.value },
      rejectClose: false
    });
    if (raw === null || raw === undefined) return;
    const n = Math.min(pool.length, Math.max(1, Math.min(5, Math.round(Number(raw)) || 1)));
    const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, n);
    const flags = JSON.parse(JSON.stringify(game.settings.get(MOD, "heroFlags") ?? {}));
    for (const h of picked) flags[h.id] = { ...(flags[h.id] ?? {}), recruitable: true };
    await game.settings.set(MOD, "heroFlags", flags);
    ui.notifications.info(`Now recruitable: ${picked.map((h) => h.name).join(", ")}.`);
  }

  /** GM: pin every completed notice back on the board. */
  static async onRestoreNotices() {
    if (!game.user.isGM) return;
    const state = getState();
    if (!state.done.length) return ui.notifications.info("No completed notices to restore.");
    state.done = [];
    await saveState(state);
    await refreshBoard();
    ui.notifications.info("Completed missions are available again and can be pulled onto the board.");
  }

  static onUnassign(event, target) {
    assignHero(target.dataset.hero, null);
  }

  static async onSend(event, target) {
    if (!game.user.isGM) return;
    const missionId = target.dataset.mission;
    const state = getState();
    const ready = (SEL.assign[missionId] ?? []).filter((id) => heroState(state, id).status === "ready");
    const need = MISSIONS.find((m) => m.id === missionId)?.slots ?? 1;
    if (ready.length < 1 || ready.length > need) return ui.notifications.warn("Assign at least one ready hero to this notice.");
    await sendParty(missionId, ready);
    const assign = structuredClone(SEL.assign);
    delete assign[missionId];
    setSelection(assign);
  }

  /** Players: ask the GM to let the assigned party set out. */
  static async onDeploy(event, target) {
    const missionId = target.dataset.mission;
    const state = getState();
    const ready = (SEL.assign[missionId] ?? []).filter((id) => heroState(state, id).status === "ready");
    const need = MISSIONS.find((m) => m.id === missionId)?.slots ?? 1;
    if (ready.length < 1 || ready.length > need) return ui.notifications.warn("Assign at least one ready hero to this notice.");
    if (!game.users.activeGM) return ui.notifications.warn("A GM must be online to approve deployments.");
    if (game.user.isGM) return DispatchApp.onSend.call(this, event, target); // the GM deploying is the approval
    game.socket.emit(SOCKET, { type: "deploy", missionId, heroIds: ready, userId: game.user.id });
    ui.notifications.info("Deployment request sent. Waiting for the GM to approve it.");
  }

  static async onLevelUpEveryone() {
    if (!game.user.isGM) return;
    if (!(await confirmDialog("Level up all heroes", "<p>Raise every hero one level and give each their stat points?</p>"))) return;
    await levelUp(HEROES.filter((h) => h.recruited).map((h) => h.id));
  }

  static async onBindScene() {
    if (!game.user.isGM || !canvas.scene) return;
    const id = game.settings.get(MOD, "dispatchScene");
    await game.settings.set(MOD, "dispatchScene", id === canvas.scene.id ? "" : canvas.scene.id);
    ui.notifications.info(id === canvas.scene.id ? "Dispatch scene cleared." : `Dispatch will open on "${canvas.scene.name}".`);
    this.render();
  }

  static async onResolveNow(event, target) {
    if (!game.user.isGM) return;
    const state = getState();
    const entry = state.active[Number(target.dataset.index)];
    if (!entry) return;
    await resolveEntry(state, entry);
    ensureBoard(state);
    await saveState(state);
    pruneSelection(state);
  }
}

/* ---------- GM settings window ---------- */

let SETTINGS_APP = null;
function openSettings() {
  if (!game.user.isGM) return;
  SETTINGS_APP ??= new DispatchSettingsApp();
  SETTINGS_APP.render({ force: true });
}

const confirmDialog = (title, html) =>
  foundry.applications.api.DialogV2.confirm({
    window: { title },
    content: html,
    modal: true,
    rejectClose: false,
    yes: { default: false }
  });

let HEROES_OPEN = true; // remembers whether the hero table is expanded across re-renders
class DispatchSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dispatch-settings",
    tag: "form",
    classes: ["dispatch-settings-app"],
    window: { title: "Dispatch Settings", icon: "fa-solid fa-gear", resizable: true },
    position: { width: 940, height: "auto" },
    form: { handler: DispatchSettingsApp.onSubmit, closeOnSubmit: false },
    actions: {
      levelUp: DispatchSettingsApp.onLevelUp,
      levelUpAll: DispatchSettingsApp.onLevelUpAll,
      resetHeroes: DispatchSettingsApp.onResetHeroes,
      resetProgress: DispatchSettingsApp.onResetProgress,
      openLog: DispatchSettingsApp.onOpenLog,
      clearLog: DispatchSettingsApp.onClearLog,
      openFolder: DispatchSettingsApp.onOpenFolder,
      copyPath: DispatchSettingsApp.onCopyPath
    }
  };
  static PARTS = { form: { template: `modules/${MOD}/templates/settings.hbs` } };

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element.querySelector("details.hero-fold")?.addEventListener("toggle", (ev) => { HEROES_OPEN = ev.currentTarget.open; });
  }

  async _prepareContext() {
    const hidden = new Set(game.settings.get(MOD, "hiddenTiers") ?? []);
    const tiers = [...new Set(MISSIONS.map((m) => m.tier))]
      .sort((a, b) => a - b)
      .map((t) => ({ tier: t, shown: !hidden.has(t), count: MISSIONS.filter((m) => m.tier === t).length }));
    const heroes = HEROES.map((h) => ({
      id: h.id, name: h.name, class: h.class, level: h.level, xp: h.xp ?? 0, pending: pendingFor(h.id), recruited: h.recruited, recruitable: h.recruitable,
      stats: STATS.map((k) => ({ key: k, val: h.stats[k] }))
    }));
    const log = findLog();
    return {
      tiers,
      heroes,
      statHeads: STATS.map((k) => ABBR[k]),
      heroesOpen: HEROES_OPEN,
      requireApproval: game.settings.get(MOD, "requireApproval"),
      showBackground: game.settings.get(MOD, "showBackground"),
      playerButton: game.settings.get(MOD, "playerButton"),
      maxRecruits: game.settings.get(MOD, "maxRecruits"),
      trainingHours: game.settings.get(MOD, "trainingHours"),
      pointsPerLevel: game.settings.get(MOD, "pointsPerLevel"),
      minNotices: game.settings.get(MOD, "minNotices"),
      maxNotices: game.settings.get(MOD, "maxNotices"),
      injuryMultiplier: game.settings.get(MOD, "injuryMultiplier"),
      critFailMultiplier: game.settings.get(MOD, "critFailMultiplier"),
      celebrateHours: game.settings.get(MOD, "celebrateHours"),
      earnerName: game.settings.get(MOD, "earnerName"),
      lootActor: game.settings.get(MOD, "lootActor"),
      actorNames: game.actors.filter((a) => foundry.utils.getProperty(a, "system.currency.gp") !== undefined).map((a) => a.name).sort(),
      rewardPercent: game.settings.get(MOD, "rewardPercent"),
      logPages: log?.pages.size ?? 0,
      path: `Data/modules/${MOD}`,
      links: [
        { label: "heroes.json", href: `${DATA}heroes.json` },
        { label: "missions.json", href: `${DATA}missions.json` }
      ]
    };
  }

  /** Read the form as it currently stands (including unsaved edits). */
  collectForm() {
    const FDE = foundry.applications.ux?.FormDataExtended ?? globalThis.FormDataExtended;
    return foundry.utils.expandObject(new FDE(this.element).object);
  }

  /** Save tier visibility and hero level/stat overrides from form data. */
  async persist(data) {
    const hidden = [...new Set(MISSIONS.map((m) => m.tier))].filter((t) => !data.tier?.[t]);
    const num = (v, min, max, fallback) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const overrides = {};
    const oldOv = game.settings.get(MOD, "heroOverrides") ?? {};
    for (const h of BASE_HEROES) {
      const d = data.hero?.[h.id];
      if (!d) continue;
      overrides[h.id] = {
        ...(oldOv[h.id]?.proficiency2 ? { proficiency2: oldOv[h.id].proficiency2 } : {}),
        level: num(d.level, 1, 20, h.level),
        xp: num(d.xp, 0, 10000000, 0),
        stats: Object.fromEntries(STATS.map((k) => [k, num(d.stats?.[k], 0, STAT_CAP, h.stats[k])]))
      };
    }
    const pending = {};
    for (const h of BASE_HEROES) {
      const n = num(data.pending?.[h.id], 0, 50, 0);
      if (n) pending[h.id] = n;
    }
    const flags = {};
    for (const h of BASE_HEROES) {
      const f = data.flags?.[h.id];
      if (f) flags[h.id] = { recruited: !!f.recruited, recruitable: !!f.recruitable };
    }
    const mx = num(data.maxNotices, 1, 10, 6);
    await game.settings.set(MOD, "maxNotices", mx);
    await game.settings.set(MOD, "minNotices", Math.min(mx, num(data.minNotices, 0, 10, 3)));
    await game.settings.set(MOD, "hiddenTiers", hidden);
    await game.settings.set(MOD, "heroOverrides", overrides);
    await game.settings.set(MOD, "pendingPoints", pending);
    await game.settings.set(MOD, "heroFlags", flags);
    await game.settings.set(MOD, "requireApproval", !!data.requireApproval);
    await game.settings.set(MOD, "showBackground", !!data.showBackground);
    await game.settings.set(MOD, "playerButton", !!data.playerButton);
    await game.settings.set(MOD, "maxRecruits", num(data.maxRecruits, 1, 12, 8));
    await game.settings.set(MOD, "trainingHours", num(data.trainingHours, 0, 168, 8));
    await game.settings.set(MOD, "pointsPerLevel", num(data.pointsPerLevel, 0, 10, 2));
    const fl = (v, min, max, fb) => (Number.isFinite(Number(v)) && v !== "" ? Math.min(max, Math.max(min, Number(v))) : fb);
    await game.settings.set(MOD, "injuryMultiplier", fl(data.injuryMultiplier, 0, 10, 1));
    await game.settings.set(MOD, "critFailMultiplier", fl(data.critFailMultiplier, 0, 10, 2));
    await game.settings.set(MOD, "celebrateHours", num(data.celebrateHours, 0, 168, 4));
    await game.settings.set(MOD, "lootActor", String(data.lootActor ?? "").trim() || "Group Loot");
    await game.settings.set(MOD, "earnerName", String(data.earnerName ?? "").trim() || "Trollskull Manor");
    await game.settings.set(MOD, "rewardPercent", fl(data.rewardPercent, 0, 1000, 100));
  }

  static async onSubmit(event, form, formData) {
    await this.persist(foundry.utils.expandObject(formData.object));
    ui.notifications.info("Dispatch settings saved.");
    this.render();
  }

  /** +1 level and a number of unspent stat points the players allocate from the hero card. */
  static #levelUpHero(data, id) {
    const d = data.hero?.[id];
    if (!d) return;
    d.level = (Number(d.level) || 1) + 1;
    const per = Number(data.pointsPerLevel);
    data.pending ??= {};
    data.pending[id] = (Number(data.pending[id]) || 0) + (Number.isFinite(per) ? per : 2);
  }

  static async onLevelUp(event, target) {
    const data = this.collectForm();
    DispatchSettingsApp.#levelUpHero(data, target.dataset.hero);
    await this.persist(data);
    this.render();
  }

  static async onLevelUpAll() {
    const data = this.collectForm();
    for (const id of Object.keys(data.hero ?? {})) if (data.flags?.[id]?.recruited) DispatchSettingsApp.#levelUpHero(data, id); // recruited heroes only
    await this.persist(data);
    this.render();
  }

  static async onResetHeroes() {
    if (!(await confirmDialog("Reset hero levels and stats", "<p>Return every hero to the level, stats and recruit status in heroes.json?</p>"))) return;
    await game.settings.set(MOD, "heroOverrides", {});
    await game.settings.set(MOD, "pendingPoints", {});
    await game.settings.set(MOD, "heroFlags", {});
    this.render();
  }

  static async onResetProgress() {
    const ok = await confirmDialog(
      "Reset all mission progress",
      "<p>This puts every completed notice back on the board, recalls all parties, clears every injury and empties the treasury. Hero levels and stats and the mission log are kept.</p><p>Continue?</p>"
    );
    if (!ok) return;
    await saveState(EMPTY());
    setSelection({});
    await refreshBoard();
    ui.notifications.info("Dispatch progress and hero statuses reset.");
  }

  static onOpenLog() {
    const log = findLog();
    if (!log) return ui.notifications.info("No missions have been completed yet, so there is no log.");
    log.sheet.render({ force: true });
  }

  static async onClearLog() {
    const log = findLog();
    if (!log?.pages.size) return ui.notifications.info("The mission log is already empty.");
    if (!(await confirmDialog("Clear the mission log", `<p>Delete all ${log.pages.size} pages from the Dispatch Mission Log?</p>`))) return;
    await log.deleteEmbeddedDocuments("JournalEntryPage", log.pages.map((p) => p.id));
    this.render();
  }

  static onOpenFolder() {
    const FP = foundry.applications.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    try {
      new FP({ type: "any", current: `modules/${MOD}` }).render({ force: true });
    } catch (err) {
      ui.notifications.warn(`Open Data/modules/${MOD} on the machine running Foundry.`);
    }
  }

  static async onCopyPath() {
    try {
      await navigator.clipboard.writeText(`Data/modules/${MOD}`);
      ui.notifications.info("Module folder path copied.");
    } catch (err) {
      ui.notifications.info(`Data/modules/${MOD}`);
    }
  }
}

/** Players can only receive the window through the Dispatch scene trigger. GMs can open it any time. */
function openDispatch({ fromScene = false } = {}) {
  if (!game.user.isGM && !fromScene && !game.settings.get(MOD, "playerButton")) return;
  APP ??= new DispatchApp();
  APP.autoOpened = fromScene;
  APP.render({ force: true });
  if (!game.user.isGM) game.socket.emit(SOCKET, { type: "req" });
}

function toggleDispatch() {
  if (!game.user.isGM && !game.settings.get(MOD, "playerButton")) return;
  if (APP?.rendered) APP.close();
  else openDispatch();
}

/* ---------- Hooks ---------- */

Hooks.once("init", () => {
  game.settings.register(MOD, "state", {
    scope: "world",
    config: false,
    type: new foundry.data.fields.ObjectField({ initial: EMPTY() }),
    default: EMPTY(),
    onChange: () => APP?.rendered && APP.render()
  });
  game.settings.register(MOD, "hiddenTiers", {
    scope: "world",
    config: false,
    type: new foundry.data.fields.ArrayField(new foundry.data.fields.NumberField({ integer: true })),
    default: [1, 2, 3, 4, 5], // a new world starts with only tier 0 quests visible
    onChange: () => { refreshBoard(); APP?.rendered && APP.render(); SETTINGS_APP?.rendered && SETTINGS_APP.render(); }
  });
  game.settings.register(MOD, "heroOverrides", {
    scope: "world",
    config: false,
    type: new foundry.data.fields.ObjectField({ initial: {} }),
    default: {},
    onChange: () => { applyOverrides(); APP?.rendered && APP.render(); SETTINGS_APP?.rendered && SETTINGS_APP.render(); LEVELUP_OPEN?.refresh(); RECRUIT_OPEN?.refresh(); }
  });
  game.settings.register(MOD, "heroFlags", {
    scope: "world",
    config: false,
    type: new foundry.data.fields.ObjectField({ initial: {} }),
    default: {},
    onChange: () => { applyOverrides(); APP?.rendered && APP.render(); SETTINGS_APP?.rendered && SETTINGS_APP.render(); RECRUIT_OPEN?.refresh(); }
  });
  game.settings.register(MOD, "requireApproval", {
    name: "GM must confirm player requests",
    hint: "When on, recruiting, deploying and training ask the GM to approve first. When off, they happen immediately (a GM must still be online).",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.BooleanField({ initial: true }),
    default: true
  });
  game.settings.register(MOD, "maxRecruits", {
    name: "Maximum recruited heroes",
    hint: "The most heroes the players can have on their roster, including the starting heroes.",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.NumberField({ integer: true, min: 1, max: 12, initial: 8 }),
    default: 8,
    onChange: () => { APP?.rendered && APP.render(); SETTINGS_APP?.rendered && SETTINGS_APP.render(); RECRUIT_OPEN?.refresh(); }
  });
  game.settings.register(MOD, "pendingPoints", {
    scope: "world",
    config: false,
    type: new foundry.data.fields.ObjectField({ initial: {} }),
    default: {},
    onChange: () => {
      for (const id of Object.keys(LEVEL_DRAFT)) if (!pendingFor(id)) delete LEVEL_DRAFT[id];
      APP?.rendered && APP.render();
      SETTINGS_APP?.rendered && SETTINGS_APP.render();
      LEVELUP_OPEN?.refresh();
    }
  });
  game.settings.register(MOD, "trainingHours", {
    name: "Training duration (in-game hours)",
    hint: "How long a hero is unavailable after the players press Train.",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.NumberField({ integer: true, min: 0, max: 168, initial: 8 }),
    default: 8
  });
  game.settings.register(MOD, "showBackground", {
    name: "Show the notice board background",
    hint: "Draws the wooden notice board image behind the notices and hero cards.",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.BooleanField({ initial: false }),
    default: false,
    onChange: () => APP?.rendered && APP.render()
  });
  game.settings.register(MOD, "playerButton", {
    name: "Show the Dispatch button to players",
    hint: "Adds the Dispatch button under Token controls for players so they can open the board themselves.",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.BooleanField({ initial: false }),
    default: false,
    onChange: () => { ui.controls?.render?.({ reset: true }); if (!game.settings.get(MOD, "playerButton") && !game.user.isGM && APP?.rendered && !APP.autoOpened) APP.close(); }
  });
  game.settings.register(MOD, "minNotices", {
    name: "Minimum notices on the board",
    hint: "When fewer than this are posted, random missions from missions.json are pinned up. 0 = never top up.",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.NumberField({ integer: true, min: 0, max: 10, initial: 3 }),
    default: 3,
    onChange: () => { refreshBoard(); APP?.rendered && APP.render(); SETTINGS_APP?.rendered && SETTINGS_APP.render(); }
  });
  game.settings.register(MOD, "maxNotices", {
    name: "Maximum notices on the board",
    hint: "The board never shows more than this many notices (10 at most).",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.NumberField({ integer: true, min: 1, max: 10, initial: 6 }),
    default: 6,
    onChange: () => { refreshBoard(); APP?.rendered && APP.render(); SETTINGS_APP?.rendered && SETTINGS_APP.render(); }
  });
  game.settings.register(MOD, "injuryMultiplier", {
    name: "Injury time multiplier (failed mission)",
    hint: "Multiplies the mission's injury time when a mission fails. 1 = as written in missions.json, 0 = nobody is injured.",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.NumberField({ min: 0, max: 10, step: 0.25, initial: 1 }),
    default: 1
  });
  game.settings.register(MOD, "critFailMultiplier", {
    name: "Injury time multiplier (critical failure)",
    hint: "Multiplies the mission's injury time on a critical failure (a very bad roll on a failed mission).",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.NumberField({ min: 0, max: 10, step: 0.25, initial: 2 }),
    default: 2
  });
  game.settings.register(MOD, "rewardPercent", {
    name: "Gold reward percentage",
    hint: "Percent of a mission's posted gold the players receive after a successful mission (100 = full reward). Applies before the critical-success doubling. Heroes always receive the full XP.",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.NumberField({ min: 0, max: 1000, step: 5, initial: 100 }),
    default: 100
  });
  game.settings.register(MOD, "lootActor", {
    name: "Gold goes to (actor name)",
    hint: 'The exact name of the actor (a group or a character) that receives the gold from successful missions. It needs a gold (gp) field.',
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.StringField({ initial: "Group Loot", blank: false }),
    default: "Group Loot"
  });
  game.settings.register(MOD, "earnerName", {
    name: "Gold earner name",
    hint: 'Who earns the gold from successful missions, as shown in the success message (for example "Trollskull Manor"). The gold is added to the actor chosen in "Gold goes to".',
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.StringField({ initial: "Trollskull Manor", blank: false }),
    default: "Trollskull Manor"
  });
  game.settings.register(MOD, "celebrateHours", {
    name: "Celebrating time (in-game hours)",
    hint: "How long heroes are unavailable, celebrating, after a successful mission. 0 = no celebration.",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.NumberField({ integer: true, min: 0, max: 168, initial: 4 }),
    default: 4
  });
  game.settings.register(MOD, "pointsPerLevel", {
    name: "Stat points per level-up",
    hint: "Points the players can spend after you level a hero up.",
    scope: "world",
    config: true,
    restricted: true,
    type: new foundry.data.fields.NumberField({ integer: true, min: 0, max: 10, initial: 2 }),
    default: 2
  });
  game.settings.registerMenu(MOD, "config", {
    name: "Dispatch Settings",
    label: "Open Dispatch Settings",
    hint: "Choose mission tiers, level up heroes, reset progress, open the mission log and find the module folder.",
    icon: "fa-solid fa-route",
    type: DispatchSettingsApp,
    restricted: true
  });
  game.settings.register(MOD, "layouts", {
    scope: "world",
    config: false,
    type: new foundry.data.fields.ObjectField({ initial: {} }),
    default: {},
    onChange: () => APP?.rendered && (APP.applyLayout(), APP.render())
  });
  game.settings.register(MOD, "dispatchScene", {
    scope: "world",
    config: false,
    type: String,
    default: "",
    onChange: () => canvas?.ready && checkScene()
  });
  game.keybindings.register(MOD, "toggleLock", {
    name: "Lock/Unlock Dispatch window to scene",
    editable: [{ key: "KeyL", modifiers: ["Shift", "Alt"] }],
    restricted: true,
    onDown: () => { if (APP?.rendered) DispatchApp.onLockLayout.call(APP); return true; }
  });
  game.modules.get(MOD).api = {
    unlock: async () => {
      if (!game.user.isGM || !canvas.scene) return;
      const layouts = JSON.parse(JSON.stringify(game.settings.get(MOD, "layouts") ?? {}));
      if (layouts[canvas.scene.id]) layouts[canvas.scene.id].locked = false;
      await game.settings.set(MOD, "layouts", layouts);
    },
    open: () => openDispatch(),
    settings: () => openSettings(),
    openLog: () => DispatchSettingsApp.onOpenLog(),
    reset: () => saveState(EMPTY()),
    setScene: (sceneId) => game.user.isGM && game.settings.set(MOD, "dispatchScene", sceneId ?? "")
  };
});

Hooks.once("ready", async () => {
  registerSocket();
  await loadData();
  tick();
});

Hooks.on("updateWorldTime", () => tick());

/** Open the window when viewing the Dispatch scene; close an auto-opened one when leaving it. */
function checkScene() {
  const boundId = game.settings.get(MOD, "dispatchScene");
  if (boundId && canvas.scene?.id === boundId) {
    if (!APP?.rendered) openDispatch({ fromScene: true });
  } else if (APP?.rendered && APP.autoOpened) {
    APP.close();
  }
}
Hooks.on("canvasReady", checkScene);
Hooks.on("canvasReady", () => APP?.rendered && APP.applyLayout());
window.addEventListener("resize", () => APP?.rendered && APP.applyLayout());
Hooks.on("canvasPan", () => APP?.rendered && APP.applyLayout());

// V13+ scene controls: `controls` is a Record keyed by control name.
Hooks.on("getSceneControlButtons", (controls) => {
  controls.tokens.tools.dispatch = {
    name: "dispatch",
    title: "Dispatch Minigame",
    icon: "fa-solid fa-route",
    order: Object.keys(controls.tokens.tools).length,
    button: true,
    visible: game.user.isGM || !!game.settings.get(MOD, "playerButton"),
    onChange: () => toggleDispatch()
  };
});
