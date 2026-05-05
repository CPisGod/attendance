// ============================================================
//  app.js — 최적화 버전
//  logs 서브컬렉션 제거 → members 문서 안 logs 필드로 통합
//  { logs: { "2026-04-21": 2, "2026-04-22": 1 } }
//  읽기 횟수: 멤버 목록 1회 조회로 모든 출석 데이터 포함
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import {
  getFirestore,
  doc, getDoc, setDoc, updateDoc,
  collection, getDocs, onSnapshot, writeBatch, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB54Bv5yCaZ3oPgVo-qan-cFKKGYRDCS4w",
  authDomain: "attendance-4e1cb.firebaseapp.com",
  projectId: "attendance-4e1cb",
  storageBucket: "attendance-4e1cb.firebasestorage.app",
  messagingSenderId: "40068891400",
  appId: "1:40068891400:web:1f38c607d73488d0a022bd",
  measurementId: "G-JC1EK3V7N5"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

const SETTINGS_REF = doc(db, "config", "settings");
const MEMBERS_COL  = collection(db, "members");

// ── 상태 ──────────────────────────────────────────────────
let isAdmin            = false;
let unsubMembers       = null;
let currentFilter      = "all";
let cachedMembers      = [];
let dragSrcId          = null;

// ── 유틸 ──────────────────────────────────────────────────
const pad = n => String(n).padStart(2, "0");
function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}

function showMsg(el, text, type = "info") {
  el.textContent = text;
  el.className = `msg-box ${type}`;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

function sortedMembers() {
  return [...cachedMembers].sort((a, b) => {
    const ao = a.order ?? 999, bo = b.order ?? 999;
    return ao !== bo ? ao - bo : a.name.localeCompare(b.name, "ko");
  });
}

// ── DOM ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const userScreen         = $("user-screen");
const adminScreen        = $("admin-screen");
const userNameInput      = $("user-name");
const userCodeInput      = $("user-code");
const btnAttend          = $("btn-attend");
const userMsg            = $("user-msg");
const adminPasswordInput = $("admin-password-input");
const btnAdminLogin      = $("btn-admin-login");
const adminLoginMsg      = $("admin-login-msg");
const btnLogout          = $("btn-logout");
const currentCodeDisplay = $("current-code-display");
const newCodeInput       = $("new-code-input");
const btnSaveCode        = $("btn-save-code");
const codeMsg            = $("code-msg");
const newMemberInput     = $("new-member-input");
const btnAddMember       = $("btn-add-member");
const memberMsg          = $("member-msg");
const memberList         = $("member-list");
const statTotal          = $("stat-total");
const statPresent        = $("stat-present");
const statAbsent         = $("stat-absent");
const btnResetAtt        = $("btn-reset-attendance");
const filterTabs         = document.querySelectorAll(".filter-tab");
const dailyMessageBox    = $("daily-message-box");
const dailyMessageText   = $("daily-message-text");
const currentMsgDisplay  = $("current-message-display");
const newMessageInput    = $("new-message-input");
const btnSaveMessage     = $("btn-save-message");
const btnClearMessage    = $("btn-clear-message");
const messageMsg         = $("message-msg");
const sessionBtns        = document.querySelectorAll(".session-btn");

// ============================================================
//  초기 설정
// ============================================================
async function ensureSettings() {
  try {
    const snap = await getDoc(SETTINGS_REF);
    if (!snap.exists()) {
      await setDoc(SETTINGS_REF, { adminPassword: "admin1234", attendanceCode: "출석", maxSessions: 2 });
    } else {
      const data = snap.data();
      const patch = {};
      if (data.maxSessions === undefined) patch.maxSessions = 2;
      if (Object.keys(patch).length) await updateDoc(SETTINGS_REF, patch);
    }
  } catch (e) { console.error(e); }
}
ensureSettings();
loadDailyMessage();
loadMembersForUser();

async function loadMembersForUser() {
  try {
    const snap = await getDocs(MEMBERS_COL);
    cachedMembers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { console.error("loadMembersForUser:", e); }
}

async function loadDailyMessage() {
  try {
    const snap = await getDoc(SETTINGS_REF);
    if (snap.exists()) {
      const msg = snap.data().dailyMessage || "";
      dailyMessageText.textContent = msg;
      dailyMessageBox.classList.toggle("hidden", !msg.trim());
    }
  } catch (e) { console.error(e); }
}

// ============================================================
//  어드민 로그인
// ============================================================
btnAdminLogin.addEventListener("click", async e => {
  e.preventDefault(); e.stopPropagation();
  const pw = adminPasswordInput.value.trim();
  if (!pw) return;
  try {
    const snap = await getDoc(SETTINGS_REF);
    if (snap.data()?.adminPassword === pw) {
      isAdmin = true;
      adminPasswordInput.value = "";
      switchToAdmin();
    } else {
      showMsg(adminLoginMsg, "비밀번호가 틀렸습니다.", "error");
      adminPasswordInput.value = "";
    }
  } catch (e) { showMsg(adminLoginMsg, "오류가 발생했습니다.", "error"); }
});
adminPasswordInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); btnAdminLogin.click(); }
});

// ============================================================
//  일반 사용자 — 출석 (logs 필드에 직접 카운트 저장)
// ============================================================
btnAttend.addEventListener("click", async () => {
  const name = userNameInput.value.trim();
  const code = userCodeInput.value.trim();
  if (!name || !code) { showMsg(userMsg, "이름과 암호를 모두 입력해주세요.", "error"); return; }

  try {
    const settings = (await getDoc(SETTINGS_REF)).data();
    if (!settings) { showMsg(userMsg, "설정을 불러올 수 없습니다.", "error"); return; }
    if (code !== settings.attendanceCode) { showMsg(userMsg, "암호가 틀렸습니다.", "error"); return; }

    const maxSessions = settings.maxSessions ?? 2;
    const todayKey    = dateKey(new Date());

    // cachedMembers에서 이름 찾기 (읽기 절약)
    const member = cachedMembers.find(m => m.name === name);
    if (!member) { showMsg(userMsg, "등록된 이름이 아닙니다. 관리자에게 문의하세요.", "error"); return; }

    const logs      = member.logs || {};
    const todayCount = logs[todayKey] || 0;

    if (todayCount >= maxSessions) {
      showMsg(userMsg, `오늘 출석 횟수(${maxSessions}회)를 모두 완료했습니다.`, "info");
      return;
    }

    const newCount   = todayCount + 1;
    const newLogs    = { ...logs, [todayKey]: newCount };
    await updateDoc(doc(db, "members", member.id), {
      present: true,
      sessionCount: newCount,
      logs: newLogs
    });

    const label = maxSessions > 1 ? ` (${newCount}/${maxSessions}회차)` : "";
    showMsg(userMsg, `✓ ${name} 님, 출석 완료!${label}`, "success");
    userNameInput.value = "";
    userCodeInput.value = "";
  } catch (e) {
    console.error(e);
    showMsg(userMsg, "오류가 발생했습니다.", "error");
  }
});
userCodeInput.addEventListener("keydown", e => { if (e.key === "Enter") btnAttend.click(); });
userNameInput.addEventListener("keydown", e => { if (e.key === "Enter") userCodeInput.focus(); });

// ============================================================
//  화면 전환
// ============================================================
function switchToAdmin() {
  userScreen.classList.replace("active", "hidden") || (userScreen.classList.remove("active"), userScreen.classList.add("hidden"));
  adminScreen.classList.remove("hidden"); adminScreen.classList.add("active");
  loadAdminData();
  startMembersListener();
  initDownload();
}
function switchToUser() {
  adminScreen.classList.remove("active"); adminScreen.classList.add("hidden");
  userScreen.classList.remove("hidden"); userScreen.classList.add("active");
  if (unsubMembers) { unsubMembers(); unsubMembers = null; }
  isAdmin = false;
}
btnLogout.addEventListener("click", switchToUser);

// ============================================================
//  어드민 데이터 로드
// ============================================================
async function loadAdminData() {
  try {
    const data = (await getDoc(SETTINGS_REF)).data() || {};
    currentCodeDisplay.textContent = data.attendanceCode || "—";
    const msg = data.dailyMessage || "";
    currentMsgDisplay.textContent = msg || "설정된 메시지 없음";
    newMessageInput.value = msg;
    const ms = data.maxSessions ?? 2;
    sessionBtns.forEach(b => b.classList.toggle("active", Number(b.dataset.session) === ms));
  } catch (e) { console.error(e); }
}

// 암호 저장
btnSaveCode.addEventListener("click", async () => {
  const v = newCodeInput.value.trim();
  if (!v) { showMsg(codeMsg, "새 암호를 입력해주세요.", "error"); return; }
  await updateDoc(SETTINGS_REF, { attendanceCode: v });
  currentCodeDisplay.textContent = v;
  newCodeInput.value = "";
  showMsg(codeMsg, "저장되었습니다.", "success");
});
newCodeInput.addEventListener("keydown", e => { if (e.key === "Enter") btnSaveCode.click(); });

// 한마디 저장/삭제
btnSaveMessage.addEventListener("click", async () => {
  const msg = newMessageInput.value.trim();
  await updateDoc(SETTINGS_REF, { dailyMessage: msg });
  currentMsgDisplay.textContent = msg || "설정된 메시지 없음";
  showMsg(messageMsg, "저장되었습니다.", "success");
});
btnClearMessage.addEventListener("click", async () => {
  await updateDoc(SETTINGS_REF, { dailyMessage: "" });
  newMessageInput.value = "";
  currentMsgDisplay.textContent = "설정된 메시지 없음";
  showMsg(messageMsg, "지워졌습니다.", "info");
});

// 회차 버튼
sessionBtns.forEach(btn => {
  btn.addEventListener("click", async () => {
    const val = Number(btn.dataset.session);
    await updateDoc(SETTINGS_REF, { maxSessions: val });
    sessionBtns.forEach(b => b.classList.toggle("active", Number(b.dataset.session) === val));
  });
});

// ============================================================
//  어드민 — 인원 추가/삭제
// ============================================================
btnAddMember.addEventListener("click", async () => {
  const name = newMemberInput.value.trim();
  if (!name) { showMsg(memberMsg, "이름을 입력해주세요.", "error"); return; }
  if (cachedMembers.some(m => m.name === name)) { showMsg(memberMsg, "이미 등록된 이름입니다.", "error"); return; }
  const maxOrder = cachedMembers.reduce((m, d) => Math.max(m, d.order ?? 0), 0);
  await setDoc(doc(MEMBERS_COL), { name, present: false, order: maxOrder + 1, logs: {}, sessionCount: 0 });
  newMemberInput.value = "";
  showMsg(memberMsg, `"${name}" 님이 추가되었습니다.`, "success");
});
newMemberInput.addEventListener("keydown", e => { if (e.key === "Enter") btnAddMember.click(); });

async function deleteMember(id, name) {
  if (!confirm(`"${name}" 님을 삭제할까요?`)) return;
  await deleteDoc(doc(db, "members", id));
}

// 기존 문서 마이그레이션 (logs 필드 없는 멤버에 logs:{} 추가)
$("btn-migrate").addEventListener("click", async () => {
  if (!confirm("기존 멤버 문서에 logs 필드를 추가합니다. 진행할까요?")) return;
  try {
    const snap = await getDocs(MEMBERS_COL);
    const batch = writeBatch(db);
    let count = 0;
    snap.docs.forEach(d => {
      const data = d.data();
      const patch = {};
      if (data.logs === undefined)         patch.logs         = {};
      if (data.sessionCount === undefined) patch.sessionCount = 0;
      if (Object.keys(patch).length) { batch.update(doc(db, "members", d.id), patch); count++; }
    });
    if (count === 0) { showMsg(memberMsg, "이미 모두 최신 형식입니다.", "info"); return; }
    await batch.commit();
    showMsg(memberMsg, `${count}명 마이그레이션 완료!`, "success");
  } catch (e) {
    console.error(e);
    showMsg(memberMsg, "오류가 발생했습니다.", "error");
  }
});

// 출석 초기화 (오늘 날짜만 logs에서 제거)
btnResetAtt.addEventListener("click", async () => {
  if (!confirm("오늘 출석을 모두 초기화할까요?")) return;
  const todayKey = dateKey(new Date());
  const batch = writeBatch(db);
  cachedMembers.forEach(m => {
    const logs = { ...(m.logs || {}) };
    delete logs[todayKey];
    batch.update(doc(db, "members", m.id), { present: false, sessionCount: 0, logs });
  });
  await batch.commit();
  showMsg(memberMsg, "출석이 초기화되었습니다.", "info");
});

// ============================================================
//  실시간 멤버 리스너 — onSnapshot 1개로 모든 데이터 수신
// ============================================================
function startMembersListener() {
  if (unsubMembers) unsubMembers();
  unsubMembers = onSnapshot(MEMBERS_COL, snap => {
    cachedMembers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderMemberList(cachedMembers);
    updateStats(cachedMembers);
  }, e => console.error(e));
}

// ============================================================
//  출석 현황 렌더링
// ============================================================
filterTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    filterTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    currentFilter = tab.dataset.filter;
    renderMemberList(cachedMembers);
  });
});

function renderMemberList(members) {
  const sorted   = sortedMembers();
  const filtered = sorted.filter(m =>
    currentFilter === "present" ? m.present :
    currentFilter === "absent"  ? !m.present : true
  );

  if (filtered.length === 0) {
    memberList.innerHTML = `<div class="empty-state">${currentFilter === "all" ? "등록된 인원이 없습니다." : (currentFilter === "present" ? "출석" : "미출석") + "한 인원이 없습니다."}</div>`;
    return;
  }

  memberList.innerHTML = filtered.map(m => `
    <div class="member-row ${m.present ? "present" : ""}" draggable="${currentFilter === "all"}" data-id="${m.id}">
      <div class="member-info">
        ${currentFilter === "all" ? `<span class="drag-handle" title="드래그로 순서 변경">⠿</span>` : ""}
        <div class="member-avatar">${m.name.charAt(0)}</div>
        <span class="member-name">${m.name}</span>
      </div>
      <div class="member-actions">
        <span class="member-badge ${m.present ? "present" : "absent"} badge-toggle"
              data-id="${m.id}" data-present="${m.present}"
              title="클릭하여 출석 상태 변경">${m.present ? "출석 ✓" : "미출석"}</span>
        <button class="btn-icon btn-info-icon" data-info-id="${m.id}" data-info-name="${m.name}" title="출석 기록">📋</button>
        <button class="btn-icon" data-delete="${m.id}" data-name="${m.name}" title="삭제">✕</button>
      </div>
    </div>`).join("");

  memberList.querySelectorAll("[data-delete]").forEach(b =>
    b.addEventListener("click", () => deleteMember(b.dataset.delete, b.dataset.name)));

  memberList.querySelectorAll(".badge-toggle").forEach(b =>
    b.addEventListener("click", e => { e.stopPropagation(); toggleToday(b.dataset.id, b.dataset.present === "true"); }));

  memberList.querySelectorAll("[data-info-id]").forEach(b =>
    b.addEventListener("click", e => { e.stopPropagation(); openLogModal(b.dataset.infoId, b.dataset.infoName); }));

  if (currentFilter === "all") attachDragEvents(sorted);
}

function updateStats(members) {
  statTotal.textContent   = members.length;
  statPresent.textContent = members.filter(m => m.present).length;
  statAbsent.textContent  = members.filter(m => !m.present).length;
}

// ============================================================
//  오늘 출석 토글 (뱃지 클릭)
// ============================================================
async function toggleToday(memberId, isPresent) {
  const todayKey = dateKey(new Date());
  const member   = cachedMembers.find(m => m.id === memberId);
  if (!member) return;
  const logs = { ...(member.logs || {}) };

  if (isPresent) {
    delete logs[todayKey];
    await updateDoc(doc(db, "members", memberId), { present: false, sessionCount: 0, logs });
  } else {
    logs[todayKey] = 1;
    await updateDoc(doc(db, "members", memberId), { present: true, sessionCount: 1, logs });
  }
}

// ============================================================
//  출석 기록 모달 (logs 필드에서 직접 읽기 — 추가 읽기 0회)
// ============================================================
function openLogModal(memberId, memberName) {
  const member = cachedMembers.find(m => m.id === memberId);
  const logs   = member?.logs || {};
  const entries = Object.entries(logs).sort((a, b) => b[0].localeCompare(a[0]));

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
      <div class="modal-body">
        ${entries.length === 0
          ? `<div class="empty-state">출석 기록이 없습니다.</div>`
          : `<table class="log-table">
              <thead><tr><th>#</th><th>날짜</th><th>횟수</th></tr></thead>
              <tbody>${entries.map(([dk, cnt], i) => `
                <tr>
                  <td class="log-num">${entries.length - i}</td>
                  <td class="log-date">${dk}</td>
                  <td class="log-num">${cnt}회</td>
                </tr>`).join("")}
              </tbody>
            </table>`}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("active"));

  const close = () => { overlay.classList.remove("active"); setTimeout(() => overlay.remove(), 220); };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
}

// ============================================================
//  드래그 앤 드롭
// ============================================================
function attachDragEvents(sortedAll) {
  const rows = memberList.querySelectorAll(".member-row[draggable='true']");
  rows.forEach(row => {
    row.addEventListener("dragstart", e => { dragSrcId = row.dataset.id; row.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    row.addEventListener("dragend",   () => { row.classList.remove("dragging"); memberList.querySelectorAll(".member-row").forEach(r => r.classList.remove("drag-over")); });
    row.addEventListener("dragover",  e => { e.preventDefault(); if (row.dataset.id !== dragSrcId) { memberList.querySelectorAll(".member-row").forEach(r => r.classList.remove("drag-over")); row.classList.add("drag-over"); } });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async e => {
      e.preventDefault(); row.classList.remove("drag-over");
      if (!dragSrcId || row.dataset.id === dragSrcId) return;
      const reordered = [...sortedAll];
      const si = reordered.findIndex(m => m.id === dragSrcId);
      const di = reordered.findIndex(m => m.id === row.dataset.id);
      reordered.splice(di, 0, reordered.splice(si, 1)[0]);
      const batch = writeBatch(db);
      reordered.forEach((m, i) => batch.update(doc(db, "members", m.id), { order: i }));
      await batch.commit();
      dragSrcId = null;
    });
  });
}

// ============================================================
//  주간 출석표 — logs 필드에서 직접 읽기 (추가 읽기 0회)
// ============================================================
// ============================================================
//  출석 데이터 다운로드
// ============================================================
function initDownload() {
  const fromEl = $("excel-date-from");
  const toEl   = $("excel-date-to");
  const dlBtn  = $("btn-download-range");
  const dlMsg  = $("download-msg");

  // 기본값: 이번 주 월~목
  const DAY_MAP = ["일","월","화","수","목","금","토"];
  const now = new Date();
  const day = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const thu = new Date(mon); thu.setDate(mon.getDate() + 3);
  fromEl.value = dateKey(mon);
  toEl.value   = dateKey(thu);

  dlBtn.addEventListener("click", async () => {
    const from = fromEl.value, to = toEl.value;
    if (!from || !to || from > to) { showMsg(dlMsg, "날짜 범위를 확인해주세요.", "error"); return; }

    dlBtn.textContent = "로딩 중…"; dlBtn.disabled = true;
    try {
      // 월~목만 (금·토·일 제외)
      const days = [], DAY_KO = [];
      let cur = new Date(from + "T00:00:00");
      const end = new Date(to + "T00:00:00");
      while (cur <= end) {
        const d = cur.getDay();
        if (d >= 1 && d <= 4) { days.push(new Date(cur)); DAY_KO.push(DAY_MAP[d]); }
        cur.setDate(cur.getDate() + 1);
      }
      if (!days.length) { showMsg(dlMsg, "선택 기간에 월~목이 없습니다.", "error"); return; }

      // settings 읽기 1회
      const ms = (await getDoc(SETTINGS_REF)).data()?.maxSessions ?? 2;

      // cachedMembers에서 logs 바로 사용 — 추가 읽기 없음
      const rows = sortedMembers().map(m => {
        const logs = m.logs || {};
        let total  = 0;
        days.forEach(d => { total += Math.min(logs[dateKey(d)] || 0, ms); });
        return { name: m.name, logs, total, maxTotal: days.length * ms };
      });

      buildCSV(days, DAY_KO, ms, rows, `출석표_${from}_~_${to}`);
      showMsg(dlMsg, "다운로드 완료!", "success");
    } catch (e) {
      console.error(e);
      showMsg(dlMsg, "오류가 발생했습니다.", "error");
    } finally {
      dlBtn.textContent = "⬇ 엑셀 다운로드";
      dlBtn.disabled = false;
    }
  });
}

function buildCSV(days, DAY_KO, ms, rows, fileName) {
  const dayHeaders = days.map((d, i) => {
    const base = `${DAY_KO[i]} ${pad(d.getMonth()+1)}/${pad(d.getDate())}`;
    return ms === 2 ? [`${base} 1회`, `${base} 2회`] : [base];
  }).flat();

  const headers = ["이름", ...dayHeaders, "출석수"];
  const csvRows = rows.map(r => {
    const cells = days.map(d => {
      const c = r.logs[dateKey(d)] || 0;
      return ms === 2 ? [`${c>=1?"O":"X"}`, `${c>=2?"O":"X"}`] : [`${c>=1?"O":"X"}`];
    }).flat();
    return [r.name, ...cells, `${r.total}/${r.maxTotal}`];
  });

  const csv = "\uFEFF" + [headers, ...csvRows].map(r => r.map(c => `"${c}"`).join(",")).join("\n");
  const a   = Object.assign(document.createElement("a"), {
    href:     URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" })),
    download: `${fileName}.csv`
  });
  a.click();
}
