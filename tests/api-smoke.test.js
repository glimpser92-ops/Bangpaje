const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = 4800 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), BREAKWATER_TEST: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

async function request(method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed: ${response.status} ${JSON.stringify(value)}`);
  }
  return value;
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      await request("GET", "/health");
      return;
    } catch (_error) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  throw new Error("server did not start");
}

async function run() {
  await waitForServer();

  const created = await request("POST", "/api/rooms");
  const code = created.code;
  const first = await request("POST", `/api/rooms/${code}/students`, { name: "민준" });
  const second = await request("POST", `/api/rooms/${code}/students`, { name: "서연" });

  await request("PATCH", `/api/rooms/${code}`, { action: "startRound" });
  await request("PATCH", `/api/rooms/${code}`, { action: "setPhase", phase: "secret_contribution" });
  await request("POST", `/api/rooms/${code}/contributions`, {
    studentId: first.studentId,
    contribution: 3,
  });
  const duplicate = await request("POST", `/api/rooms/${code}/contributions`, {
    studentId: first.studentId,
    contribution: 4,
  });
  await request("POST", `/api/rooms/${code}/contributions`, {
    studentId: second.studentId,
    contribution: 5,
  });

  assert.equal(duplicate.submission.updated, true);

  const judged = await request("POST", `/api/rooms/${code}/judge`);
  assert.equal(judged.state.result.totalContribution, 9);
  assert.equal(judged.state.result.missingCount, 0);

  const teacherView = await request("GET", `/api/rooms/${code}`);
  assert.equal(teacherView.students.some((student) => Object.hasOwn(student, "currentContribution")), false);
  assert.equal(teacherView.students.some((student) => Object.hasOwn(student, "storedResources")), false);

  const studentView = await request("GET", `/api/rooms/${code}?student=${first.studentId}`);
  assert.equal(studentView.me.currentContribution, 4);
  assert.equal(studentView.students.some((student) => Object.hasOwn(student, "currentContribution")), false);

  await runReinforcementVoteTests();

  console.log("API smoke passed");
}

// Drives a defense failure (everyone contributes 0) with a stocked reinforcement,
// so the round pauses for the reinforcement-use vote. Returns the post-judge state.
async function setupFailedRoundWithReinforcement(reinforcement) {
  const created = await request("POST", "/api/rooms");
  const code = created.code;
  const a = await request("POST", `/api/rooms/${code}/students`, { name: "가" });
  const b = await request("POST", `/api/rooms/${code}/students`, { name: "나" });
  await request("PATCH", `/api/rooms/${code}`, { action: "startRound" });
  await request("PATCH", `/api/rooms/${code}`, { action: "__setReinforcement", reinforcement });
  await request("PATCH", `/api/rooms/${code}`, { action: "setPhase", phase: "secret_contribution" });
  await request("POST", `/api/rooms/${code}/contributions`, { studentId: a.studentId, contribution: 0 });
  await request("POST", `/api/rooms/${code}/contributions`, { studentId: b.studentId, contribution: 0 });
  const judged = await request("POST", `/api/rooms/${code}/judge`);
  return { code, a, b, judged };
}

async function runReinforcementVoteTests() {
  // Failure + enough reinforcement -> pauses for a vote, individual votes stay hidden.
  const passing = await setupFailedRoundWithReinforcement(2);
  assert.equal(passing.judged.state.phase, "reinforcement_vote");
  assert.equal(passing.judged.state.result.defenseSuccess, false);
  assert.ok(passing.judged.state.reinforcementVote, "vote should be open");
  assert.equal(passing.judged.state.reinforcementVote.totalPlayers, 2);

  // Majority "yes" spends 2 reinforcement and blocks the damage (auto-resolves on last vote).
  await request("POST", `/api/rooms/${passing.code}/votes`, { studentId: passing.a.studentId, vote: true });
  const afterYes = await request("POST", `/api/rooms/${passing.code}/votes`, { studentId: passing.b.studentId, vote: true });
  assert.equal(afterYes.state.phase, "round_result");
  assert.equal(afterYes.state.result.reinforcementUsed, true);
  assert.equal(afterYes.state.result.reinforcementSpent, 2);
  assert.equal(afterYes.state.result.cityDamage, 0);
  assert.equal(afterYes.state.group.reinforcement, 0);
  assert.equal(afterYes.state.reinforcementVote, null);

  // Votes must never be exposed per-student in the public roster.
  const teacherDuringVote = await setupFailedRoundWithReinforcement(2);
  const teacherView = await request("GET", `/api/rooms/${teacherDuringVote.code}`);
  assert.equal(teacherView.students.some((student) => Object.hasOwn(student, "vote")), false);

  // Majority "no" applies the damage and keeps the reinforcement.
  const rejecting = await setupFailedRoundWithReinforcement(2);
  await request("POST", `/api/rooms/${rejecting.code}/votes`, { studentId: rejecting.a.studentId, vote: false });
  const afterNo = await request("POST", `/api/rooms/${rejecting.code}/votes`, { studentId: rejecting.b.studentId, vote: false });
  assert.equal(afterNo.state.phase, "round_result");
  assert.equal(afterNo.state.result.reinforcementUsed, false);
  assert.equal(afterNo.state.result.cityDamage, 1);
  assert.equal(afterNo.state.group.reinforcement, 2);

  // Teacher force-resolve with a non-majority tally rejects the spend.
  const forced = await setupFailedRoundWithReinforcement(2);
  await request("POST", `/api/rooms/${forced.code}/votes`, { studentId: forced.a.studentId, vote: true });
  const afterForce = await request("PATCH", `/api/rooms/${forced.code}`, { action: "resolveVote" });
  assert.equal(afterForce.state.phase, "round_result");
  assert.equal(afterForce.state.result.reinforcementUsed, false);
  assert.equal(afterForce.state.result.cityDamage, 1);

  // Failure with only 1 reinforcement does not trigger a vote; damage applies directly.
  const noVote = await setupFailedRoundWithReinforcement(1);
  assert.equal(noVote.judged.state.phase, "round_result");
  assert.equal(noVote.judged.state.reinforcementVote, null);
  assert.equal(noVote.judged.state.result.reinforcementUsed, null);
  assert.equal(noVote.judged.state.result.cityDamage, 1);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
  });
