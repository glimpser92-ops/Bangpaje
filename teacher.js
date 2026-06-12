(function () {
  "use strict";

  const QUESTIONS = [
    "왜 세금은 자발적 기부가 아니라 제도일까?",
    "정확한 기여량이 보이지 않을 때 신뢰는 어떻게 만들어졌을까?",
    "기준 미달자 수만 공개되면 협상은 어떻게 달라질까?",
    "공동체 생존과 개인 점수 사이에서 어떤 선택이 합리적이었을까?",
    "감시와 처벌이 늘어나면 협력은 좋아질까, 불신은 커질까?",
  ];

  const $ = (selector) => document.querySelector(selector);

  const ui = {
    resetClassButton: $("#resetClassButton"),
    teacherRoomBanner: $("#teacherRoomBanner"),
    teacherRoomCode: $("#teacherRoomCode"),
    teacherStudentCount: $("#teacherStudentCount"),
    copyJoinLinkButton: $("#copyJoinLinkButton"),
    teacherRosterPanel: $("#teacherRosterPanel"),
    teacherRosterList: $("#teacherRosterList"),
    teacherSubmitBadge: $("#teacherSubmitBadge"),
    teacherRoundBadge: $("#teacherRoundBadge"),
    teacherPhaseBadge: $("#teacherPhaseBadge"),
    teacherVisibleStorm: $("#teacherVisibleStorm"),
    teacherHiddenStorm: $("#teacherHiddenStorm"),
    teacherHiddenRange: $("#teacherHiddenRange"),
    teacherHarborStandard: $("#teacherHarborStandard"),
    startRoundButton: $("#startRoundButton"),
    negotiationButton: $("#negotiationButton"),
    contributionPhaseButton: $("#contributionPhaseButton"),
    judgeRoundButton: $("#judgeRoundButton"),
    resolveVoteButton: $("#resolveVoteButton"),
    timerDisplay: $("#timerDisplay"),
    startTimerButton: $("#startTimerButton"),
    pauseTimerButton: $("#pauseTimerButton"),
    resetTimerButton: $("#resetTimerButton"),
    groupList: $("#groupList"),
    debriefList: $("#debriefList"),
  };

  const roomCode = new URLSearchParams(window.location.search).get("room")?.toUpperCase() || "";
  const joinUrl = roomCode ? `${window.location.origin}/?room=${roomCode}` : "";
  let room = null;
  let timerId = null;
  let timerSeconds = 120;
  let timerTotal = 120;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = value.error || "request-failed";
      throw new Error(message);
    }
    return value;
  }

  async function refreshRoom() {
    if (!roomCode) {
      renderNoRoom();
      return;
    }
    try {
      room = await api(`./api/rooms/${encodeURIComponent(roomCode)}`);
      timerSeconds = Number(room.state.timerSeconds || timerSeconds);
      timerTotal = Number(room.state.timerTotal || timerTotal);
      render();
    } catch (_error) {
      room = null;
      renderNoRoom();
    }
  }

  async function patchRoom(body) {
    if (!roomCode) return;
    room = await api(`./api/rooms/${encodeURIComponent(roomCode)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    timerSeconds = Number(room.state.timerSeconds || timerSeconds);
    timerTotal = Number(room.state.timerTotal || timerTotal);
    render();
  }

  async function startRound() {
    await patchRoom({ action: "startRound" });
  }

  async function setPhase(phase) {
    await patchRoom({ action: "setPhase", phase });
  }

  async function judgeRound() {
    if (!roomCode) return;
    room = await api(`./api/rooms/${encodeURIComponent(roomCode)}/judge`, { method: "POST" });
    render();
  }

  async function resolveVote() {
    await patchRoom({ action: "resolveVote" });
  }

  function setTimer(minutes) {
    timerTotal = minutes * 60;
    timerSeconds = timerTotal;
    syncTimer();
    renderTimer();
    renderTimerButtons();
  }

  function startTimer() {
    if (timerId) return;
    timerId = window.setInterval(() => {
      timerSeconds = Math.max(0, timerSeconds - 1);
      renderTimer();
      if (timerSeconds === 0) stopTimer();
      if (timerSeconds % 5 === 0 || timerSeconds === 0) syncTimer();
    }, 1000);
  }

  function stopTimer() {
    window.clearInterval(timerId);
    timerId = null;
    syncTimer();
  }

  function resetTimer() {
    stopTimer();
    timerSeconds = timerTotal;
    syncTimer();
    renderTimer();
  }

  async function syncTimer() {
    if (!roomCode) return;
    try {
      await patchRoom({ action: "setTimer", timerSeconds, timerTotal });
    } catch (_error) {
      // The visible timer still works if the classroom server is unavailable.
    }
  }

  function renderNoRoom() {
    ui.teacherRoomBanner.hidden = true;
    ui.teacherRoundBadge.textContent = "0 / 6";
    ui.teacherPhaseBadge.textContent = "방 없음";
    ui.teacherVisibleStorm.textContent = "-";
    ui.teacherHiddenStorm.textContent = "?";
    ui.teacherHiddenRange.textContent = "시작 화면에서 방 열기";
    ui.teacherHarborStandard.textContent = "-";
    ui.teacherRosterPanel.hidden = true;
    ui.groupList.innerHTML = `
      <article class="group-card">
        <div class="result-banner warning">
          <strong>참여 방이 없습니다.</strong>
          <span>시작 화면에서 방을 열면 학생 입장과 비밀 기여를 실시간으로 받을 수 있습니다.</span>
        </div>
      </article>
    `;
    ui.debriefList.innerHTML = QUESTIONS.map((question) => `<button class="debrief-question" type="button">${question}</button>`).join("");
    disableButtons(true);
  }

  function render() {
    if (!room) {
      renderNoRoom();
      return;
    }

    const { state, students } = room;
    const round = state.round;
    const result = state.result;
    const finalResult = state.finalResult;

    ui.teacherRoomBanner.hidden = false;
    ui.teacherRosterPanel.hidden = false;
    ui.teacherRoomCode.textContent = room.code;
    ui.teacherStudentCount.textContent = `${students.length}명`;
    ui.teacherRoundBadge.textContent = `${state.roundNumber} / ${state.maxRounds}`;
    ui.teacherPhaseBadge.textContent = state.phaseLabel;
    ui.teacherVisibleStorm.textContent = round ? round.visibleStorm : "-";
    ui.teacherHiddenStorm.textContent = result ? result.hiddenStorm : "?";
    ui.teacherHiddenRange.textContent = round
      ? result
        ? "공개됨"
        : `${round.hiddenStormMin}-${round.hiddenStormMax}`
      : "예보 전";
    ui.teacherHarborStandard.textContent = round ? `${round.harborStandard}개` : "-";

    timerSeconds = Number(state.timerSeconds || timerSeconds);
    timerTotal = Number(state.timerTotal || timerTotal);
    renderTimer();
    renderTimerButtons();
    renderButtons(state);
    renderRoster(students, state);
    renderGroup(state, result, finalResult);
    renderDebrief(state, result, finalResult);
  }

  function renderButtons(state) {
    const hasRoom = Boolean(roomCode && room);
    const isFinal = state.phase === "final_result";
    const hasRound = Boolean(state.round);
    const voting = state.phase === "reinforcement_vote";

    ui.startRoundButton.disabled = !hasRoom || isFinal || voting || (hasRound && state.phase !== "round_result");
    ui.startRoundButton.textContent = state.roundNumber === 0 ? "1라운드 시작" : "다음 라운드 시작";
    ui.negotiationButton.disabled = !hasRoom || !hasRound || !["storm_forecast", "negotiation"].includes(state.phase);
    ui.contributionPhaseButton.disabled = !hasRoom || !hasRound || !["storm_forecast", "negotiation", "secret_contribution"].includes(state.phase);
    ui.judgeRoundButton.disabled = !hasRoom || !hasRound || state.phase !== "secret_contribution" || state.totalPlayers === 0;
    ui.judgeRoundButton.hidden = voting;
    ui.resolveVoteButton.hidden = !voting;
    ui.resolveVoteButton.disabled = !hasRoom || !voting;
  }

  function disableButtons(disabled) {
    ui.startRoundButton.disabled = disabled;
    ui.negotiationButton.disabled = disabled;
    ui.contributionPhaseButton.disabled = disabled;
    ui.judgeRoundButton.disabled = disabled;
    ui.resolveVoteButton.disabled = disabled;
    ui.resolveVoteButton.hidden = true;
  }

  function renderRoster(students, state) {
    ui.teacherSubmitBadge.textContent = `${state.submittedCount} / ${state.totalPlayers}`;
    if (!students.length) {
      ui.teacherRosterList.innerHTML = `<div class="roster-item">아직 참여한 학생이 없습니다.<span>${joinUrl}</span></div>`;
      return;
    }

    ui.teacherRosterList.innerHTML = students
      .map((student) => {
        const status = state.round ? (student.submitted ? "제출 완료" : "대기") : "입장";
        const className = student.submitted ? "submitted" : "";
        return `
          <div class="roster-item ${className}">
            <span class="roster-name">${escapeHtml(student.name)}</span>
            <span>${status}</span>
          </div>
        `;
      })
      .join("");
  }

  function renderGroup(state, result, finalResult) {
    const damageDots = Array.from(
      { length: 3 },
      (_, index) => `<span class="breach-dot ${index < state.group.cityDamage ? "on" : ""}"></span>`,
    ).join("");
    const history = state.group.roundHistory
      .map((item) => `${item.roundNumber}R ${item.totalContribution}/${item.actualStorm} · 미달 ${item.belowStandardCount}`)
      .join(" · ");
    const resultHtml = result ? renderResult(result, finalResult) : `<p class="group-history">라운드를 시작하면 폭풍 예보와 항구 기준이 표시됩니다.</p>`;
    const voteHtml = state.reinforcementVote ? renderVoteStatus(state.reinforcementVote) : "";

    ui.groupList.innerHTML = `
      <article class="group-card ${state.group.isCollapsed ? "collapsed" : ""}">
        <div class="group-card-top">
          <h3 class="group-title">${escapeHtml(state.group.name)}</h3>
          <strong>${state.group.isCollapsed ? "함락" : "생존 중"}</strong>
        </div>
        <div class="breach-row" aria-label="도시 피해 ${state.group.cityDamage} / 3">${damageDots}</div>
        <div class="summary-grid">
          <div><span>방파제 강화</span><strong>${state.group.reinforcement}</strong></div>
          <div><span>학생 수</span><strong>${state.totalPlayers}</strong></div>
          <div><span>제출</span><strong>${state.submittedCount} / ${state.totalPlayers}</strong></div>
          <div><span>최종 보너스</span><strong>${state.group.finalBonus}</strong></div>
        </div>
        ${voteHtml}
        ${resultHtml}
        <p class="group-history">${history || "기록 없음"}</p>
      </article>
    `;
  }

  function renderVoteStatus(vote) {
    return `
      <div class="result-banner warning">
        <strong>방파제 강화 사용 투표 중</strong>
        <span>방어 실패. 강화 ${vote.cost}개를 사용하면 이번 피해를 막습니다. (보유 ${vote.reinforcementAvailable}개)</span>
        <span>투표 ${vote.votedCount} / ${vote.totalPlayers}명 · 과반 찬성 시 사용. 전원 투표 시 자동 판정, 또는 "강화 투표 종료"로 마감하세요.</span>
      </div>
    `;
  }

  function renderResult(result, finalResult) {
    const tone = result.defenseSuccess ? "success" : "warning";
    const title = finalResult ? finalResult.title : result.defenseSuccess ? "방어 성공" : "방어 실패";
    const nearMiss = result.nearMissRecordName
      ? `<span>아슬아슬한 실패 기록: 기준 미달자 중 ${escapeHtml(result.nearMissRecordName)} 학생이 항구 기록에 남았습니다.</span>`
      : "";
    const honor = result.honorWinnerName
      ? `<span>명예 보상: ${escapeHtml(result.honorWinnerName)} 학생에게 +2점</span>`
      : "<span>명예 보상 없음</span>";
    let reinforcementLine = "";
    if (result.reinforcementUsed === true) {
      reinforcementLine = `<span>강화 투표 가결(${result.voteYes}/${result.voteTotal}): 방파제 강화 ${result.reinforcementSpent}개 사용, 피해를 막았습니다.</span>`;
    } else if (result.reinforcementUsed === false) {
      reinforcementLine = `<span>강화 투표 부결(${result.voteYes}/${result.voteTotal}): 강화를 쓰지 않아 도시 피해가 늘었습니다.</span>`;
    } else if (result.recovered) {
      reinforcementLine = "<span>긴급 라운드 회복: 도시 피해를 1 줄였습니다.</span>";
    }
    const final = finalResult
      ? `<span>${finalResult.collapsed ? "전원 공동 패배" : `최종 우승: ${escapeHtml(finalResult.winnerName || "-")} (${finalResult.winnerScore}점)`}</span>`
      : "";

    return `
      <div class="result-banner ${tone}">
        <strong>${title}</strong>
        <span>총 기여 ${result.totalContribution} / 실제 폭풍 ${result.actualStorm}</span>
        <span>기준 미달자 ${result.belowStandardCount}명 · 기준 이상 ${result.standardContributorCount}/${result.cooperationTarget}명 필요</span>
        <span>${result.cooperationSuccess ? "공동 협력 성공: 방파제 강화 +1" : "공동 협력 미달: 강화 없음"}</span>
        ${honor}
        ${reinforcementLine}
        ${nearMiss}
        ${final}
      </div>
    `;
  }

  function renderDebrief(state, result, finalResult) {
    const summary = finalResult
      ? `${finalResult.title} · 피해 ${finalResult.cityDamage} · 보너스 ${finalResult.finalBonus}`
      : result
        ? `${result.defenseSuccess ? "방어 성공" : "방어 실패"} · 기준 미달자 ${result.belowStandardCount}명`
        : "아직 판정 전";
    ui.debriefList.innerHTML = `
      <div class="debrief-summary">
        <strong>${state.phaseLabel}</strong>
        <span>${summary}</span>
      </div>
      ${QUESTIONS.map((question) => `<button class="debrief-question" type="button">${question}</button>`).join("")}
    `;
  }

  function renderTimer() {
    const minutes = Math.floor(timerSeconds / 60);
    const seconds = timerSeconds % 60;
    ui.timerDisplay.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    ui.timerDisplay.classList.toggle("urgent", timerSeconds <= 10 && timerSeconds > 0);
  }

  function renderTimerButtons() {
    document.querySelectorAll("[data-minutes]").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.minutes) * 60 === timerTotal);
    });
  }

  function bindEvents() {
    ui.resetClassButton.addEventListener("click", () => {
      window.location.href = "./";
    });
    ui.copyJoinLinkButton.addEventListener("click", async () => {
      if (!joinUrl) return;
      try {
        await navigator.clipboard.writeText(joinUrl);
        ui.copyJoinLinkButton.textContent = "복사됨";
        window.setTimeout(() => {
          ui.copyJoinLinkButton.textContent = "복사";
        }, 1400);
      } catch (_error) {
        window.prompt("참여 주소", joinUrl);
      }
    });
    ui.startRoundButton.addEventListener("click", () => startRound().catch(showError));
    ui.negotiationButton.addEventListener("click", () => setPhase("negotiation").catch(showError));
    ui.contributionPhaseButton.addEventListener("click", () => setPhase("secret_contribution").catch(showError));
    ui.judgeRoundButton.addEventListener("click", () => judgeRound().catch(showError));
    ui.resolveVoteButton.addEventListener("click", () => resolveVote().catch(showError));
    ui.startTimerButton.addEventListener("click", startTimer);
    ui.pauseTimerButton.addEventListener("click", stopTimer);
    ui.resetTimerButton.addEventListener("click", resetTimer);
    document.querySelectorAll("[data-minutes]").forEach((button) => {
      button.addEventListener("click", () => setTimer(Number(button.dataset.minutes)));
    });
  }

  function showError(error) {
    ui.groupList.innerHTML = `
      <article class="group-card">
        <div class="result-banner warning">
          <strong>진행할 수 없습니다.</strong>
          <span>${escapeHtml(error.message || "요청을 처리하지 못했습니다.")}</span>
        </div>
      </article>
    `;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  bindEvents();
  refreshRoom();
  window.setInterval(refreshRoom, 1500);
})();
