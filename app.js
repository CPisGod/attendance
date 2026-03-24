// ============================================================
//  app.js — Firebase 기반 출석부 (순서변경 + 필터 기능 포함)
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import {
  getFirestore,
  doc, getDoc, setDoc, updateDoc,
  collection, getDocs, deleteDoc, onSnapshot, writeBatch
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

// ── 초기 설정 ─────────────────────────────────────────────
async function ensureSettings() {
  try {
    const snap = await getDoc(SETTINGS_REF);
    if (!snap.exists()) {
      await setDoc(SETTINGS_REF, { adminPassword: "admin1234", attendanceCode: "출석" });
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
//  일반 사용자 — 출석
// ============================================================
btnAttend.addEventListener("click", async () => {
  const name = userNameInput.value.trim();
  const code = userCodeInput.value.trim();
  if (!name || !code) { showMsg(userMsg, "이름과 암호를 모두 입력해주세요.", "error"); return; }

  try {
    const settingsSnap = await getDoc(SETTINGS_REF);
    if (!settingsSnap.exists()) { showMsg(userMsg, "설정을 불러올 수 없습니다.", "error"); return; }
    const { attendanceCode } = settingsSnap.data();
    if (code !== attendanceCode) { showMsg(userMsg, "암호가 틀렸습니다.", "error"); return; }

    const membersSnap = await getDocs(MEMBERS_COL);
    let found = false;
    for (const memberDoc of membersSnap.docs) {
      if (memberDoc.data().name === name) {
        if (memberDoc.data().present) {
          showMsg(userMsg, `${name} 님은 이미 출석 처리되었습니다.`, "info");
        } else {
          await updateDoc(doc(db, "members", memberDoc.id), { present: true });
          showMsg(userMsg, `✓ ${name} 님, 출석이 완료되었습니다!`, "success");
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
    }
  } catch (err) { console.error(err); }
}

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
//  어드민 — 인원 삭제
// ============================================================
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
        <span class="member-badge ${m.present ? "present" : "absent"}">${m.present ? "출석" : "미출석"}</span>
        <button class="btn-icon" data-delete="${m.id}" data-name="${m.name}" title="삭제">✕</button>
      </div>
    </div>
  `).join("");

  // 삭제 이벤트
  memberList.querySelectorAll("[data-delete]").forEach(btn => {
    btn.addEventListener("click", () => deleteMember(btn.dataset.delete, btn.dataset.name));
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
//  유틸
// ============================================================
function showMsg(el, text, type = "info") {
  el.textContent = text;
  el.className = `msg-box ${type}`;
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), 3500);
}
