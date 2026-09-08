let RESET_DELAY = 3000;
let resetTimer = null;
let todayEntries = 0;
let isOffline = false;
let localStudents = null;

const urlParams = new URLSearchParams(window.location.search);
const GATE_MODE = urlParams.get('mode') === 'exit' ? 'exit' : 'entry';
const GATE_ID = urlParams.get('gate') || 'main';

// --- SERVICE WORKER ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// --- OFFLINE SYNC ---
async function syncStudents() {
  try {
    const res = await fetch('/api/sync');
    const data = await res.json();
    localStorage.setItem('lgu_students', JSON.stringify(data.students));
    localStorage.setItem('lgu_sync_time', data.synced_at);
    localStudents = data.students;
    setOnlineStatus(true);
  } catch (e) {
    const cached = localStorage.getItem('lgu_students');
    if (cached) localStudents = JSON.parse(cached);
    setOnlineStatus(false);
  }
}

function setOnlineStatus(online) {
  isOffline = !online;
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  if (!dot || !label) return;
  if (online) {
    dot.className = 'status-dot';
    label.textContent = 'System Online';
    label.style.color = 'var(--green)';
  } else {
    dot.className = 'status-dot offline';
    label.textContent = 'OFFLINE MODE';
    label.style.color = 'var(--orange)';
  }
}

function offlineScan(uid) {
  if (!localStudents) {
    return { found: false, result: 'unknown', message: 'OFFLINE — NO CACHED DATA' };
  }
  const student = localStudents.find(s =>
    s.card_uid.toUpperCase() === uid || s.roll_number.toUpperCase() === uid
  );
  if (!student) {
    return { found: false, result: 'unknown', message: 'UNREGISTERED CARD' };
  }
  const currentYear = new Date().getFullYear();
  const isExpired = student.expiry_year && currentYear > student.expiry_year;
  if (isExpired) {
    return { found: true, result: 'denied', message: `CARD EXPIRED — ENTRY DENIED`, student };
  }
  if (student.status === 'suspended' && student.suspended_until) {
    const suspEnd = new Date(student.suspended_until);
    if (suspEnd > new Date()) {
      const daysLeft = Math.ceil((suspEnd - new Date()) / (1000 * 60 * 60 * 24));
      return { found: true, result: 'denied', message: `SUSPENDED — ${daysLeft} DAY${daysLeft !== 1 ? 'S' : ''} LEFT`, student };
    }
  }
  if (student.status !== 'active') {
    const labels = { graduated: 'GRADUATED', frozen: 'SEMESTER FROZEN', suspended: 'SUSPENDED', dropped: 'DROPPED OUT' };
    return { found: true, result: 'denied', message: `${labels[student.status] || 'DENIED'} — OFFLINE`, student };
  }
  return { found: true, result: 'allowed', message: 'ENROLLED STUDENT — ALLOWED (OFFLINE)', student, mode: 'entry' };
}

syncStudents();
setInterval(syncStudents, 60000);

// --- AUDIO ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playBeep(type) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  if (type === 'allowed') {
    osc.frequency.value = 1200;
    osc.type = 'sine';
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } else if (type === 'denied') {
    osc.frequency.value = 400;
    osc.type = 'square';
    gain.gain.value = 0.25;
    osc.start();
    setTimeout(() => {
      const osc2 = audioCtx.createOscillator();
      const gain2 = audioCtx.createGain();
      osc2.connect(gain2);
      gain2.connect(audioCtx.destination);
      osc2.frequency.value = 300;
      osc2.type = 'square';
      gain2.gain.value = 0.25;
      osc2.start();
      osc2.stop(audioCtx.currentTime + 0.3);
    }, 200);
    osc.stop(audioCtx.currentTime + 0.15);
  } else {
    osc.frequency.value = 500;
    osc.type = 'triangle';
    gain.gain.value = 0.2;
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);
  }
}

// --- CLOCK ---
function updateClock() {
  const now = new Date();
  const h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  document.getElementById('clock').textContent = `${h12}:${m}:${s} ${ampm}`;
}
setInterval(updateClock, 1000);
updateClock();

// --- ENTRY COUNT ---
async function updateEntryCount() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    todayEntries = data.entriesToday;
    document.getElementById('entry-count').textContent = todayEntries;
    const insideEl = document.getElementById('inside-count');
    if (insideEl) insideEl.textContent = data.insideCampus || 0;
  } catch (e) {}
}
updateEntryCount();

// --- SCAN ---
async function handleScan() {
  const input = document.getElementById('card-input');
  const uid = input.value.trim();
  if (!uid) return;
  input.value = '';

  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_uid: uid, mode: GATE_MODE })
    });
    const data = await res.json();
    setOnlineStatus(true);
    showResult(data);
  } catch (err) {
    setOnlineStatus(false);
    showResult(offlineScan(uid));
  }
}

function showResult(data) {
  if (resetTimer) clearTimeout(resetTimer);

  const app = document.getElementById('app');
  const idleView = document.getElementById('idle-view');
  const resultView = document.getElementById('result-view');
  const banner = document.getElementById('result-banner');
  const studentCard = document.getElementById('student-card');
  const unknownCard = document.getElementById('unknown-card');
  const countdownFill = document.getElementById('countdown-fill');
  const modeEl = document.getElementById('result-mode');

  idleView.classList.add('hidden');
  resultView.classList.remove('hidden');

  const isExit = data.mode === 'exit' && data.result === 'allowed';
  banner.className = 'result-banner ' + (isExit ? 'exit' : data.result);
  document.getElementById('result-icon').textContent = isExit ? '👋' : data.result === 'allowed' ? '✅' : data.result === 'denied' ? '🚫' : '⚠️';
  document.getElementById('result-text').textContent = data.message;
  modeEl.textContent = isExit ? 'EXIT SCAN' : data.result === 'allowed' ? 'ENTRY SCAN' : '';

  if (data.found && data.student) {
    studentCard.classList.remove('hidden');
    unknownCard.classList.add('hidden');

    document.getElementById('student-photo').src = data.student.photo_url;
    document.getElementById('student-name').textContent = data.student.name;
    document.getElementById('student-roll').textContent = data.student.roll_number;
    document.getElementById('student-dept').textContent = data.student.department;
    document.getElementById('student-sem').textContent = data.student.semester;
    document.getElementById('student-sec').textContent = data.student.section;

    const statusEl = document.getElementById('student-status');
    const displayStatus = data.student.status === 'active' ? 'ENROLLED' : data.student.status.toUpperCase();
    statusEl.textContent = displayStatus;
    statusEl.className = 'info-value status-' + data.student.status;

    const validityEl = document.getElementById('student-validity');
    if (data.student.enrollment_year && data.student.expiry_year) {
      validityEl.textContent = `${data.student.enrollment_year} - ${data.student.expiry_year}`;
      const currentYear = new Date().getFullYear();
      validityEl.className = currentYear > data.student.expiry_year ? 'info-value status-expired' : 'info-value status-active';
    } else {
      validityEl.textContent = '—';
      validityEl.className = 'info-value';
    }
  } else {
    studentCard.classList.add('hidden');
    unknownCard.classList.remove('hidden');
  }

  app.classList.remove('flash-green', 'flash-red');
  void app.offsetWidth;
  app.classList.add(data.result === 'allowed' ? 'flash-green' : 'flash-red');

  playBeep(data.result);

  todayEntries++;
  document.getElementById('entry-count').textContent = todayEntries;
  updateEntryCount();

  countdownFill.style.transition = 'none';
  countdownFill.style.width = '100%';
  void countdownFill.offsetWidth;
  countdownFill.style.transition = `width ${RESET_DELAY}ms linear`;
  countdownFill.style.width = '0%';

  // Focus ghost input so RFID reader keystrokes are captured during result screen
  const ghost = document.getElementById('ghost-input');
  ghost.value = '';
  ghost.focus();

  resetTimer = setTimeout(resetToIdle, RESET_DELAY);
}

function resetToIdle() {
  document.getElementById('idle-view').classList.remove('hidden');
  document.getElementById('result-view').classList.add('hidden');
  document.getElementById('app').classList.remove('flash-green', 'flash-red');
  document.getElementById('card-input').focus();
}

// --- EVENTS ---
document.addEventListener('DOMContentLoaded', () => {
  const badge = document.getElementById('gate-badge');
  const gateNames = { main: 'MAIN GATE', parking: 'PARKING GATE' };
  badge.textContent = gateNames[GATE_ID] || GATE_ID.toUpperCase();
  if (GATE_ID === 'parking') badge.className = 'gate-badge gate-exit';

  document.getElementById('scan-btn').addEventListener('click', handleScan);
  document.getElementById('card-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleScan();
  });
  document.getElementById('idle-view').addEventListener('click', (e) => {
    if (e.target.id !== 'scan-btn') document.getElementById('card-input').focus();
  });
  // Ghost input — captures RFID taps during result screen
  document.getElementById('ghost-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const ghost = document.getElementById('ghost-input');
      const uid = ghost.value.trim();
      if (!uid) return;
      ghost.value = '';
      document.getElementById('card-input').value = uid;
      handleScan();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') resetToIdle();
  });
  document.getElementById('card-input').focus();
});
