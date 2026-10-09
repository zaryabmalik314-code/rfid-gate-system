const express = require('express');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Pool } = require('pg');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
// WS broadcasts carry live student PII — require an admin session or the gate token
const wss = new WebSocketServer({
  server,
  verifyClient: (info, cb) => {
    let token = '';
    try {
      token = new URL(info.req.url, `http://${info.req.headers.host}`).searchParams.get('token') || '';
    } catch (e) {}
    const session = adminSessions.get(token);
    const isAdmin = session && session.expires > Date.now();
    if (isAdmin || (GATE_TOKEN && safeEqual(token, GATE_TOKEN))) return cb(true);
    cb(false, 401, 'Unauthorized');
  }
});
const PORT = process.env.PORT || 4000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD is not set. Refusing to start.');
  process.exit(1);
}
const GATE_TOKEN = process.env.GATE_TOKEN || '';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireGate(req, res, next) {
  if (!GATE_TOKEN) {
    return res.status(503).json({ error: 'Gate authentication not configured' });
  }
  const token = req.headers['x-gate-token'] || req.query.gate_token;
  if (!safeEqual(token, GATE_TOKEN)) {
    return res.status(403).json({ error: 'Invalid gate token' });
  }
  next();
}

// Device endpoints can't send custom headers — authenticate by serial allowlist
const AIT_DEVICE_SN = (process.env.AIT_DEVICE_SN || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

function deviceAllowed(sn) {
  if (!AIT_DEVICE_SN.length) return false;
  return AIT_DEVICE_SN.includes(String(sn || '').trim().toUpperCase());
}

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const PHOTOS_DIR = path.join(__dirname, 'photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
app.use('/photos', express.static(PHOTOS_DIR));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

// --- ADMIN AUTH ---
const adminSessions = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = auth.slice(7);
  const session = adminSessions.get(token);
  if (!session || session.expires < Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }
  next();
}

// --- LOGIN RATE LIMIT ---
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function rateLimitLogin(req, res, next) {
  const key = req.ip;
  const rec = loginAttempts.get(key);
  if (rec && rec.count >= MAX_ATTEMPTS && Date.now() - rec.first < LOCKOUT_MS) {
    const mins = Math.ceil((LOCKOUT_MS - (Date.now() - rec.first)) / 60000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${mins} min.` });
  }
  if (rec && Date.now() - rec.first >= LOCKOUT_MS) loginAttempts.delete(key);
  next();
}

function recordFailedLogin(ip) {
  const rec = loginAttempts.get(ip);
  if (rec) rec.count++;
  else loginAttempts.set(ip, { count: 1, first: Date.now() });
}

app.post('/api/admin/login', rateLimitLogin, (req, res) => {
  const { password } = req.body;
  if (!safeEqual(password, ADMIN_PASSWORD)) {
    recordFailedLogin(req.ip);
    return res.status(403).json({ error: 'Wrong password' });
  }
  loginAttempts.delete(req.ip);
  const token = generateToken();
  adminSessions.set(token, { expires: Date.now() + 24 * 60 * 60 * 1000 });
  res.json({ token });
});

app.post('/api/admin/logout', (req, res) => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    adminSessions.delete(auth.slice(7));
  }
  res.json({ success: true });
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function query(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

async function run(sql, params = []) {
  await pool.query(sql, params);
}

// --- WEBSOCKET ---
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

function sendAlert(data) {
  broadcast('alert', data);
  pool.query(
    `INSERT INTO alerts (timestamp, alert_type, severity, student_name, roll_number, department, photo_url, gate_id, title, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [data.timestamp, data.alert_type, data.severity, data.student_name, data.roll_number, data.department || null, data.photo_url || null, data.gate_id, data.title, data.detail]
  ).catch(err => console.error('Alert save error:', err.message));
}

wss.on('connection', (ws) => {
  ws.on('error', () => {});
});

// --- COOLDOWN (only after exit→re-entry, not on consecutive entries) ---
const COOLDOWN_MS = parseInt(process.env.SCAN_COOLDOWN_MS || '180000');
const lastExitTime = new Map();

// --- SCAN ENDPOINT ---
app.post('/api/scan', requireGate, async (req, res) => {
  const { card_uid, gate_id } = req.body;
  const gate = (gate_id || 'main').trim();

  if (!card_uid || !card_uid.trim()) {
    return res.json({ found: false, result: 'unknown', message: 'No card UID provided' });
  }

  const uid = card_uid.trim().toUpperCase();
  const now = Date.now();

  const student = await queryOne(
    `SELECT id, card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year, inside_campus, suspended_until
     FROM students WHERE UPPER(card_uid) = $1 OR UPPER(roll_number) = $1`,
    [uid]
  );

  let result, message;

  if (!student) {
    result = 'unknown';
    message = 'UNREGISTERED CARD';
    await run(
      `INSERT INTO entry_logs (card_uid, student_id, student_name, roll_number, status_at_entry, result, scan_mode, gate_id)
       VALUES ($1, NULL, NULL, NULL, NULL, $2, $3, $4)`,
      [uid, result, 'entry', gate]
    );
    broadcast('scan', {
      timestamp: new Date().toISOString(),
      card_uid: uid,
      student_name: null,
      roll_number: null,
      result,
      mode: 'entry',
      gate_id: gate,
      message
    });
    sendAlert({
      timestamp: new Date().toISOString(),
      alert_type: 'unknown_card',
      severity: 'critical',
      student_name: null,
      roll_number: null,
      gate_id: gate,
      title: 'UNREGISTERED CARD',
      detail: `Unknown card ${uid} scanned at ${gate}`
    });
    return res.json({ found: false, result, message });
  }

  // Auto-detect direction based on inside_campus flag
  const scanMode = student.inside_campus ? 'exit' : 'entry';
  const currentYear = new Date().getFullYear();
  const isExpired = student.expiry_year && currentYear > student.expiry_year;

  if (scanMode === 'exit') {
    result = 'allowed';
    message = 'EXIT RECORDED — GOODBYE';
    await run('UPDATE students SET inside_campus = FALSE WHERE id = $1', [student.id]);
    student.inside_campus = false;
    lastExitTime.set(uid, now);
  } else {
    // Cooldown only on exit→entry (prevent quick re-entry after exit)
    const lastExit = lastExitTime.get(uid);
    if (lastExit && (now - lastExit) < COOLDOWN_MS) {
      const remainSec = Math.ceil((COOLDOWN_MS - (now - lastExit)) / 1000);
      return res.json({
        found: true, result: 'denied',
        message: `PLEASE WAIT ${remainSec}s — COOLDOWN ACTIVE`,
        cooldown: true, student, mode: scanMode
      });
    }

    if (isExpired) {
      result = 'denied';
      message = `CARD EXPIRED (${student.enrollment_year}-${student.expiry_year}) — ENTRY DENIED`;
      student.status = 'expired';
    } else if (student.status === 'suspended' && student.suspended_until) {
      const suspEnd = new Date(student.suspended_until);
      if (suspEnd > new Date()) {
        result = 'denied';
        const daysLeft = Math.ceil((suspEnd - new Date()) / (1000 * 60 * 60 * 24));
        message = `SUSPENDED — ${daysLeft} DAY${daysLeft !== 1 ? 'S' : ''} LEFT`;
      } else {
        // Suspension expired — auto-restore to enrolled
        await run("UPDATE students SET status = 'active', suspended_until = NULL WHERE id = $1", [student.id]);
        student.status = 'active';
        result = 'allowed';
        message = 'SUSPENSION ENDED — WELCOME BACK';
        await run('UPDATE students SET inside_campus = TRUE WHERE id = $1', [student.id]);
        student.inside_campus = true;
      }
    } else if (student.status !== 'active') {
      result = 'denied';
      const statusLabels = {
        graduated: 'GRADUATED — NO LONGER ENROLLED',
        frozen: 'SEMESTER FROZEN — ENTRY DENIED',
        suspended: 'SUSPENDED — ENTRY DENIED',
        dropped: 'DROPPED OUT — ENTRY DENIED'
      };
      message = statusLabels[student.status] || 'ENTRY DENIED';
    } else {
      result = 'allowed';
      message = 'ENROLLED STUDENT — ENTRY ALLOWED';
      await run('UPDATE students SET inside_campus = TRUE WHERE id = $1', [student.id]);
      student.inside_campus = true;
    }
  }

  await run(
    `INSERT INTO entry_logs (card_uid, student_id, student_name, roll_number, status_at_entry, result, scan_mode, gate_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [student.card_uid, student.id, student.name, student.roll_number, student.status, result, scanMode, gate]
  );

  // Auto-calculate current semester from roll number (e.g. "Fa-2025/BS CMAI/055")
  // DB semester is static from import; this derives the live value without touching DB
  let currentSem = student.semester;
  const rollMatch = student.roll_number.match(/^(Fa|Sp)-(\d{4})\//i);
  if (rollMatch) {
    const startFall = rollMatch[1].toLowerCase() === 'fa';
    const startYear = parseInt(rollMatch[2]);
    const now = new Date();
    const curYear = now.getFullYear();
    const curFall = now.getMonth() >= 7; // Aug-Dec = Fall
    if (startFall) {
      currentSem = curFall ? (curYear - startYear) * 2 + 1 : (curYear - startYear) * 2;
    } else {
      currentSem = curFall ? (curYear - startYear) * 2 + 2 : (curYear - startYear) * 2 + 1;
    }
    if (currentSem < 1) currentSem = 1;
  }
  student.current_semester = currentSem;

  // Timetable check on entry
  let timetable = null;
  if (scanMode === 'entry' && result === 'allowed') {
    const todayDay = DAYS[new Date().getDay()];

    let todayClasses = await query(
      `SELECT subject, time_start, time_end, room, teacher FROM timetable
       WHERE department = $1 AND semester = $2 AND LOWER(section) = LOWER($3) AND day_of_week = $4
       ORDER BY time_start`,
      [student.department, currentSem, student.section, todayDay]
    );
    if (todayClasses.length === 0) {
      todayClasses = await query(
        `SELECT subject, time_start, time_end, room, teacher FROM timetable
         WHERE REPLACE(LOWER(department), ' ', '') = REPLACE(LOWER($1), ' ', '')
         AND semester = $2 AND LOWER(section) = LOWER($3) AND day_of_week = $4
         ORDER BY time_start`,
        [student.department, currentSem, student.section, todayDay]
      );
    }
    if (todayClasses.length === 0) {
      timetable = { has_classes: false, classes: [], next_class: null };
    } else {
      const nowTime = new Date().toTimeString().slice(0, 5);
      const nextClass = todayClasses.find(c => c.time_start > nowTime) || null;
      timetable = { has_classes: true, classes: todayClasses, next_class: nextClass };
    }
  }

  // Broadcast to all connected WebSocket clients
  broadcast('scan', {
    timestamp: new Date().toISOString(),
    student_name: student.name,
    roll_number: student.roll_number,
    department: student.department,
    photo_url: student.photo_url,
    result,
    mode: scanMode,
    gate_id: gate,
    message
  });

  // Alert: student entered campus with no classes today
  if (timetable && !timetable.has_classes && scanMode === 'entry' && result === 'allowed') {
    sendAlert({
      timestamp: new Date().toISOString(),
      alert_type: 'no_lecture',
      severity: 'warning',
      student_name: student.name,
      roll_number: student.roll_number,
      department: student.department,
      photo_url: student.photo_url,
      gate_id: gate,
      title: 'NO LECTURES TODAY',
      detail: `${student.name} entered campus but has no classes scheduled today`
    });
  }

  // Alert: suspended student attempted entry
  if (result === 'denied' && (student.status === 'suspended' || message.includes('SUSPENDED'))) {
    sendAlert({
      timestamp: new Date().toISOString(),
      alert_type: 'suspended_entry',
      severity: 'critical',
      student_name: student.name,
      roll_number: student.roll_number,
      department: student.department,
      photo_url: student.photo_url,
      gate_id: gate,
      title: 'SUSPENDED STUDENT',
      detail: `${student.name} attempted entry while suspended`
    });
  }

  // Alert: expired card
  if (result === 'denied' && isExpired) {
    sendAlert({
      timestamp: new Date().toISOString(),
      alert_type: 'expired_card',
      severity: 'warning',
      student_name: student.name,
      roll_number: student.roll_number,
      department: student.department,
      photo_url: student.photo_url,
      gate_id: gate,
      title: 'EXPIRED CARD',
      detail: `${student.name} tried to enter with expired card (${student.enrollment_year}-${student.expiry_year})`
    });
  }

  const { card_uid: _uid, ...safeStudent } = student;
  res.json({ found: true, result, message, student: safeStudent, mode: scanMode, timetable });
});

// --- STUDENTS CRUD (admin-only) ---
app.get('/api/students', requireAdmin, async (req, res) => {
  const { search, status, department, page = 1, limit = 50 } = req.query;
  let where = '1=1';
  const params = [];
  let paramIdx = 1;

  if (search) {
    where += ` AND (name ILIKE $${paramIdx} OR roll_number ILIKE $${paramIdx} OR card_uid ILIKE $${paramIdx} OR cnic ILIKE $${paramIdx} OR phone ILIKE $${paramIdx} OR father_name ILIKE $${paramIdx})`;
    params.push(`%${search}%`);
    paramIdx++;
  }
  if (status) {
    where += ` AND status = $${paramIdx}`;
    params.push(status);
    paramIdx++;
  }
  if (department) {
    where += ` AND department = $${paramIdx}`;
    params.push(department);
    paramIdx++;
  }

  const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
  const safePage = Math.max(parseInt(page) || 1, 1);
  const totalRow = await queryOne(`SELECT COUNT(*) as total FROM students WHERE ${where}`, params);
  const total = parseInt(totalRow.total);
  const offset = (safePage - 1) * safeLimit;
  const students = await query(
    `SELECT * FROM students WHERE ${where} ORDER BY name ASC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, safeLimit, offset]
  );

  res.json({ students, total, page: safePage, pages: Math.ceil(total / safeLimit) });
});

app.post('/api/students', requireAdmin, async (req, res) => {
  const { card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year, father_name, cnic, phone, gender } = req.body;
  try {
    await run(
      `INSERT INTO students (card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year, father_name, cnic, phone, gender)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [card_uid, name, roll_number, department, parseInt(semester), section || 'A', status || 'active',
       photo_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=200&background=random&bold=true`,
       parseInt(enrollment_year) || null, parseInt(expiry_year) || null, father_name || null, cnic || null, phone || null, gender || null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/students/:id', requireAdmin, async (req, res) => {
  const { card_uid, name, roll_number, department, semester, section, status, enrollment_year, expiry_year, father_name, cnic, phone, gender } = req.body;
  try {
    await run(
      `UPDATE students SET card_uid=$1, name=$2, roll_number=$3, department=$4, semester=$5, section=$6, status=$7, enrollment_year=$8, expiry_year=$9, father_name=$10, cnic=$11, phone=$12, gender=$13 WHERE id=$14`,
      [card_uid, name, roll_number, department, parseInt(semester), section, status, parseInt(enrollment_year) || null, parseInt(expiry_year) || null, father_name || null, cnic || null, phone || null, gender || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.patch('/api/students/:id/status', requireAdmin, async (req, res) => {
  const { status, suspended_days } = req.body;
  const valid = ['active', 'graduated', 'frozen', 'suspended', 'dropped'];
  if (!valid.includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }
  if (status === 'suspended' && suspended_days && parseInt(suspended_days) > 0) {
    const days = Math.min(parseInt(suspended_days), 3);
    const until = new Date();
    until.setDate(until.getDate() + days);
    await run('UPDATE students SET status = $1, suspended_until = $2 WHERE id = $3', [status, until.toISOString(), req.params.id]);
  } else {
    await run('UPDATE students SET status = $1, suspended_until = NULL WHERE id = $2', [status, req.params.id]);
  }
  res.json({ success: true });
});

app.delete('/api/students/:id', requireAdmin, async (req, res) => {
  await run('DELETE FROM students WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// --- BULK IMPORT ---
function parseJoiningSession(session) {
  if (!session) return { enrollYear: null, expiryYear: null, semester: 1 };
  const match = String(session).match(/(Fa|Sp)-(\d{4})/i);
  if (!match) return { enrollYear: null, expiryYear: null, semester: 1 };
  const enrollYear = parseInt(match[2]);
  const isFall = match[1].toLowerCase() === 'fa';
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  let semCount = (currentYear - enrollYear) * 2;
  if (isFall) { semCount -= 1; }
  if (currentMonth >= 8) { semCount += 1; }
  const semester = Math.max(1, Math.min(8, semCount));
  const expiryYear = enrollYear + 4;
  return { enrollYear, expiryYear, semester };
}

app.post('/api/students/import', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    let rows = XLSX.utils.sheet_to_json(sheet);

    // Skip title rows: if first row has no recognizable columns, find real header row
    if (rows.length && !rows[0].studentname && !rows[0].name && !rows[0].Name && !rows[0]['Student Name']
        && !rows[0].StdRollNo && !rows[0].roll_number && !rows[0]['Student Roll No.']) {
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const headerIdx = rawRows.findIndex(r => r && r.length >= 3 &&
        r.some(c => /roll/i.test(String(c || ''))) && r.some(c => /name/i.test(String(c || ''))));
      if (headerIdx > 0) {
        const newSheet = XLSX.utils.aoa_to_sheet(rawRows.slice(headerIdx));
        rows = XLSX.utils.sheet_to_json(newSheet);
      }
    }

    let imported = 0;
    const errors = [];
    const maxIdRow = await queryOne("SELECT COALESCE(MAX(id), 0) as m FROM students");
    let uidCounter = parseInt(maxIdRow.m) + 1;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];

      const name = String(r.studentname || r.name || r.Name || r.STUDENT_NAME || r.student_name || r['Student Name'] || '').trim();
      const rollNo = String(r.StdRollNo || r.roll_number || r.Roll_Number || r.RollNumber || r.ROLL_NO || r.roll_no || r['Student Roll No.'] || '').trim();
      const dept = String(r.DegreeID || r.department || r.Department || r.DEPARTMENT || r.dept || r.Degree || '').trim();
      let cardUid = String(r.card_uid || r.Card_UID || r.CardUID || r.CARD_UID || '').trim();
      const fatherName = String(r.FatherName || r.father_name || r['Father Name'] || '').trim() || null;
      const cnic = String(r.CNIC || r.cnic || '').trim() || null;
      const phone = String(r.PhoneMobilePrimary || r.phone || r.Phone || r['Mobile No.'] || '').trim() || null;
      const gender = String(r.Gender || r.gender || '').trim() || null;
      const joiningSession = r.JoiningSession || r.joining_session || '';
      const email = String(r.Email || r.email || '').trim() || null;

      const sem = parseInt(r.semester || r.Semester || r.SEMESTER || 0);
      const sec = String(r.section || r.Section || r.SECTION || r['Class Section'] || 'A').trim();
      const status = String(r.status || r.Status || r.STATUS || 'active').trim().toLowerCase();
      let enrollYear = parseInt(r.enrollment_year || r.Enrollment_Year || 0) || null;
      let expiryYear = parseInt(r.expiry_year || r.Expiry_Year || 0) || null;

      if (!name || !rollNo) {
        errors.push(`Row ${i + 2}: Missing name or roll number`);
        continue;
      }

      // Auto-generate card_uid if not provided
      if (!cardUid) {
        cardUid = `LGU-${String(uidCounter).padStart(5, '0')}`;
        uidCounter++;
      }

      // Parse enrollment from joining session or roll number (e.g. "Fa26-ADP(AF)-001")
      if (joiningSession && (!enrollYear || !expiryYear)) {
        const parsed = parseJoiningSession(joiningSession);
        if (!enrollYear) enrollYear = parsed.enrollYear;
        if (!expiryYear) expiryYear = parsed.expiryYear;
      }
      if (!enrollYear && rollNo) {
        const rollMatch = rollNo.match(/^(Fa|Sp)(\d{2})-/i);
        if (rollMatch) {
          const yr = parseInt(rollMatch[2]);
          enrollYear = yr < 50 ? 2000 + yr : 1900 + yr;
          if (!expiryYear) expiryYear = enrollYear + 4;
        }
      }
      const finalSem = sem || (joiningSession ? parseJoiningSession(joiningSession).semester : 1);

      try {
        const validStatus = ['active', 'graduated', 'frozen', 'suspended', 'dropped'].includes(status) ? status : 'active';
        const defaultPhoto = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=200&background=random&bold=true`;

        const existingRoll = await queryOne('SELECT id, photo_url FROM students WHERE roll_number = $1', [rollNo]);
        if (existingRoll) {
          const keepPhoto = (existingRoll.photo_url && existingRoll.photo_url.startsWith('/photos/')) ? existingRoll.photo_url : defaultPhoto;
          await run(
            `UPDATE students SET name=$1, department=$2, semester=$3, section=$4, status=$5, photo_url=$6,
             enrollment_year=$7, expiry_year=$8, father_name=$9, cnic=$10, phone=$11, gender=$12 WHERE roll_number=$13`,
            [name, dept || 'Unknown', finalSem, sec, validStatus, keepPhoto, enrollYear, expiryYear,
             fatherName, cnic, phone, gender, rollNo]
          );
        } else {
          await run(
            `INSERT INTO students (card_uid, name, roll_number, department, semester, section, status, photo_url,
             enrollment_year, expiry_year, father_name, cnic, phone, gender)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [cardUid, name, rollNo, dept || 'Unknown', finalSem, sec, validStatus, defaultPhoto,
             enrollYear, expiryYear, fatherName, cnic, phone, gender]
          );
        }
        imported++;
      } catch (err) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, imported, errors: errors.slice(0, 20), total: rows.length });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- BULK STATUS UPDATE ---
app.post('/api/students/bulk-status', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  const defaultStatus = req.body.status || 'frozen';

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    let updated = 0;
    const notFound = [];

    for (const r of rows) {
      const rollNo = String(r.roll_number || r.Roll_Number || r.RollNumber || r.ROLL_NO || r.roll_no || '').trim();
      const cardUid = String(r.card_uid || r.Card_UID || r.CardUID || r.CARD_UID || '').trim();
      const rowStatus = String(r.status || r.Status || r.STATUS || defaultStatus).trim().toLowerCase();

      let found = false;
      if (rollNo) {
        const existing = await queryOne('SELECT id FROM students WHERE roll_number = $1', [rollNo]);
        if (existing) {
          await run('UPDATE students SET status = $1 WHERE roll_number = $2', [rowStatus, rollNo]);
          found = true;
        }
      }
      if (!found && cardUid) {
        const existing = await queryOne('SELECT id FROM students WHERE card_uid = $1', [cardUid]);
        if (existing) {
          await run('UPDATE students SET status = $1 WHERE card_uid = $2', [rowStatus, cardUid]);
          found = true;
        }
      }

      if (found) updated++;
      else notFound.push(rollNo || cardUid || 'unknown');
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, updated, notFound, total: rows.length });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- LOGS ---
app.get('/api/logs', requireAdmin, async (req, res) => {
  const { date, result, gate, page = 1, limit = 50 } = req.query;
  let where = '1=1';
  const params = [];
  let paramIdx = 1;

  if (date) {
    where += ` AND DATE(timestamp) = $${paramIdx}`;
    params.push(date);
    paramIdx++;
  }
  if (result) {
    where += ` AND result = $${paramIdx}`;
    params.push(result);
    paramIdx++;
  }
  if (gate) {
    where += ` AND gate_id = $${paramIdx}`;
    params.push(gate);
    paramIdx++;
  }

  const totalRow = await queryOne(`SELECT COUNT(*) as total FROM entry_logs WHERE ${where}`, params);
  const total = parseInt(totalRow.total);
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const logs = await query(
    `SELECT * FROM entry_logs WHERE ${where} ORDER BY timestamp DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, parseInt(limit), offset]
  );

  res.json({ logs, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

// --- STATS ---
function requireGateOrAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const session = adminSessions.get(token);
    if (session && session.expires > Date.now()) return next();
  }
  return requireGate(req, res, next);
}

app.get('/api/stats', requireGateOrAdmin, async (req, res) => {
  const total = (await queryOne('SELECT COUNT(*) as c FROM students')).c;
  const enrolled = (await queryOne("SELECT COUNT(*) as c FROM students WHERE status='active'")).c;
  const graduated = (await queryOne("SELECT COUNT(*) as c FROM students WHERE status='graduated'")).c;
  const frozen = (await queryOne("SELECT COUNT(*) as c FROM students WHERE status='frozen'")).c;
  const suspended = (await queryOne("SELECT COUNT(*) as c FROM students WHERE status='suspended'")).c;
  const dropped = (await queryOne("SELECT COUNT(*) as c FROM students WHERE status='dropped'")).c;

  const today = new Date().toISOString().split('T')[0];
  const entriesToday = (await queryOne("SELECT COUNT(*) as c FROM entry_logs WHERE DATE(timestamp) = $1", [today])).c;
  const allowedToday = (await queryOne("SELECT COUNT(*) as c FROM entry_logs WHERE DATE(timestamp) = $1 AND result='allowed'", [today])).c;
  const deniedToday = (await queryOne("SELECT COUNT(*) as c FROM entry_logs WHERE DATE(timestamp) = $1 AND result='denied'", [today])).c;

  const insideCampus = (await queryOne("SELECT COUNT(*) as c FROM students WHERE inside_campus = TRUE")).c;

  res.json({
    total: parseInt(total), enrolled: parseInt(enrolled), graduated: parseInt(graduated),
    frozen: parseInt(frozen), suspended: parseInt(suspended), dropped: parseInt(dropped),
    entriesToday: parseInt(entriesToday), allowedToday: parseInt(allowedToday), deniedToday: parseInt(deniedToday),
    insideCampus: parseInt(insideCampus)
  });
});

app.get('/api/alerts', requireAdmin, async (req, res) => {
  const { type, limit = 100, offset = 0 } = req.query;
  let where = '1=1';
  const params = [];
  let idx = 1;
  if (type) { where += ` AND alert_type = $${idx}`; params.push(type); idx++; }
  params.push(parseInt(limit), parseInt(offset));
  const rows = await query(`SELECT * FROM alerts WHERE ${where} ORDER BY timestamp DESC LIMIT $${idx} OFFSET $${idx + 1}`, params);
  const totalRow = await queryOne(`SELECT COUNT(*) as total FROM alerts WHERE ${where}`, type ? [type] : []);
  res.json({ alerts: rows, total: parseInt(totalRow.total) });
});

app.delete('/api/alerts', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM alerts');
  res.json({ success: true });
});

app.get('/api/stats/detailed', requireAdmin, async (req, res) => {
  const [
    genderRows, deptRows, statusRows, yearRows,
    dailyRows, hourlyRows, gatewiseRows
  ] = await Promise.all([
    query("SELECT COALESCE(NULLIF(gender,''), 'Unknown') as label, COUNT(*)::int as count FROM students GROUP BY label ORDER BY count DESC"),
    query("SELECT department as label, COUNT(*)::int as count FROM students GROUP BY department ORDER BY count DESC"),
    query("SELECT status as label, COUNT(*)::int as count FROM students GROUP BY status ORDER BY count DESC"),
    query("SELECT enrollment_year as label, COUNT(*)::int as count FROM students WHERE enrollment_year IS NOT NULL GROUP BY enrollment_year ORDER BY enrollment_year"),
    query("SELECT DATE(timestamp) as day, COUNT(*)::int as total, SUM(CASE WHEN result='allowed' THEN 1 ELSE 0 END)::int as allowed, SUM(CASE WHEN result='denied' THEN 1 ELSE 0 END)::int as denied FROM entry_logs WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY day ORDER BY day"),
    query("SELECT EXTRACT(HOUR FROM timestamp)::int as hour, COUNT(*)::int as count FROM entry_logs WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY hour ORDER BY hour"),
    query("SELECT COALESCE(gate_id,'main') as label, COUNT(*)::int as count FROM entry_logs WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY label ORDER BY count DESC"),
  ]);
  res.json({ gender: genderRows, departments: deptRows, status: statusRows, enrollmentYears: yearRows, dailyScans: dailyRows, peakHours: hourlyRows, gatewise: gatewiseRows });
});

// --- SYNC (for offline kiosk) ---
app.get('/api/sync', requireGate, async (req, res) => {
  const students = await query(
    'SELECT name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year, inside_campus, suspended_until, gender FROM students'
  );
  res.json({ students, synced_at: new Date().toISOString() });
});

// --- TIMETABLE ---
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

app.get('/api/timetable', requireAdmin, async (req, res) => {
  const { department, semester, section, day } = req.query;
  let where = '1=1';
  const params = [];
  let idx = 1;
  if (department) { where += ` AND department = $${idx}`; params.push(department); idx++; }
  if (semester) { where += ` AND semester = $${idx}`; params.push(parseInt(semester)); idx++; }
  if (section) { where += ` AND section = $${idx}`; params.push(section); idx++; }
  if (day) { where += ` AND day_of_week = $${idx}`; params.push(day.toLowerCase()); idx++; }
  const rows = await query(`SELECT * FROM timetable WHERE ${where} ORDER BY department, semester, section, day_of_week, time_start`, params);
  res.json(rows);
});

app.post('/api/timetable', requireAdmin, async (req, res) => {
  const { department, semester, section, day_of_week, time_start, time_end, subject, room, teacher } = req.body;
  try {
    await run(
      `INSERT INTO timetable (department, semester, section, day_of_week, time_start, time_end, subject, room, teacher)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [department, parseInt(semester), section || 'A', day_of_week.toLowerCase(), time_start, time_end, subject, room || null, teacher || null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/timetable/:id', requireAdmin, async (req, res) => {
  await run('DELETE FROM timetable WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.post('/api/timetable/clear', requireAdmin, async (req, res) => {
  const { department, semester, section } = req.body;
  let where = '1=1';
  const params = [];
  let idx = 1;
  if (department) { where += ` AND department = $${idx}`; params.push(department); idx++; }
  if (semester) { where += ` AND semester = $${idx}`; params.push(parseInt(semester)); idx++; }
  if (section) { where += ` AND section = $${idx}`; params.push(section); idx++; }
  const result = await pool.query(`DELETE FROM timetable WHERE ${where}`, params);
  res.json({ success: true, deleted: result.rowCount });
});

app.post('/api/timetable/import', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    let imported = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const dept = String(r.department || r.Department || r.DegreeID || r.degree || '').trim();
      const sem = parseInt(r.semester || r.Semester || r.sem || 0);
      const sec = String(r.section || r.Section || r.sec || 'A').trim();
      const day = String(r.day || r.Day || r.day_of_week || '').trim().toLowerCase();
      const timeStart = String(r.time_start || r.start || r.Start || r.from || '').trim();
      const timeEnd = String(r.time_end || r.end || r.End || r.to || '').trim();
      const subject = String(r.subject || r.Subject || r.course || r.Course || '').trim();
      const room = String(r.room || r.Room || r.venue || r.Venue || '').trim() || null;
      const teacher = String(r.teacher || r.Teacher || r.instructor || r.Instructor || '').trim() || null;

      if (!dept || !sem || !day || !timeStart || !timeEnd || !subject) {
        errors.push(`Row ${i + 2}: Missing required fields`);
        continue;
      }
      if (!DAYS.includes(day)) {
        errors.push(`Row ${i + 2}: Invalid day "${day}"`);
        continue;
      }

      try {
        await run(
          `INSERT INTO timetable (department, semester, section, day_of_week, time_start, time_end, subject, room, teacher)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [dept, sem, sec, day, timeStart, timeEnd, subject, room, teacher]
        );
        imported++;
      } catch (err) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, imported, errors: errors.slice(0, 20), total: rows.length });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- LGU TIMETABLE PORTAL SYNC ---
const PORTAL_HOST = 'timetable.lgu.edu.pk';
const PORTAL_PROGRAMS = {
  'BSCS': 1, 'BSSE': 2, 'BBA': 9, 'BSCMAI': 123, 'BSAI': 132,
  'BSEE': 3, 'BSME': 4, 'BSCE': 5, 'BArch': 6, 'BSIT': 7,
  'LLB': 8, 'BSAcc': 10, 'PharmD': 11, 'BDS': 12, 'MBBS': 13,
  'BSMS': 14, 'BSPsych': 15, 'BEd': 16, 'BSEM': 17
};
const SECTION_IDS = { 'A': 1, 'B': 2, 'C': 3, 'D': 4 };

function portalGet(urlPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: PORTAL_HOST,
      path: urlPath,
      method: 'GET'
    };
    const req = https.request(opts, (res) => {
      let html = '';
      res.on('data', chunk => html += chunk);
      res.on('end', () => resolve(html));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Portal request timeout')); });
    req.end();
  });
}

function portalPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body;
    const opts = {
      hostname: PORTAL_HOST,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(opts, (res) => {
      let html = '';
      res.on('data', chunk => html += chunk);
      res.on('end', () => resolve(html));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Portal request timeout')); });
    req.write(data);
    req.end();
  });
}

function parseTimetableHtml(html) {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const classes = [];

  for (const day of days) {
    const dayPattern = new RegExp(`>${day}<`, 'i');
    const dayMatch = dayPattern.exec(html);
    if (!dayMatch) continue;

    const dayIdx = dayMatch.index;
    const dayCapital = day.charAt(0).toUpperCase() + day.slice(1);
    const nextDayIdx = days.indexOf(day) < days.length - 1
      ? html.indexOf(`>${days[days.indexOf(day) + 1].charAt(0).toUpperCase() + days[days.indexOf(day) + 1].slice(1)}<`, dayIdx)
      : html.indexOf('</table>', dayIdx);
    const rowHtml = html.substring(dayIdx, nextDayIdx > 0 ? nextDayIdx : undefined);

    const tdRegex = /<td[^>]*>(?:(?!<td).)*?<span class='style2'>(.*?)<\/span>.*?<span class='style3'>(.*?)<\/span>.*?<span class='style4'>(.*?)<\/span>.*?<span class='style3'>(\d{2}:\d{2}\s*-\s*\d{2}:\d{2})<\/span>/gs;
    let match;
    while ((match = tdRegex.exec(rowHtml)) !== null) {
      const timeParts = match[4].split('-').map(t => t.trim());
      classes.push({
        day_of_week: day,
        subject: match[1].trim(),
        room: match[2].trim(),
        teacher: match[3].trim(),
        time_start: timeParts[0],
        time_end: timeParts[1]
      });
    }
  }
  return classes;
}

async function fetchPortalPrograms(semLabel) {
  try {
    const html = await portalPost('/Semesters/ajax.php', `semester=${encodeURIComponent(semLabel)}`);
    console.log(`[SYNC] ajax.php response for "${semLabel}": ${html.length} chars, starts: ${html.substring(0, 150).replace(/\n/g, ' ')}`);
    const programs = {};
    const optRegex = /<option value="(\d+)"[^>]*>([^<]+)<\/option>/g;
    let m;
    while ((m = optRegex.exec(html)) !== null) {
      const name = m[2].trim();
      if (name && name !== 'Select Program') {
        programs[name] = parseInt(m[1]);
      }
    }
    return programs;
  } catch (e) {
    console.log(`[SYNC] fetchPortalPrograms error for "${semLabel}": ${e.message}`);
    return {};
  }
}

async function fetchPortalSections(programId, semesterLabel) {
  try {
    const html = await portalPost('/Semesters/ajax.php', `program=${programId}&semester=${encodeURIComponent(semesterLabel)}`);
    const sections = {};
    const optRegex = /<option value="(\d+)"[^>]*>([^<]+)<\/option>/g;
    let m;
    while ((m = optRegex.exec(html)) !== null) {
      const name = m[2].trim();
      if (name && name !== 'Select Section') {
        sections[name] = parseInt(m[1]);
      }
    }
    return sections;
  } catch (e) {
    return {};
  }
}

app.post('/api/timetable/sync-portal', requireAdmin, async (req, res) => {
  const startTime = Date.now();
  const allClasses = [];
  const errors = [];
  const synced = [];

  try {
    const now = new Date();
    const curYear = now.getFullYear();
    const isFall = now.getMonth() >= 6;
    const sessionTag = `${isFall ? 'Fa' : 'Sp'}-${curYear}`;
    const ordinals = ['1st','2nd','3rd','4th','5th','6th','7th','8th'];
    const semOptions = [];
    for (let i = 0; i < 8; i++) {
      const yearsBack = Math.floor(i / 2);
      const joinYear = curYear - yearsBack;
      const joinSession = (i % 2 === 0) ? `Fa-${joinYear}` : `Sp-${joinYear}`;
      semOptions.push({
        label: `${ordinals[i]} Semester ${sessionTag} / ${joinSession}`,
        num: i + 1
      });
    }

    // Phase 1: Fetch all data into memory first
    console.log('[SYNC] Starting portal sync...');
    for (const { label: semValue, num: semNum } of semOptions) {
      let programs;
      try {
        programs = await fetchPortalPrograms(semValue);
      } catch (e) {
        console.log(`[SYNC] Failed to fetch programs for ${semValue}: ${e.message}`);
        errors.push(`Sem ${semNum} programs: ${e.message}`);
        continue;
      }
      if (Object.keys(programs).length === 0) {
        console.log(`[SYNC] No programs for: ${semValue}`);
        continue;
      }
      console.log(`[SYNC] Sem ${semNum}: ${Object.keys(programs).length} programs`);

      for (const [progName, progId] of Object.entries(programs)) {
        let sections;
        try {
          sections = await fetchPortalSections(progId, semValue);
        } catch (e) { sections = {}; }
        const sectionEntries = Object.keys(sections).length > 0
          ? Object.entries(sections)
          : Object.entries(SECTION_IDS);

        for (const [secName, secId] of sectionEntries) {
          try {
            const html = await portalPost('/Semesters/semester_info/SEMESTER_TIMETABLE.php',
              `semester=${encodeURIComponent(semValue)}&program=${progId}&section=${secId}`
            );
            const classes = parseTimetableHtml(html);
            if (classes.length === 0) continue;

            for (const c of classes) {
              allClasses.push([progName, semNum, secName, c.day_of_week, c.time_start, c.time_end, c.subject, c.room, c.teacher]);
            }
            synced.push(`${progName} Sem ${semNum} Sec ${secName}: ${classes.length} classes`);
          } catch (e) {
            errors.push(`${progName} Sem ${semNum} Sec ${secName}: ${e.message}`);
          }
        }
      }
    }

    console.log(`[SYNC] Fetched ${allClasses.length} classes total. Errors: ${errors.length}`);

    // Phase 2: Only replace DB data if we actually got something
    if (allClasses.length === 0) {
      return res.json({
        success: false,
        error: `Portal returned 0 classes. Existing timetable data preserved. ${errors.length} errors: ${errors.slice(0, 5).join('; ')}`,
        errors: errors.slice(0, 20)
      });
    }

    await run('DELETE FROM timetable');
    for (const row of allClasses) {
      await run(
        `INSERT INTO timetable (department, semester, section, day_of_week, time_start, time_end, subject, room, teacher)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, row
      );
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SYNC] Done: ${allClasses.length} classes in ${elapsed}s`);
    res.json({
      success: true, imported: allClasses.length,
      synced, errors: errors.slice(0, 20), elapsed_seconds: parseFloat(elapsed)
    });
  } catch (err) {
    console.error('[SYNC] Fatal error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Debug: test portal fetch (temporary)
app.get('/api/timetable/test-portal', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const curYear = now.getFullYear();
    const isFall = now.getMonth() >= 6;
    const sessionTag = `${isFall ? 'Fa' : 'Sp'}-${curYear}`;
    const semValue = `1st Semester ${sessionTag} / ${sessionTag}`;

    const programsHtml = await portalPost('/Semesters/ajax.php', `semester=${encodeURIComponent(semValue)}`);
    const programs = {};
    const optRegex = /<option value="(\d+)"[^>]*>([^<]+)<\/option>/g;
    let m;
    while ((m = optRegex.exec(programsHtml)) !== null) {
      const name = m[2].trim();
      if (name && name !== 'Select Program') programs[name] = parseInt(m[1]);
    }

    let ttHtml = '';
    let classes = [];
    const firstProg = Object.entries(programs)[0];
    if (firstProg) {
      ttHtml = await portalPost('/Semesters/semester_info/SEMESTER_TIMETABLE.php',
        `semester=${encodeURIComponent(semValue)}&program=${firstProg[1]}&section=1`
      );
      classes = parseTimetableHtml(ttHtml);
    }

    res.json({
      semValue,
      programsHtml: programsHtml.substring(0, 500),
      programCount: Object.keys(programs).length,
      programs,
      ttHtmlLength: ttHtml.length,
      ttHtmlSample: ttHtml.substring(0, 1000),
      classesFound: classes.length,
      classes: classes.slice(0, 5)
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Normalize department names for timetable lookup (portal name vs DB name)
app.get('/api/timetable/dept-map', requireAdmin, async (req, res) => {
  const dbDepts = await query('SELECT DISTINCT department FROM students ORDER BY department');
  const ttDepts = await query('SELECT DISTINCT department FROM timetable ORDER BY department');
  res.json({ student_departments: dbDepts.map(d => d.department), timetable_departments: ttDepts.map(d => d.department) });
});

// --- DEPARTMENTS ---
app.get('/api/departments', requireAdmin, async (req, res) => {
  const depts = await query('SELECT DISTINCT department FROM students ORDER BY department');
  res.json(depts.map(d => d.department));
});

app.get('/api/timetable/departments', requireAdmin, async (req, res) => {
  const depts = await query('SELECT DISTINCT department FROM timetable ORDER BY department');
  res.json(depts.map(d => d.department));
});

// --- MANUAL RESET (admin) ---
app.post('/api/reset-campus', requireAdmin, async (req, res) => {
  const result = await pool.query('UPDATE students SET inside_campus = FALSE WHERE inside_campus = TRUE');
  res.json({ success: true, reset: result.rowCount });
});

// --- AUTO RESET at closing time (default 10 PM PKT = 17:00 UTC) ---
const RESET_HOUR_UTC = parseInt(process.env.RESET_HOUR_UTC || '17');

function scheduleNightlyReset() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(RESET_HOUR_UTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

  const ms = next - now;
  console.log(`  Next campus reset at ${next.toISOString()} (in ${Math.round(ms / 60000)} min)`);

  setTimeout(async () => {
    try {
      const result = await pool.query('UPDATE students SET inside_campus = FALSE WHERE inside_campus = TRUE');
      console.log(`[AUTO-RESET] ${new Date().toISOString()} — Reset ${result.rowCount} students to outside`);
    } catch (e) {
      console.error('[AUTO-RESET] Failed:', e.message);
    }
    scheduleNightlyReset();
  }, ms);
}

// --- CARD REGISTRATION (Excel-based) ---
const REGISTER_EXCEL = fs.existsSync(PHOTOS_DIR) ? path.join(PHOTOS_DIR, 'enrolled_students.xlsx') : path.join(__dirname, 'data', 'enrolled_students.xlsx');

function loadExcel() {
  if (!fs.existsSync(REGISTER_EXCEL)) return null;
  const wb = XLSX.readFile(REGISTER_EXCEL);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const testRows = XLSX.utils.sheet_to_json(sheet);
  if (testRows.length && !testRows[0].StdRollNo && !testRows[0]['Student Roll No.'] && !testRows[0].roll_number) {
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const hdrIdx = rawRows.findIndex(r => r && r.length >= 3 &&
      r.some(c => /roll/i.test(String(c || ''))) && r.some(c => /name/i.test(String(c || ''))));
    if (hdrIdx > 0) {
      const newSheet = XLSX.utils.aoa_to_sheet(rawRows.slice(hdrIdx));
      wb.Sheets[wb.SheetNames[0]] = newSheet;
    }
  }
  return wb;
}

function exRoll(r) { return String(r.StdRollNo || r['Student Roll No.'] || r.roll_number || '').trim(); }
function exName(r) { return String(r.studentname || r['Student Name'] || r.name || '').trim(); }
function exDept(r) { return String(r.DegreeID || r.Degree || r.department || '').trim(); }
function exFather(r) { return String(r.FatherName || r['Father Name'] || r.father_name || '').trim(); }

function findStudentRow(wb, rollQuery) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  const q = rollQuery.trim().toUpperCase();
  return rows.find(r => {
    const roll = exRoll(r).toUpperCase();
    return roll === q || roll.includes(q);
  });
}

function getExcelStats(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  const total = rows.length;
  const mapped = rows.filter(r => r.CardUID && String(r.CardUID).trim()).length;
  return { total, mapped, remaining: total - mapped };
}

app.get('/api/register/stats', (req, res) => {
  const wb = loadExcel();
  if (!wb) return res.status(404).json({ error: 'Excel file not found. Upload it first.' });
  res.json(getExcelStats(wb));
});

app.get('/api/register/search', requireTeam, (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query required' });
  const wb = loadExcel();
  if (!wb) return res.status(404).json({ error: 'Excel file not found' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  const query = q.trim().toUpperCase();
  const matches = rows.filter(r => {
    return exRoll(r).toUpperCase().includes(query) || exName(r).toUpperCase().includes(query);
  }).slice(0, 10);
  res.json(matches.map(r => ({
    roll: exRoll(r),
    name: exName(r),
    father: exFather(r),
    degree: exDept(r),
    session: r.JoiningSession || '',
    gender: r.Gender || r.gender || '',
    cardUid: r.CardUID || null
  })));
});

app.post('/api/register/assign', requireTeam, async (req, res) => {
  const { roll_number, card_uid } = req.body;
  if (!roll_number || !card_uid) return res.status(400).json({ error: 'roll_number and card_uid required' });
  const wb = loadExcel();
  if (!wb) return res.status(404).json({ error: 'Excel file not found' });

  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  const q = roll_number.trim().toUpperCase();
  const uid = card_uid.trim().toUpperCase();

  const dupUid = rows.find(r => String(r.CardUID || '').toUpperCase() === uid);
  if (dupUid) return res.status(409).json({ error: `Card UID already assigned to ${exRoll(dupUid)} (${exName(dupUid)})` });

  const idx = rows.findIndex(r => exRoll(r).toUpperCase() === q);
  if (idx === -1) return res.status(404).json({ error: 'Roll number not found in Excel' });

  rows[idx].CardUID = uid;
  rows[idx].AssignedBy = req.teamMember ? req.teamMember.name : 'admin';
  rows[idx].AssignedAt = new Date().toISOString();
  const newWs = XLSX.utils.json_to_sheet(rows);
  wb.Sheets[wb.SheetNames[0]] = newWs;
  XLSX.writeFile(wb, REGISTER_EXCEL);

  const student = rows[idx];
  const name = exName(student);
  const roll = exRoll(student);
  const dept = exDept(student) || 'Unknown';
  const gender = student.Gender || student.gender || '';
  const phone = String(student['Mobile No.'] || student.PhoneMobilePrimary || student.phone || '').trim();
  const cnic = String(student.CNIC || student.cnic || '').trim();
  const father = exFather(student);
  const rollMatch = roll.match(/^(Fa|Sp)(\d{2})-/i);
  const enrollYear = rollMatch ? (parseInt(rollMatch[2]) < 50 ? 2000 + parseInt(rollMatch[2]) : 1900 + parseInt(rollMatch[2])) : null;
  const photoOnDisk = ['.jpeg','.jpg','.png'].map(e => path.join(PHOTOS_DIR, roll + e)).find(p => fs.existsSync(p));
  const photoUrl = photoOnDisk ? `/photos/${path.basename(photoOnDisk)}` : `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=200&background=random&bold=true`;

  try {
    const mappedBy = req.teamMember ? req.teamMember.name : 'admin';
    const existing = await queryOne('SELECT id FROM students WHERE roll_number = $1', [roll]);
    if (existing) {
      await run('UPDATE students SET card_uid = $1, mapped_by = $2, mapped_at = NOW() WHERE id = $3', [uid, mappedBy, existing.id]);
    } else {
      await run(
        `INSERT INTO students (card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, father_name, cnic, phone, gender)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [uid, name, roll, dept, 1, 'A', 'active', photoUrl, enrollYear, father, cnic, phone, gender]
      );
    }
  } catch (dbErr) {
    console.error('DB sync after card assign:', dbErr.message);
  }

  res.json({ success: true, student: { roll, name, cardUid: uid } });
});

app.post('/api/register/unassign', requireAdmin, (req, res) => {
  // Only admin can unassign
  const { roll_number } = req.body;
  if (!roll_number) return res.status(400).json({ error: 'roll_number required' });
  const wb = loadExcel();
  if (!wb) return res.status(404).json({ error: 'Excel file not found' });

  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  const q = roll_number.trim().toUpperCase();
  const idx = rows.findIndex(r => exRoll(r).toUpperCase() === q);
  if (idx === -1) return res.status(404).json({ error: 'Roll number not found' });

  rows[idx].CardUID = '';
  const newWs = XLSX.utils.json_to_sheet(rows);
  wb.Sheets[wb.SheetNames[0]] = newWs;
  XLSX.writeFile(wb, REGISTER_EXCEL);

  res.json({ success: true });
});

app.get('/api/register/recent', requireTeam, (req, res) => {
  const wb = loadExcel();
  if (!wb) return res.status(404).json({ error: 'Excel file not found' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  const mapped = rows.filter(r => r.CardUID && String(r.CardUID).trim())
    .map(r => ({ roll: exRoll(r), name: exName(r), degree: exDept(r), cardUid: r.CardUID }));
  res.json(mapped);
});

app.get('/api/register/download', (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').slice(7);
  const session = adminSessions.get(token);
  if (!session || session.expires < Date.now()) return res.status(401).json({ error: 'Admin login required' });
  if (!fs.existsSync(REGISTER_EXCEL)) return res.status(404).json({ error: 'No Excel file found' });
  res.download(REGISTER_EXCEL, 'enrolled_students_mapped.xlsx');
});

app.get('/api/students/export', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT card_uid, name, roll_number, department, semester, section, status, enrollment_year, expiry_year, phone, cnic, gender, mapped_by, mapped_at
     FROM students ORDER BY roll_number`
  );
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=students_export.xlsx');
  res.send(buf);
});

const photoUpload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 } });
app.post('/api/students/upload-photos', requireAdmin, photoUpload.array('photos', 50), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No photos uploaded' });
  let matched = 0, notFound = 0;
  const errors = [];
  for (const file of req.files) {
    const rollNo = path.basename(file.originalname, path.extname(file.originalname)).trim();
    const ext = path.extname(file.originalname).toLowerCase() || '.jpeg';
    const student = await queryOne('SELECT id FROM students WHERE UPPER(roll_number) = $1', [rollNo.toUpperCase()]);
    if (student) {
      const dest = path.join(PHOTOS_DIR, `${rollNo}${ext}`);
      fs.copyFileSync(file.path, dest); fs.unlinkSync(file.path);
      const photoUrl = `/photos/${rollNo}${ext}`;
      await run('UPDATE students SET photo_url = $1 WHERE id = $2', [photoUrl, student.id]);
      matched++;
    } else {
      errors.push(rollNo);
      notFound++;
      fs.unlinkSync(file.path);
    }
  }
  res.json({ success: true, matched, notFound, errors: errors.slice(0, 20), total: req.files.length });
});

app.post('/api/students/bulk-photo-upload', photoUpload.array('photos', 50), async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  if (!token || token !== GATE_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No photos' });
  let matched = 0, notFound = 0;
  const errors = [];
  for (const file of req.files) {
    const rollNo = path.basename(file.originalname, path.extname(file.originalname)).trim();
    const ext = path.extname(file.originalname).toLowerCase() || '.jpeg';
    const student = await queryOne('SELECT id FROM students WHERE UPPER(roll_number) = $1', [rollNo.toUpperCase()]);
    if (student) {
      const dest = path.join(PHOTOS_DIR, `${rollNo}${ext}`);
      fs.copyFileSync(file.path, dest); fs.unlinkSync(file.path);
      await run('UPDATE students SET photo_url = $1 WHERE id = $2', [`/photos/${rollNo}${ext}`, student.id]);
      matched++;
    } else { errors.push(rollNo); notFound++; fs.unlinkSync(file.path); }
  }
  res.json({ success: true, matched, notFound, errors: errors.slice(0, 20), total: req.files.length });
});

app.post('/api/students/sync-photos', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  if (!token || token !== GATE_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  try {
    const files = fs.readdirSync(PHOTOS_DIR).filter(f => /\.(jpeg|jpg|png)$/i.test(f));
    let updated = 0;
    for (const f of files) {
      const rollNo = path.basename(f, path.extname(f)).trim();
      const photoUrl = `/photos/${f}`;
      const r = await pool.query('UPDATE students SET photo_url = $1 WHERE UPPER(roll_number) = $2', [photoUrl, rollNo.toUpperCase()]);
      if (r.rowCount > 0) updated++;
    }
    res.json({ success: true, totalPhotos: files.length, updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/diagnostics', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  if (!token || token !== GATE_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  try {
    const total = await queryOne('SELECT COUNT(*) as c FROM students');
    const withCard = await queryOne('SELECT COUNT(*) as c FROM students WHERE card_uid IS NOT NULL');
    const withPhoto = await queryOne('SELECT COUNT(*) as c FROM students WHERE photo_url LIKE $1', ['/photos/%']);
    const withAvatar = await queryOne('SELECT COUNT(*) as c FROM students WHERE photo_url LIKE $1', ['https://ui-avatars%']);
    const noPhoto = await queryOne('SELECT COUNT(*) as c FROM students WHERE photo_url IS NULL');
    const dups = await pool.query('SELECT roll_number, COUNT(*) as c FROM students GROUP BY roll_number HAVING COUNT(*) > 1');
    const photoFiles = fs.existsSync(PHOTOS_DIR) ? fs.readdirSync(PHOTOS_DIR).filter(f => /\.(jpeg|jpg|png)$/i.test(f)).length : 0;
    const excelExists = fs.existsSync(REGISTER_EXCEL);
    const teams = await pool.query('SELECT id, name FROM team_members');
    const gates = await pool.query("SELECT DISTINCT gate_id FROM scan_logs ORDER BY gate_id") .catch(() => ({rows:[]}));
    const realMapped = await pool.query("SELECT name, roll_number, card_uid, mapped_by, mapped_at FROM students WHERE mapped_by IS NOT NULL ORDER BY mapped_at DESC LIMIT 20");
    res.json({
      students: { total: +total.c, withCard: +withCard.c, withRealPhoto: +withPhoto.c, withAvatarUrl: +withAvatar.c, noPhoto: +noPhoto.c },
      photos: { filesOnDisk: photoFiles },
      duplicateRolls: dups.rows,
      realMapped: realMapped.rows,
      registerExcel: excelExists,
      teamMembers: teams.rows,
      activeGates: gates.rows.map(r => r.gate_id)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/students/import-server', requireAdmin, async (req, res) => {
  const filePath = path.join(__dirname, 'data', 'enrolled_students.xlsx');
  if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'No server file found at data/enrolled_students.xlsx' });
  try {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    let rows = XLSX.utils.sheet_to_json(sheet);

    if (rows.length && !rows[0].studentname && !rows[0].name && !rows[0].Name && !rows[0]['Student Name']
        && !rows[0].StdRollNo && !rows[0].roll_number && !rows[0]['Student Roll No.']) {
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const headerIdx = rawRows.findIndex(r => r && r.length >= 3 &&
        r.some(c => /roll/i.test(String(c || ''))) && r.some(c => /name/i.test(String(c || ''))));
      if (headerIdx > 0) {
        const newSheet = XLSX.utils.aoa_to_sheet(rawRows.slice(headerIdx));
        rows = XLSX.utils.sheet_to_json(newSheet);
      }
    }

    let imported = 0;
    const errors = [];
    const maxIdRow = await queryOne("SELECT COALESCE(MAX(id), 0) as m FROM students");
    let uidCounter = parseInt(maxIdRow.m) + 1;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = String(r.studentname || r.name || r.Name || r.STUDENT_NAME || r.student_name || r['Student Name'] || '').trim();
      const rollNo = String(r.StdRollNo || r.roll_number || r.Roll_Number || r.RollNumber || r.ROLL_NO || r.roll_no || r['Student Roll No.'] || '').trim();
      const dept = String(r.DegreeID || r.department || r.Department || r.DEPARTMENT || r.dept || r.Degree || '').trim();
      let cardUid = String(r.card_uid || r.Card_UID || r.CardUID || r.CARD_UID || '').trim();
      const fatherName = String(r.FatherName || r.father_name || r['Father Name'] || '').trim() || null;
      const cnic = String(r.CNIC || r.cnic || '').trim() || null;
      const phone = String(r.PhoneMobilePrimary || r.phone || r.Phone || r['Mobile No.'] || '').trim() || null;
      const gender = String(r.Gender || r.gender || '').trim() || null;
      const joiningSession = r.JoiningSession || r.joining_session || '';
      const sem = parseInt(r.semester || r.Semester || r.SEMESTER || 0);
      const sec = String(r.section || r.Section || r.SECTION || r['Class Section'] || 'A').trim();
      const status = String(r.status || r.Status || r.STATUS || 'active').trim().toLowerCase();
      let enrollYear = parseInt(r.enrollment_year || r.Enrollment_Year || 0) || null;
      let expiryYear = parseInt(r.expiry_year || r.Expiry_Year || 0) || null;

      if (!name || !rollNo) { errors.push(`Row ${i + 2}: Missing name or roll number`); continue; }
      if (!cardUid) { cardUid = `LGU-${String(uidCounter).padStart(5, '0')}`; uidCounter++; }

      if (joiningSession && (!enrollYear || !expiryYear)) {
        const parsed = parseJoiningSession(joiningSession);
        if (!enrollYear) enrollYear = parsed.enrollYear;
        if (!expiryYear) expiryYear = parsed.expiryYear;
      }
      if (!enrollYear && rollNo) {
        const rollMatch = rollNo.match(/^(Fa|Sp)(\d{2})-/i);
        if (rollMatch) {
          const yr = parseInt(rollMatch[2]);
          enrollYear = yr < 50 ? 2000 + yr : 1900 + yr;
          if (!expiryYear) expiryYear = enrollYear + 4;
        }
      }
      const finalSem = sem || (joiningSession ? parseJoiningSession(joiningSession).semester : 1);

      try {
        const validStatus = ['active', 'graduated', 'frozen', 'suspended', 'dropped'].includes(status) ? status : 'active';
        const photoUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=200&background=random&bold=true`;
        const existingRoll = await queryOne('SELECT id FROM students WHERE roll_number = $1', [rollNo]);
        if (existingRoll) {
          await run(
            `UPDATE students SET name=$1, department=$2, semester=$3, section=$4, status=$5, photo_url=$6,
             enrollment_year=$7, expiry_year=$8, father_name=$9, cnic=$10, phone=$11, gender=$12 WHERE roll_number=$13`,
            [name, dept || 'Unknown', finalSem, sec, validStatus, photoUrl, enrollYear, expiryYear, fatherName, cnic, phone, gender, rollNo]
          );
        } else {
          await run(
            `INSERT INTO students (card_uid, name, roll_number, department, semester, section, status, photo_url,
             enrollment_year, expiry_year, father_name, cnic, phone, gender)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [cardUid, name, rollNo, dept || 'Unknown', finalSem, sec, validStatus, photoUrl, enrollYear, expiryYear, fatherName, cnic, phone, gender]
          );
        }
        imported++;
      } catch (err) { errors.push(`Row ${i + 2}: ${err.message}`); }
    }
    res.json({ success: true, imported, errors: errors.slice(0, 20), total: rows.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/students/import-gate', upload.single('file'), async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  if (!token || token !== GATE_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    let rows = XLSX.utils.sheet_to_json(sheet);
    if (rows.length && !rows[0].studentname && !rows[0].name && !rows[0].Name && !rows[0]['Student Name']
        && !rows[0].StdRollNo && !rows[0].roll_number && !rows[0]['Student Roll No.']) {
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const headerIdx = rawRows.findIndex(r => r && r.length >= 3 &&
        r.some(c => /roll/i.test(String(c || ''))) && r.some(c => /name/i.test(String(c || ''))));
      if (headerIdx > 0) {
        const newSheet = XLSX.utils.aoa_to_sheet(rawRows.slice(headerIdx));
        rows = XLSX.utils.sheet_to_json(newSheet);
      }
    }
    let imported = 0, uidCounter = 1;
    const maxUid = await queryOne("SELECT MAX(CAST(SUBSTRING(card_uid FROM 5) AS INTEGER)) as m FROM students WHERE card_uid LIKE 'LGU-%'");
    if (maxUid && maxUid.m) uidCounter = maxUid.m + 1;
    const errors = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = String(r.studentname || r['Student Name'] || r.name || '').trim();
      const rollNo = String(r.StdRollNo || r['Student Roll No.'] || r.roll_number || '').trim();
      const dept = String(r.DegreeID || r.Degree || r.department || '').trim();
      let cardUid = String(r.card_uid || r.CardUID || '').trim();
      const fatherName = String(r.FatherName || r['Father Name'] || '').trim() || null;
      const cnic = String(r.CNIC || r.cnic || '').trim() || null;
      const phone = String(r['Mobile No.'] || r.PhoneMobilePrimary || r.phone || '').trim() || null;
      const gender = String(r.Gender || r.gender || '').trim() || null;
      const sec = String(r['Class Section'] || r.section || 'A').trim();
      if (!name || !rollNo) { errors.push(`Row ${i+2}: missing name/roll`); continue; }
      if (!cardUid) { cardUid = `LGU-${String(uidCounter).padStart(5,'0')}`; uidCounter++; }
      let enrollYear = null, expiryYear = null;
      const rm = rollNo.match(/^(Fa|Sp)(\d{2})-/i);
      if (rm) { const yr = parseInt(rm[2]); enrollYear = yr < 50 ? 2000+yr : 1900+yr; expiryYear = enrollYear+4; }
      const defaultPhoto = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=200&background=random&bold=true`;
      try {
        const existing = await queryOne('SELECT id, photo_url FROM students WHERE roll_number = $1', [rollNo]);
        if (existing) {
          const keepPhoto = (existing.photo_url && existing.photo_url.startsWith('/photos/')) ? existing.photo_url : defaultPhoto;
          await run('UPDATE students SET name=$1, department=$2, semester=$3, section=$4, photo_url=$5, enrollment_year=$6, expiry_year=$7, father_name=$8, cnic=$9, phone=$10, gender=$11 WHERE roll_number=$12',
            [name, dept||'Unknown', 1, sec, keepPhoto, enrollYear, expiryYear, fatherName, cnic, phone, gender, rollNo]);
        } else {
          await run('INSERT INTO students (card_uid,name,roll_number,department,semester,section,status,photo_url,enrollment_year,expiry_year,father_name,cnic,phone,gender) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
            [cardUid, name, rollNo, dept||'Unknown', 1, sec, 'active', defaultPhoto, enrollYear, expiryYear, fatherName, cnic, phone, gender]);
        }
        imported++;
      } catch (err) { errors.push(`Row ${i+2}: ${err.message}`); }
    }
    fs.unlinkSync(req.file.path);
    res.json({ success: true, imported, total: rows.length, errors: errors.slice(0, 20) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/register/upload', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(req.file.path, REGISTER_EXCEL); fs.unlinkSync(req.file.path);
  const wb = loadExcel();
  res.json({ success: true, stats: getExcelStats(wb) });
});

app.post('/api/register/upload-gate', upload.single('file'), (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  if (!token || token !== GATE_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(req.file.path, REGISTER_EXCEL); fs.unlinkSync(req.file.path);
  const wb = loadExcel();
  res.json({ success: true, stats: getExcelStats(wb) });
});

// --- TEAM MEMBERS (for registration tool) ---
const teamSessions = new Map();

app.post('/api/team/login', rateLimitLogin, async (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });
  try {
    const result = await pool.query(
      'SELECT id, name, status FROM team_members WHERE LOWER(name) = LOWER($1) AND pin = $2', [name.trim(), pin.trim()]
    );
    if (!result.rows.length) {
      recordFailedLogin(req.ip);
      return res.status(403).json({ error: 'Wrong name or PIN' });
    }
    loginAttempts.delete(req.ip);
    const member = result.rows[0];
    if (member.status !== 'approved') return res.status(403).json({ error: 'Your account is pending approval. Contact admin.' });
    const token = generateToken();
    teamSessions.set(token, { id: member.id, name: member.name, expires: Date.now() + 12 * 60 * 60 * 1000 });
    res.json({ token, name: member.name });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

function requireTeam(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Login required' });
  const token = auth.slice(7);
  const session = teamSessions.get(token);
  if (!session || session.expires < Date.now()) {
    teamSessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.teamMember = session;
  next();
}

// Admin: create team member
app.post('/api/team/create', requireAdmin, async (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });
  try {
    const existing = await pool.query('SELECT id FROM team_members WHERE LOWER(name) = LOWER($1)', [name.trim()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Name already exists' });
    await pool.query('INSERT INTO team_members (name, pin, status) VALUES ($1, $2, $3)', [name.trim(), pin.trim(), 'approved']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Admin: list team members
app.get('/api/team/list', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT id, name, status, created_at FROM team_members ORDER BY created_at DESC');
  res.json(result.rows);
});

// Admin: remove team member
app.delete('/api/team/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM team_members WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// --- AIT DEVICE USER MANAGEMENT ---
app.get('/api/ait/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.enrollid, a.name, a.device_sn, a.student_id, a.synced_at,
            s.name AS student_name, s.roll_number
     FROM ait_users a LEFT JOIN students s ON a.student_id = s.id
     ORDER BY a.enrollid::int`
  );
  res.json(rows);
});

app.post('/api/ait/link', requireAdmin, async (req, res) => {
  const { enrollid, student_id } = req.body;
  if (!enrollid || !student_id) return res.status(400).json({ error: 'enrollid and student_id required' });
  await run('UPDATE students SET ait_pin = $1 WHERE id = $2', [String(enrollid), student_id]);
  await run('UPDATE ait_users SET student_id = $1 WHERE enrollid = $2', [student_id, String(enrollid)]);
  res.json({ success: true });
});

app.post('/api/ait/unlink', requireAdmin, async (req, res) => {
  const { enrollid } = req.body;
  if (!enrollid) return res.status(400).json({ error: 'enrollid required' });
  await run('UPDATE students SET ait_pin = NULL WHERE ait_pin = $1', [String(enrollid)]);
  await run('UPDATE ait_users SET student_id = NULL WHERE enrollid = $1', [String(enrollid)]);
  res.json({ success: true });
});

// --- AIT / YUNATT PUSH PROTOCOL ---
const aitProcessedLogs = new Set();
const aitPunchCooldown = new Map();
const aitLastVerdict = new Map();
const AIT_COOLDOWN_MS = 10000;

// In access-control mode the device blocks on a server verdict before opening.
// No public spec for this firmware, so send the known field aliases at once —
// the device ignores the ones it doesn't use. `result` stays true (= request
// handled); `access`/`opendoor` carry the actual allow/deny.
function aitAccessResponse(cmd, pin, verdict, extra = {}) {
  const granted = !verdict || verdict.result === 'allowed';
  return {
    ret: cmd,
    result: true,
    access: granted ? 1 : 0,
    opendoor: granted ? 1 : 0,
    enrollid: pin ? (parseInt(pin, 10) || pin) : undefined,
    message: verdict ? verdict.message : undefined,
    ...extra
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of aitPunchCooldown) if (v < now - 120000) aitPunchCooldown.delete(k);
  if (aitProcessedLogs.size > 5000) aitProcessedLogs.clear();
  for (const [t, s] of adminSessions) if (s.expires < now) adminSessions.delete(t);
  for (const [t, s] of teamSessions) if (s.expires < now) teamSessions.delete(t);
  for (const [ip, r] of loginAttempts) if (now - r.first >= LOCKOUT_MS) loginAttempts.delete(ip);
}, 60000);
app.post('/pub/api', async (req, res) => {
  const data = req.body;
  const cmd = data && data.cmd;
  const sn = data && data.sn;
  if (!deviceAllowed(sn)) {
    console.warn(`[ait] REJECTED unknown device sn=${sn} ip=${req.ip} cmd=${cmd}`);
    return res.status(403).json({ ret: cmd || 'unknown', result: false });
  }
  console.log(`[ait] POST /pub/api cmd=${cmd} sn=${sn} body=${JSON.stringify(data).substring(0, 1000)}`);

  // Device registration / heartbeat
  if (cmd === 'reg') {
    console.log(`[ait] Device ${sn} registering — model=${data.devinfo?.modelname} fw=${data.devinfo?.firmware} users=${data.devinfo?.useduser} logs=${data.devinfo?.usednewlog}`);
    return res.json({
      ret: 'reg',
      result: true,
      cloudtime: new Date().toISOString().replace('T', ' ').substring(0, 19),
      nosenduser: false,
      nosendlog: false,
      cloudSn: sn,
      realtime: 1,
      transinterval: 1,
      selfcheck: 0,
      attstate: 0,
      showstate: 0,
      manualstate: 0
    });
  }

  // Heartbeat / keepalive
  if (cmd === 'checklive') {
    return res.json({
      ret: 'checklive',
      result: true,
      cloudtime: new Date().toISOString().replace('T', ' ').substring(0, 19)
    });
  }

  // Attendance log push
  if (cmd === 'sendlog') {
    const records = data.record || data.records || [];
    const logArr = Array.isArray(records) ? records : [records];
    console.log(`[ait] Received ${logArr.length} log records`);
    let lastPin = '', lastVerdict = null;
    for (const rec of logArr) {
      const pin = String(rec.enrollid || rec.pin || rec.userId || rec.empCode || rec.id || '').toUpperCase();
      if (!pin) continue;
      lastPin = pin;
      const logKey = `${pin}:${rec.time || rec.logtime}`;
      if (aitProcessedLogs.has(logKey)) {
        lastVerdict = aitLastVerdict.get(pin) || lastVerdict;
        continue;
      }
      aitProcessedLogs.add(logKey);
      console.log(`[ait] Log: pin=${pin} name=${rec.name} mode=${rec.mode} time=${rec.time || rec.logtime}`);
      lastVerdict = await processAitPunch(pin, rec.name);
    }
    return res.json(aitAccessResponse('sendlog', lastPin, lastVerdict, { count: logArr.length }));
  }

  // Real-time event push
  if (cmd === 'sendrtlog' || cmd === 'rtlog') {
    const rec = data.record || data;
    const pin = String(rec.enrollid || rec.pin || rec.userId || rec.empCode || '').toUpperCase();
    console.log(`[ait] Realtime log: pin=${pin} name=${rec.name} mode=${rec.mode} time=${rec.time || rec.logtime}`);
    const verdict = pin ? await processAitPunch(pin, rec.name) : null;
    return res.json(aitAccessResponse(cmd, pin, verdict));
  }

  // User sync — store device-enrolled users for admin mapping
  if (cmd === 'senduser' || cmd === 'senduserinfo') {
    const enrollid = String(data.enrollid || '');
    const name = data.name || '';
    if (enrollid) {
      try {
        await run(
          `INSERT INTO ait_users (enrollid, name, device_sn, synced_at) VALUES ($1, $2, $3, NOW())
           ON CONFLICT (enrollid) DO UPDATE SET name = $2, device_sn = $3, synced_at = NOW()`,
          [enrollid, name, sn]
        );
        console.log(`[ait] Stored device user: enrollid=${enrollid} name=${name}`);
      } catch (e) {
        console.log(`[ait] Failed to store device user: ${e.message}`);
      }
    }
    return res.json({ ret: cmd, result: true });
  }

  // Default response for any other command
  console.log(`[ait] Unknown cmd: ${cmd}`);
  res.json({ ret: cmd || 'unknown', result: true, returnCode: 0 });
});

app.get('/pub/api', (req, res) => {
  console.log(`[ait] GET /pub/api query=${JSON.stringify(req.query)}`);
  res.json({ ret: 'reg', result: true, returnCode: 0 });
});

// Catch-all for any other AIT/Yunatt paths
app.all('/pub/*', (req, res) => {
  console.log(`[ait] ${req.method} ${req.path} body=${JSON.stringify(req.body).substring(0, 500)}`);
  res.json({ ret: 'ok', result: true, returnCode: 0 });
});

async function processAitPunch(pin, deviceName) {
  const now = Date.now();
  const lastPunch = aitPunchCooldown.get(pin);
  if (lastPunch && now - lastPunch < AIT_COOLDOWN_MS) {
    return aitLastVerdict.get(pin) || { result: 'allowed', message: 'OK' };
  }
  aitPunchCooldown.set(pin, now);

  let student = await queryOne(
    `SELECT id, card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year, inside_campus, suspended_until
     FROM students WHERE UPPER(card_uid) = $1 OR UPPER(roll_number) = $1 OR ait_pin = $1`,
    [pin]
  );

  // Auto-link: device sends short name (e.g. "ZARYAB"), DB has full name ("Muhammad Zaryab Malik")
  if (!student && deviceName) {
    const nameParts = deviceName.trim().split(/\s+/).filter(Boolean);
    if (nameParts.length) {
      const likePattern = '%' + nameParts.map(p => p.toUpperCase()).join('%') + '%';
      student = await queryOne(
        `SELECT id, card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year, inside_campus, suspended_until
         FROM students WHERE UPPER(name) LIKE $1 AND ait_pin IS NULL LIMIT 1`,
        [likePattern]
      );
    }
    if (student) {
      await run('UPDATE students SET ait_pin = $1 WHERE id = $2', [pin, student.id]);
      console.log(`[ait] Auto-linked enrollid=${pin} to student ${student.name} (${student.roll_number})`);
    }
  }
  const gate = 'gate4';
  let result, message;

  if (!student) {
    result = 'unknown'; message = 'UNREGISTERED CARD';
    await run(
      `INSERT INTO entry_logs (card_uid, student_id, student_name, roll_number, status_at_entry, result, scan_mode, gate_id)
       VALUES ($1, NULL, NULL, NULL, NULL, $2, $3, $4)`,
      [pin, result, 'entry', gate]
    );
    sendAlert({
      timestamp: new Date().toISOString(),
      alert_type: 'unknown_card', severity: 'critical',
      student_name: null, roll_number: null, gate_id: gate,
      title: 'UNREGISTERED CARD', detail: `Unknown PIN ${pin} from AIT device`
    });
    broadcast('scan', {
      type: 'scan', timestamp: new Date().toISOString(), card_uid: pin,
      found: false, result, mode: 'entry', gate_id: gate, message
    });
    const verdict = { result, message };
    aitLastVerdict.set(pin, verdict);
    return verdict;
  }

  const scanMode = student.inside_campus ? 'exit' : 'entry';
  const currentYear = new Date().getFullYear();
  const isExpired = student.expiry_year && currentYear > student.expiry_year;

  if (scanMode === 'exit') {
    result = 'allowed'; message = 'EXIT RECORDED — GOODBYE';
    await run('UPDATE students SET inside_campus = FALSE WHERE id = $1', [student.id]);
    student.inside_campus = false;
  } else if (isExpired) {
    result = 'denied'; message = `CARD EXPIRED (${student.enrollment_year}-${student.expiry_year})`;
  } else if (student.status === 'suspended' && student.suspended_until && new Date(student.suspended_until) > new Date()) {
    result = 'denied';
    const daysLeft = Math.ceil((new Date(student.suspended_until) - new Date()) / 86400000);
    message = `SUSPENDED — ${daysLeft} DAY${daysLeft !== 1 ? 'S' : ''} LEFT`;
  } else if (student.status !== 'active') {
    result = 'denied'; message = student.status.toUpperCase() + ' — ENTRY DENIED';
  } else {
    result = 'allowed'; message = 'ENROLLED STUDENT — ENTRY ALLOWED';
    await run('UPDATE students SET inside_campus = TRUE WHERE id = $1', [student.id]);
    student.inside_campus = true;
  }

  let currentSem = student.semester;
  const rollMatch = student.roll_number && student.roll_number.match(/^(Fa|Sp)-(\d{4})\//i);
  if (rollMatch) {
    const startFall = rollMatch[1].toLowerCase() === 'fa';
    const startYear = parseInt(rollMatch[2]);
    const now = new Date();
    const curYear = now.getFullYear();
    const curFall = now.getMonth() >= 7;
    currentSem = startFall
      ? (curFall ? (curYear - startYear) * 2 + 1 : (curYear - startYear) * 2)
      : (curFall ? (curYear - startYear) * 2 + 2 : (curYear - startYear) * 2 + 1);
    if (currentSem < 1) currentSem = 1;
  }
  student.current_semester = currentSem;

  await run(
    `INSERT INTO entry_logs (card_uid, student_id, student_name, roll_number, status_at_entry, result, scan_mode, gate_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [student.card_uid || pin, student.id, student.name, student.roll_number, student.status, result, scanMode, gate]
  );

  const { id: _id, card_uid: _cuid, ...safeStudent } = student;
  broadcast('scan', {
    type: 'scan', timestamp: new Date().toISOString(),
    found: true, result, message, mode: scanMode, gate_id: gate,
    student_name: student.name, roll_number: student.roll_number,
    department: student.department, photo_url: student.photo_url,
    student: safeStudent
  });

  if (result === 'denied') {
    sendAlert({
      timestamp: new Date().toISOString(),
      alert_type: student.status === 'suspended' ? 'suspended_entry' : 'denied_entry',
      severity: 'warning', student_name: student.name,
      roll_number: student.roll_number, department: student.department,
      photo_url: student.photo_url, gate_id: gate,
      title: message, detail: `${student.name} (${student.roll_number}) — ${message}`
    });
  }

  const verdict = { result, message, name: student.name };
  aitLastVerdict.set(pin, verdict);
  return verdict;
}

// --- ICLOCK / ZKTeco PUSH PROTOCOL (AIT device integration) ---
// The device pushes attendance records here and polls for commands.
// Raw body parsing for iclock routes (device sends form-encoded or plain text)
const iclockRaw = express.raw({ type: '*/*', limit: '1mb' });

// Device handshake — GET /iclock/cdata?SN=xxx
// Device calls this on boot to register itself and get config
app.get('/iclock/cdata', (req, res) => {
  const sn = req.query.SN || req.query.sn || 'unknown';
  if (!deviceAllowed(sn)) {
    console.warn(`[iclock] REJECTED handshake from unknown device sn=${sn} ip=${req.ip}`);
    return res.status(403).send('ERROR');
  }
  console.log(`[iclock] Device ${sn} connected — handshake`);
  // Response tells device: push mode, timezone offset, stamp for new logs
  res.set('Content-Type', 'text/plain');
  res.send([
    'GET OPTION FROM: ' + sn,
    'Stamp=9999',
    'OpStamp=9999',
    'PhotoStamp=9999',
    'ErrorDelay=30',
    'Delay=3',
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog\tOpLog\tAttPhoto\tEnrollUser\tChgUser\tEnrollFP\tChgFP\tFACE\tUserPic',
    'TimeZone=5',
    'Realtime=1',
    'Encrypt=0',
    ''
  ].join('\r\n'));
});

// Device pushes attendance/scan records — POST /iclock/cdata?SN=xxx&table=ATTLOG
app.post('/iclock/cdata', iclockRaw, async (req, res) => {
  const sn = req.query.SN || req.query.sn || 'unknown';
  const table = (req.query.table || '').toUpperCase();
  const body = req.body ? req.body.toString('utf8') : '';

  if (!deviceAllowed(sn)) {
    console.warn(`[iclock] REJECTED unknown device sn=${sn} ip=${req.ip}`);
    return res.status(403).send('ERROR');
  }

  console.log(`[iclock] POST from ${sn} table=${table} body=${body.substring(0, 200)}`);

  if (table === 'ATTLOG' && body.trim()) {
    // Each line: PIN\ttimestamp\tstatus\tverify\tworkcode\treserved
    const lines = body.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().split('\t');
      if (parts.length < 2) continue;

      const pin = parts[0].trim();
      const timestamp = parts[1] ? parts[1].trim() : new Date().toISOString();
      const status = parts[2] ? parseInt(parts[2]) : 0;
      const verify = parts[3] ? parseInt(parts[3]) : 0;

      console.log(`[iclock] Punch: PIN=${pin} time=${timestamp} status=${status} verify=${verify}`);

      // PIN is the user ID on the device — match to student by card_uid or roll_number
      const uid = pin.toUpperCase();
      const student = await queryOne(
        `SELECT id, card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year, inside_campus, suspended_until
         FROM students WHERE UPPER(card_uid) = $1 OR UPPER(roll_number) = $1`,
        [uid]
      );

      let result, message;
      if (!student) {
        result = 'unknown';
        message = 'UNREGISTERED CARD';
        await run(
          `INSERT INTO entry_logs (card_uid, student_id, student_name, roll_number, status_at_entry, result, scan_mode, gate_id)
           VALUES ($1, NULL, NULL, NULL, NULL, $2, $3, $4)`,
          [uid, result, 'entry', 'gate-4']
        );
        sendAlert({
          timestamp: new Date().toISOString(),
          alert_type: 'unknown_card',
          severity: 'critical',
          student_name: null,
          roll_number: null,
          gate_id: 'gate-4',
          title: 'UNREGISTERED CARD',
          detail: `Unknown PIN ${uid} from AIT device ${sn}`
        });
        broadcast('scan', {
          timestamp: new Date().toISOString(),
          card_uid: uid, student_name: null, roll_number: null,
          result, mode: 'entry', gate_id: 'gate-4', message
        });
        continue;
      }

      // Auto-detect direction
      const scanMode = student.inside_campus ? 'exit' : 'entry';
      const currentYear = new Date().getFullYear();
      const isExpired = student.expiry_year && currentYear > student.expiry_year;

      if (scanMode === 'exit') {
        result = 'allowed';
        message = 'EXIT RECORDED';
        await run('UPDATE students SET inside_campus = FALSE WHERE id = $1', [student.id]);
      } else if (isExpired) {
        result = 'denied';
        message = 'CARD EXPIRED';
      } else if (student.status === 'suspended' && student.suspended_until) {
        const suspEnd = new Date(student.suspended_until);
        if (suspEnd > new Date()) {
          result = 'denied';
          message = 'SUSPENDED';
        } else {
          await run("UPDATE students SET status = 'active', suspended_until = NULL WHERE id = $1", [student.id]);
          result = 'allowed';
          message = 'SUSPENSION ENDED — WELCOME BACK';
          await run('UPDATE students SET inside_campus = TRUE WHERE id = $1', [student.id]);
        }
      } else if (student.status !== 'active') {
        result = 'denied';
        message = student.status.toUpperCase() + ' — ENTRY DENIED';
      } else {
        result = 'allowed';
        message = 'ENTRY ALLOWED';
        await run('UPDATE students SET inside_campus = TRUE WHERE id = $1', [student.id]);
      }

      await run(
        `INSERT INTO entry_logs (card_uid, student_id, student_name, roll_number, status_at_entry, result, scan_mode, gate_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [student.card_uid || uid, student.id, student.name, student.roll_number, student.status, result, scanMode, 'gate-4']
      );

      broadcast('scan', {
        timestamp: new Date().toISOString(),
        card_uid: student.card_uid || uid,
        student_name: student.name,
        roll_number: student.roll_number,
        result, mode: scanMode, gate_id: 'gate-4', message
      });

      // Alert for denied entries
      if (result === 'denied') {
        sendAlert({
          timestamp: new Date().toISOString(),
          alert_type: student.status === 'suspended' ? 'suspended_entry' : isExpired ? 'expired_card' : 'denied_entry',
          severity: 'warning',
          student_name: student.name,
          roll_number: student.roll_number,
          department: student.department,
          photo_url: student.photo_url,
          gate_id: 'gate-4',
          title: message,
          detail: `${student.name} (${student.roll_number}) — ${message}`
        });
      }
    }
  }

  // Device expects "OK" response
  res.set('Content-Type', 'text/plain');
  res.send('OK');
});

// Device polls for commands — GET /iclock/getrequest?SN=xxx
app.get('/iclock/getrequest', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send('OK');
});

// Device sends operation logs — POST /iclock/devicecmd?SN=xxx
app.post('/iclock/devicecmd', iclockRaw, (req, res) => {
  const sn = req.query.SN || req.query.sn || 'unknown';
  console.log(`[iclock] devicecmd from ${sn}`);
  res.set('Content-Type', 'text/plain');
  res.send('OK');
});

// --- INIT DB & START ---
async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      card_uid TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      roll_number TEXT UNIQUE NOT NULL,
      department TEXT NOT NULL,
      semester INTEGER NOT NULL,
      section TEXT DEFAULT 'A',
      status TEXT NOT NULL DEFAULT 'active',
      photo_url TEXT,
      enrollment_year INTEGER,
      expiry_year INTEGER,
      inside_campus BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  try { await pool.query('ALTER TABLE students ADD COLUMN inside_campus BOOLEAN DEFAULT FALSE'); } catch(e) {}
  try { await pool.query('ALTER TABLE students ADD COLUMN suspended_until TIMESTAMPTZ'); } catch(e) {}
  try { await pool.query('ALTER TABLE students ADD COLUMN father_name TEXT'); } catch(e) {}
  try { await pool.query('ALTER TABLE students ADD COLUMN cnic TEXT'); } catch(e) {}
  try { await pool.query('ALTER TABLE students ADD COLUMN phone TEXT'); } catch(e) {}
  try { await pool.query('ALTER TABLE students ADD COLUMN gender TEXT'); } catch(e) {}
  try { await pool.query('ALTER TABLE students ADD COLUMN ait_pin TEXT'); } catch(e) {}
  try { await pool.query('ALTER TABLE students ADD COLUMN mapped_by TEXT'); } catch(e) {}
  try { await pool.query('ALTER TABLE students ADD COLUMN mapped_at TIMESTAMPTZ'); } catch(e) {}

  await pool.query('CREATE INDEX IF NOT EXISTS idx_card_uid ON students(card_uid)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ait_pin ON students(ait_pin)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_roll_number ON students(roll_number)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_status ON students(status)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_card_uid_upper ON students(UPPER(card_uid))');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_roll_upper ON students(UPPER(roll_number))');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS entry_logs (
      id SERIAL PRIMARY KEY,
      card_uid TEXT NOT NULL,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      student_name TEXT,
      roll_number TEXT,
      status_at_entry TEXT,
      result TEXT NOT NULL,
      scan_mode TEXT DEFAULT 'entry',
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  try { await pool.query("ALTER TABLE entry_logs ADD COLUMN scan_mode TEXT DEFAULT 'entry'"); } catch(e) {}
  try { await pool.query("ALTER TABLE entry_logs ADD COLUMN gate_id TEXT DEFAULT 'main'"); } catch(e) {}

  await pool.query('CREATE INDEX IF NOT EXISTS idx_log_timestamp ON entry_logs(timestamp)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_log_result ON entry_logs(result)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timetable (
      id SERIAL PRIMARY KEY,
      department TEXT NOT NULL,
      semester INTEGER NOT NULL,
      section TEXT DEFAULT 'A',
      day_of_week TEXT NOT NULL,
      time_start TEXT NOT NULL,
      time_end TEXT NOT NULL,
      subject TEXT NOT NULL,
      room TEXT,
      teacher TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tt_lookup ON timetable(department, semester, section, day_of_week)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      alert_type VARCHAR(50) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      student_name VARCHAR(255),
      roll_number VARCHAR(100),
      department VARCHAR(100),
      photo_url TEXT,
      gate_id VARCHAR(50),
      title VARCHAR(255),
      detail TEXT
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_alert_timestamp ON alerts(timestamp)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ait_users (
      id SERIAL PRIMARY KEY,
      enrollid TEXT NOT NULL UNIQUE,
      name TEXT,
      device_sn TEXT,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      pin TEXT NOT NULL,
      status TEXT DEFAULT 'approved',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // One-time cleanup: remove seed/test students and their logs
  const seedResult = await pool.query("DELETE FROM students WHERE card_uid LIKE 'LGU-2024-%'");
  if (seedResult.rowCount > 0) {
    await pool.query("DELETE FROM entry_logs WHERE card_uid LIKE 'LGU-2024-%'");
    console.log(`Cleaned up ${seedResult.rowCount} test students and their logs.`);
  }

  // One-time auto-import from bundled Excel if students table is empty
  const studentCount = await queryOne('SELECT COUNT(*) as c FROM students');
  if (parseInt(studentCount.c) === 0) {
    const importPath = path.join(__dirname, 'data', 'enrolled_students_mapped.xlsx');
    if (fs.existsSync(importPath)) {
      console.log('[IMPORT] Students table empty — auto-importing from bundled Excel...');
      try {
        const workbook = XLSX.readFile(importPath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet);
        let imported = 0, errors = 0;
        const maxIdRow = await queryOne("SELECT COALESCE(MAX(id), 0) as m FROM students");
        let uidCounter = parseInt(maxIdRow.m) + 1;
        for (const r of rows) {
          const name = String(r.studentname || r.name || '').trim();
          const rollNo = String(r.StdRollNo || r.roll_number || '').trim();
          const dept = String(r.DegreeID || r.department || '').trim();
          const fatherName = String(r.FatherName || '').trim() || null;
          const cnic = String(r.CNIC || '').trim() || null;
          const phone = String(r.PhoneMobilePrimary || '').trim() || null;
          const gender = String(r.Gender || '').trim() || null;
          const joiningSession = r.JoiningSession || '';
          if (!name || !rollNo) { errors++; continue; }
          const cardUid = `LGU-${String(uidCounter).padStart(5, '0')}`;
          uidCounter++;
          const parsed = joiningSession ? parseJoiningSession(joiningSession) : { enrollYear: null, expiryYear: null, semester: 1 };
          const photoUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=200&background=random&bold=true`;
          try {
            await run(
              `INSERT INTO students (card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year, father_name, cnic, phone, gender)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
              [cardUid, name, rollNo, dept || 'Unknown', parsed.semester, 'A', 'active', photoUrl, parsed.enrollYear, parsed.expiryYear, fatherName, cnic, phone, gender]
            );
            imported++;
          } catch { errors++; }
        }
        console.log(`[IMPORT] Done: ${imported} imported, ${errors} errors out of ${rows.length} rows`);
      } catch (e) {
        console.error('[IMPORT] Failed:', e.message);
      }
    }
  }

  server.listen(PORT, () => {
    console.log(`\n  LGU Smart Gate System running on port ${PORT}`);
    console.log(`  Gate Kiosk (Entry): http://localhost:${PORT}/`);
    console.log(`  Gate Kiosk (Exit):  http://localhost:${PORT}/?mode=exit`);
    console.log(`  Admin Dashboard:    http://localhost:${PORT}/admin.html\n`);
    scheduleNightlyReset();
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
