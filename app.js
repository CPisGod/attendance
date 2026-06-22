// ================================================================
//  app.js
//  출석부 앱 — Firebase Firestore 연동
//
//  데이터 구조:
//    config/settings  { adminPassword, attendanceCode, dailyMessage }
//    members/{id}     { name, order, present, sessionCount, logs }
//      logs: { "YYYY-MM-DD": 출석횟수 }  ex) { "2026-04-21": 2 }
//
//  출석은 하루 2회 고정
// ================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, onSnapshot, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";


// ── Firebase 초기화 ──────────────────────────────────────────────
const db = getFirestore(initializeApp({
  apiKey:            "AIzaSyB54Bv5yCaZ3oPgVo-qan-cFKKGYRDCS4w",
  authDomain:        "attendance-4e1cb.firebaseapp.com",
  projectId:         "attendance-4e1cb",
  storageBucket:     "attendance-4e1cb.firebasestorage.app",
  messagingSenderId: "40068891400",
  appId:             "1:40068891400:web:1f38c607d73488d0a022bd",
}));

const SETTINGS_REF = doc(db, "config", "settings");
const MEMBERS_COL  = collection(db, "members");
const MAX_SESSIONS = 2; // 하루 최대 출석 횟수 (고정)


// ── 앱 상태 ──────────────────────────────────────────────────────
let cachedMembers = [];   // onSnapshot / getDocs 로 채워지는 멤버 목록
let currentFilter = "all";
let dragSrcId     = null;
let unsubMembers  = null; // onSnapshot 구독 해제용


// ── 유틸리티 ─────────────────────────────────────────────────────
const $    = id => document.getElementById(id);
const pad  = n  => String(n).padStart(2, "0");

function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function sortedMembers() {
  return [...cachedMembers].sort((a, b) => {
    const diff = (a.order ?? 999) - (b.order ?? 999);
    return diff !== 0 ? diff : a.name.localeCompare(b.name, "ko");
  });
}

function showMsg(el, text, type = "info") {
  el.textContent = text;
  el.className   = `msg-box ${type}`;
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), 3500);
}


// ================================================================
//  앱 부팅 — 페이지 로드 시 1회 실행
// ================================================================
(async function boot() {
  await ensureSettings();
  await Promise.all([loadDailyMessage(), loadMembersOnce()]);
})();

/** config/settings 문서가 없으면 기본값으로 생성 */
async function ensureSettings() {
  const snap = await getDoc(SETTINGS_REF);
  if (!snap.exists()) {
    await setDoc(SETTINGS_REF, { adminPassword: "admin1234", attendanceCode: "출석", dailyMessage: "" });
  }
}

/** 일반 사용자 화면용 — 멤버 목록 1회 조회 */
async function loadMembersOnce() {
  const snap    = await getDocs(MEMBERS_COL);
  cachedMembers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** 일반 사용자 화면 상단 "오늘의 한마디" 표시 */
async function loadDailyMessage() {
  const snap = await getDoc(SETTINGS_REF);
  const msg  = snap.data()?.dailyMessage || "";
  $("daily-message-text").textContent = msg;
  $("daily-message-box").classList.toggle("hidden", !msg.trim());
}


// ================================================================
//  일반 사용자 — 출석 체크
// ================================================================
$("btn-attend").addEventListener("click", handleAttend);
$("user-code").addEventListener("keydown",  e => e.key === "Enter" && $("btn-attend").click());
$("user-name").addEventListener("keydown",  e => e.key === "Enter" && $("user-code").focus());

async function handleAttend() {
  const name = $("user-name").value.trim();
  const code = $("user-code").value.trim();

  if (!name || !code) {
    return showMsg($("user-msg"), "이름과 암호를 모두 입력해주세요.", "error");
  }

  const settings = (await getDoc(SETTINGS_REF)).data();
  if (!settings)                          return showMsg($("user-msg"), "설정을 불러올 수 없습니다.", "error");
  if (code !== settings.attendanceCode)   return showMsg($("user-msg"), "암호가 틀렸습니다.", "error");

  const member = cachedMembers.find(m => m.name === name);
  if (!member) return showMsg($("user-msg"), "등록된 이름이 아닙니다. 관리자에게 문의하세요.", "error");

  // 현재 출석 상태가 true면 차단 (초기화 후에만 재출석 가능)
  if (member.present) {
    return showMsg($("user-msg"), "이미 출석 처리되었습니다. 관리자에게 문의하세요.", "info");
  }

  const today      = dateKey();
  const logs       = member.logs || {};
  const todayEntry = logs[today];
  const todayCount = typeof todayEntry === "object" ? (todayEntry?.count || 0) : (todayEntry || 0);

  if (todayCount >= MAX_SESSIONS) {
    return showMsg($("user-msg"), `오늘 출석(${MAX_SESSIONS}회)을 모두 완료했습니다.`, "info");
  }

  const newCount = todayCount + 1;
  await updateDoc(doc(db, "members", member.id), {
    present:      true,
    sessionCount: newCount,
    logs:         { ...logs, [today]: { count: newCount, label: null } },
  });

  showMsg($("user-msg"), `✓ ${name} 님, 출석 완료! (${newCount}/${MAX_SESSIONS}회차)`, "success");
  $("user-name").value = "";
  $("user-code").value = "";
}


// ================================================================
//  어드민 — 로그인 / 로그아웃
// ================================================================
$("btn-admin-login").addEventListener("click",  handleAdminLogin);
$("admin-password-input").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); $("btn-admin-login").click(); }
});
$("btn-logout").addEventListener("click", handleLogout);

async function handleAdminLogin(e) {
  e.preventDefault();
  e.stopPropagation();

  const pw   = $("admin-password-input").value.trim();
  const snap = await getDoc(SETTINGS_REF);

  if (snap.data()?.adminPassword === pw) {
    $("admin-password-input").value = "";
    enterAdminMode();
  } else {
    $("admin-password-input").value = "";
    showMsg($("admin-login-msg"), "비밀번호가 틀렸습니다.", "error");
  }
}

function enterAdminMode() {
  $("user-screen").classList.replace("active", "hidden");
  $("admin-screen").classList.remove("hidden");
  $("admin-screen").classList.add("active");
  loadAdminSettings();
  startMembersListener();
  initDownloadPanel();
}

function handleLogout() {
  $("admin-screen").classList.replace("active", "hidden");
  $("user-screen").classList.remove("hidden");
  $("user-screen").classList.add("active");
  if (unsubMembers) { unsubMembers(); unsubMembers = null; }
}


// ================================================================
//  어드민 — 설정 패널 (암호, 한마디)
// ================================================================
async function loadAdminSettings() {
  const data = (await getDoc(SETTINGS_REF)).data() || {};
  $("current-code-display").textContent = data.attendanceCode || "—";
  const msg = data.dailyMessage || "";
  $("current-message-display").textContent = msg || "설정된 메시지 없음";
  $("new-message-input").value             = msg;
}

// 출석 암호 저장
$("btn-save-code").addEventListener("click", async () => {
  const code = $("new-code-input").value.trim();
  if (!code) return showMsg($("code-msg"), "새 암호를 입력해주세요.", "error");
  await updateDoc(SETTINGS_REF, { attendanceCode: code });
  $("current-code-display").textContent = code;
  $("new-code-input").value             = "";
  showMsg($("code-msg"), "저장되었습니다.", "success");
});
$("new-code-input").addEventListener("keydown", e => e.key === "Enter" && $("btn-save-code").click());

// 한마디 저장 / 지우기
$("btn-save-message").addEventListener("click", async () => {
  const msg = $("new-message-input").value.trim();
  await updateDoc(SETTINGS_REF, { dailyMessage: msg });
  $("current-message-display").textContent = msg || "설정된 메시지 없음";
  showMsg($("message-msg"), "저장되었습니다.", "success");
});
$("btn-clear-message").addEventListener("click", async () => {
  await updateDoc(SETTINGS_REF, { dailyMessage: "" });
  $("new-message-input").value             = "";
  $("current-message-display").textContent = "설정된 메시지 없음";
  showMsg($("message-msg"), "지워졌습니다.", "info");
});


// ================================================================
//  어드민 — 인원 관리
// ================================================================

// 멤버 추가
$("btn-add-member").addEventListener("click", async () => {
  const name = $("new-member-input").value.trim();
  if (!name)                                    return showMsg($("member-msg"), "이름을 입력해주세요.", "error");
  if (cachedMembers.some(m => m.name === name)) return showMsg($("member-msg"), "이미 등록된 이름입니다.", "error");

  const nextOrder = cachedMembers.reduce((max, m) => Math.max(max, m.order ?? 0), 0) + 1;
  await setDoc(doc(MEMBERS_COL), { name, order: nextOrder, present: false, sessionCount: 0, logs: {} });
  $("new-member-input").value = "";
  showMsg($("member-msg"), `"${name}" 님이 추가되었습니다.`, "success");
});
$("new-member-input").addEventListener("keydown", e => e.key === "Enter" && $("btn-add-member").click());

// 멤버 삭제
async function deleteMember(id, name) {
  if (!confirm(`"${name}" 님을 삭제할까요?`)) return;
  await deleteDoc(doc(db, "members", id));
}

// 오늘 출석 전체 초기화
$("btn-reset-attendance").addEventListener("click", async () => {
  if (!confirm("오늘 출석을 모두 초기화할까요?")) return;
  const today = dateKey();
  const batch = writeBatch(db);
  cachedMembers.forEach(m => {
    const logs = { ...(m.logs || {}) };
    delete logs[today];
    batch.update(doc(db, "members", m.id), { present: false, sessionCount: 0, logs });
  });
  await batch.commit();
  showMsg($("member-msg"), "출석이 초기화되었습니다.", "info");
});

// 기존 문서 마이그레이션 (logs 필드 없는 경우 추가)
$("btn-migrate").addEventListener("click", async () => {
  if (!confirm("기존 멤버 문서에 logs 필드를 추가합니다. 진행할까요?")) return;
  const snap  = await getDocs(MEMBERS_COL);
  const batch = writeBatch(db);
  let   count = 0;

  snap.docs.forEach(d => {
    const patch = {};
    if (d.data().logs         === undefined) patch.logs         = {};
    if (d.data().sessionCount === undefined) patch.sessionCount = 0;
    if (Object.keys(patch).length) { batch.update(doc(db, "members", d.id), patch); count++; }
  });

  if (!count) return showMsg($("member-msg"), "이미 모두 최신 형식입니다.", "info");
  await batch.commit();
  showMsg($("member-msg"), `${count}명 마이그레이션 완료!`, "success");
});


// ================================================================
//  어드민 — 출석 현황 (실시간 리스너)
// ================================================================
function startMembersListener() {
  if (unsubMembers) unsubMembers();
  unsubMembers = onSnapshot(MEMBERS_COL, snap => {
    cachedMembers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderMemberList();
    renderStats();
  });
}

// 필터 탭
document.querySelectorAll(".filter-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".filter-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    currentFilter = tab.dataset.filter;
    renderMemberList();
  });
});

function renderMemberList() {
  const list = sortedMembers().filter(m => {
    if (currentFilter === "present") return  m.present;
    if (currentFilter === "absent")  return !m.present;
    return true;
  });

  if (!list.length) {
    const label = currentFilter === "present" ? "출석" : currentFilter === "absent" ? "미출석" : "";
    $("member-list").innerHTML = `<div class="empty-state">${label ? label + "한 인원이 없습니다." : "등록된 인원이 없습니다."}</div>`;
    return;
  }

  $("member-list").innerHTML = list.map(m => {
    const todayLog   = (m.logs || {})[dateKey()];
    const customLabel = todayLog?.label || null;
    const isPresent  = m.present;

    // 뱃지 상태: 출석 / 개인사정(커스텀) / 미출석
    const badgeClass = isPresent ? (customLabel ? "custom" : "present") : "absent";
    const badgeText  = isPresent ? (customLabel || "출석 ✓") : "미출석";

    return `
    <div class="member-row ${isPresent ? "present" : ""} ${customLabel ? "custom-state" : ""}"
         draggable="${currentFilter === "all"}" data-id="${m.id}">
      <div class="member-info">
        ${currentFilter === "all" ? `<span class="drag-handle">⠿</span>` : ""}
        <div class="member-avatar">${m.name.charAt(0)}</div>
        <span class="member-name">${m.name}</span>
      </div>
      <div class="member-actions">
        <span class="member-badge ${badgeClass} badge-toggle"
              data-id="${m.id}" data-present="${isPresent}"
              title="꾹 눌러 커스텀 상태 설정">${badgeText}</span>
        <button class="btn-icon" data-info-id="${m.id}" data-info-name="${m.name}" title="출석 기록">📋</button>
        <button class="btn-icon" data-delete="${m.id}" data-name="${m.name}" title="삭제">✕</button>
      </div>
    </div>`;
  }).join("");

  // 삭제
  $("member-list").querySelectorAll("[data-delete]").forEach(b =>
    b.addEventListener("click", () => deleteMember(b.dataset.delete, b.dataset.name)));

  // 출석 기록 모달
  $("member-list").querySelectorAll("[data-info-id]").forEach(b =>
    b.addEventListener("click", e => { e.stopPropagation(); openLogModal(b.dataset.infoId, b.dataset.infoName); }));

  // 뱃지 클릭 / 꾹 누르기
  $("member-list").querySelectorAll(".badge-toggle").forEach(b => {
    let pressTimer = null;

    // 꾹 누르기 → 커스텀 라벨 입력
    const startPress = () => {
      pressTimer = setTimeout(() => {
        pressTimer = null;
        openCustomLabelModal(b.dataset.id);
      }, 600);
    };
    const cancelPress = () => clearTimeout(pressTimer);

    b.addEventListener("mousedown",  startPress);
    b.addEventListener("touchstart", startPress, { passive: true });
    b.addEventListener("mouseup",    cancelPress);
    b.addEventListener("mouseleave", cancelPress);
    b.addEventListener("touchend",   cancelPress);

    // 짧게 클릭 → 출석 토글
    b.addEventListener("click", e => {
      e.stopPropagation();
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        toggleTodayAttendance(b.dataset.id, b.dataset.present === "true");
      }
    });
  });

  if (currentFilter === "all") attachDragEvents(list);
}

function renderStats() {
  const present = cachedMembers.filter(m => m.present).length;
  $("stat-total").textContent   = cachedMembers.length;
  $("stat-present").textContent = present;
  $("stat-absent").textContent  = cachedMembers.length - present;
}


// ================================================================
//  어드민 — 출석 토글 / 커스텀 라벨
// ================================================================
async function toggleTodayAttendance(memberId, isPresent) {
  const member = cachedMembers.find(m => m.id === memberId);
  if (!member) return;

  const today = dateKey();
  const logs  = { ...(member.logs || {}) };

  if (isPresent) {
    // 출석 → 미출석 (오늘 로그 삭제)
    delete logs[today];
    await updateDoc(doc(db, "members", memberId), { present: false, sessionCount: 0, logs });
  } else {
    // 미출석 → 출석
    const prev  = logs[today] || {};
    const count = (typeof prev === "object" ? prev.count : prev) || 0;
    logs[today] = { count: count + 1, label: null };
    await updateDoc(doc(db, "members", memberId), { present: true, sessionCount: count + 1, logs });
  }
}

/** 꾹 누르면 커스텀 라벨 입력 모달 */
function openCustomLabelModal(memberId) {
  const member    = cachedMembers.find(m => m.id === memberId);
  if (!member) return;

  const today    = dateKey();
  const todayLog = (member.logs || {})[today];
  const current  = todayLog?.label || "";

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-card" style="max-width:320px">
      <div class="modal-header">
        <div class="modal-title">${member.name} — 오늘 상태</div>
        <button class="btn-icon modal-close">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:10px;padding-top:4px">
        <p style="font-size:0.85rem;color:var(--text-sub)">빈칸으로 저장하면 일반 출석으로 표시됩니다.</p>
        <input type="text" id="custom-label-input" placeholder="예) 개인사정, 공결, 병결"
               value="${current}" maxlength="10"
               style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:0.95rem;background:var(--bg3);color:var(--text);outline:none" />
        <div style="display:flex;gap:8px">
          <button id="custom-label-save" class="btn btn-primary" style="flex:1">저장</button>
          <button id="custom-label-clear" class="btn btn-ghost btn-sm">초기화</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("active"));

  const close = () => { overlay.classList.remove("active"); setTimeout(() => overlay.remove(), 220); };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  // 저장 — 라벨만 바꾸고 present/count는 유지
  overlay.querySelector("#custom-label-save").addEventListener("click", async () => {
    const label = overlay.querySelector("#custom-label-input").value.trim();
    const logs  = { ...(member.logs || {}) };
    const prev  = logs[today] || {};
    const count = typeof prev === "object" ? (prev.count || 1) : (prev || 1);
    logs[today] = { count, label: label || null };
    // present는 그대로 유지
    await updateDoc(doc(db, "members", memberId), { logs });
    close();
  });

  // 초기화 — 라벨 제거
  overlay.querySelector("#custom-label-clear").addEventListener("click", async () => {
    const logs = { ...(member.logs || {}) };
    const prev = logs[today] || {};
    const count = typeof prev === "object" ? (prev.count || 1) : (prev || 1);
    logs[today] = { count, label: null };
    await updateDoc(doc(db, "members", memberId), { logs });
    close();
  });

  setTimeout(() => overlay.querySelector("#custom-label-input").focus(), 100);
}


// ================================================================
//  어드민 — 출석 기록 모달
// ================================================================
function openLogModal(memberId, memberName) {
  const logs    = cachedMembers.find(m => m.id === memberId)?.logs || {};
  const entries = Object.entries(logs).sort((a, b) => b[0].localeCompare(a[0]));

  const getCount = v => typeof v === "object" ? (v?.count || 0) : (v || 0);
  const getLabel = v => typeof v === "object" ? (v?.label || null) : null;

  const tableHTML = entries.length
    ? `<table class="log-table">
        <thead><tr><th>#</th><th>날짜</th><th>횟수</th><th>상태</th></tr></thead>
        <tbody>${entries.map(([date, val], i) => `
          <tr>
            <td class="log-num">${entries.length - i}</td>
            <td class="log-date">${date}</td>
            <td class="log-num">${getCount(val)}회</td>
            <td class="log-num">${getLabel(val) || "—"}</td>
          </tr>`).join("")}
        </tbody>
      </table>`
    : `<div class="empty-state">출석 기록이 없습니다.</div>`;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <div>
          <div class="modal-title">${memberName}</div>
          <div class="modal-sub">ID: <span class="modal-id">${memberId}</span></div>
        </div>
        <button class="btn-icon modal-close">✕</button>
      </div>
      <div class="modal-body">${tableHTML}</div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("active"));

  const close = () => { overlay.classList.remove("active"); setTimeout(() => overlay.remove(), 220); };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
}


// ================================================================
//  어드민 — 드래그 앤 드롭 순서 변경
// ================================================================
function attachDragEvents(orderedList) {
  const rows = $("member-list").querySelectorAll(".member-row[draggable='true']");

  rows.forEach(row => {
    row.addEventListener("dragstart", e => {
      dragSrcId = row.dataset.id;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });

    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      rows.forEach(r => r.classList.remove("drag-over"));
    });

    row.addEventListener("dragover", e => {
      e.preventDefault();
      if (row.dataset.id !== dragSrcId) {
        rows.forEach(r => r.classList.remove("drag-over"));
        row.classList.add("drag-over");
      }
    });

    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));

    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");
      if (!dragSrcId || row.dataset.id === dragSrcId) return;

      const list = [...orderedList];
      const from = list.findIndex(m => m.id === dragSrcId);
      const to   = list.findIndex(m => m.id === row.dataset.id);
      list.splice(to, 0, list.splice(from, 1)[0]);

      const batch = writeBatch(db);
      list.forEach((m, i) => batch.update(doc(db, "members", m.id), { order: i }));
      await batch.commit();
      dragSrcId = null;
    });
  });
}


// ================================================================
//  어드민 — 출석 데이터 CSV 다운로드
// ================================================================
function initDownloadPanel() {
  const fromEl = $("excel-date-from");
  const toEl   = $("excel-date-to");
  const dlBtn  = $("btn-download-range");
  const dlMsg  = $("download-msg");

  // 기본값: 이번 주 월~목
  const now = new Date();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
  const thu = new Date(mon);
  thu.setDate(mon.getDate() + 3);
  fromEl.value = dateKey(mon);
  toEl.value   = dateKey(thu);

  dlBtn.addEventListener("click", () => downloadCSV(fromEl.value, toEl.value, dlBtn, dlMsg));
}

async function downloadCSV(from, to, btn, msgEl) {
  if (!from || !to || from > to) return showMsg(msgEl, "날짜 범위를 확인해주세요.", "error");

  btn.textContent = "로딩 중…";
  btn.disabled    = true;

  // 월~목 날짜만 수집
  const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
  const days = [], dayNames = [];
  for (let d = new Date(from + "T00:00:00"); d <= new Date(to + "T00:00:00"); d.setDate(d.getDate() + 1)) {
    if (d.getDay() >= 1 && d.getDay() <= 4) {
      days.push(new Date(d));
      dayNames.push(DAY_NAMES[d.getDay()]);
    }
  }

  if (!days.length) {
    btn.textContent = "⬇ 엑셀 다운로드";
    btn.disabled    = false;
    return showMsg(msgEl, "선택 기간에 월~목이 없습니다.", "error");
  }

  // 헤더
  const headers = [
    "이름",
    ...days.flatMap((d, i) => [`${dayNames[i]} ${pad(d.getMonth()+1)}/${pad(d.getDate())} 1회`, `${dayNames[i]} ${pad(d.getMonth()+1)}/${pad(d.getDate())} 2회`]),
    "출석수",
  ];

  // 데이터 행
  const csvRows = sortedMembers().map(m => {
    const logs  = m.logs || {};
    let   total = 0;
    const cells = days.flatMap(d => {
      const entry = logs[dateKey(d)];
      const count = typeof entry === "object" ? (entry?.count || 0) : (entry || 0);
      const label = typeof entry === "object" ? (entry?.label || null) : null;
      total += Math.min(count, MAX_SESSIONS);
      // O/X 대신 커스텀 라벨이 있으면 해당 텍스트로
      const cell1 = count >= 1 ? (label || "O") : "X";
      const cell2 = count >= 2 ? (label || "O") : "X";
      return [cell1, cell2];
    });
    return [m.name, ...cells, `${total}/${days.length * MAX_SESSIONS}`];
  });

  // CSV 파일 생성 및 다운로드
  const csv  = "\uFEFF" + [headers, ...csvRows].map(row => row.map(c => `"${c}"`).join(",")).join("\n");
  const link = Object.assign(document.createElement("a"), {
    href:     URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" })),
    download: `출석표_${from}_~_${to}.csv`,
  });
  link.click();

  showMsg(msgEl, "다운로드 완료!", "success");
  btn.textContent = "⬇ 엑셀 다운로드";
  btn.disabled    = false;
}
