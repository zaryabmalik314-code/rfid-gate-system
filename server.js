const express = require('express');
const crypto = require('crypto');
const https = require('https');
const { Pool } = require('pg');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'LguAdmin2026';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: UPLOAD_DIR });

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

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Wrong password' });
  }
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

// --- COOLDOWN (only after exit→re-entry, not on consecutive entries) ---
const COOLDOWN_MS = parseInt(process.env.SCAN_COOLDOWN_MS || '180000');
const lastExitTime = new Map();

// --- SCAN ENDPOINT ---
app.post('/api/scan', async (req, res) => {
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

  // Timetable check on entry
  let timetable = null;
  if (scanMode === 'entry' && result === 'allowed') {
    const todayDay = DAYS[new Date().getDay()];

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

  res.json({ found: true, result, message, student, mode: scanMode, timetable });
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

  const totalRow = await queryOne(`SELECT COUNT(*) as total FROM students WHERE ${where}`, params);
  const total = parseInt(totalRow.total);
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const students = await query(
    `SELECT * FROM students WHERE ${where} ORDER BY name ASC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, parseInt(limit), offset]
  );

  res.json({ students, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
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
    const until = new Date();
    until.setDate(until.getDate() + parseInt(suspended_days));
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
    const rows = XLSX.utils.sheet_to_json(sheet);

    let imported = 0;
    const errors = [];
    const maxIdRow = await queryOne("SELECT COALESCE(MAX(id), 0) as m FROM students");
    let uidCounter = parseInt(maxIdRow.m) + 1;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];

      // Support both LGU format (StdRollNo, studentname, DegreeID, etc.) and standard format
      const name = String(r.studentname || r.name || r.Name || r.STUDENT_NAME || r.student_name || '').trim();
      const rollNo = String(r.StdRollNo || r.roll_number || r.Roll_Number || r.RollNumber || r.ROLL_NO || r.roll_no || '').trim();
      const dept = String(r.DegreeID || r.department || r.Department || r.DEPARTMENT || r.dept || '').trim();
      let cardUid = String(r.card_uid || r.Card_UID || r.CardUID || r.CARD_UID || '').trim();
      const fatherName = String(r.FatherName || r.father_name || '').trim() || null;
      const cnic = String(r.CNIC || r.cnic || '').trim() || null;
      const phone = String(r.PhoneMobilePrimary || r.phone || r.Phone || '').trim() || null;
      const gender = String(r.Gender || r.gender || '').trim() || null;
      const joiningSession = r.JoiningSession || r.joining_session || '';

      const sem = parseInt(r.semester || r.Semester || r.SEMESTER || 0);
      const sec = String(r.section || r.Section || r.SECTION || 'A').trim();
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

      // Parse joining session for enrollment/expiry/semester if not provided
      if (joiningSession && (!enrollYear || !expiryYear)) {
        const parsed = parseJoiningSession(joiningSession);
        if (!enrollYear) enrollYear = parsed.enrollYear;
        if (!expiryYear) expiryYear = parsed.expiryYear;
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
            [name, dept || 'Unknown', finalSem, sec, validStatus, photoUrl, enrollYear, expiryYear,
             fatherName, cnic, phone, gender, rollNo]
          );
        } else {
          await run(
            `INSERT INTO students (card_uid, name, roll_number, department, semester, section, status, photo_url,
             enrollment_year, expiry_year, father_name, cnic, phone, gender)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [cardUid, name, rollNo, dept || 'Unknown', finalSem, sec, validStatus, photoUrl,
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
app.get('/api/stats', async (req, res) => {
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

// --- SYNC (for offline kiosk) ---
app.get('/api/sync', async (req, res) => {
  const students = await query(
    'SELECT card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year, inside_campus, suspended_until, gender FROM students'
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

  await pool.query('CREATE INDEX IF NOT EXISTS idx_card_uid ON students(card_uid)');
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

  // One-time cleanup: remove seed/test students and their logs
  const seedResult = await pool.query("DELETE FROM students WHERE card_uid LIKE 'LGU-2024-%'");
  if (seedResult.rowCount > 0) {
    await pool.query("DELETE FROM entry_logs WHERE card_uid LIKE 'LGU-2024-%'");
    console.log(`Cleaned up ${seedResult.rowCount} test students and their logs.`);
  }

  app.listen(PORT, () => {
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
