const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: UPLOAD_DIR });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
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

// --- SCAN ENDPOINT ---
app.post('/api/scan', async (req, res) => {
  const { card_uid } = req.body;
  if (!card_uid || !card_uid.trim()) {
    return res.json({ found: false, result: 'unknown', message: 'No card UID provided' });
  }

  const uid = card_uid.trim().toUpperCase();
  const student = await queryOne(
    `SELECT id, card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year
     FROM students WHERE UPPER(card_uid) = $1 OR UPPER(roll_number) = $1`,
    [uid]
  );

  let result, message;

  if (!student) {
    result = 'unknown';
    message = 'UNREGISTERED CARD';
    await run(
      `INSERT INTO entry_logs (card_uid, student_id, student_name, roll_number, status_at_entry, result)
       VALUES ($1, NULL, NULL, NULL, NULL, $2)`,
      [uid, result]
    );
    return res.json({ found: false, result, message });
  }

  const currentYear = new Date().getFullYear();
  const isExpired = student.expiry_year && currentYear > student.expiry_year;

  if (isExpired) {
    result = 'denied';
    message = `CARD EXPIRED (${student.enrollment_year}-${student.expiry_year}) — ENTRY DENIED`;
    student.status = 'expired';
  } else if (student.status === 'active') {
    result = 'allowed';
    message = 'ACTIVE STUDENT — ENTRY ALLOWED';
  } else {
    result = 'denied';
    const statusLabels = {
      graduated: 'GRADUATED — NO LONGER ENROLLED',
      frozen: 'SEMESTER FROZEN — ENTRY DENIED',
      suspended: 'SUSPENDED — ENTRY DENIED',
      dropped: 'DROPPED OUT — ENTRY DENIED'
    };
    message = statusLabels[student.status] || 'ENTRY DENIED';
  }

  await run(
    `INSERT INTO entry_logs (card_uid, student_id, student_name, roll_number, status_at_entry, result)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [student.card_uid, student.id, student.name, student.roll_number, student.status, result]
  );

  res.json({ found: true, result, message, student });
});

// --- STUDENTS CRUD ---
app.get('/api/students', async (req, res) => {
  const { search, status, department, page = 1, limit = 50 } = req.query;
  let where = '1=1';
  const params = [];
  let paramIdx = 1;

  if (search) {
    where += ` AND (name ILIKE $${paramIdx} OR roll_number ILIKE $${paramIdx} OR card_uid ILIKE $${paramIdx})`;
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

app.post('/api/students', async (req, res) => {
  const { card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year } = req.body;
  try {
    await run(
      `INSERT INTO students (card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [card_uid, name, roll_number, department, parseInt(semester), section || 'A', status || 'active',
       photo_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=200&background=random&bold=true`,
       parseInt(enrollment_year) || null, parseInt(expiry_year) || null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/students/:id', async (req, res) => {
  const { card_uid, name, roll_number, department, semester, section, status, enrollment_year, expiry_year } = req.body;
  try {
    await run(
      `UPDATE students SET card_uid=$1, name=$2, roll_number=$3, department=$4, semester=$5, section=$6, status=$7, enrollment_year=$8, expiry_year=$9 WHERE id=$10`,
      [card_uid, name, roll_number, department, parseInt(semester), section, status, parseInt(enrollment_year) || null, parseInt(expiry_year) || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.patch('/api/students/:id/status', async (req, res) => {
  const { status } = req.body;
  const valid = ['active', 'graduated', 'frozen', 'suspended', 'dropped'];
  if (!valid.includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }
  await run('UPDATE students SET status = $1 WHERE id = $2', [status, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/students/:id', async (req, res) => {
  await run('DELETE FROM students WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// --- BULK IMPORT ---
app.post('/api/students/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    let imported = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cardUid = String(r.card_uid || r.Card_UID || r.CardUID || r.CARD_UID || '').trim();
      const name = String(r.name || r.Name || r.STUDENT_NAME || r.student_name || '').trim();
      const rollNo = String(r.roll_number || r.Roll_Number || r.RollNumber || r.ROLL_NO || r.roll_no || '').trim();
      const dept = String(r.department || r.Department || r.DEPARTMENT || r.dept || '').trim();
      const sem = parseInt(r.semester || r.Semester || r.SEMESTER || 1);
      const sec = String(r.section || r.Section || r.SECTION || 'A').trim();
      const status = String(r.status || r.Status || r.STATUS || 'active').trim().toLowerCase();
      const enrollYear = parseInt(r.enrollment_year || r.Enrollment_Year || r.ENROLLMENT_YEAR || 0) || null;
      const expiryYear = parseInt(r.expiry_year || r.Expiry_Year || r.EXPIRY_YEAR || 0) || null;

      if (!cardUid || !name || !rollNo) {
        errors.push(`Row ${i + 2}: Missing required fields`);
        continue;
      }

      try {
        const validStatus = ['active', 'graduated', 'frozen', 'suspended', 'dropped'].includes(status) ? status : 'active';
        const photoUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=200&background=random&bold=true`;

        const existing = await queryOne('SELECT id FROM students WHERE card_uid = $1', [cardUid]);
        if (existing) {
          await run(
            'UPDATE students SET name=$1, roll_number=$2, department=$3, semester=$4, section=$5, status=$6, photo_url=$7, enrollment_year=$8, expiry_year=$9 WHERE card_uid=$10',
            [name, rollNo, dept || 'Unknown', sem || 1, sec, validStatus, photoUrl, enrollYear, expiryYear, cardUid]
          );
        } else {
          await run(
            `INSERT INTO students (card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [cardUid, name, rollNo, dept || 'Unknown', sem || 1, sec, validStatus, photoUrl, enrollYear, expiryYear]
          );
        }
        imported++;
      } catch (err) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, imported, errors, total: rows.length });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- BULK STATUS UPDATE ---
app.post('/api/students/bulk-status', upload.single('file'), async (req, res) => {
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
app.get('/api/logs', async (req, res) => {
  const { date, result, page = 1, limit = 50 } = req.query;
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
  const active = (await queryOne("SELECT COUNT(*) as c FROM students WHERE status='active'")).c;
  const graduated = (await queryOne("SELECT COUNT(*) as c FROM students WHERE status='graduated'")).c;
  const frozen = (await queryOne("SELECT COUNT(*) as c FROM students WHERE status='frozen'")).c;
  const suspended = (await queryOne("SELECT COUNT(*) as c FROM students WHERE status='suspended'")).c;
  const dropped = (await queryOne("SELECT COUNT(*) as c FROM students WHERE status='dropped'")).c;

  const today = new Date().toISOString().split('T')[0];
  const entriesToday = (await queryOne("SELECT COUNT(*) as c FROM entry_logs WHERE DATE(timestamp) = $1", [today])).c;
  const allowedToday = (await queryOne("SELECT COUNT(*) as c FROM entry_logs WHERE DATE(timestamp) = $1 AND result='allowed'", [today])).c;
  const deniedToday = (await queryOne("SELECT COUNT(*) as c FROM entry_logs WHERE DATE(timestamp) = $1 AND result='denied'", [today])).c;

  res.json({
    total: parseInt(total), active: parseInt(active), graduated: parseInt(graduated),
    frozen: parseInt(frozen), suspended: parseInt(suspended), dropped: parseInt(dropped),
    entriesToday: parseInt(entriesToday), allowedToday: parseInt(allowedToday), deniedToday: parseInt(deniedToday)
  });
});

// --- DEPARTMENTS ---
app.get('/api/departments', async (req, res) => {
  const depts = await query('SELECT DISTINCT department FROM students ORDER BY department');
  res.json(depts.map(d => d.department));
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

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
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_log_timestamp ON entry_logs(timestamp)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_log_result ON entry_logs(result)');

  const count = await queryOne('SELECT COUNT(*) as c FROM students');
  if (parseInt(count.c) === 0) {
    const seeds = [
      ['LGU-2024-001', 'Ahmed Raza Khan', '001', 'BS-CMAI', 2, 'A', 'active', 2025, 2029],
      ['LGU-2024-002', 'Fatima Zahra', '015', 'BS-CS', 4, 'B', 'active', 2024, 2028],
      ['LGU-2024-003', 'Muhammad Bilal', '032', 'BBA', 6, 'A', 'active', 2023, 2027],
      ['LGU-2024-004', 'Ayesha Siddiqui', '048', 'BS-EE', 3, 'A', 'active', 2025, 2029],
      ['LGU-2024-005', 'Zaryab Malik', '069', 'BS-CMAI', 2, 'A', 'active', 2025, 2029],
      ['LGU-2024-006', 'Hassan Ali Qureshi', '077', 'BS-CS', 8, 'B', 'active', 2022, 2026],
      ['LGU-2024-007', 'Sana Malik', '091', 'BS-CMAI', 4, 'A', 'active', 2020, 2024],
      ['LGU-2024-008', 'Usman Tariq', '103', 'BBA', 8, 'B', 'active', 2019, 2023],
      ['LGU-2024-009', 'Hira Noor', '055', 'BS-EE', 5, 'A', 'frozen', 2024, 2028],
      ['LGU-2024-010', 'Ali Abbas Shah', '088', 'BS-CS', 3, 'A', 'suspended', 2025, 2029],
      ['LGU-2024-011', 'Maryam Bukhari', '042', 'BBA', 6, 'B', 'active', 2023, 2027],
      ['LGU-2024-012', 'Kamran Javed', '066', 'BS-EE', 7, 'A', 'dropped', 2022, 2026],
    ];

    for (const s of seeds) {
      const photoUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(s[1])}&size=200&background=random&bold=true`;
      await run(
        `INSERT INTO students (card_uid, name, roll_number, department, semester, section, status, photo_url, enrollment_year, expiry_year)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [s[0], s[1], s[2], s[3], s[4], s[5], s[6], photoUrl, s[7], s[8]]
      );
    }
    console.log('Database seeded with 12 students.');
  }

  app.listen(PORT, () => {
    console.log(`\n  LGU Smart Gate System running on port ${PORT}`);
    console.log(`  Gate Kiosk:       http://localhost:${PORT}/`);
    console.log(`  Admin Dashboard:  http://localhost:${PORT}/admin.html\n`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
