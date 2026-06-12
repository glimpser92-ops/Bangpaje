(function () {
  "use strict";

  const createRoomButton = document.querySelector("#createRoomButton");
  const joinRoomForm = document.querySelector("#joinRoomForm");
  const roomCodeInput = document.querySelector("#roomCodeInput");
  const studentNameInput = document.querySelector("#studentNameInput");
  const lobbyStatus = document.querySelector("#lobbyStatus");
  const demoPrevButton = document.querySelector("#demoPrevButton");
  const demoNextButton = document.querySelector("#demoNextButton");
  const demoResetButton = document.querySelector("#demoResetButton");
  const demoStepLabel = document.querySelector("#demoStepLabel");
  const demoPhase = document.querySelector("#demoPhase");
  const demoVisibleStorm = document.querySelector("#demoVisibleStorm");
  const demoHiddenStorm = document.querySelector("#demoHiddenStorm");
  const demoStormTotal = document.querySelector("#demoStormTotal");
  const demoPublicTotal = document.querySelector("#demoPublicTotal");
  const demoPublicMeter = document.querySelector("#demoPublicMeter");
  const demoFamilyGrid = document.querySelector("#demoFamilyGrid");
  const demoResult = document.querySelector("#demoResult");
  const demoStepDots = document.querySelector("#demoStepDots");
  const demoGuideList = document.querySelector("#demoGuideList");
  const initialRoomCode = new URLSearchParams(window.location.search).get("room")?.toUpperCase() || "";
  const demoFamilies = ["A", "B", "C", "D", "E"];
  const guideSteps = [
    {
      title: "방 열기와 참여",
      text: "교사는 방을 열고 학생은 코드와 이름으로 들어옵니다.",
    },
    {
      title: "자원 받기",
      text: "매달 각 가문은 자원 10개를 받고 도시와 창고 사이에서 나눕니다.",
    },
    {
      title: "폭풍 예보",
      text: "공개 폭풍은 보이지만 숨은 파고는 범위만 알 수 있습니다.",
    },
    {
      title: "짧은 협상",
      text: "모둠은 1~2분 동안 말로 계획을 맞추지만 약속은 강제되지 않습니다.",
    },
    {
      title: "익명 투입",
      text: "각자 몰래 제출하고, 개인 기여량이 아니라 합계와 기준 미달자 수만 공개됩니다.",
    },
    {
      title: "판정",
      text: "합계가 폭풍보다 낮으면 도시 피해가 1칸 오르고, 3칸이면 모두 실패합니다.",
    },
    {
      title: "도움꾼 칭찬",
      text: "방어에 성공하면 기준 이상 기여자 중 한 명이 명예 보상을 받습니다.",
    },
    {
      title: "6라운드 후 토론",
      text: "도시가 살아남았는지, 누가 높은 점수인지, 왜 그렇게 선택했는지 이야기합니다.",
    },
  ];
  const demoStates = [
    {
      phase: "선생님이 방을 열고, 학생들은 코드로 자기 모둠 도시에 들어옵니다.",
      visible: "-",
      hidden: "-",
      stormTotal: "-",
      publicTotal: 0,
      publicTarget: 36,
      contributions: [0, 0, 0, 0, 0],
      resultTitle: "수업 준비",
      resultText: "교사 화면은 폭풍과 시간을 진행하고, 학생 화면은 모둠 선택을 기록합니다.",
      tone: "neutral",
    },
    {
      phase: "한 달이 시작되면 모든 가문이 자원 10개를 받습니다.",
      visible: "-",
      hidden: "-",
      stormTotal: "-",
      publicTotal: 0,
      publicTarget: 36,
      contributions: [0, 0, 0, 0, 0],
      resultTitle: "자원 지급",
      resultText: "자원을 많이 내면 도시가 안전해지고, 적게 내면 자기 창고 점수가 커집니다.",
      tone: "neutral",
    },
    {
      phase: "폭풍 예보가 나옵니다. 공개 폭풍은 보이지만 숨은 파고는 아직 모릅니다.",
      visible: "+20",
      hidden: "+?",
      stormTotal: "?",
      publicTotal: 0,
      publicTarget: 36,
      contributions: [0, 0, 0, 0, 0],
      resultTitle: "불확실한 위협",
      resultText: "안전하게 많이 낼지, 조금 아끼고 버틸지 계산해야 합니다.",
      tone: "neutral",
    },
    {
      phase: "모둠은 짧게 협상합니다. 말은 할 수 있지만 선택은 익명입니다.",
      visible: "+20",
      hidden: "+?",
      stormTotal: "?",
      publicTotal: 0,
      publicTarget: 36,
      contributions: [null, null, null, null, null],
      resultTitle: "약속과 선택",
      resultText: "서로 믿고 충분히 낼 수도 있고, 남이 낼 거라 기대하며 아낄 수도 있습니다.",
      tone: "neutral",
    },
    {
      phase: "모두 동시에 몰래 제출합니다. 개인 기여량 대신 합계와 제출 여부만 확인합니다.",
      visible: "+20",
      hidden: "+?",
      stormTotal: "?",
      publicTotal: 34,
      publicTarget: 36,
      contributions: [8, 7, 7, 6, 6],
      resultTitle: "비밀 제출 완료",
      resultText: "남긴 자원은 점수가 되지만, 정확히 누가 얼마나 냈는지는 공개되지 않습니다.",
      tone: "neutral",
    },
    {
      phase: "숨은 폭풍 +16이 공개되어 이번 달 필요 합계가 36이 됩니다.",
      visible: "+20",
      hidden: "+16",
      stormTotal: "36",
      publicTotal: 34,
      publicTarget: 36,
      contributions: [8, 7, 7, 6, 6],
      resultTitle: "2개 부족",
      resultText: "도시 피해가 1칸 오르고, 기준 미달자 수만 공개됩니다.",
      tone: "warning",
    },
    {
      phase: "다음 달에는 조금 더 내서 합계 37로 폭풍을 막아냅니다.",
      visible: "+20",
      hidden: "+16",
      stormTotal: "36",
      publicTotal: 37,
      publicTarget: 36,
      contributions: [9, 8, 7, 7, 6],
      resultTitle: "도시 생존",
      resultText: "기준 이상 기여자 중 한 명만 명예 보상을 받고, 다른 기여량은 숨깁니다.",
      tone: "success",
      helpers: [0],
    },
    {
      phase: "6라운드가 끝나면 살아남은 도시와 점수를 확인하고 토론합니다.",
      visible: "종료",
      hidden: "토론",
      stormTotal: "6월",
      publicTotal: 37,
      publicTarget: 36,
      contributions: [9, 8, 7, 7, 6],
      resultTitle: "디브리핑",
      resultText: "왜 더 내거나 덜 냈는지, 공공재와 무임승차 문제로 연결해 봅니다.",
      tone: "success",
      helpers: [0],
    },
  ];
  let demoIndex = 0;

  function setStatus(message) {
    lobbyStatus.textContent = message;
  }

  function renderGuide(activeIndex) {
    demoGuideList.innerHTML = guideSteps
      .map((step, index) => {
        const stateClass = index === activeIndex ? "active" : index < activeIndex ? "done" : "";
        return `
          <li class="${stateClass}">
            <strong>${index + 1}. ${step.title}</strong>
            <span>${step.text}</span>
          </li>
        `;
      })
      .join("");
  }

  function renderDemo(index) {
    const state = demoStates[index];
    const target = state.publicTarget;
    const fill = target ? Math.min(100, Math.round((state.publicTotal / target) * 100)) : 0;

    demoPhase.textContent = state.phase;
    demoStepLabel.textContent = `${index + 1} / ${demoStates.length}`;
    demoVisibleStorm.textContent = state.visible;
    demoHiddenStorm.textContent = state.hidden;
    demoStormTotal.textContent = state.stormTotal;
    demoPublicTotal.textContent = `${state.publicTotal} / ${state.stormTotal}`;
    demoPublicMeter.style.width = `${fill}%`;
    demoResult.className = `demo-result ${state.tone}`;
    demoResult.innerHTML = `<strong>${state.resultTitle}</strong><span>${state.resultText}</span>`;

    demoFamilyGrid.innerHTML = state.contributions
      .map((amount, familyIndex) => {
        const stored = amount === null ? "?" : 10 - amount;
        const isHelper = state.helpers?.includes(familyIndex);
        const contributionText = amount === null ? "선택 전" : "제출 완료";
        const fillHeight = amount === null ? 0 : amount * 10;
        return `
          <div class="demo-family ${isHelper ? "helper" : ""}">
            <strong>가문 ${demoFamilies[familyIndex]}</strong>
            <div class="demo-family-bar" style="--demo-fill: ${fillHeight}%">
              <span></span>
            </div>
            <span>${contributionText} · 창고 ${stored}</span>
          </div>
        `;
      })
      .join("");

    demoStepDots.innerHTML = demoStates
      .map((_, stepIndex) => `<span class="${stepIndex === index ? "active" : ""}"></span>`)
      .join("");

    renderGuide(index);
    demoPrevButton.disabled = index === 0;
    demoNextButton.textContent = index === demoStates.length - 1 ? "처음으로" : "다음";
  }

  function resetDemo() {
    demoIndex = 0;
    renderDemo(demoIndex);
  }

  function goToPreviousDemoStep() {
    demoIndex = Math.max(0, demoIndex - 1);
    renderDemo(demoIndex);
  }

  function goToNextDemoStep() {
    demoIndex = demoIndex === demoStates.length - 1 ? 0 : demoIndex + 1;
    renderDemo(demoIndex);
  }

  async function createRoom() {
    setStatus("방을 여는 중입니다...");
    try {
      const response = await fetch("./api/rooms", { method: "POST" });
      if (!response.ok) throw new Error("room-create-failed");
      const room = await response.json();
      window.location.href = room.teacherUrl;
    } catch (_error) {
      setStatus("방 기능 서버가 꺼져 있어 교사 화면만 엽니다. 공유 방은 server.js로 실행해야 합니다.");
      window.location.href = "./teacher.html";
    }
  }

  async function joinRoom(event) {
    event.preventDefault();
    const code = roomCodeInput.value.trim().toUpperCase();
    const name = studentNameInput.value.trim();

    if (!code) {
      setStatus("방 코드를 입력하세요.");
      roomCodeInput.focus();
      return;
    }

    setStatus("방에 참여하는 중입니다...");
    try {
      const response = await fetch(`./api/rooms/${encodeURIComponent(code)}/students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error("room-join-failed");
      const room = await response.json();
      window.location.href = room.studentUrl;
    } catch (_error) {
      setStatus("방 코드를 찾을 수 없습니다. 선생님 화면의 참여 코드를 확인하세요.");
    }
  }

  createRoomButton.addEventListener("click", createRoom);
  joinRoomForm.addEventListener("submit", joinRoom);
  demoPrevButton.addEventListener("click", goToPreviousDemoStep);
  demoNextButton.addEventListener("click", goToNextDemoStep);
  demoResetButton.addEventListener("click", resetDemo);
  renderDemo(demoIndex);

  if (initialRoomCode) {
    roomCodeInput.value = initialRoomCode;
    setStatus(`방 ${initialRoomCode}에 참여할 이름이나 모둠명을 입력하세요.`);
    studentNameInput.focus();
  }
})();
