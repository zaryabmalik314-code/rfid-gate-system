const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'gate.db');

async function initDB() {
  const SQL = await initSqlJs();
  let db;

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log('Loaded existing database.');
  } else {
    db = new SQL.Database();
    console.log('Created new database.');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_uid TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      roll_number TEXT UNIQUE NOT NULL,
      department TEXT NOT NULL,
      semester INTEGER NOT NULL,
      section TEXT DEFAULT 'A',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','graduated','frozen','suspended','dropped')),
      photo_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_card_uid ON students(card_uid)');
  db.run('CREATE INDEX IF NOT EXISTS idx_roll_number ON students(roll_number)');
  db.run('CREATE INDEX IF NOT EXISTS idx_status ON students(status)');

  db.run(`
    CREATE TABLE IF NOT EXISTS entry_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_uid TEXT NOT NULL,
      student_id INTEGER,
      student_name TEXT,
      roll_number TEXT,
      status_at_entry TEXT,
      result TEXT NOT NULL CHECK(result IN ('allowed','denied','unknown')),
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_log_timestamp ON entry_logs(timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_log_result ON entry_logs(result)');

  const count = db.exec("SELECT COUNT(*) as count FROM students")[0].values[0][0];

  if (count === 0) {
    const seedStudents = [
      { card_uid: 'LGU-2024-001', name: 'Ahmed Raza Khan', roll_number: '001', department: 'BS-CMAI', semester: 2, section: 'A', status: 'active' },
      { card_uid: 'LGU-2024-002', name: 'Fatima Zahra', roll_number: '015', department: 'BS-CS', semester: 4, section: 'B', status: 'active' },
      { card_uid: 'LGU-2024-003', name: 'Muhammad Bilal', roll_number: '032', department: 'BBA', semester: 6, section: 'A', status: 'active' },
      { card_uid: 'LGU-2024-004', name: 'Ayesha Siddiqui', roll_number: '048', department: 'BS-EE', semester: 3, section: 'A', status: 'active' },
      { card_uid: 'LGU-2024-005', name: 'Zaryab Malik', roll_number: '069', department: 'BS-CMAI', semester: 2, section: 'A', status: 'active' },
      { card_uid: 'LGU-2024-006', name: 'Hassan Ali Qureshi', roll_number: '077', department: 'BS-CS', semester: 8, section: 'B', status: 'active' },
      { card_uid: 'LGU-2024-007', name: 'Sana Malik', roll_number: '091', department: 'BS-CMAI', semester: 4, section: 'A', status: 'graduated' },
      { card_uid: 'LGU-2024-008', name: 'Usman Tariq', roll_number: '103', department: 'BBA', semester: 8, section: 'B', status: 'graduated' },
      { card_uid: 'LGU-2024-009', name: 'Hira Noor', roll_number: '055', department: 'BS-EE', semester: 5, section: 'A', status: 'frozen' },
      { card_uid: 'LGU-2024-010', name: 'Ali Abbas Shah', roll_number: '088', department: 'BS-CS', semester: 3, section: 'A', status: 'suspended' },
      { card_uid: 'LGU-2024-011', name: 'Maryam Bukhari', roll_number: '042', department: 'BBA', semester: 6, section: 'B', status: 'active' },
      { card_uid: 'LGU-2024-012', name: 'Kamran Javed', roll_number: '066', department: 'BS-EE', semester: 7, section: 'A', status: 'dropped' },
    ];

    const stmt = db.prepare(`
      INSERT INTO students (card_uid, name, roll_number, department, semester, section, status, photo_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const s of seedStudents) {
      const photoUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(s.name)}&size=200&background=random&bold=true`;
      stmt.run([s.card_uid, s.name, s.roll_number, s.department, s.semester, s.section, s.status, photoUrl]);
    }
    stmt.free();
    console.log(`Seeded ${seedStudents.length} students.`);
  } else {
    console.log(`Database already has ${count} students. Skipping seed.`);
  }

  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
  console.log('Database initialized and saved.');

  return db;
}

if (require.main === module) {
  initDB().then(() => process.exit(0));
}

module.exports = { initDB, DB_PATH };
