let RESET_DELAY = 5000;
let resetTimer = null;
let todayEntries = 0;

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
  } catch (e) {}
}
updateEntryCount();

// --- SCAN HANDLER ---
async function handleScan() {
  const input = document.getElementById('card-input');
  const uid = input.value.trim();
  if (!uid) return;

  input.value = '';

  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_uid: uid })
    });
    const data = await res.json();
    showResult(data);
  } catch (err) {
    showResult({ found: false, result: 'unknown', message: 'SYSTEM ERROR — RETRY' });
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

  idleView.classList.add('hidden');
  resultView.classList.remove('hidden');

  banner.className = 'result-banner ' + data.result;
  document.getElementById('result-icon').textContent = data.result === 'allowed' ? '✅' : data.result === 'denied' ? '🚫' : '⚠️';
  document.getElementById('result-text').textContent = data.message;

  if (data.found && data.student) {
    studentCard.classList.remove('hidden');
    unknownCard.classList.add('hidden');

    document.getElementById('student-photo').src = data.student.photo_url;
    document.getElementById('student-name').textContent = data.student.name;
    document.getElementById('student-roll').textContent = data.student.roll_number;
    document.getElementById('student-dept').textContent = data.student.department;
    document.getElementById('student-sem').textContent = data.student.semester;
    document.getElementById('student-sec').textContent = data.student.section;

    const validityEl = document.getElementById('student-validity');
    if (data.student.enrollment_year && data.student.expiry_year) {
      validityEl.textContent = `${data.student.enrollment_year} - ${data.student.expiry_year}`;
      const currentYear = new Date().getFullYear();
      if (currentYear > data.student.expiry_year) {
        validityEl.className = 'info-value status-expired';
      } else {
        validityEl.className = 'info-value status-active';
      }
    } else {
      validityEl.textContent = '—';
      validityEl.className = 'info-value';
    }

    const statusEl = document.getElementById('student-status');
    statusEl.textContent = data.student.status.toUpperCase();
    statusEl.className = 'info-value status-' + data.student.status;
  } else {
    studentCard.classList.add('hidden');
    unknownCard.classList.remove('hidden');
  }

  // Flash effect
  app.classList.remove('flash-green', 'flash-red');
  void app.offsetWidth;
  app.classList.add(data.result === 'allowed' ? 'flash-green' : 'flash-red');

  // Sound
  playBeep(data.result);

  // Update entry count
  todayEntries++;
  document.getElementById('entry-count').textContent = todayEntries;

  // Countdown bar
  countdownFill.style.transition = 'none';
  countdownFill.style.width = '100%';
  void countdownFill.offsetWidth;
  countdownFill.style.transition = `width ${RESET_DELAY}ms linear`;
  countdownFill.style.width = '0%';

  // Auto reset
  resetTimer = setTimeout(resetToIdle, RESET_DELAY);
}

function resetToIdle() {
  document.getElementById('idle-view').classList.remove('hidden');
  document.getElementById('result-view').classList.add('hidden');
  document.getElementById('app').classList.remove('flash-green', 'flash-red');
  document.getElementById('card-input').focus();
}

// --- EVENT LISTENERS ---
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('scan-btn').addEventListener('click', handleScan);

  document.getElementById('card-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleScan();
  });

  document.getElementById('idle-view').addEventListener('click', (e) => {
    if (e.target.id !== 'scan-btn') document.getElementById('card-input').focus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') resetToIdle();
  });

  document.getElementById('card-input').focus();
});
