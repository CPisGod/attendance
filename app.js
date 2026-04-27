// ============================================================
//  app.js — Firebase 기반 출석부 (순서변경 + 필터 기능 포함)
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import {
  getFirestore,
  doc, getDoc, setDoc, updateDoc,
  collection, getDocs, deleteDoc, onSnapshot, writeBatch,
  addDoc, query, orderBy
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
let isAdmin          = false;
let unsubscribeMembers = null;
let currentFilter    = "all";   // "all" | "present" | "absent"
let cachedMembers    = [];
let dragSrcId        = null;

// ── DOM ───────────────────────────────────────────────────
const userScreen         = document.getElementById("user-screen");
const adminScreen        = document.getElementById("admin-screen");
const userNameInput      = document.getElementById("user-name");
const userCodeInput      = document.getElementById("user-code");
const btnAttend          = document.getElementById("btn-attend");
const userMsg            = document.getElementById("user-msg");
const adminPasswordInput = document.getElementById("admin-password-input");
const btnAdminLogin      = document.getElementById("btn-admin-login");
const adminLoginMsg      = document.getElementById("admin-login-msg");
const btnLogout          = document.getElementById("btn-logout");
const currentCodeDisplay = document.getElementById("current-code-display");
const newCodeInput       = document.getElementById("new-code-input");
const btnSaveCode        = document.getElementById("btn-save-code");
const codeMsg            = document.getElementById("code-msg");
const newMemberInput     = document.getElementById("new-member-input");
const btnAddMember       = document.getElementById("btn-add-member");
const memberMsg          = document.getElementById("member-msg");
const memberList         = document.getElementById("member-list");
const statTotal          = document.getElementById("stat-total");
const statPresent        = document.getElementById("stat-present");
const statAbsent         = document.getElementById("stat-absent");
const btnResetAttendance = document.getElementById("btn-reset-attendance");
const filterTabs         = document.querySelectorAll(".filter-tab");
const dailyMessageBox    = document.getElementById("daily-message-box");
const dailyMessageText   = document.getElementById("daily-message-text");
const currentMsgDisplay  = document.getElementById("current-message-display");
const newMessageInput    = document.getElementById("new-message-input");
const btnSaveMessage     = document.getElementById("btn-save-message");
const btnClearMessage    = document.getElementById("btn-clear-message");
const messageMsg         = document.getElementById("message-msg");
const weeklyThead        = document.getElementById("weekly-thead");
const weeklyTbody        = document.getElementById("weekly-tbody");
const weekLabel          = document.getElementById("week-label");
const btnWeekPrev        = document.getElementById("btn-week-prev");
const btnWeekNext        = document.getElementById("btn-week-next");
const btnDownloadExcel   = document.getElementById("btn-download-excel");
const sessionBtns        = document.querySelectorAll(".session-btn");

// ── 초기 설정 ─────────────────────────────────────────────
async function ensureSettings() {
  try {
    const snap = await getDoc(SETTINGS_REF);
    if (!snap.exists()) {
      await setDoc(SETTINGS_REF, { adminPassword: "admin1234", attendanceCode: "출석", maxSessions: 1 });
    } else {
      // 기존 문서에 maxSessions 필드가 없으면 추가
      const data = snap.data();
      const patch = {};
      if (data.maxSessions === undefined) patch.maxSessions = 1;
      if (Object.keys(patch).length > 0) await updateDoc(SETTINGS_REF, patch);
    }
  } catch (err) { console.error("ensureSettings:", err); }
}
ensureSettings();

// ── 일반 사용자 화면 — 한마디 로드 ────────────────────────
loadDailyMessage();

async function loadDailyMessage() {
  try {
    const snap = await getDoc(SETTINGS_REF);
    if (snap.exists()) {
      const msg = snap.data().dailyMessage || "";
      if (msg.trim()) {
        dailyMessageText.textContent = msg;
        dailyMessageBox.classList.remove("hidden");
      } else {
        dailyMessageBox.classList.add("hidden");
      }
    }
  } catch (err) { console.error("loadDailyMessage:", err); }
}

// ============================================================
//  필터 탭
// ============================================================
filterTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    filterTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    currentFilter = tab.dataset.filter;
    renderMemberList(cachedMembers);
  });
});

// ============================================================
//  어드민 로그인
// ============================================================
btnAdminLogin.addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const pw = adminPasswordInput.value.trim();
  if (!pw) { showMsg(adminLoginMsg, "비밀번호를 입력해주세요.", "error"); return; }

  try {
    const snap = await getDoc(SETTINGS_REF);
    if (!snap.exists()) { showMsg(adminLoginMsg, "설정을 불러올 수 없습니다.", "error"); return; }
    if (snap.data().adminPassword === pw) {
      isAdmin = true;
      adminPasswordInput.value = "";
      switchToAdmin();
    } else {
      showMsg(adminLoginMsg, "비밀번호가 틀렸습니다.", "error");
      adminPasswordInput.value = "";
      adminPasswordInput.focus();
    }
  } catch (err) {
    console.error(err);
    showMsg(adminLoginMsg, "오류가 발생했습니다.", "error");
  }
});

adminPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); btnAdminLogin.click(); }
});

// ============================================================
//  일반 사용자 — 출석 (회차 지원)
// ============================================================
btnAttend.addEventListener("click", async () => {
  const name = userNameInput.value.trim();
  const code = userCodeInput.value.trim();
  if (!name || !code) { showMsg(userMsg, "이름과 암호를 모두 입력해주세요.", "error"); return; }

  try {
    const settingsSnap = await getDoc(SETTINGS_REF);
    if (!settingsSnap.exists()) { showMsg(userMsg, "설정을 불러올 수 없습니다.", "error"); return; }
    const { attendanceCode, maxSessions = 1 } = settingsSnap.data();
    if (code !== attendanceCode) { showMsg(userMsg, "암호가 틀렸습니다.", "error"); return; }

    const membersSnap = await getDocs(MEMBERS_COL);
    let found = false;
    for (const memberDoc of membersSnap.docs) {
      if (memberDoc.data().name === name) {
        const memberId = memberDoc.id;
        // 오늘 날짜 로그 조회
        const logsCol = collection(db, "members", memberId, "attendance_logs");
        const allLogs = await getDocs(logsCol);
        const todayKey = dateKey(new Date());
        const todayLogs = allLogs.docs.filter(d => d.data().date === todayKey);
        const todayCount = todayLogs.length;

        if (todayCount >= maxSessions) {
          const sessionLabel = maxSessions === 1 ? "1회" : `${maxSessions}회`;
          showMsg(userMsg, `오늘 출석 횟수(${sessionLabel})를 모두 완료했습니다.`, "info");
        } else {
          const sessionNum = todayCount + 1;
          await addDoc(logsCol, {
            date: todayKey,       // "YYYY-MM-DD"
            session: sessionNum   // 1 or 2
          });
          await updateDoc(doc(db, "members", memberId), {
            present: true,
            sessionCount: sessionNum
          });
          const sessionLabel = maxSessions > 1 ? ` (${sessionNum}/${maxSessions}회차)` : "";
          showMsg(userMsg, `✓ ${name} 님, 출석 완료!${sessionLabel}`, "success");
          userNameInput.value = "";
          userCodeInput.value = "";
        }
        found = true;
        break;
      }
    }
    if (!found) showMsg(userMsg, "등록된 이름이 아닙니다. 관리자에게 문의하세요.", "error");
  } catch (err) {
    console.error(err);
    showMsg(userMsg, "오류가 발생했습니다.", "error");
  }
});

userCodeInput.addEventListener("keydown", e => { if (e.key === "Enter") btnAttend.click(); });
userNameInput.addEventListener("keydown", e => { if (e.key === "Enter") userCodeInput.focus(); });

// ============================================================
//  화면 전환
// ============================================================
function switchToAdmin() {
  userScreen.classList.remove("active"); userScreen.classList.add("hidden");
  adminScreen.classList.remove("hidden"); adminScreen.classList.add("active");
  loadAdminData();
  startMembersListener();
  initWeeklyTable();
}

function switchToUser() {
  adminScreen.classList.remove("active"); adminScreen.classList.add("hidden");
  userScreen.classList.remove("hidden"); userScreen.classList.add("active");
  if (unsubscribeMembers) { unsubscribeMembers(); unsubscribeMembers = null; }
  isAdmin = false;
}

btnLogout.addEventListener("click", switchToUser);

// ============================================================
//  어드민 — 암호 로드
// ============================================================
async function loadAdminData() {
  try {
    const snap = await getDoc(SETTINGS_REF);
    if (snap.exists()) {
      currentCodeDisplay.textContent = snap.data().attendanceCode || "—";
      const msg = snap.data().dailyMessage || "";
      currentMsgDisplay.textContent = msg.trim() ? msg : "설정된 메시지 없음";
      newMessageInput.value = msg;
      // 회차 버튼 상태 반영
      const ms = snap.data().maxSessions || 1;
      sessionBtns.forEach(b => {
        b.classList.toggle("active", Number(b.dataset.session) === ms);
      });
    }
  } catch (err) { console.error(err); }
}

// 회차 버튼 클릭
sessionBtns.forEach(btn => {
  btn.addEventListener("click", async () => {
    const val = Number(btn.dataset.session);
    try {
      await updateDoc(SETTINGS_REF, { maxSessions: val });
      sessionBtns.forEach(b => b.classList.toggle("active", Number(b.dataset.session) === val));
    } catch (err) { console.error(err); }
  });
});

// ============================================================
//  어드민 — 암호 저장
// ============================================================
btnSaveCode.addEventListener("click", async () => {
  const newCode = newCodeInput.value.trim();
  if (!newCode) { showMsg(codeMsg, "새 암호를 입력해주세요.", "error"); return; }
  try {
    await updateDoc(SETTINGS_REF, { attendanceCode: newCode });
    currentCodeDisplay.textContent = newCode;
    newCodeInput.value = "";
    showMsg(codeMsg, "암호가 저장되었습니다.", "success");
  } catch (err) {
    console.error(err);
    showMsg(codeMsg, "저장 중 오류가 발생했습니다.", "error");
  }
});
newCodeInput.addEventListener("keydown", e => { if (e.key === "Enter") btnSaveCode.click(); });

// ============================================================
//  어드민 — 한마디 저장
// ============================================================
btnSaveMessage.addEventListener("click", async () => {
  const msg = newMessageInput.value.trim();
  try {
    await updateDoc(SETTINGS_REF, { dailyMessage: msg });
    currentMsgDisplay.textContent = msg || "설정된 메시지 없음";
    showMsg(messageMsg, "한마디가 저장되었습니다.", "success");
  } catch (err) {
    console.error(err);
    showMsg(messageMsg, "저장 중 오류가 발생했습니다.", "error");
  }
});

btnClearMessage.addEventListener("click", async () => {
  try {
    await updateDoc(SETTINGS_REF, { dailyMessage: "" });
    newMessageInput.value = "";
    currentMsgDisplay.textContent = "설정된 메시지 없음";
    showMsg(messageMsg, "한마디가 지워졌습니다.", "info");
  } catch (err) {
    console.error(err);
    showMsg(messageMsg, "오류가 발생했습니다.", "error");
  }
});

// ============================================================
//  어드민 — 인원 추가 (order 필드 포함)
// ============================================================
btnAddMember.addEventListener("click", async () => {
  const name = newMemberInput.value.trim();
  if (!name) { showMsg(memberMsg, "이름을 입력해주세요.", "error"); return; }

  try {
    const snap = await getDocs(MEMBERS_COL);
    const exists = snap.docs.some(d => d.data().name === name);
    if (exists) { showMsg(memberMsg, "이미 등록된 이름입니다.", "error"); return; }

    // order: 현재 최대값 + 1
    const maxOrder = snap.docs.reduce((m, d) => Math.max(m, d.data().order ?? 0), 0);
    await setDoc(doc(MEMBERS_COL), { name, present: false, order: maxOrder + 1 });
    newMemberInput.value = "";
    showMsg(memberMsg, `"${name}" 님이 추가되었습니다.`, "success");
  } catch (err) {
    console.error(err);
    showMsg(memberMsg, "오류가 발생했습니다.", "error");
  }
});
newMemberInput.addEventListener("keydown", e => { if (e.key === "Enter") btnAddMember.click(); });

// ============================================================
//  어드민 — 출석 초기화
// ============================================================
btnResetAttendance.addEventListener("click", async () => {
  if (!confirm("오늘 출석 데이터를 모두 초기화할까요?")) return;
  try {
    const snap = await getDocs(MEMBERS_COL);
    await Promise.all(snap.docs.map(d => updateDoc(doc(db, "members", d.id), { present: false })));
    showMsg(memberMsg, "출석이 초기화되었습니다.", "info");
  } catch (err) {
    console.error(err);
    showMsg(memberMsg, "오류가 발생했습니다.", "error");
  }
});

// ============================================================
//  어드민 — 오늘 출석 토글 (출석현황 뱃지 클릭)
// ============================================================
async function toggleTodayAttendance(memberId, isCurrentlyPresent) {
  const todayKey = dateKey(new Date());
  try {
    if (isCurrentlyPresent) {
      // 출석 → 미출석: present=false, 오늘 로그 삭제
      await updateDoc(doc(db, "members", memberId), { present: false, sessionCount: 0 });
      const logsCol = collection(db, "members", memberId, "attendance_logs");
      const snap = await getDocs(logsCol);
      const toDelete = snap.docs.filter(d => d.data().date === todayKey);
      await Promise.all(toDelete.map(d => deleteDoc(doc(db, "members", memberId, "attendance_logs", d.id))));
    } else {
      // 미출석 → 출석: 로그 1개 추가
      const logsCol = collection(db, "members", memberId, "attendance_logs");
      await addDoc(logsCol, { date: todayKey, session: 1 });
      await updateDoc(doc(db, "members", memberId), { present: true, sessionCount: 1 });
    }
    renderWeeklyTable();
  } catch (err) {
    console.error("toggleTodayAttendance:", err);
  }
}

// ============================================================
//  어드민 — 주간표 회차 토글
// ============================================================
async function toggleWeeklyDaySession(memberId, memberName, dk, currentCount, sessionNum, maxSessions) {
  try {
    const logsCol  = collection(db, "members", memberId, "attendance_logs");
    const snap     = await getDocs(logsCol);
    const todayKey = dateKey(new Date());

    // 해당 날짜 로그 (session 오름차순)
    const dayLogs = snap.docs
      .filter(d => d.data().date === dk)
      .sort((a, b) => (a.data().session || 1) - (b.data().session || 1));

    if (sessionNum <= currentCount) {
      // O → X: 해당 회차 로그 삭제 (마지막 것 제거)
      const toDelete = dayLogs[dayLogs.length - 1];
      if (toDelete) await deleteDoc(doc(db, "members", memberId, "attendance_logs", toDelete.id));
      if (dk === todayKey) {
        const newCount = dayLogs.length - 1;
        await updateDoc(doc(db, "members", memberId), {
          present: newCount > 0,
          sessionCount: newCount
        });
      }
    } else {
      // X → O: 로그 추가
      await addDoc(logsCol, { date: dk, session: dayLogs.length + 1 });
      if (dk === todayKey) {
        await updateDoc(doc(db, "members", memberId), {
          present: true,
          sessionCount: dayLogs.length + 1
        });
      }
    }
    renderWeeklyTable();
  } catch (err) {
    console.error("toggleWeeklyDaySession:", err);
  }
}

// ============================================================
//  엑셀 다운로드 (SheetJS CDN 없이 CSV로 대체 — 엑셀에서 열림)
// ============================================================
// 현재 주간표 보기용 다운로드 (⬇ 엑셀 버튼)
function downloadExcel() {
  const data = window._weeklyData;
  if (!data) return;
  const { days, DAY_KO, maxSessions, rows } = data;
  buildAndDownloadCSV(days, DAY_KO, maxSessions, rows, weekLabel.textContent.replace(/\s/g,"_"));
}
document.getElementById("btn-download-excel").addEventListener("click", downloadExcel);

// CSV 생성 공통 함수
function buildAndDownloadCSV(days, DAY_KO, maxSessions, rows, fileName) {
  const pad = n => String(n).padStart(2, "0");

  const dayHeaders = days.map((d, i) => {
    const base = `${DAY_KO[i]} ${pad(d.getMonth()+1)}/${pad(d.getDate())}`;
    if (maxSessions === 2) return [`${base} 1회`, `${base} 2회`];
    return [base];
  }).flat();

  const headers = ["이름", ...dayHeaders, "출석수"];

  const csvRows = rows.map(r => {
    const cells = days.map(d => {
      const count = r.dayCountMap.get(dateKey(d)) || 0;
      if (maxSessions === 2) return [`${count >= 1 ? "O" : "X"}`, `${count >= 2 ? "O" : "X"}`];
      return [`${count >= 1 ? "O" : "X"}`];
    }).flat();
    return [r.name, ...cells, `${r.totalSessions}/${r.maxTotal}`];
  });

  const allRows = [headers, ...csvRows];
  const csv  = "\uFEFF" + allRows.map(r => r.map(c => `"${c}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${fileName}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
async function deleteMember(id, name) {
  if (!confirm(`"${name}" 님을 목록에서 삭제할까요?`)) return;
  try {
    await deleteDoc(doc(db, "members", id));
  } catch (err) {
    console.error(err);
    showMsg(memberMsg, "삭제 중 오류가 발생했습니다.", "error");
  }
}

// ============================================================
//  어드민 — 순서 저장 (Firestore batch write)
// ============================================================
async function saveOrder(orderedMembers) {
  try {
    const batch = writeBatch(db);
    orderedMembers.forEach((m, i) => {
      batch.update(doc(db, "members", m.id), { order: i });
    });
    await batch.commit();
  } catch (err) {
    console.error("saveOrder error:", err);
  }
}

// ============================================================
//  어드민 — 실시간 리스너
// ============================================================
function startMembersListener() {
  if (unsubscribeMembers) unsubscribeMembers();
  unsubscribeMembers = onSnapshot(MEMBERS_COL, snapshot => {
    cachedMembers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderMemberList(cachedMembers);
    updateStats(cachedMembers);
    // 멤버 데이터가 들어오면 주간 테이블도 갱신
    renderWeeklyTable();
  }, err => console.error("Members listener:", err));
}

// ============================================================
//  렌더링 — 필터 + 순서 적용
// ============================================================
function renderMemberList(members) {
  if (members.length === 0) {
    memberList.innerHTML = `<div class="empty-state">등록된 인원이 없습니다.<br>위에서 이름을 추가해주세요.</div>`;
    return;
  }

  // order 기준 정렬 (없으면 이름순)
  const sorted = [...members].sort((a, b) => {
    const ao = a.order ?? 999, bo = b.order ?? 999;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name, "ko");
  });

  // 필터 적용
  const filtered = sorted.filter(m => {
    if (currentFilter === "present") return m.present;
    if (currentFilter === "absent")  return !m.present;
    return true;
  });

  if (filtered.length === 0) {
    const label = currentFilter === "present" ? "출석" : "미출석";
    memberList.innerHTML = `<div class="empty-state">${label}한 인원이 없습니다.</div>`;
    return;
  }

  memberList.innerHTML = filtered.map(m => `
    <div class="member-row ${m.present ? "present" : ""}"
         draggable="${currentFilter === "all"}"
         data-id="${m.id}">
      <div class="member-info">
        ${currentFilter === "all" ? `<span class="drag-handle" title="드래그로 순서 변경">⠿</span>` : ""}
        <div class="member-avatar">${m.name.charAt(0)}</div>
        <span class="member-name">${m.name}</span>
      </div>
      <div class="member-actions">
        <span class="member-badge ${m.present ? "present" : "absent"} badge-toggle"
              data-toggle-id="${m.id}"
              data-toggle-present="${m.present}"
              title="클릭하여 출석 상태 변경">${m.present ? "출석 ✓" : "미출석"}</span>
        <button class="btn-icon btn-info-icon" data-info-id="${m.id}" data-info-name="${m.name}" title="출석 기록">📋</button>
        <button class="btn-icon" data-delete="${m.id}" data-name="${m.name}" title="삭제">✕</button>
      </div>
    </div>
  `).join("");

  // 삭제 이벤트
  memberList.querySelectorAll("[data-delete]").forEach(btn => {
    btn.addEventListener("click", () => deleteMember(btn.dataset.delete, btn.dataset.name));
  });

  // 출석 토글 뱃지
  memberList.querySelectorAll(".badge-toggle").forEach(badge => {
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTodayAttendance(badge.dataset.toggleId, badge.dataset.togglePresent === "true");
    });
  });

  // 출석 기록 모달
  memberList.querySelectorAll("[data-info-id]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openAttendanceModal(btn.dataset.infoId, btn.dataset.infoName);
    });
  });

  // 드래그 앤 드롭 (전체 보기일 때만)
  if (currentFilter === "all") {
    attachDragEvents(sorted);
  }
}

// ============================================================
//  드래그 앤 드롭
// ============================================================
function attachDragEvents(sortedAll) {
  const rows = memberList.querySelectorAll(".member-row[draggable='true']");

  rows.forEach(row => {
    row.addEventListener("dragstart", e => {
      dragSrcId = row.dataset.id;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });

    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      memberList.querySelectorAll(".member-row").forEach(r => r.classList.remove("drag-over"));
    });

    row.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (row.dataset.id !== dragSrcId) {
        memberList.querySelectorAll(".member-row").forEach(r => r.classList.remove("drag-over"));
        row.classList.add("drag-over");
      }
    });

    row.addEventListener("dragleave", () => {
      row.classList.remove("drag-over");
    });

    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");
      if (!dragSrcId || row.dataset.id === dragSrcId) return;

      // 현재 DOM 순서에서 새 order 계산
      const allRows = [...memberList.querySelectorAll(".member-row")];
      const srcIdx  = allRows.findIndex(r => r.dataset.id === dragSrcId);
      const dstIdx  = allRows.findIndex(r => r.dataset.id === row.dataset.id);

      // sortedAll 기준으로 재정렬
      const reordered = [...sortedAll];
      const srcItem = reordered.find(m => m.id === dragSrcId);
      const srcPos  = reordered.indexOf(srcItem);
      const dstItem = reordered.find(m => m.id === row.dataset.id);
      const dstPos  = reordered.indexOf(dstItem);

      reordered.splice(srcPos, 1);
      reordered.splice(dstPos, 0, srcItem);

      // 로컬 즉시 반영
      cachedMembers = cachedMembers.map(m => {
        const idx = reordered.findIndex(r => r.id === m.id);
        return { ...m, order: idx };
      });
      renderMemberList(cachedMembers);

      // Firestore 저장
      await saveOrder(reordered);
      dragSrcId = null;
    });
  });
}

function updateStats(members) {
  const total   = members.length;
  const present = members.filter(m => m.present).length;
  statTotal.textContent   = total;
  statPresent.textContent = present;
  statAbsent.textContent  = total - present;
}

// ============================================================
//  날짜 포맷
// ============================================================
function formatDateTime(date) {
  const d = typeof date === "string" ? new Date(date) : date;
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ============================================================
//  출석 기록 모달
// ============================================================
async function openAttendanceModal(memberId, memberName) {
  // 모달 생성
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <div>
          <div class="modal-title">${memberName}</div>
          <div class="modal-sub">ID: <span class="modal-id">${memberId}</span></div>
        </div>
        <button class="btn-icon modal-close" title="닫기">✕</button>
      </div>
      <div class="modal-body">
        <div class="modal-loading">불러오는 중…</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("active"));

  // 닫기
  const close = () => {
    overlay.classList.remove("active");
    setTimeout(() => overlay.remove(), 220);
  };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  // 로그 불러오기
  try {
    const logsCol = collection(db, "members", memberId, "attendance_logs");
    const q = query(logsCol, orderBy("date", "desc"));
    const snap = await getDocs(q);

    const modalBody = overlay.querySelector(".modal-body");
    if (snap.empty) {
      modalBody.innerHTML = `<div class="empty-state">출석 기록이 없습니다.</div>`;
      return;
    }

    const rows = snap.docs.map((d, i) => {
      const data = d.data();
      const label = data.date + (data.session ? ` (${data.session}회차)` : "");
      return `
        <tr>
          <td class="log-num">${snap.docs.length - i}</td>
          <td class="log-date">${label}</td>
        </tr>`;
    }).join("");

    modalBody.innerHTML = `
      <table class="log-table">
        <thead>
          <tr>
            <th>#</th>
            <th>출석 일시</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  } catch (err) {
    console.error(err);
    overlay.querySelector(".modal-body").innerHTML = `<div class="empty-state" style="color:var(--danger)">불러오기 실패</div>`;
  }
}

// ============================================================
//  유틸
// ============================================================
function showMsg(el, text, type = "info") {
  el.textContent = text;
  el.className = `msg-box ${type}`;
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), 3500);
}

// ============================================================
//  주간 출석표
// ============================================================
let weekOffset = 0; // 0 = 이번주, -1 = 지난주, ...

function getWeekDays(offset = 0) {
  // 이번 주 월~목 날짜 배열 반환 (금요일 제외)
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  monday.setHours(0, 0, 0, 0);

  return Array.from({ length: 4 }, (_, i) => {  // 5→4 (월화수목)
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function dateKey(date) {
  // "YYYY-MM-DD"
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}

function initWeeklyTable() {
  weekOffset = 0;
  renderWeeklyTable();

  btnWeekPrev.onclick = () => { weekOffset--; renderWeeklyTable(); };
  btnWeekNext.onclick = () => { weekOffset++; renderWeeklyTable(); };

  // 날짜 범위 다운로드 초기화 (admin 진입 시점에 DOM이 존재)
  const excelDateFrom    = document.getElementById("excel-date-from");
  const excelDateTo      = document.getElementById("excel-date-to");
  const btnDownloadRange = document.getElementById("btn-download-range");

  // 기본값: 이번 주 월~목
  const weekDays = getWeekDays(0);
  excelDateFrom.value = dateKey(weekDays[0]);
  excelDateTo.value   = dateKey(weekDays[weekDays.length - 1]);

  // 이전에 붙은 리스너 제거 후 재등록 (중복 방지)
  const newBtn = btnDownloadRange.cloneNode(true);
  btnDownloadRange.parentNode.replaceChild(newBtn, btnDownloadRange);

  newBtn.addEventListener("click", async () => {
    const from = excelDateFrom.value;
    const to   = excelDateTo.value;
    if (!from || !to) { alert("시작일과 종료일을 모두 선택해주세요."); return; }
    if (from > to)    { alert("시작일이 종료일보다 늦을 수 없습니다."); return; }

    newBtn.textContent = "로딩 중…";
    newBtn.disabled = true;

    try {
      const DAY_KO_MAP = ["일","월","화","수","목","금","토"];
      const days = [];
      let cur = new Date(from + "T00:00:00");
      const end = new Date(to + "T00:00:00");
      while (cur <= end) {
        if (cur.getDay() !== 5 && cur.getDay() !== 0) {
          days.push(new Date(cur));
        }
        cur.setDate(cur.getDate() + 1);
      }

      if (days.length === 0) { alert("선택한 기간에 평일(월~목)이 없습니다."); return; }

      const DAY_KO = days.map(d => DAY_KO_MAP[d.getDay()]);

      let maxSessions = 1;
      const snap = await getDoc(SETTINGS_REF);
      if (snap.exists()) maxSessions = snap.data().maxSessions || 1;

      const sorted = [...cachedMembers].sort((a, b) => {
        const ao = a.order ?? 999, bo = b.order ?? 999;
        return ao !== bo ? ao - bo : a.name.localeCompare(b.name, "ko");
      });

      const rows = [];
      for (const m of sorted) {
        const logSnap = await getDocs(collection(db, "members", m.id, "attendance_logs"));
        const dayCountMap = new Map();
        logSnap.docs.forEach(d => {
          const dk = d.data().date;
          if (dk) dayCountMap.set(dk, (dayCountMap.get(dk) || 0) + 1);
        });
        let totalSessions = 0;
        days.forEach(d => { totalSessions += Math.min(dayCountMap.get(dateKey(d)) || 0, maxSessions); });
        rows.push({ name: m.name, dayCountMap, totalSessions, maxTotal: days.length * maxSessions });
      }

      buildAndDownloadCSV(days, DAY_KO, maxSessions, rows, `출석표_${from}_~_${to}`);
    } catch (err) {
      console.error(err);
      alert("다운로드 중 오류가 발생했습니다.");
    } finally {
      newBtn.textContent = "⬇ 다운로드";
      newBtn.disabled = false;
    }
  });
}

async function renderWeeklyTable() {
  const days = getWeekDays(weekOffset);
  const todayKey = dateKey(new Date());
  const DAY_KO = ["월", "화", "수", "목"];
  const pad = n => String(n).padStart(2, "0");

  // 설정에서 maxSessions 가져오기
  let maxSessions = 1;
  try {
    const snap = await getDoc(SETTINGS_REF);
    if (snap.exists()) maxSessions = snap.data().maxSessions || 1;
  } catch (e) {}

  const colSpan = 2 + days.length; // 이름 + 날짜5 + 출석수

  // 주간 레이블
  const s = days[0], e = days[4];
  weekLabel.textContent =
    `${s.getFullYear()}.${pad(s.getMonth()+1)}.${pad(s.getDate())} ~ ${pad(e.getMonth()+1)}.${pad(e.getDate())}`;

  // 헤더
  weeklyThead.innerHTML = `<tr>
    <th class="col-name">이름</th>
    ${days.map((d, i) => {
      const isToday = dateKey(d) === todayKey;
      return `<th class="${isToday ? "th-today" : ""}">
        ${DAY_KO[i]}<br>
        <span style="font-weight:400;font-size:0.7rem">${pad(d.getMonth()+1)}/${pad(d.getDate())}</span>
        ${maxSessions === 2 ? `<br><span style="font-size:0.65rem;color:var(--text-muted);font-weight:400">1회/2회</span>` : ""}
      </th>`;
    }).join("")}
    <th class="col-count">출석수</th>
  </tr>`;

  if (!cachedMembers || cachedMembers.length === 0) {
    weeklyTbody.innerHTML = `<tr><td colspan="${colSpan}" class="weekly-empty">등록된 인원이 없습니다.</td></tr>`;
    return;
  }

  weeklyTbody.innerHTML = `<tr><td colspan="${colSpan}" class="weekly-empty">불러오는 중…</td></tr>`;

  const sorted = [...cachedMembers].sort((a, b) => {
    const ao = a.order ?? 999, bo = b.order ?? 999;
    return ao !== bo ? ao - bo : a.name.localeCompare(b.name, "ko");
  });

  // 엑셀용 데이터 저장
  window._weeklyData = { days, DAY_KO, maxSessions, rows: [] };

  try {
    const memberLogs = [];
    for (const m of sorted) {
      try {
        const logsCol = collection(db, "members", m.id, "attendance_logs");
        const snap = await getDocs(logsCol);
        // 날짜별 로그 횟수 Map  { "YYYY-MM-DD": count }
        const dayCountMap = new Map();
        snap.docs.forEach(d => {
          const dk = d.data().date;
          if (dk) dayCountMap.set(dk, (dayCountMap.get(dk) || 0) + 1);
        });
        memberLogs.push({ ...m, dayCountMap });
      } catch (err) {
        console.error(`로그 로드 실패 (${m.name}):`, err);
        memberLogs.push({ ...m, dayCountMap: new Map() });
      }
    }

    weeklyTbody.innerHTML = memberLogs.map(m => {
      let totalSessions = 0;
      const cells = days.map(d => {
        const dk = dateKey(d);
        const isToday = dk === todayKey;
        const count = m.dayCountMap.get(dk) || 0;
        totalSessions += Math.min(count, maxSessions);

        let cellContent = "";
        if (maxSessions === 1) {
          const present = count >= 1;
          cellContent = `<span class="${present ? "att-o" : "att-x"} att-toggle"
            data-member-id="${m.id}" data-member-name="${m.name}"
            data-date-key="${dk}" data-present="${present}"
            title="클릭하여 출석 변경">${present ? "O" : "X"}</span>`;
        } else {
          // 2회차: 두 칸 나란히
          const s1 = count >= 1, s2 = count >= 2;
          cellContent = `
            <div style="display:flex;gap:3px;justify-content:center;">
              <span class="${s1 ? "att-o" : "att-x"} att-toggle att-session"
                data-member-id="${m.id}" data-member-name="${m.name}"
                data-date-key="${dk}" data-present="${s1}" data-session="1"
                data-count="${count}" data-max="${maxSessions}"
                title="1회차">${s1 ? "O" : "X"}</span>
              <span class="${s2 ? "att-o" : "att-x"} att-toggle att-session"
                data-member-id="${m.id}" data-member-name="${m.name}"
                data-date-key="${dk}" data-present="${s2}" data-session="2"
                data-count="${count}" data-max="${maxSessions}"
                title="2회차">${s2 ? "O" : "X"}</span>
            </div>`;
        }
        return `<td class="${isToday ? "col-today" : ""}">${cellContent}</td>`;
      }).join("");

      const maxTotal = days.length * maxSessions;
      window._weeklyData.rows.push({ name: m.name, days, dayCountMap: m.dayCountMap, totalSessions, maxTotal });

      return `<tr>
        <td class="col-name">${m.name}</td>
        ${cells}
        <td class="col-count">${totalSessions} / ${days.length * maxSessions}</td>
      </tr>`;
    }).join("");

    // O/X 토글 이벤트
    weeklyTbody.querySelectorAll(".att-toggle").forEach(el => {
      el.addEventListener("click", () => {
        const count   = Number(el.dataset.count ?? (el.dataset.present === "true" ? 1 : 0));
        const session = Number(el.dataset.session ?? 1);
        const max     = Number(el.dataset.max ?? maxSessions);
        toggleWeeklyDaySession(
          el.dataset.memberId, el.dataset.memberName,
          el.dataset.dateKey, count, session, max
        );
      });
    });

  } catch (err) {
    console.error("renderWeeklyTable 전체 오류:", err);
    weeklyTbody.innerHTML = `<tr><td colspan="${colSpan}" class="weekly-empty" style="color:var(--danger)">불러오기 실패: ${err.message}</td></tr>`;
  }
}
