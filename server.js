/* 방파제 (Breakwater) — 교실용 세미 협력 보드게임 서버
 * 의존성 없는 Node.js 서버 (Node 16+)
 * 실행: node server.js  (기본 포트 3000, PORT 환경변수로 변경 가능)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // 12시간 지난 방은 정리

// ---------------------------------------------------------------- 상태

/** @type {Record<string, Room>} */
let rooms = {};

function now() { return Date.now(); }
function token() { return crypto.randomBytes(12).toString('hex'); }
function pid() { return 'p' + crypto.randomBytes(6).toString('hex'); }

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // 헷갈리는 I, L, O 제외
function newRoomCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms[c]) return c;
  }
  throw new Error('room code space exhausted');
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function randBetween(lo, hi) { return lo + Math.random() * (hi - lo); }

// ---------------------------------------------------------------- 영속화 (서버 재시작 대비)

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(rooms));
    } catch (e) { console.error('저장 실패:', e.message); }
  }, 800);
}

function loadRooms() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      rooms = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
      purgeOldRooms();
      console.log(`저장된 방 ${Object.keys(rooms).length}개를 불러왔습니다.`);
    }
  } catch (e) { console.error('불러오기 실패(새로 시작합니다):', e.message); rooms = {}; }
}

function purgeOldRooms() {
  const t = now();
  for (const code of Object.keys(rooms)) {
    if (t - (rooms[code].lastActivity || rooms[code].createdAt || 0) > ROOM_TTL_MS) delete rooms[code];
  }
}
setInterval(() => { purgeOldRooms(); scheduleSave(); }, 60 * 60 * 1000);

// ---------------------------------------------------------------- 게임 규칙

/* 라운드별 폭풍 강도 비율: 초반은 약하게, 후반은 가혹하게.
 * ratio = 모둠 전체 자원(인원 × 큐브) 대비 폭풍 강도 비율 */
function stormRatioForRound(r, totalRounds) {
  const t = totalRounds <= 1 ? 1 : r / (totalRounds - 1); // 0..1
  const base = 0.52 + 0.34 * t;                            // 0.52 → 0.86
  return clamp(base + randBetween(-0.035, 0.035), 0.45, 0.92);
}

/* 게임 시작 시 모든 라운드 × 모든 모둠의 폭풍 카드를 미리 생성한다.
 * 같은 비율 카드를 모든 모둠에 적용하되, 모둠 인원에 비례해 절대값으로 환산
 * → 인원이 달라도 공정한 "같은 폭풍". */
function generateStorms(room) {
  const R = room.settings.rounds;
  const ratios = [];
  for (let r = 0; r < R; r++) {
    ratios.push({ ratio: stormRatioForRound(r, R), pubFrac: randBetween(0.55, 0.7) });
  }
  room.stormPlan = ratios;
  room.storms = []; // [round][group] = {storm, pub, hidden, lo, hi}
  const sizes = groupSizes(room);
  for (let r = 0; r < R; r++) {
    const row = [];
    for (let g = 0; g < room.settings.groupCount; g++) {
      const capacity = sizes[g] * room.settings.cubes;
      if (capacity === 0) { row.push(null); continue; }
      const storm = Math.max(1, Math.round(ratios[r].ratio * capacity));
      const pub = clamp(Math.round(ratios[r].pubFrac * storm), 1, storm - 1 >= 1 ? storm - 1 : 1);
      const hidden = storm - pub;
      const spread = Math.max(3, Math.round(0.12 * capacity));
      const lo = Math.max(0, hidden - (1 + crypto.randomInt(spread)));
      const hi = hidden + (1 + crypto.randomInt(spread));
      row.push({ storm, pub, hidden, lo, hi });
    }
    room.storms.push(row);
  }
}

function groupSizes(room) {
  const sizes = new Array(room.settings.groupCount).fill(0);
  for (const p of Object.values(room.players)) {
    if (p.group >= 0 && p.group < sizes.length) sizes[p.group]++;
  }
  return sizes;
}

function playersInGroup(room, g) {
  return Object.values(room.players).filter(p => p.group === g);
}

function cooperationNeed(size) {
  return Math.max(1, Math.ceil(size * 0.8));
}

function harborStandard(room, card, size) {
  if (!card || size <= 0) return 0;
  const need = cooperationNeed(size);
  const forecastMid = ((card.pub + card.lo) + (card.pub + card.hi)) / 2;
  return clamp(Math.ceil(forecastMid / need), 1, room.settings.cubes);
}

function groupState(room, g) {
  const gr = room.groups[g] || {};
  if (!Number.isInteger(gr.damage)) gr.damage = 0;
  if (!Number.isInteger(gr.reinforcement)) gr.reinforcement = 0;
  gr.fallen = !!gr.fallen;
  return gr;
}

function isEmergencyGroup(room, g) {
  const gr = groupState(room, g);
  return room.state === 'playing' && !gr.fallen && gr.damage >= 2;
}

function negotiationSecondsForPhase(room) {
  if (!room.settings.negotiationSec) return 0;
  return aliveGroups(room).some(g => isEmergencyGroup(room, g)) ? 60 : room.settings.negotiationSec;
}

function finalDamageBonus(room, g) {
  const gr = room.groups[g];
  if (!gr || gr.fallen) return 0;
  if (gr.damage === 0) return 6;
  if (gr.damage === 1) return 3;
  return 0;
}

function createRoom(settings) {
  const code = newRoomCode();
  const s = {
    rounds: clamp(parseInt(settings.rounds, 10) || 6, 1, 12),
    cubes: clamp(parseInt(settings.cubes, 10) || 10, 5, 20),
    groupCount: clamp(parseInt(settings.groupCount, 10) || 4, 1, 8),
    negotiationSec: clamp(parseInt(settings.negotiationSec, 10) || 90, 0, 600),
  };
  const room = {
    code,
    createdAt: now(),
    lastActivity: now(),
    teacherToken: token(),
    settings: s,
    state: 'lobby',          // lobby | playing | finished
    phase: null,             // storm | negotiate | contribute | resolve
    round: 0,
    phaseEndsAt: null,
    players: {},
    groups: [],
    storms: [],
    results: [],
    finishedReason: null,
    gamesPlayed: 0,
  };
  rooms[code] = room;
  scheduleSave();
  return room;
}

function startGame(room) {
  // 인원이 0명인 모둠은 비활성 처리되고, 폭풍은 모둠 크기에 맞춰 생성된다.
  room.state = 'playing';
  room.round = 0;
  room.phase = 'storm';
  room.phaseEndsAt = null;
  room.results = [];
  room.finishedReason = null;
  room.groups = [];
  for (let g = 0; g < room.settings.groupCount; g++) {
    room.groups.push({ damage: 0, fallen: false, fallenRound: null, reinforcement: 0 });
  }
  for (const p of Object.values(room.players)) {
    p.points = 0; p.honor = 0; p.out = false;
    p.contributions = []; p.submitted = false; p.currentContribution = null;
  }
  generateStorms(room);
  touch(room);
}

function aliveGroups(room) {
  const sizes = groupSizes(room);
  const list = [];
  for (let g = 0; g < room.settings.groupCount; g++) {
    if (sizes[g] > 0 && !room.groups[g].fallen) list.push(g);
  }
  return list;
}

function advancePhase(room) {
  if (room.state !== 'playing') return;
  const order = ['storm', 'negotiate', 'contribute', 'resolve'];
  const idx = order.indexOf(room.phase);
  if (idx < 0) return;

  if (room.phase === 'contribute') {
    resolveRound(room);
    room.phase = 'resolve';
    room.phaseEndsAt = null;
  } else if (room.phase === 'resolve') {
    finalizeOpenShieldVotes(room, false);
    const lastRound = room.round >= room.settings.rounds - 1;
    const anyAlive = aliveGroups(room).length > 0;
    if (lastRound || !anyAlive) {
      room.state = 'finished';
      room.phase = null;
      room.finishedReason = anyAlive ? 'completed' : 'allFallen';
    } else {
      room.round++;
      room.phase = 'storm';
      for (const p of Object.values(room.players)) {
        p.submitted = false; p.currentContribution = null;
      }
    }
  } else {
    room.phase = order[idx + 1];
    const sec = room.phase === 'negotiate' ? negotiationSecondsForPhase(room) : 0;
    if (room.phase === 'negotiate' && sec > 0) {
      room.phaseEndsAt = now() + sec * 1000;
    } else {
      room.phaseEndsAt = null;
    }
  }
  touch(room);
}

function applyRoundDamage(room, g, result, damage) {
  const gr = groupState(room, g);
  result.damage = damage;
  if (damage > 0) {
    gr.damage += damage;
    if (gr.damage >= 3) {
      gr.damage = 3;
      gr.fallen = true;
      gr.fallenRound = room.round;
      result.fellNow = true;
      for (const p of playersInGroup(room, g)) p.out = true;
    }
  }
  result.damageAfter = gr.damage;
  result.reinforcementAfter = gr.reinforcement;
}

function resolveShieldVote(room, g, useShield) {
  const result = room.results[room.round] && room.results[room.round][g];
  if (!result || !result.shieldVote || !result.shieldVote.open) return false;
  const gr = groupState(room, g);
  const use = !!useShield && gr.reinforcement >= 2;

  result.shieldVote.open = false;
  result.shieldVote.resolved = true;
  result.shieldVote.used = use;

  if (use) {
    gr.reinforcement -= 2;
    result.damageBlocked = true;
    result.damage = 0;
    result.damageAfter = gr.damage;
    result.reinforcementAfter = gr.reinforcement;
  } else {
    applyRoundDamage(room, g, result, result.pendingDamage || result.baseDamage || 1);
  }
  return true;
}

function finalizeOpenShieldVotes(room, useShield) {
  if (!room.results[room.round]) return;
  for (let g = 0; g < room.settings.groupCount; g++) {
    resolveShieldVote(room, g, useShield);
  }
}

function castShieldVote(room, player, support) {
  if (room.state !== 'playing' || room.phase !== 'resolve') return { ok: false, status: 409, error: 'wrong-phase' };
  const result = room.results[room.round] && room.results[room.round][player.group];
  if (!result || !result.shieldVote || !result.shieldVote.open) return { ok: false, status: 409, error: 'no-vote' };

  const vote = result.shieldVote;
  vote.yes = vote.yes.filter(id => id !== player.id);
  vote.no = vote.no.filter(id => id !== player.id);
  (support ? vote.yes : vote.no).push(player.id);

  if (vote.yes.length >= vote.required) {
    resolveShieldVote(room, player.group, true);
  } else if (vote.no.length >= vote.required || vote.yes.length + vote.no.length >= vote.eligibleCount) {
    resolveShieldVote(room, player.group, false);
  }
  touch(room);
  return { ok: true };
}

function resolveRound(room) {
  const r = room.round;
  const roundResult = [];
  for (let g = 0; g < room.settings.groupCount; g++) {
    const card = room.storms[r][g];
    const members = playersInGroup(room, g);
    if (!card || members.length === 0) { roundResult.push(null); continue; }
    const gr = groupState(room, g);
    if (gr.fallen) { roundResult.push({ skipped: true }); continue; }

    let total = 0;
    let topAmount = 0;
    const standard = harborStandard(room, card, members.length);
    const need = cooperationNeed(members.length);
    const belowStandardNames = [];
    for (const p of members) {
      const c = p.submitted && Number.isInteger(p.currentContribution)
        ? clamp(p.currentContribution, 0, room.settings.cubes) : 0;
      p.contributions[r] = c;
      total += c;
      if (c > topAmount) topAmount = c;
      if (c < standard) belowStandardNames.push(p.name);
    }
    const ok = total >= card.storm;
    const standardMetCount = members.length - belowStandardNames.length;
    const cooperationSuccess = ok && standardMetCount >= need;
    const baseDamage = ok ? 0 : (total < 0.75 * card.storm ? 2 : 1);
    const emergency = isEmergencyGroup(room, g);
    const nearMiss = !ok && card.storm - total >= 1 && card.storm - total <= 2 && belowStandardNames.length > 0;

    const result = {
      total, storm: card.storm, pub: card.pub, hidden: card.hidden,
      lo: card.lo, hi: card.hi,
      ok, surplus: ok ? total - card.storm : 0,
      baseDamage, damage: 0, fellNow: false,
      standard, cooperationNeed: need, standardMetCount,
      belowStandardCount: belowStandardNames.length,
      cooperationSuccess,
      reinforcementBefore: gr.reinforcement,
      reinforcementAfter: gr.reinforcement,
      reinforcementGained: false,
      damageAfter: gr.damage,
      emergency,
      recovered: false,
      topNames: [],
      nearMissRecordName: nearMiss ? belowStandardNames[crypto.randomInt(belowStandardNames.length)] : null,
      shieldEligible: false,
      shieldVote: null,
      pendingDamage: 0,
      damageBlocked: false,
    };

    if (cooperationSuccess) {
      gr.reinforcement += 1;
      result.reinforcementGained = true;
      result.reinforcementAfter = gr.reinforcement;
      if (emergency && gr.damage > 0) {
        gr.damage -= 1;
        result.recovered = true;
        result.damageAfter = gr.damage;
      }
    }

    // 명예 토큰: 방어 성공 시, 항구 기준 이상 기여자 중 최다 기여자에게만 +2점.
    const topNames = [];
    if (ok) {
      topAmount = 0;
      for (const p of members) {
        if (p.contributions[r] >= standard && p.contributions[r] > topAmount) topAmount = p.contributions[r];
      }
      for (const p of members) {
        if (topAmount > 0 && p.contributions[r] === topAmount) {
          topNames.push(p.name);
          p.honor += 1;
          p.points += 2;
        }
      }
    }
    result.topNames = topNames;

    if (!ok) {
      if (gr.reinforcement >= 2) {
        result.shieldEligible = true;
        result.pendingDamage = baseDamage;
        result.shieldVote = {
          open: true,
          resolved: false,
          used: false,
          yes: [],
          no: [],
          required: Math.floor(members.length / 2) + 1,
          eligibleCount: members.length,
        };
      } else {
        applyRoundDamage(room, g, result, baseDamage);
      }
    }

    // 사적 축적: 내지 않은 큐브가 점수가 된다.
    for (const p of members) {
      p.points += room.settings.cubes - p.contributions[r];
      if (gr.fallen) p.out = true;
    }

    roundResult.push(result);
  }
  room.results[r] = roundResult;
}

function touch(room) { room.lastActivity = now(); scheduleSave(); }

// ---------------------------------------------------------------- 상태 스냅샷 (역할별)

function stormView(room, g, revealHidden) {
  if (room.state !== 'playing' || !room.storms[room.round]) return null;
  const card = room.storms[room.round][g];
  if (!card) return null;
  let lo = card.lo;
  let hi = card.hi;
  if (!revealHidden && isEmergencyGroup(room, g)) {
    lo = Math.max(0, lo - 1);
    hi += 1;
  }
  const v = {
    pub: card.pub, lo, hi,
    min: card.pub + lo, max: card.pub + hi,
    standard: harborStandard(room, card, playersInGroup(room, g).length),
    cooperationNeed: cooperationNeed(playersInGroup(room, g).length),
    emergency: isEmergencyGroup(room, g),
  };
  if (revealHidden) { v.hidden = card.hidden; v.storm = card.storm; }
  return v;
}

function publicGroupInfo(room, g) {
  const members = playersInGroup(room, g);
  const gr = room.groups[g] || { damage: 0, fallen: false, fallenRound: null, reinforcement: 0 };
  return {
    index: g,
    size: members.length,
    members: members.map(p => ({
      name: p.name,
      online: now() - (p.lastSeen || 0) < 6000,
      submitted: !!p.submitted,
    })),
    damage: gr.damage, fallen: gr.fallen, fallenRound: gr.fallenRound,
    reinforcement: gr.reinforcement || 0,
    emergency: isEmergencyGroup(room, g),
    submittedCount: members.filter(p => p.submitted).length,
  };
}

function finalRanking(room, g) {
  const members = playersInGroup(room, g);
  const fallen = room.groups[g] && room.groups[g].fallen;
  const bonus = finalDamageBonus(room, g);
  const sorted = members.slice().sort((a, b) => b.points - a.points);
  let rank = 0, prev = null, shown = 0;
  return sorted.map(p => {
    const finalPoints = p.points + bonus;
    shown++;
    if (finalPoints !== prev) { rank = shown; prev = finalPoints; }
    return {
      name: p.name, points: finalPoints, basePoints: p.points,
      finalBonus: bonus, honor: p.honor, rank, fallen: !!fallen,
    };
  });
}

function resultView(result) {
  if (!result) return result;
  const view = { ...result };
  if (result.shieldVote) {
    view.shieldVote = {
      open: result.shieldVote.open,
      resolved: result.shieldVote.resolved,
      used: result.shieldVote.used,
      yesCount: result.shieldVote.yes.length,
      noCount: result.shieldVote.no.length,
      required: result.shieldVote.required,
      eligibleCount: result.shieldVote.eligibleCount,
    };
  }
  return view;
}

function teacherState(room) {
  const base = {
    code: room.code, state: room.state, phase: room.phase, round: room.round,
    settings: room.settings, phaseEndsAt: room.phaseEndsAt, serverNow: now(),
    gamesPlayed: room.gamesPlayed,
    groups: [], finishedReason: room.finishedReason,
  };
  for (let g = 0; g < room.settings.groupCount; g++) {
    const info = publicGroupInfo(room, g);
    // 로비에서는 학생 이동을 위해 playerId 포함
    if (room.state === 'lobby') {
      info.members = playersInGroup(room, g).map(p => ({
        id: p.id, name: p.name, online: now() - (p.lastSeen || 0) < 6000,
      }));
    }
    if (room.state === 'playing') {
      const reveal = room.phase === 'resolve';
      info.stormCard = stormView(room, g, reveal);
      if (room.phase === 'resolve' && room.results[room.round]) {
        info.result = resultView(room.results[room.round][g]);
      }
    }
    if (room.state === 'finished') {
      info.ranking = finalRanking(room, g);
      info.finalBonus = finalDamageBonus(room, g);
      info.history = (room.results || []).map(row => (row && row[g]) ? {
        total: row[g].total, storm: row[g].storm, ok: row[g].ok, damage: row[g].damage,
        standard: row[g].standard, belowStandardCount: row[g].belowStandardCount,
        cooperationSuccess: row[g].cooperationSuccess, skipped: row[g].skipped,
      } : null);
    }
    base.groups.push(info);
  }
  return base;
}

function studentState(room, player) {
  const g = player.group;
  const finalBonus = room.state === 'finished' ? finalDamageBonus(room, g) : 0;
  const base = {
    code: room.code, state: room.state, phase: room.phase, round: room.round,
    settings: room.settings, phaseEndsAt: room.phaseEndsAt, serverNow: now(),
    me: {
      name: player.name, group: g, points: player.points, honor: player.honor,
      finalBonus, finalPoints: player.points + finalBonus,
      out: player.out, submitted: player.submitted,
      currentContribution: player.currentContribution,
    },
    group: publicGroupInfo(room, g),
    finishedReason: room.finishedReason,
    gamesPlayed: room.gamesPlayed,
  };
    if (room.state === 'playing') {
    base.stormCard = stormView(room, g, room.phase === 'resolve');
    if (room.phase === 'resolve' && room.results[room.round]) {
      const res = room.results[room.round][g];
      base.result = resultView(res);
      if (res && !res.skipped) {
        base.myContribution = player.contributions[room.round] ?? 0;
        base.myKept = room.settings.cubes - (player.contributions[room.round] ?? 0);
        base.myHonor = res.topNames.includes(player.name);
        base.myMeetsStandard = base.myContribution >= res.standard;
        if (res.shieldVote && res.shieldVote.open) {
          base.myShieldVote = res.shieldVote.yes.includes(player.id)
            ? 'yes' : res.shieldVote.no.includes(player.id) ? 'no' : null;
        }
      }
    }
  }
  if (room.state === 'finished') {
    base.ranking = finalRanking(room, g);
  }
  return base;
}

// ---------------------------------------------------------------- HTTP 유틸

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 64 * 1024) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = path.normalize(p).replace(/^([.][.][/\\])+/, '');
  const full = path.join(PUBLIC_DIR, p);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('찾을 수 없는 페이지입니다.'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

function lanUrls() {
  const urls = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${PORT}`);
    }
  }
  return urls;
}

// ---------------------------------------------------------------- API 라우팅

function getRoom(code) {
  if (!code) return null;
  return rooms[String(code).toUpperCase().trim()] || null;
}

function requireTeacher(room, body) {
  return room && body && body.token === room.teacherToken;
}

function findPlayer(room, playerId, tok) {
  const p = room.players[playerId];
  if (!p || p.token !== tok) return null;
  return p;
}

async function handleApi(req, res, urlObj) {
  const parts = urlObj.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  try {
    // GET /api/info
    if (method === 'GET' && parts[1] === 'info') {
      return sendJSON(res, 200, { urls: lanUrls(), port: PORT });
    }

    // POST /api/rooms — 방 만들기
    if (method === 'POST' && parts[1] === 'rooms' && parts.length === 2) {
      const body = await readBody(req);
      if (!body) return sendJSON(res, 400, { error: 'bad-json' });
      const room = createRoom(body.settings || {});
      return sendJSON(res, 200, { code: room.code, teacherToken: room.teacherToken });
    }

    const room = getRoom(parts[2]);
    const sub = parts[3];

    // GET /api/rooms/:code/peek — 참여 전 방 정보 확인
    if (method === 'GET' && sub === 'peek') {
      if (!room) return sendJSON(res, 404, { error: 'no-room' });
      return sendJSON(res, 200, {
        code: room.code, state: room.state,
        groupCount: room.settings.groupCount,
        names: Object.values(room.players).map(p => ({
          name: p.name, group: p.group,
          online: now() - (p.lastSeen || 0) < 6000,
        })),
      });
    }

    if (!room) return sendJSON(res, 404, { error: 'no-room', message: '방을 찾을 수 없습니다. 코드를 확인해 주세요.' });

    // GET /api/rooms/:code/state
    if (method === 'GET' && sub === 'state') {
      const q = urlObj.searchParams;
      if (q.get('role') === 'teacher') {
        if (q.get('token') !== room.teacherToken) return sendJSON(res, 401, { error: 'bad-token' });
        return sendJSON(res, 200, teacherState(room));
      }
      const p = findPlayer(room, q.get('playerId'), q.get('token'));
      if (!p) return sendJSON(res, 401, { error: 'bad-token', message: '연결 정보가 만료되었습니다. 다시 접속해 주세요.' });
      p.lastSeen = now();
      return sendJSON(res, 200, studentState(room, p));
    }

    const body = await readBody(req);
    if (body === null) return sendJSON(res, 400, { error: 'bad-json' });

    // POST /api/rooms/:code/join
    if (method === 'POST' && sub === 'join') {
      const name = String(body.name || '').trim().slice(0, 12);
      const group = clamp(parseInt(body.group, 10) || 0, 0, room.settings.groupCount - 1);
      if (!name) return sendJSON(res, 400, { error: 'no-name', message: '이름을 입력해 주세요.' });
      const existing = Object.values(room.players).find(p => p.name === name);
      if (existing) return sendJSON(res, 409, { error: 'name-taken', message: '이미 같은 이름이 있습니다. 본인이라면 "이어서 하기"를 누르세요.' });
      if (room.state !== 'lobby') return sendJSON(res, 409, { error: 'started', message: '게임이 이미 시작되었습니다. 기존 참가자라면 "이어서 하기"로 들어오세요.' });
      if (Object.keys(room.players).length >= 60) return sendJSON(res, 409, { error: 'full' });
      const p = {
        id: pid(), token: token(), name, group,
        points: 0, honor: 0, out: false,
        contributions: [], submitted: false, currentContribution: null,
        lastSeen: now(),
      };
      room.players[p.id] = p;
      touch(room);
      return sendJSON(res, 200, { playerId: p.id, token: p.token, group: p.group });
    }

    // POST /api/rooms/:code/claim — 이름으로 다시 들어오기 (기기 변경·토큰 분실)
    if (method === 'POST' && sub === 'claim') {
      const name = String(body.name || '').trim();
      const p = Object.values(room.players).find(x => x.name === name);
      if (!p) return sendJSON(res, 404, { error: 'no-player', message: '그 이름의 참가자가 없습니다.' });
      p.token = token(); // 이전 기기 연결은 끊김
      p.lastSeen = now();
      touch(room);
      return sendJSON(res, 200, { playerId: p.id, token: p.token, group: p.group, name: p.name });
    }

    // POST /api/rooms/:code/rejoin — 저장된 토큰으로 자동 복귀
    if (method === 'POST' && sub === 'rejoin') {
      const p = findPlayer(room, body.playerId, body.token);
      if (!p) return sendJSON(res, 401, { error: 'bad-token' });
      p.lastSeen = now();
      return sendJSON(res, 200, { ok: true, name: p.name, group: p.group });
    }

    // POST /api/rooms/:code/contribute
    if (method === 'POST' && sub === 'contribute') {
      const p = findPlayer(room, body.playerId, body.token);
      if (!p) return sendJSON(res, 401, { error: 'bad-token' });
      if (room.state !== 'playing' || room.phase !== 'contribute') {
        return sendJSON(res, 409, { error: 'wrong-phase', message: '지금은 기여 단계가 아닙니다.' });
      }
      if (p.out || (room.groups[p.group] && room.groups[p.group].fallen)) {
        return sendJSON(res, 409, { error: 'fallen', message: '도시가 이미 무너진 모둠입니다.' });
      }
      const amount = clamp(parseInt(body.amount, 10), 0, room.settings.cubes);
      if (!Number.isInteger(amount)) return sendJSON(res, 400, { error: 'bad-amount' });
      p.currentContribution = amount;
      p.submitted = true;
      p.lastSeen = now();
      touch(room);
      return sendJSON(res, 200, { ok: true, amount });
    }

    // POST /api/rooms/:code/shieldVote
    if (method === 'POST' && sub === 'shieldVote') {
      const p = findPlayer(room, body.playerId, body.token);
      if (!p) return sendJSON(res, 401, { error: 'bad-token' });
      const result = castShieldVote(room, p, !!body.support);
      if (!result.ok) return sendJSON(res, result.status || 409, { error: result.error || 'vote-failed' });
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/rooms/:code/teacher/<action>
    if (method === 'POST' && sub === 'teacher') {
      if (!requireTeacher(room, body)) return sendJSON(res, 401, { error: 'bad-token' });
      const action = parts[4];
      if (action === 'start') {
        if (room.state !== 'lobby') return sendJSON(res, 409, { error: 'not-lobby' });
        if (Object.keys(room.players).length === 0) return sendJSON(res, 409, { error: 'empty', message: '참가한 학생이 없습니다.' });
        startGame(room);
        return sendJSON(res, 200, { ok: true });
      }
      if (action === 'next') {
        if (room.state !== 'playing') return sendJSON(res, 409, { error: 'not-playing' });
        advancePhase(room);
        return sendJSON(res, 200, { ok: true, phase: room.phase, state: room.state });
      }
      if (action === 'setGroup') {
        const p = room.players[body.playerId];
        if (!p) return sendJSON(res, 404, { error: 'no-player' });
        if (room.state !== 'lobby') return sendJSON(res, 409, { error: 'not-lobby', message: '모둠 이동은 시작 전에만 가능합니다.' });
        p.group = clamp(parseInt(body.group, 10) || 0, 0, room.settings.groupCount - 1);
        touch(room);
        return sendJSON(res, 200, { ok: true });
      }
      if (action === 'kick') {
        const p = room.players[body.playerId];
        if (!p) return sendJSON(res, 404, { error: 'no-player' });
        if (room.state !== 'lobby') return sendJSON(res, 409, { error: 'not-lobby', message: '내보내기는 시작 전에만 가능합니다.' });
        delete room.players[body.playerId];
        touch(room);
        return sendJSON(res, 200, { ok: true });
      }
      if (action === 'rematch') {
        if (room.state !== 'finished') return sendJSON(res, 409, { error: 'not-finished' });
        room.state = 'lobby';
        room.phase = null;
        room.round = 0;
        room.results = [];
        room.storms = [];
        room.groups = [];
        room.finishedReason = null;
        room.gamesPlayed++;
        for (const p of Object.values(room.players)) {
          p.points = 0; p.honor = 0; p.out = false;
          p.contributions = []; p.submitted = false; p.currentContribution = null;
        }
        touch(room);
        return sendJSON(res, 200, { ok: true });
      }
      if (action === 'endGame') {
        if (room.state === 'playing' && room.phase === 'resolve') finalizeOpenShieldVotes(room, false);
        room.state = 'finished';
        room.phase = null;
        room.finishedReason = room.finishedReason || 'teacher';
        touch(room);
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 404, { error: 'no-action' });
    }

    return sendJSON(res, 404, { error: 'no-route' });
  } catch (e) {
    console.error(e);
    return sendJSON(res, 500, { error: 'server', message: '서버 오류가 발생했습니다.' });
  }
}

// ---------------------------------------------------------------- 서버 시작

loadRooms();

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (urlObj.pathname === '/health') return sendJSON(res, 200, { ok: true });
  if (urlObj.pathname.startsWith('/api/')) return void handleApi(req, res, urlObj);
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, urlObj.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ⚓ 방파제 서버가 시작되었습니다!');
  console.log('');
  console.log(`  교사용(이 컴퓨터):  http://localhost:${PORT}/teacher.html`);
  for (const u of lanUrls()) {
    console.log(`  학생 접속 주소:     ${u}  ← 같은 와이파이에서 접속`);
  }
  console.log('');
});
