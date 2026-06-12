const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const rooms = new Map();

const MAX_ROUNDS = 6;
const BASE_RESOURCES = 10;
const COLLAPSE_AT = 3;
const DEFAULT_TIMER = 120;
const REINFORCEMENT_COST = 2;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

const PHASE_LABELS = {
  lobby: "입장 대기",
  storm_forecast: "폭풍 예보",
  negotiation: "협상",
  secret_contribution: "비밀 기여",
  reinforcement_vote: "강화 사용 투표",
  round_result: "라운드 결과",
  final_result: "최종 결과",
};

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom(req) {
  const code = createRoomCode();
  const origin = getOrigin(req);
  const room = {
    code,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: createGameState(),
    students: [],
  };
  rooms.set(code, room);
  return {
    code,
    teacherUrl: `/teacher.html?room=${code}`,
    studentUrl: `/student.html?room=${code}`,
    joinUrl: `${origin}/?room=${code}`,
  };
}

function createGameState() {
  return {
    phase: "lobby",
    maxRounds: MAX_ROUNDS,
    roundNumber: 0,
    timerSeconds: DEFAULT_TIMER,
    timerTotal: DEFAULT_TIMER,
    group: {
      id: "harbor",
      name: "항구 도시",
      cityDamage: 0,
      reinforcement: 0,
      isCollapsed: false,
      finalBonus: 0,
      roundHistory: [],
    },
    round: null,
    lastResult: null,
    finalResult: null,
    reinforcementVote: null,
  };
}

function addStudent(code, body) {
  const room = rooms.get(code);
  if (!room) return null;

  const id = crypto.randomUUID();
  const name = String(body.name || "").trim().slice(0, 16) || "학생";
  const player = {
    id,
    name,
    groupId: room.state.group.id,
    joinedAt: Date.now(),
    resources: room.state.round ? BASE_RESOURCES : 0,
    storedResources: 0,
    currentContribution: null,
    totalContribution: 0,
    honorPoints: 0,
    lastSubmittedRound: null,
  };
  room.students.push(player);
  touch(room);
  return {
    code,
    studentId: id,
    studentUrl: `/student.html?room=${code}&student=${id}&name=${encodeURIComponent(name)}`,
  };
}

function updateRoom(code, body) {
  const room = rooms.get(code);
  if (!room) return null;

  const action = String(body.action || "");
  if (action === "startRound") {
    const result = startRound(room);
    if (result.error) return { status: 400, value: result };
  } else if (action === "setPhase") {
    const result = setPhase(room, body.phase);
    if (result.error) return { status: 400, value: result };
  } else if (action === "resolveVote") {
    const result = resolveReinforcementVote(room, { force: true });
    if (result.error) return { status: 400, value: result };
  } else if (action === "__setReinforcement" && process.env.BREAKWATER_TEST === "1") {
    // Test-only seam: reinforcement otherwise accrues only through cooperation,
    // which depends on the hidden storm and cannot be forced through the API.
    room.state.group.reinforcement = clamp(Number(body.reinforcement), 0, 99);
  } else if (action === "setTimer") {
    room.state.timerSeconds = clamp(Number(body.timerSeconds), 0, 60 * 20);
    room.state.timerTotal = clamp(Number(body.timerTotal || body.timerSeconds), 0, 60 * 20);
  } else if (body.state && typeof body.state === "object") {
    // Backward-compatible narrow merge for older teacher screens.
    room.state.timerSeconds = clamp(Number(body.state.timerSeconds ?? room.state.timerSeconds), 0, 60 * 20);
  }

  touch(room);
  return { status: 200, value: serializeRoom(room) };
}

function startRound(room) {
  const state = room.state;
  if (state.group.isCollapsed || state.phase === "final_result") {
    return { error: "game-finished" };
  }
  if (state.roundNumber >= state.maxRounds) {
    finalizeGame(room);
    return {};
  }

  state.roundNumber += 1;
  state.phase = "storm_forecast";
  state.lastResult = null;
  state.finalResult = null;
  state.reinforcementVote = null;
  state.round = generateRound(state.roundNumber, Math.max(room.students.length, 1), state.group.cityDamage);
  state.timerSeconds = DEFAULT_TIMER;
  state.timerTotal = DEFAULT_TIMER;
  room.students.forEach((student) => {
    student.resources = BASE_RESOURCES;
    student.currentContribution = null;
    student.lastSubmittedRound = null;
  });
  return {};
}

function setPhase(room, nextPhase) {
  const allowed = ["storm_forecast", "negotiation", "secret_contribution"];
  if (!room.state.round) return { error: "round-not-started" };
  if (!allowed.includes(nextPhase)) return { error: "invalid-phase" };
  if (room.state.phase === "round_result" || room.state.phase === "final_result") return { error: "round-already-judged" };
  room.state.phase = nextPhase;
  return {};
}

function generateRound(roundNumber, playerCount, cityDamage) {
  const isEmergencyRound = cityDamage >= 2;
  const pressure = clamp(5 + Math.floor((roundNumber - 1) / 2) + (isEmergencyRound ? 1 : 0), 5, 8);
  const harborStandard = clamp(pressure + randomInt(-1, 1), 4, 9);
  const target = clamp(playerCount * harborStandard + randomInt(-Math.ceil(playerCount / 2), Math.ceil(playerCount / 2)), playerCount * 3, playerCount * BASE_RESOURCES);
  const hiddenStorm = clamp(randomInt(Math.max(1, playerCount), Math.max(2, playerCount * 3)), 1, Math.max(1, target - 1));
  const visibleStorm = Math.max(1, target - hiddenStorm);
  const rangePadding = Math.max(1, Math.ceil(playerCount / 2));

  return {
    roundNumber,
    visibleStorm,
    hiddenStorm,
    hiddenStormMin: Math.max(1, hiddenStorm - rangePadding),
    hiddenStormMax: hiddenStorm + rangePadding,
    actualStorm: visibleStorm + hiddenStorm,
    harborStandard,
    isEmergencyRound,
    startedAt: Date.now(),
  };
}

function submitContribution(code, body) {
  const room = rooms.get(code);
  if (!room) return { status: 404, value: { error: "room-not-found" } };
  if (room.state.phase !== "secret_contribution") {
    return { status: 409, value: { error: "contribution-closed" } };
  }

  const student = room.students.find((item) => item.id === body.studentId);
  if (!student) return { status: 404, value: { error: "student-not-found" } };

  const wasSubmitted = student.currentContribution !== null && student.lastSubmittedRound === room.state.round.roundNumber;
  student.currentContribution = clamp(Number(body.contribution), 0, BASE_RESOURCES);
  student.lastSubmittedRound = room.state.round.roundNumber;
  touch(room);

  const response = serializeRoom(room, { studentId: student.id });
  response.submission = {
    accepted: true,
    updated: wasSubmitted,
    contribution: student.currentContribution,
  };
  return { status: 200, value: response };
}

function judgeRoom(code) {
  const room = rooms.get(code);
  if (!room) return { status: 404, value: { error: "room-not-found" } };

  const state = room.state;
  const round = state.round;
  if (!round) return { status: 400, value: { error: "round-not-started" } };
  if (state.phase === "round_result" || state.phase === "final_result" || state.phase === "reinforcement_vote") {
    return { status: 200, value: serializeRoom(room) };
  }
  if (room.students.length === 0) return { status: 400, value: { error: "no-students" } };

  const missing = room.students.filter((student) => student.lastSubmittedRound !== round.roundNumber);
  missing.forEach((student) => {
    student.currentContribution = 0;
    student.lastSubmittedRound = round.roundNumber;
  });

  const totalContribution = room.students.reduce((sum, student) => sum + student.currentContribution, 0);
  const belowStandard = room.students.filter((student) => student.currentContribution < round.harborStandard);
  const standardContributors = room.students.filter((student) => student.currentContribution >= round.harborStandard);
  const defenseSuccess = totalContribution >= round.actualStorm;
  const cooperationTarget = Math.ceil(room.students.length * 0.8);
  const cooperationSuccess = defenseSuccess && standardContributors.length >= cooperationTarget;
  const deficit = Math.max(0, round.actualStorm - totalContribution);
  const excess = Math.max(0, totalContribution - round.actualStorm);

  let honorWinner = null;
  if (defenseSuccess && standardContributors.length > 0) {
    const highestContribution = Math.max(...standardContributors.map((student) => student.currentContribution));
    const candidates = standardContributors.filter((student) => student.currentContribution === highestContribution);
    honorWinner = candidates[randomInt(0, candidates.length - 1)];
    honorWinner.honorPoints += 2;
  }

  if (cooperationSuccess) {
    state.group.reinforcement += 1;
  }

  // Resource bookkeeping is independent of the damage decision, so settle it now.
  room.students.forEach((student) => {
    const kept = BASE_RESOURCES - student.currentContribution;
    student.storedResources += kept;
    student.totalContribution += student.currentContribution;
    student.resources = 0;
  });

  const nearMissRecord = !defenseSuccess && deficit > 0 && deficit <= 2 && belowStandard.length > 0
    ? belowStandard[randomInt(0, belowStandard.length - 1)]
    : null;

  const result = {
    roundNumber: round.roundNumber,
    phaseLabel: "판정 완료",
    visibleStorm: round.visibleStorm,
    hiddenStorm: round.hiddenStorm,
    actualStorm: round.actualStorm,
    harborStandard: round.harborStandard,
    totalContribution,
    deficit,
    excess,
    defenseSuccess,
    cooperationSuccess,
    cooperationTarget,
    standardContributorCount: standardContributors.length,
    belowStandardCount: belowStandard.length,
    missingCount: missing.length,
    honorWinnerName: honorWinner ? honorWinner.name : null,
    nearMissRecordName: nearMissRecord ? nearMissRecord.name : null,
    isEmergencyRound: round.isEmergencyRound,
    // Damage-related fields are filled by applyDamageOutcome, after any vote.
    reinforcementUsed: null,
    reinforcementSpent: 0,
    recovered: false,
    voteYes: 0,
    voteNo: 0,
    voteTotal: 0,
    cityDamage: state.group.cityDamage,
    reinforcement: state.group.reinforcement,
    isCollapsed: state.group.isCollapsed,
    judgedAt: Date.now(),
  };
  state.lastResult = result;

  // Defense failed but the group can spend reinforcement to block the damage.
  // Pause for a group vote instead of applying damage immediately.
  if (!defenseSuccess && state.group.reinforcement >= REINFORCEMENT_COST) {
    state.reinforcementVote = {
      open: true,
      votes: {},
      reinforcementAvailable: state.group.reinforcement,
      cost: REINFORCEMENT_COST,
      deficit,
    };
    state.phase = "reinforcement_vote";
    touch(room);
    return { status: 200, value: serializeRoom(room) };
  }

  applyDamageOutcome(room, false);
  commitRoundResult(room);
  touch(room);
  return { status: 200, value: serializeRoom(room) };
}

// Applies damage / recovery / reinforcement spend onto the group, then mirrors
// the final figures back onto state.lastResult. defenseSuccess and emergency
// recovery are read from the already-built result.
function applyDamageOutcome(room, useReinforcement) {
  const state = room.state;
  const result = state.lastResult;

  if (!result.defenseSuccess) {
    if (useReinforcement) {
      state.group.reinforcement = Math.max(0, state.group.reinforcement - REINFORCEMENT_COST);
      result.reinforcementSpent = REINFORCEMENT_COST;
    } else {
      state.group.cityDamage = Math.min(COLLAPSE_AT, state.group.cityDamage + 1);
      state.group.isCollapsed = state.group.cityDamage >= COLLAPSE_AT;
    }
  }

  if (result.isEmergencyRound && result.defenseSuccess && result.cooperationSuccess && state.group.cityDamage > 0) {
    state.group.cityDamage -= 1;
    result.recovered = true;
  }

  result.cityDamage = state.group.cityDamage;
  result.reinforcement = state.group.reinforcement;
  result.isCollapsed = state.group.isCollapsed;
}

function commitRoundResult(room) {
  const state = room.state;
  state.group.roundHistory.push(state.lastResult);
  if (state.group.isCollapsed || state.roundNumber >= state.maxRounds) {
    finalizeGame(room);
  } else {
    state.phase = "round_result";
  }
}

// Resolves a pending reinforcement vote. Without `force`, only resolves once
// every student has voted (auto-resolve); the teacher can force it any time.
function resolveReinforcementVote(room, { force = false } = {}) {
  const state = room.state;
  const vote = state.reinforcementVote;
  if (!vote || state.phase !== "reinforcement_vote") return { error: "no-pending-vote" };

  const cast = Object.values(vote.votes);
  const total = room.students.length;
  if (!force && cast.length < total) return { pending: true };

  const voteYes = cast.filter(Boolean).length;
  const voteNo = cast.length - voteYes;
  const useReinforcement = voteYes * 2 > total; // strict majority of the whole group

  const result = state.lastResult;
  result.voteYes = voteYes;
  result.voteNo = voteNo;
  result.voteTotal = total;
  result.reinforcementUsed = useReinforcement;

  applyDamageOutcome(room, useReinforcement);
  state.reinforcementVote = null;
  commitRoundResult(room);
  return {};
}

function submitVote(code, body) {
  const room = rooms.get(code);
  if (!room) return { status: 404, value: { error: "room-not-found" } };
  if (room.state.phase !== "reinforcement_vote" || !room.state.reinforcementVote) {
    return { status: 409, value: { error: "vote-closed" } };
  }

  const student = room.students.find((item) => item.id === body.studentId);
  if (!student) return { status: 404, value: { error: "student-not-found" } };

  room.state.reinforcementVote.votes[student.id] = Boolean(body.vote);
  resolveReinforcementVote(room, { force: false });
  touch(room);
  return { status: 200, value: serializeRoom(room, { studentId: student.id }) };
}

function finalizeGame(room) {
  const state = room.state;
  const collapsed = state.group.isCollapsed || state.group.cityDamage >= COLLAPSE_AT;
  let finalBonus = 0;
  if (!collapsed) {
    if (state.group.cityDamage === 0) finalBonus = 6;
    if (state.group.cityDamage === 1) finalBonus = 3;
  }
  state.group.finalBonus = finalBonus;
  state.group.isCollapsed = collapsed;

  const ranked = room.students
    .map((student) => ({
      id: student.id,
      name: student.name,
      score: collapsed ? 0 : scoreOf(student, state),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ko"));

  state.finalResult = {
    collapsed,
    title: collapsed ? "도시 함락" : "도시 생존",
    finalBonus,
    cityDamage: state.group.cityDamage,
    winnerName: collapsed ? null : ranked[0]?.name || null,
    winnerScore: collapsed ? null : ranked[0]?.score || 0,
  };
  state.phase = "final_result";
}

function scoreOf(student, state) {
  return student.storedResources + student.honorPoints + (state.group.finalBonus || 0);
}

function serializeRoom(room, options = {}) {
  const studentId = options.studentId || "";
  const state = room.state;
  return {
    code: room.code,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    state: {
      phase: state.phase,
      phaseLabel: PHASE_LABELS[state.phase] || state.phase,
      maxRounds: state.maxRounds,
      roundNumber: state.roundNumber,
      timerSeconds: state.timerSeconds,
      timerTotal: state.timerTotal,
      group: {
        id: state.group.id,
        name: state.group.name,
        cityDamage: state.group.cityDamage,
        reinforcement: state.group.reinforcement,
        isCollapsed: state.group.isCollapsed,
        finalBonus: state.group.finalBonus,
        roundHistory: state.group.roundHistory.map(sanitizeResult),
      },
      round: serializeRound(state),
      result: state.lastResult ? sanitizeResult(state.lastResult) : null,
      finalResult: state.finalResult,
      reinforcementVote: serializeReinforcementVote(room),
      submittedCount: submittedCount(room),
      totalPlayers: room.students.length,
    },
    students: room.students.slice(-80).map((student) => serializeStudentSummary(student, state)),
    me: studentId ? serializeOwnStudent(room, studentId) : null,
  };
}

function serializeReinforcementVote(room) {
  const vote = room.state.reinforcementVote;
  if (!vote) return null;
  return {
    open: true,
    votedCount: Object.keys(vote.votes).length,
    totalPlayers: room.students.length,
    reinforcementAvailable: vote.reinforcementAvailable,
    cost: vote.cost,
    deficit: vote.deficit,
  };
}

function serializeRound(state) {
  if (!state.round) return null;
  const revealed = state.phase === "round_result" || state.phase === "final_result" || state.phase === "reinforcement_vote";
  return {
    roundNumber: state.round.roundNumber,
    visibleStorm: state.round.visibleStorm,
    hiddenStormMin: state.round.hiddenStormMin,
    hiddenStormMax: state.round.hiddenStormMax,
    hiddenStorm: revealed ? state.round.hiddenStorm : null,
    actualStorm: revealed ? state.round.actualStorm : null,
    harborStandard: state.round.harborStandard,
    isEmergencyRound: state.round.isEmergencyRound,
  };
}

function serializeStudentSummary(student, state) {
  const submitted = Boolean(state.round && student.lastSubmittedRound === state.round.roundNumber);
  return {
    id: student.id,
    name: student.name,
    groupId: student.groupId,
    joinedAt: student.joinedAt,
    submitted,
  };
}

function serializeOwnStudent(room, studentId) {
  const student = room.students.find((item) => item.id === studentId);
  if (!student) return null;
  const vote = room.state.reinforcementVote;
  const hasVoted = Boolean(vote && Object.hasOwn(vote.votes, student.id));
  return {
    id: student.id,
    name: student.name,
    resources: student.resources,
    storedResources: student.storedResources,
    currentContribution: student.currentContribution,
    totalContribution: student.totalContribution,
    honorPoints: student.honorPoints,
    score: scoreOf(student, room.state),
    submitted: Boolean(room.state.round && student.lastSubmittedRound === room.state.round.roundNumber),
    voted: hasVoted,
    vote: hasVoted ? vote.votes[student.id] : null,
  };
}

function sanitizeResult(result) {
  return {
    roundNumber: result.roundNumber,
    phaseLabel: result.phaseLabel,
    visibleStorm: result.visibleStorm,
    hiddenStorm: result.hiddenStorm,
    actualStorm: result.actualStorm,
    harborStandard: result.harborStandard,
    totalContribution: result.totalContribution,
    deficit: result.deficit,
    excess: result.excess,
    defenseSuccess: result.defenseSuccess,
    cooperationSuccess: result.cooperationSuccess,
    cooperationTarget: result.cooperationTarget,
    standardContributorCount: result.standardContributorCount,
    belowStandardCount: result.belowStandardCount,
    missingCount: result.missingCount,
    honorWinnerName: result.honorWinnerName,
    nearMissRecordName: result.nearMissRecordName,
    isEmergencyRound: result.isEmergencyRound,
    reinforcementUsed: result.reinforcementUsed,
    reinforcementSpent: result.reinforcementSpent,
    recovered: result.recovered,
    voteYes: result.voteYes,
    voteNo: result.voteNo,
    voteTotal: result.voteTotal,
    cityDamage: result.cityDamage,
    reinforcement: result.reinforcement,
    isCollapsed: result.isCollapsed,
    judgedAt: result.judgedAt,
  };
}

function submittedCount(room) {
  if (!room.state.round) return 0;
  return room.students.filter((student) => student.lastSubmittedRound === room.state.round.roundNumber).length;
}

function touch(room) {
  room.updatedAt = Date.now();
}

function getOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}`;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 128_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (_error) {
        resolve({});
      }
    });
  });
}

function serveFile(req, res) {
  const url = new URL(req.url, "http://local");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const relative = normalized.replace(/^[/\\]+/, "");
  const filePath = path.join(ROOT, relative);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/rooms") {
    sendJson(res, 200, createRoom(req));
    return;
  }

  const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4})(?:\/(students|contributions|votes|judge))?$/);
  if (!match) {
    sendJson(res, 404, { error: "not-found" });
    return;
  }

  const code = match[1];
  const child = match[2];

  if (req.method === "GET" && !child) {
    const room = rooms.get(code);
    const studentId = url.searchParams.get("student") || "";
    sendJson(res, room ? 200 : 404, room ? serializeRoom(room, { studentId }) : { error: "room-not-found" });
    return;
  }

  if (req.method === "PATCH" && !child) {
    const body = await readJson(req);
    const result = updateRoom(code, body);
    sendJson(res, result ? result.status : 404, result ? result.value : { error: "room-not-found" });
    return;
  }

  if (req.method === "POST" && child === "students") {
    const body = await readJson(req);
    const result = addStudent(code, body);
    sendJson(res, result ? 200 : 404, result || { error: "room-not-found" });
    return;
  }

  if (req.method === "POST" && child === "contributions") {
    const body = await readJson(req);
    const result = submitContribution(code, body);
    sendJson(res, result.status, result.value);
    return;
  }

  if (req.method === "POST" && child === "votes") {
    const body = await readJson(req);
    const result = submitVote(code, body);
    sendJson(res, result.status, result.value);
    return;
  }

  if (req.method === "POST" && child === "judge") {
    const result = judgeRoom(code);
    sendJson(res, result.status, result.value);
    return;
  }

  sendJson(res, 405, { error: "method-not-allowed" });
}

function randomInt(min, max) {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function clamp(value, min, max) {
  const number = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, number));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveFile(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Breakwater classroom server: http://127.0.0.1:${PORT}`);
});
