(function () {
  "use strict";

  const BASE_RESOURCES = 10;
  const $ = (selector) => document.querySelector(selector);

  const ui = {
    harborScene: $("#harborScene"),
    monthBadge: $("#monthBadge"),
    breachStatus: $("#breachStatus"),
    visibleStorm: $("#visibleStorm"),
    hiddenRange: $("#hiddenRange"),
    reinforcementStatus: $("#honorBonus"),
    stormCards: $("#stormCards"),
    contributionSlider: $("#contributionSlider"),
    contributionValue: $("#contributionValue"),
    contributionHint: $("#contributionHint"),
    decisionReadout: $("#decisionReadout"),
    voteBox: $("#voteBox"),
    voteHint: $("#voteHint"),
    voteUseButton: $("#voteUseButton"),
    voteSkipButton: $("#voteSkipButton"),
    commitButton: $("#commitButton"),
    housesList: $("#housesList"),
    logList: $("#logList"),
    studentRoomBanner: $("#studentRoomBanner"),
    studentRoomCode: $("#studentRoomCode"),
    studentRoomName: $("#studentRoomName"),
    studentRoomStorm: $("#studentRoomStorm"),
  };

  const params = new URLSearchParams(window.location.search);
  const roomCode = params.get("room")?.toUpperCase() || "";
  const studentId = params.get("student") || "";
  const studentName = params.get("name") || "학생";

  let room = null;
  let lastRoundNumber = null;
  let userDirty = false;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "request-failed");
    return value;
  }

  async function refreshRoom() {
    if (!roomCode || !studentId) {
      renderNoRoom();
      return;
    }
    try {
      room = await api(`./api/rooms/${encodeURIComponent(roomCode)}?student=${encodeURIComponent(studentId)}`);
      render();
    } catch (_error) {
      room = null;
      renderNoRoom();
    }
  }

  async function submitContribution() {
    if (!room || !room.me) return;
    const contribution = Number(ui.contributionSlider.value);
    try {
      room = await api(`./api/rooms/${encodeURIComponent(roomCode)}/contributions`, {
        method: "POST",
        body: JSON.stringify({ studentId, contribution }),
      });
      userDirty = false;
      render();
    } catch (error) {
      renderMessage("제출할 수 없습니다.", phaseHelp(error.message));
    }
  }

  async function submitVote(vote) {
    if (!room || !room.me) return;
    try {
      room = await api(`./api/rooms/${encodeURIComponent(roomCode)}/votes`, {
        method: "POST",
        body: JSON.stringify({ studentId, vote }),
      });
      render();
    } catch (error) {
      renderMessage("투표할 수 없습니다.", phaseHelp(error.message));
    }
  }

  function renderNoRoom() {
    ui.studentRoomBanner.hidden = true;
    ui.monthBadge.textContent = "0 / 6";
    ui.breachStatus.textContent = "0 / 3";
    ui.visibleStorm.textContent = "-";
    ui.hiddenRange.textContent = "-";
    ui.reinforcementStatus.textContent = "0";
    ui.stormCards.innerHTML = "";
    ui.contributionSlider.disabled = true;
    ui.commitButton.disabled = true;
    ui.contributionValue.textContent = "0";
    ui.contributionHint.textContent = "시작 화면에서 방 코드와 이름으로 입장하세요.";
    renderMessage("참여 정보가 없습니다.", "선생님이 만든 방 코드로 들어오면 비밀 기여 화면이 열립니다.");
    if (ui.voteBox) ui.voteBox.hidden = true;
    ui.housesList.innerHTML = "";
    ui.logList.innerHTML = "";
    setActiveStep("storm");
  }

  function render() {
    if (!room || !room.me) {
      renderNoRoom();
      return;
    }

    const { state, students, me } = room;
    const round = state.round;
    const result = state.result;
    const finalResult = state.finalResult;

    ui.studentRoomBanner.hidden = false;
    ui.studentRoomCode.textContent = room.code;
    ui.studentRoomName.textContent = me.name || studentName;
    ui.studentRoomStorm.textContent = state.phaseLabel;
    ui.monthBadge.textContent = `${state.roundNumber} / ${state.maxRounds}`;
    ui.breachStatus.textContent = `${state.group.cityDamage} / 3`;
    ui.visibleStorm.textContent = round ? round.visibleStorm : "-";
    ui.hiddenRange.textContent = round
      ? result
        ? `${result.hiddenStorm}`
        : `${round.hiddenStormMin}-${round.hiddenStormMax}`
      : "-";
    ui.reinforcementStatus.textContent = state.group.reinforcement;

    const stormPressure = round ? Math.min(1, (round.visibleStorm + round.hiddenStormMax) / Math.max(12, state.totalPlayers * BASE_RESOURCES)) : 0.18;
    ui.harborScene.style.setProperty("--storm", stormPressure.toFixed(2));
    ui.harborScene.style.setProperty("--breach", String(state.group.cityDamage));

    syncContributionInput(round, me);
    renderStormCards(state, round, result);
    renderDecision(state, round, result, finalResult, me);
    renderVote(state, me);
    renderPublicList(students, me, state);
    renderLog(state, result, finalResult);
    setActiveStep(stepForPhase(state.phase));
  }

  function syncContributionInput(round, me) {
    const roundNumber = round ? round.roundNumber : 0;
    if (roundNumber !== lastRoundNumber) {
      lastRoundNumber = roundNumber;
      userDirty = false;
      const suggested = round ? Math.min(BASE_RESOURCES, round.harborStandard) : 0;
      ui.contributionSlider.value = String(me.currentContribution ?? suggested);
    } else if (!userDirty && me.currentContribution !== null) {
      ui.contributionSlider.value = String(me.currentContribution);
    }

    ui.contributionSlider.max = String(BASE_RESOURCES);
    ui.contributionValue.textContent = ui.contributionSlider.value;
    updateContributionHint(round);
  }

  function renderStormCards(state, round, result) {
    if (!round) {
      ui.stormCards.innerHTML = `
        <div class="storm-card"><span>라운드</span><strong>대기</strong><small>교사가 시작합니다</small></div>
      `;
      return;
    }

    const hidden = result ? result.hiddenStorm : "?";
    const total = result ? result.actualStorm : "?";
    ui.stormCards.innerHTML = `
      <div class="storm-card">
        <span>공개 폭풍</span>
        <strong>${round.visibleStorm}</strong>
        <small>모두가 아는 위협</small>
      </div>
      <div class="storm-card hidden">
        <span>숨은 파고</span>
        <strong>${hidden}</strong>
        <small>${result ? "판정 때 공개됨" : `${round.hiddenStormMin}-${round.hiddenStormMax}`}</small>
      </div>
      <div class="storm-card honor">
        <span>항구 기준</span>
        <strong>${round.harborStandard}</strong>
        <small>${state.submittedCount} / ${state.totalPlayers} 제출</small>
      </div>
      <div class="storm-card total">
        <span>실제 폭풍</span>
        <strong>${total}</strong>
        <small>${round.isEmergencyRound ? "긴급 라운드" : "일반 라운드"}</small>
      </div>
    `;
  }

  function renderDecision(state, round, result, finalResult, me) {
    const canSubmit = state.phase === "secret_contribution" && round && !state.group.isCollapsed;
    ui.contributionSlider.disabled = !canSubmit;
    ui.commitButton.disabled = !canSubmit;
    ui.commitButton.textContent = me.submitted ? "비밀 기여 수정" : "비밀 기여 제출";

    if (!round) {
      renderMessage("입장 완료", "교사가 라운드를 시작하면 자원 10개를 받고 비밀 기여를 선택합니다.");
      return;
    }

    const contribution = Number(ui.contributionSlider.value);
    const kept = BASE_RESOURCES - contribution;
    const standardText = contribution >= round.harborStandard ? "기준 이상" : "기준 미달 위험";

    if (finalResult) {
      renderMessage(
        finalResult.title,
        finalResult.collapsed
          ? "도시가 함락되어 개인 점수 경쟁은 열리지 않습니다."
          : `최종 보너스 ${finalResult.finalBonus}점. 최종 우승은 ${escapeHtml(finalResult.winnerName || "-")}입니다.`,
      );
      return;
    }

    if (result) {
      const verdict = result.defenseSuccess ? "도시는 이번 폭풍을 버텼습니다." : "도시 피해가 늘었습니다.";
      ui.decisionReadout.innerHTML = `
        <div class="readout-row"><span>공동 기여 합계</span><strong>${result.totalContribution}</strong></div>
        <div class="readout-row"><span>실제 폭풍</span><strong>${result.actualStorm}</strong></div>
        <div class="readout-row"><span>기준 미달자 수</span><strong>${result.belowStandardCount}명</strong></div>
        <div class="readout-row"><span>판정</span><strong>${verdict}</strong></div>
      `;
      return;
    }

    ui.decisionReadout.innerHTML = `
      <div class="readout-row"><span>내 선택</span><strong>${contribution}개 기여</strong></div>
      <div class="readout-row"><span>내 창고로 남김</span><strong>${kept}개</strong></div>
      <div class="readout-row"><span>항구 기준</span><strong>${round.harborStandard}개</strong></div>
      <div class="readout-row"><span>위험 신호</span><strong>${standardText}</strong></div>
    `;
  }

  function renderMessage(title, body) {
    ui.decisionReadout.innerHTML = `
      <div class="result-banner">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(body)}</span>
      </div>
    `;
  }

  function renderVote(state, me) {
    if (!ui.voteBox) return;
    const vote = state.reinforcementVote;
    const active = state.phase === "reinforcement_vote" && Boolean(vote);
    ui.voteBox.hidden = !active;
    if (!active) return;

    const myVote = me.vote;
    ui.voteHint.textContent =
      `방어에 실패했습니다. 방파제 강화 ${vote.cost}개를 사용하면 이번 피해를 막습니다. ` +
      `남은 강화 ${vote.reinforcementAvailable}개 · ${vote.votedCount}/${vote.totalPlayers}명 투표 · 과반 찬성 시 사용합니다.`;
    ui.voteUseButton.classList.toggle("chosen", myVote === true);
    ui.voteSkipButton.classList.toggle("chosen", myVote === false);
    ui.voteUseButton.textContent = myVote === true ? "✓ 강화 사용" : "강화 사용 (피해 막기)";
    ui.voteSkipButton.textContent = myVote === false ? "✓ 사용 안 함" : "사용 안 함";
  }

  function renderPublicList(students, me, state) {
    const participantList = students.length
      ? students
          .map((student) => {
            const isMe = student.id === me.id;
            const status = state.round ? (student.submitted ? "제출 완료" : "대기") : "입장";
            return `
              <div class="public-row ${student.submitted ? "submitted" : ""}">
                <strong>${escapeHtml(student.name)}${isMe ? " (나)" : ""}</strong>
                <span>${status}</span>
              </div>
            `;
          })
          .join("")
      : `<div class="public-row"><strong>참가자 없음</strong><span>대기</span></div>`;

    const ownContribution = me.currentContribution === null ? "-" : `${me.currentContribution}개`;
    ui.housesList.innerHTML = `
      <article class="house-card player">
        <div class="house-top">
          <h3 class="house-name">내 기록</h3>
          <span class="crest teal">나</span>
        </div>
        <div class="house-stats">
          <div class="house-stat"><span>현재 자원</span><strong>${me.resources}</strong></div>
          <div class="house-stat"><span>이번 기여</span><strong>${ownContribution}</strong></div>
          <div class="house-stat"><span>창고 점수</span><strong>${me.storedResources}</strong></div>
          <div class="house-stat"><span>명예 점수</span><strong>${me.honorPoints}</strong></div>
          <div class="house-stat"><span>총점</span><strong>${me.score}</strong></div>
          <div class="house-stat"><span>누적 기여</span><strong>${me.totalContribution}</strong></div>
        </div>
      </article>
      <article class="house-card">
        <div class="house-top">
          <h3 class="house-name">공개 참가자 현황</h3>
          <span class="submit-badge">${state.submittedCount} / ${state.totalPlayers}</span>
        </div>
        <div class="public-list">${participantList}</div>
      </article>
    `;
  }

  function renderLog(state, result, finalResult) {
    const entries = [];
    if (finalResult) {
      entries.push(`
        <div class="log-entry ${finalResult.collapsed ? "warning" : "success"}">
          <strong>${escapeHtml(finalResult.title)}</strong>
          <span>${finalResult.collapsed ? "전원 공동 패배" : `최종 보너스 ${finalResult.finalBonus}점 · 우승 ${escapeHtml(finalResult.winnerName || "-")}`}</span>
        </div>
      `);
    }
    if (result) {
      const nearMiss = result.nearMissRecordName ? ` · 기록 대상 ${escapeHtml(result.nearMissRecordName)}` : "";
      entries.push(`
        <div class="log-entry ${result.defenseSuccess ? "success" : "warning"}">
          <strong>${result.roundNumber}라운드 ${result.defenseSuccess ? "방어 성공" : "방어 실패"}</strong>
          <span>총합 ${result.totalContribution} / 폭풍 ${result.actualStorm} · 기준 미달자 ${result.belowStandardCount}명${nearMiss}${reinforcementNote(result)}</span>
        </div>
      `);
    }

    state.group.roundHistory
      .slice()
      .reverse()
      .forEach((item) => {
        entries.push(`
          <div class="log-entry ${item.defenseSuccess ? "success" : "warning"}">
            <strong>${item.roundNumber}라운드 기록</strong>
            <span>총합 ${item.totalContribution} / 폭풍 ${item.actualStorm} · 기준 미달자 ${item.belowStandardCount}명${reinforcementNote(item)}</span>
          </div>
        `);
      });

    ui.logList.innerHTML = entries.join("") || `<div class="log-entry"><strong>기록 없음</strong><span>첫 판정 뒤 제한 공개 결과가 남습니다.</span></div>`;
  }

  function updateContributionHint(round) {
    if (!round) {
      ui.contributionHint.textContent = "라운드 시작을 기다리는 중입니다.";
      return;
    }

    const contribution = Number(ui.contributionSlider.value);
    if (contribution < round.harborStandard) {
      ui.contributionHint.textContent = "항구 기준보다 적습니다. 점수는 남지만 기준 미달자 수에 들어갈 수 있습니다.";
    } else if (contribution === round.harborStandard) {
      ui.contributionHint.textContent = "항구 기준에 맞춘 선택입니다. 정확한 기여량은 본인에게만 보입니다.";
    } else {
      ui.contributionHint.textContent = "기준보다 많이 냅니다. 방어와 명예 보상 가능성이 올라갑니다.";
    }
  }

  function reinforcementNote(item) {
    if (item.reinforcementUsed === true) return ` · 방파제 강화 ${item.reinforcementSpent || 2}개 사용, 피해 막음`;
    if (item.reinforcementUsed === false) return " · 강화 사용 부결, 피해 +1";
    if (item.recovered) return " · 긴급 회복으로 피해 -1";
    return "";
  }

  function setActiveStep(stepName) {
    document.querySelectorAll(".round-steps li").forEach((step) => {
      step.classList.toggle("active", step.dataset.step === stepName);
    });
  }

  function stepForPhase(phase) {
    if (phase === "storm_forecast" || phase === "lobby") return "storm";
    if (phase === "negotiation") return "council";
    if (phase === "secret_contribution") return "contribute";
    if (phase === "reinforcement_vote") return "resolve";
    if (phase === "round_result") return "resolve";
    if (phase === "final_result") return "score";
    return "storm";
  }

  function phaseHelp(message) {
    const messages = {
      "contribution-closed": "아직 비밀 기여 단계가 아니거나 이미 판정이 끝났습니다.",
      "vote-closed": "강화 사용 투표 단계가 아닙니다. 잠시 뒤 결과를 확인하세요.",
      "student-not-found": "학생 입장 정보가 없습니다. 시작 화면에서 다시 참여하세요.",
    };
    return messages[message] || "잠시 뒤 다시 시도하세요.";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  ui.contributionSlider.addEventListener("input", () => {
    userDirty = true;
    ui.contributionValue.textContent = ui.contributionSlider.value;
    updateContributionHint(room?.state?.round || null);
    if (room) renderDecision(room.state, room.state.round, room.state.result, room.state.finalResult, room.me);
  });
  ui.commitButton.addEventListener("click", () => submitContribution());
  if (ui.voteUseButton) ui.voteUseButton.addEventListener("click", () => submitVote(true));
  if (ui.voteSkipButton) ui.voteSkipButton.addEventListener("click", () => submitVote(false));

  refreshRoom();
  window.setInterval(refreshRoom, 1500);
})();
