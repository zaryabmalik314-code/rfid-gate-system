let currentStudentPage = 1;
let currentLogPage = 1;
let searchTimeout = null;

function getToken() { return sessionStorage.getItem('admin_token'); }

function authHeaders() {
  return { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' };
}

async function authFetch(url, opts = {}) {
  if (!opts.headers) opts.headers = {};
  if (opts.headers instanceof Headers) {
    opts.headers.set('Authorization', `Bearer ${getToken()}`);
  } else {
    opts.headers['Authorization'] = `Bearer ${getToken()}`;
  }
  if (opts.body instanceof FormData) delete opts.headers['Content-Type'];
  const res = await fetch(url, opts);
  if (res.status === 401) {
    sessionStorage.removeItem('admin_token');
    showLogin();
    throw new Error('Session expired');
  }
  return res;
}

function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('admin-layout').classList.add('hidden');
  document.getElementById('login-password').focus();
}

function showAdmin() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('admin-layout').classList.remove('hidden');
  loadStats();
  loadStudents();
  loadDepartments();
}

async function handleLogin(e) {
  e.preventDefault();
  const pw = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const data = await res.json();
    if (data.token) {
      sessionStorage.setItem('admin_token', data.token);
      showAdmin();
    } else {
      errEl.textContent = data.error || 'Wrong password';
      errEl.classList.remove('hidden');
    }
  } catch (err) {
    errEl.textContent = 'Connection error';
    errEl.classList.remove('hidden');
  }
}

async function handleLogout() {
  try { await fetch('/api/admin/logout', { method: 'POST', headers: authHeaders() }); } catch(e) {}
  sessionStorage.removeItem('admin_token');
  showLogin();
}

document.addEventListener('DOMContentLoaded', () => {
  if (getToken()) {
    showAdmin();
  } else {
    showLogin();
  }
  setInterval(() => { if (getToken()) loadStats(); }, 30000);
});

// --- TABS ---
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`[onclick="switchTab('${tab}')"]`).classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');
  if (tab === 'logs') loadLogs();
  if (tab === 'timetable') { loadTimetable(); loadTTDepts(); }
}

// --- STATS ---
async function loadStats() {
  const res = await authFetch('/api/stats');
  const s = await res.json();
  document.getElementById('stats-grid').innerHTML = `
    <div class="stat-card"><div class="stat-value" style="color:var(--accent)">${s.total}</div><div class="stat-label">Total Students</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--green)">${s.enrolled}</div><div class="stat-label">Enrolled</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--red)">${s.graduated}</div><div class="stat-label">Graduated</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--orange)">${s.frozen}</div><div class="stat-label">Frozen</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--red)">${s.suspended + s.dropped}</div><div class="stat-label">Suspended/Dropped</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--green)">${s.insideCampus || 0}</div><div class="stat-label">Inside Campus</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--accent)">${s.entriesToday}</div><div class="stat-label">Scans Today</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--green)">${s.allowedToday}</div><div class="stat-label">Allowed</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--red)">${s.deniedToday}</div><div class="stat-label">Denied</div></div>
  `;
}

// --- STUDENTS ---
async function loadStudents(page = currentStudentPage) {
  currentStudentPage = page;
  const search = document.getElementById('search-input').value;
  const status = document.getElementById('filter-status').value;
  const dept = document.getElementById('filter-dept').value;

  const params = new URLSearchParams({ page, limit: 50 });
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  if (dept) params.set('department', dept);

  const res = await authFetch(`/api/students?${params}`);
  const data = await res.json();

  const tbody = document.getElementById('students-tbody');
  if (data.students.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--muted);padding:40px">No students found</td></tr>';
  } else {
    const currentYear = new Date().getFullYear();
    tbody.innerHTML = data.students.map(s => {
      const isExpired = s.expiry_year && currentYear > s.expiry_year;
      const validStr = s.enrollment_year && s.expiry_year ? `${s.enrollment_year}-${s.expiry_year}` : '—';
      const validStyle = isExpired ? 'color:var(--red)' : 'color:var(--green)';
      let suspInfo = '';
      if (s.status === 'suspended' && s.suspended_until) {
        const until = new Date(s.suspended_until);
        const daysLeft = Math.ceil((until - new Date()) / (1000 * 60 * 60 * 24));
        suspInfo = daysLeft > 0 ? ` <span style="font-size:10px;color:var(--orange)">(${daysLeft}d left)</span>` : ' <span style="font-size:10px;color:var(--green)">(expired)</span>';
      }
      const genderIcon = s.gender === 'Male' ? '♂' : s.gender === 'Female' ? '♀' : '—';
      const genderColor = s.gender === 'Male' ? 'var(--accent)' : s.gender === 'Female' ? '#e879f9' : 'var(--muted)';
      return `
      <tr>
        <td><img src="${s.photo_url}" class="photo-small" alt="${s.name}"></td>
        <td><strong>${s.name}</strong><br><span style="font-size:10px;color:var(--muted)">${s.father_name || ''}</span></td>
        <td>${s.roll_number}</td>
        <td style="font-size:11px;color:var(--muted)">${s.card_uid}</td>
        <td>${s.department}</td>
        <td style="text-align:center">${s.semester}</td>
        <td style="text-align:center">${s.section}</td>
        <td style="text-align:center;color:${genderColor};font-size:16px" title="${s.gender || ''}">${genderIcon}</td>
        <td style="font-size:11px;color:var(--muted)">${s.phone || '—'}</td>
        <td style="font-size:12px;font-weight:700;${validStyle}">${validStr}${isExpired ? ' ⛔' : ''}</td>
        <td>
          <select class="status-select" onchange="updateStatus(${s.id}, this.value)">
            ${[['active','Enrolled'],['graduated','Graduated'],['frozen','Frozen'],['suspended','Suspended'],['dropped','Dropped']].map(([val,lbl]) =>
              `<option value="${val}" ${s.status === val ? 'selected' : ''}>${lbl}</option>`
            ).join('')}
          </select>${suspInfo}
        </td>
        <td class="actions-cell">
          <button class="btn-small btn-edit" onclick='editStudent(${JSON.stringify(s)})'>Edit</button>
          <button class="btn-small btn-delete" onclick="deleteStudent(${s.id}, '${s.name}')">Del</button>
        </td>
      </tr>
    `}).join('');
  }

  renderPagination('students-pagination', data.pages, page, (p) => loadStudents(p));
}

function debounceSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => loadStudents(1), 300);
}

async function loadDepartments() {
  const res = await authFetch('/api/departments');
  const depts = await res.json();
  const select = document.getElementById('filter-dept');
  depts.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    select.appendChild(opt);
  });
}

let pendingSuspendId = null;

function showSuspendModal(id, name) {
  pendingSuspendId = id;
  document.getElementById('suspend-title').textContent = `Suspend ${name}`;
  document.getElementById('suspend-desc').textContent = `Choose how long to suspend ${name} from campus.`;
  document.getElementById('suspend-days-input').value = '';
  document.getElementById('suspend-overlay').classList.remove('hidden');
}

function closeSuspendModal() {
  document.getElementById('suspend-overlay').classList.add('hidden');
  pendingSuspendId = null;
  loadStudents();
}

function selectSuspendDays(days) {
  document.getElementById('suspend-days-input').value = days;
  confirmSuspend(days);
}

async function confirmSuspend(days) {
  if (!pendingSuspendId) return;
  await authFetch(`/api/students/${pendingSuspendId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'suspended', suspended_days: days || null })
  });
  closeSuspendModal();
  loadStudents();
  loadStats();
}

function confirmSuspendCustom() {
  const days = parseInt(document.getElementById('suspend-days-input').value);
  if (!days || days < 1) { document.getElementById('suspend-days-input').focus(); return; }
  confirmSuspend(days);
}

async function updateStatus(id, status) {
  if (status === 'suspended') {
    const nameEl = document.querySelector(`[onchange="updateStatus(${id}, this.value)"]`)?.closest('tr')?.querySelector('strong');
    showSuspendModal(id, nameEl ? nameEl.textContent : 'Student');
    return;
  }
  await authFetch(`/api/students/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  loadStudents();
  loadStats();
}

async function deleteStudent(id, name) {
  if (!confirm(`Delete student "${name}"? This cannot be undone.`)) return;
  await authFetch(`/api/students/${id}`, { method: 'DELETE' });
  loadStudents();
  loadStats();
}

// --- MODAL ---
function showAddModal() {
  document.getElementById('modal-title').textContent = 'Add Student';
  document.getElementById('edit-id').value = '';
  document.getElementById('student-form').reset();
  document.getElementById('f-gender').value = '';
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function editStudent(s) {
  document.getElementById('modal-title').textContent = 'Edit Student';
  document.getElementById('edit-id').value = s.id;
  document.getElementById('f-card-uid').value = s.card_uid;
  document.getElementById('f-name').value = s.name;
  document.getElementById('f-roll').value = s.roll_number;
  document.getElementById('f-dept').value = s.department;
  document.getElementById('f-sem').value = s.semester;
  document.getElementById('f-sec').value = s.section;
  document.getElementById('f-enroll').value = s.enrollment_year || '';
  document.getElementById('f-expiry').value = s.expiry_year || '';
  document.getElementById('f-status').value = s.status;
  document.getElementById('f-father').value = s.father_name || '';
  document.getElementById('f-cnic').value = s.cnic || '';
  document.getElementById('f-phone').value = s.phone || '';
  document.getElementById('f-gender').value = s.gender || '';
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

async function handleStudentSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('edit-id').value;
  const body = {
    card_uid: document.getElementById('f-card-uid').value,
    name: document.getElementById('f-name').value,
    roll_number: document.getElementById('f-roll').value,
    department: document.getElementById('f-dept').value,
    semester: document.getElementById('f-sem').value,
    section: document.getElementById('f-sec').value,
    enrollment_year: document.getElementById('f-enroll').value,
    expiry_year: document.getElementById('f-expiry').value,
    status: document.getElementById('f-status').value,
    father_name: document.getElementById('f-father').value,
    cnic: document.getElementById('f-cnic').value,
    phone: document.getElementById('f-phone').value,
    gender: document.getElementById('f-gender').value,
  };

  const url = id ? `/api/students/${id}` : '/api/students';
  const method = id ? 'PUT' : 'POST';

  const res = await authFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (data.success) {
    closeModal();
    loadStudents();
    loadStats();
  } else {
    alert('Error: ' + data.error);
  }
}

// --- LOGS ---
async function loadLogs(page = currentLogPage) {
  currentLogPage = page;
  const date = document.getElementById('log-date').value;
  const result = document.getElementById('log-result').value;
  const gate = document.getElementById('log-gate').value;

  const params = new URLSearchParams({ page, limit: 50 });
  if (date) params.set('date', date);
  if (result) params.set('result', result);
  if (gate) params.set('gate', gate);

  const res = await authFetch(`/api/logs?${params}`);
  const data = await res.json();

  const tbody = document.getElementById('logs-tbody');
  if (data.logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:40px">No logs found</td></tr>';
  } else {
    tbody.innerHTML = data.logs.map(l => {
      const dt = new Date(l.timestamp);
      const time = isNaN(dt) ? l.timestamp : dt.toLocaleString();
      const mode = l.scan_mode || 'entry';
      const gate = l.gate_id || 'main';
      const gateLabel = gate.charAt(0).toUpperCase() + gate.slice(1);
      return `
        <tr>
          <td style="white-space:nowrap;font-size:12px">${time}</td>
          <td style="font-size:11px;color:var(--muted)">${l.card_uid}</td>
          <td>${l.student_name || '—'}</td>
          <td>${l.roll_number || '—'}</td>
          <td><span class="badge badge-gate">${gateLabel}</span></td>
          <td><span class="badge badge-${mode}">${mode}</span></td>
          <td>${l.status_at_entry ? `<span class="badge badge-${l.status_at_entry}">${l.status_at_entry}</span>` : '—'}</td>
          <td><span class="badge badge-${l.result}">${l.result}</span></td>
        </tr>
      `;
    }).join('');
  }

  renderPagination('logs-pagination', data.pages, page, (p) => loadLogs(p));
}

// --- IMPORT ---
async function handleImport(e) {
  e.preventDefault();
  const file = document.getElementById('import-file').files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  const resultDiv = document.getElementById('import-result');
  resultDiv.classList.remove('hidden', 'success', 'error');
  resultDiv.textContent = 'Importing...';

  const res = await authFetch('/api/students/import', { method: 'POST', body: formData });
  const data = await res.json();

  if (data.success) {
    resultDiv.className = 'import-result success';
    resultDiv.innerHTML = `Imported ${data.imported} of ${data.total} students.${data.errors.length ? '<br>Errors: ' + data.errors.join(', ') : ''}`;
    loadStudents();
    loadStats();
    loadDepartments();
  } else {
    resultDiv.className = 'import-result error';
    resultDiv.textContent = 'Error: ' + data.error;
  }
}

async function handleBulkStatus(e) {
  e.preventDefault();
  const file = document.getElementById('bulk-status-file').files[0];
  const status = document.getElementById('bulk-status-select').value;
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('status', status);

  const resultDiv = document.getElementById('bulk-result');
  resultDiv.classList.remove('hidden', 'success', 'error');
  resultDiv.textContent = 'Updating...';

  const res = await authFetch('/api/students/bulk-status', { method: 'POST', body: formData });
  const data = await res.json();

  if (data.success) {
    resultDiv.className = 'import-result success';
    resultDiv.innerHTML = `Updated ${data.updated} of ${data.total} students.${data.notFound.length ? '<br>Not found: ' + data.notFound.slice(0, 10).join(', ') + (data.notFound.length > 10 ? '...' : '') : ''}`;
    loadStudents();
    loadStats();
  } else {
    resultDiv.className = 'import-result error';
    resultDiv.textContent = 'Error: ' + data.error;
  }
}

function downloadTemplate() {
  const headers = ['card_uid', 'name', 'roll_number', 'department', 'semester', 'section', 'status', 'enrollment_year', 'expiry_year'];
  const sample = ['LGU-2024-001', 'Ahmed Raza Khan', '001', 'BS-CMAI', '2', 'A', 'active', '2025', '2029'];
  const csv = headers.join(',') + '\n' + sample.join(',') + '\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'student_import_template.csv';
  a.click();
}

// --- RESET ---
async function resetCampus() {
  if (!confirm('Reset all students to "outside campus"? This clears the inside_campus flag for everyone.')) return;
  const res = await authFetch('/api/reset-campus', { method: 'POST' });
  const data = await res.json();
  alert(`Reset ${data.reset} students to outside.`);
  loadStats();
}

// --- PAGINATION ---
function renderPagination(containerId, totalPages, currentPage, onPageClick) {
  const container = document.getElementById(containerId);
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  let html = `<button ${currentPage <= 1 ? 'disabled' : ''}>← Prev</button>`;
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);

  for (let i = start; i <= end; i++) {
    html += `<button class="${i === currentPage ? 'active' : ''}">${i}</button>`;
  }

  html += `<button ${currentPage >= totalPages ? 'disabled' : ''}>Next →</button>`;
  container.innerHTML = html;

  container.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.textContent.trim();
      if (text === '← Prev') onPageClick(currentPage - 1);
      else if (text === 'Next →') onPageClick(currentPage + 1);
      else onPageClick(parseInt(text));
    });
  });
}

// --- TIMETABLE ---
let ttDeptsLoaded = false;

async function loadTTDepts() {
  if (ttDeptsLoaded) return;
  const res = await authFetch('/api/timetable/departments');
  const depts = await res.json();
  const select = document.getElementById('tt-dept');
  select.innerHTML = '<option value="">All Departments</option>';
  depts.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    select.appendChild(opt);
  });
  ttDeptsLoaded = true;
}

async function loadTimetable() {
  const dept = document.getElementById('tt-dept').value;
  const sem = document.getElementById('tt-sem').value;
  const day = document.getElementById('tt-day').value;

  const params = new URLSearchParams();
  if (dept) params.set('department', dept);
  if (sem) params.set('semester', sem);
  if (day) params.set('day', day);

  const res = await authFetch(`/api/timetable?${params}`);
  const rows = await res.json();

  const tbody = document.getElementById('tt-tbody');
  document.getElementById('tt-count').textContent = `${rows.length} entries`;

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:40px">No timetable entries found</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.department}</td>
      <td style="text-align:center">${r.semester}</td>
      <td style="text-align:center">${r.section}</td>
      <td style="text-transform:capitalize">${r.day_of_week}</td>
      <td>${r.time_start}</td>
      <td>${r.time_end}</td>
      <td><strong>${r.subject}</strong></td>
      <td>${r.room || '—'}</td>
      <td>${r.teacher || '—'}</td>
      <td><button class="btn-small btn-delete" onclick="deleteTTEntry(${r.id})">×</button></td>
    </tr>
  `).join('');
}

async function deleteTTEntry(id) {
  await authFetch(`/api/timetable/${id}`, { method: 'DELETE' });
  loadTimetable();
}

async function clearTimetable() {
  const dept = document.getElementById('tt-dept').value;
  const sem = document.getElementById('tt-sem').value;
  const filterDesc = [dept, sem ? `Sem ${sem}` : ''].filter(Boolean).join(', ') || 'ALL';
  if (!confirm(`Clear timetable entries for: ${filterDesc}? This cannot be undone.`)) return;

  const body = {};
  if (dept) body.department = dept;
  if (sem) body.semester = sem;

  const res = await authFetch('/api/timetable/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  alert(`Deleted ${data.deleted} timetable entries.`);
  loadTimetable();
}

async function handleTimetableImport(e) {
  e.preventDefault();
  const file = document.getElementById('tt-import-file').files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  const resultDiv = document.getElementById('tt-import-result');
  resultDiv.classList.remove('hidden', 'success', 'error');
  resultDiv.textContent = 'Importing timetable...';

  const res = await authFetch('/api/timetable/import', { method: 'POST', body: formData });
  const data = await res.json();

  if (data.success) {
    resultDiv.className = 'import-result success';
    resultDiv.innerHTML = `Imported ${data.imported} of ${data.total} entries.${data.errors.length ? '<br>Errors: ' + data.errors.join(', ') : ''}`;
    loadTimetable();
  } else {
    resultDiv.className = 'import-result error';
    resultDiv.textContent = 'Error: ' + data.error;
  }
}

async function syncPortalTimetable() {
  const btn = document.getElementById('portal-sync-btn');
  const resultEl = document.getElementById('portal-sync-result');
  if (!confirm('This will replace ALL existing timetable data with fresh data from LGU portal. Continue?')) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Syncing... (this may take a few minutes)';
  resultEl.classList.add('hidden');

  try {
    const res = await authFetch('/api/timetable/sync-portal', { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    resultEl.classList.remove('hidden');
    if (data.success) {
      resultEl.innerHTML = `<div style="color:var(--green)">Synced ${data.imported} classes in ${data.elapsed_seconds}s</div>` +
        (data.synced.length ? `<div style="font-size:12px;color:var(--muted);max-height:200px;overflow:auto;margin-top:8px">${data.synced.join('<br>')}</div>` : '') +
        (data.errors.length ? `<div style="color:var(--orange);margin-top:8px">Errors: ${data.errors.join(', ')}</div>` : '');
      loadTimetable();
      ttDeptsLoaded = false;
      loadTTDepts();
    } else {
      resultEl.innerHTML = `<div style="color:var(--red)">Error: ${data.error}</div>`;
    }
  } catch (e) {
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `<div style="color:var(--red)">Failed: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Sync from Portal';
  }
}

function downloadTimetableTemplate() {
  const headers = ['department', 'semester', 'section', 'day', 'time_start', 'time_end', 'subject', 'room', 'teacher'];
  const sample = ['BS-CMAI', '2', 'A', 'monday', '09:00', '10:30', 'Calculus', 'R-201', 'Dr. Ahmed'];
  const csv = headers.join(',') + '\n' + sample.join(',') + '\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'timetable_template.csv';
  a.click();
}
