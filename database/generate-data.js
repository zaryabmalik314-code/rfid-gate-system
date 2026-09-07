const fs = require('path');
const path = require('path');

const firstNamesMale = [
  'Ahmed', 'Muhammad', 'Ali', 'Hassan', 'Usman', 'Bilal', 'Hamza', 'Zaryab', 'Kamran', 'Faisal',
  'Imran', 'Tariq', 'Shahid', 'Waqar', 'Junaid', 'Asad', 'Rizwan', 'Nabeel', 'Adeel', 'Kashif',
  'Salman', 'Arslan', 'Danish', 'Fahad', 'Saad', 'Owais', 'Zubair', 'Talha', 'Umer', 'Yasir',
  'Shoaib', 'Rehan', 'Irfan', 'Wahab', 'Noman', 'Atif', 'Sarfraz', 'Farhan', 'Mohsin', 'Raza',
  'Aamir', 'Babar', 'Sajid', 'Nasir', 'Khalid', 'Mudassar', 'Sohail', 'Tanveer', 'Arif', 'Waseem',
  'Zain', 'Haris', 'Awais', 'Taimur', 'Shayan', 'Rayyan', 'Ibrahim', 'Ismail', 'Yousuf', 'Dawood',
  'Haider', 'Abbas', 'Mustafa', 'Hasan', 'Rafay', 'Armaan', 'Sameer', 'Shahzad', 'Qaiser', 'Naeem',
  'Asghar', 'Pervez', 'Shehzad', 'Amjad', 'Akbar', 'Anwar', 'Bashir', 'Ghulam', 'Iqbal', 'Javed',
  'Latif', 'Majid', 'Nadeem', 'Qasim', 'Sabir', 'Tahir', 'Umair', 'Zafar', 'Amir', 'Ehsan',
  'Haroon', 'Jawad', 'Kamil', 'Luqman', 'Mubashir', 'Nouman', 'Obaid', 'Parvez', 'Raheel', 'Sufyan'
];

const firstNamesFemale = [
  'Fatima', 'Ayesha', 'Sana', 'Hira', 'Maryam', 'Zainab', 'Amna', 'Sadia', 'Nadia', 'Rabia',
  'Khadija', 'Mahnoor', 'Laiba', 'Anum', 'Nimra', 'Iqra', 'Bushra', 'Saima', 'Noor', 'Hafsa',
  'Sidra', 'Mehak', 'Farah', 'Asma', 'Samra', 'Alisha', 'Rimsha', 'Arooj', 'Kinza', 'Tooba',
  'Javeria', 'Sumera', 'Tahira', 'Uzma', 'Wardah', 'Zunaira', 'Anila', 'Bina', 'Dur-e-Nayab', 'Esha',
  'Fizza', 'Ghazala', 'Humaira', 'Iram', 'Jamila', 'Kanwal', 'Lubna', 'Muneeba', 'Naila', 'Pakeeza',
  'Qurat', 'Rukhsar', 'Shabana', 'Tayyaba', 'Urooj', 'Very', 'Wajeeha', 'Yasmeen', 'Zarish', 'Areesha',
  'Dua', 'Emaan', 'Fariha', 'Gulshan', 'Hamna', 'Inaya', 'Jannat', 'Komal', 'Laraib', 'Mishal',
  'Nawal', 'Palwasha', 'Rameen', 'Sajal', 'Tania', 'Ume-Habiba', 'Veena', 'Waheeda', 'Yumna', 'Zoha'
];

const lastNames = [
  'Khan', 'Malik', 'Ahmed', 'Ali', 'Shah', 'Hussain', 'Butt', 'Qureshi', 'Siddiqui', 'Chaudhry',
  'Sheikh', 'Rana', 'Bajwa', 'Bhatti', 'Gill', 'Aslam', 'Akhtar', 'Raza', 'Javed', 'Tariq',
  'Rehman', 'Mirza', 'Hashmi', 'Mughal', 'Abbasi', 'Bukhari', 'Naqvi', 'Rizvi', 'Zaidi', 'Kazmi',
  'Durrani', 'Lodhi', 'Rajput', 'Minhas', 'Gondal', 'Warraich', 'Cheema', 'Virk', 'Awan', 'Niazi',
  'Paracha', 'Khattak', 'Yousafzai', 'Afridi', 'Shinwari', 'Bangash', 'Marwat', 'Wazir', 'Mehsud', 'Baloch',
  'Leghari', 'Mazari', 'Lund', 'Jamali', 'Brohi', 'Chandio', 'Memon', 'Pathan', 'Sethi', 'Gujjar'
];

const departments = ['BS-CMAI', 'BS-CS', 'BBA', 'BS-EE', 'BS-SE', 'BS-AI', 'BS-ME', 'BS-CE', 'BS-PHY', 'BS-MATH'];
const sections = ['A', 'B', 'C'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

const TOTAL = 6200;
const DROPPED = 20;
const FROZEN = 40;
const GRADUATED = 7;
const ACTIVE = TOTAL - DROPPED - FROZEN - GRADUATED;

const students = [];
const usedRolls = new Set();
const usedNames = new Set();

for (let i = 0; i < TOTAL; i++) {
  let status;
  if (i < ACTIVE) status = 'active';
  else if (i < ACTIVE + DROPPED) status = 'dropped';
  else if (i < ACTIVE + DROPPED + FROZEN) status = 'frozen';
  else status = 'graduated';

  const isFemale = Math.random() < 0.4;
  let firstName, lastName, fullName;
  do {
    firstName = isFemale ? pick(firstNamesFemale) : pick(firstNamesMale);
    lastName = pick(lastNames);
    fullName = `${firstName} ${lastName}`;
  } while (usedNames.has(fullName));
  usedNames.add(fullName);

  let rollNo;
  do {
    rollNo = String(randInt(1, 9999)).padStart(3, '0');
  } while (usedRolls.has(rollNo));
  usedRolls.add(rollNo);

  const dept = pick(departments);
  const sem = status === 'graduated' ? 8 : randInt(1, 8);
  const sec = pick(sections);
  const cardUid = `LGU-${2020 + randInt(0, 5)}-${String(i + 1).padStart(4, '0')}`;

  let enrollYear, expiryYear;
  if (status === 'graduated') {
    enrollYear = randInt(2018, 2022);
    expiryYear = enrollYear + 4;
  } else {
    enrollYear = randInt(2023, 2026);
    expiryYear = enrollYear + 4;
  }

  students.push({
    card_uid: cardUid,
    name: fullName,
    roll_number: rollNo,
    department: dept,
    semester: sem,
    section: sec,
    status: status,
    enrollment_year: enrollYear,
    expiry_year: expiryYear
  });
}

// Shuffle so blocked students aren't all at the end
for (let i = students.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [students[i], students[j]] = [students[j], students[i]];
}

// Write CSV
const headers = 'card_uid,name,roll_number,department,semester,section,status,enrollment_year,expiry_year';
const rows = students.map(s =>
  `${s.card_uid},${s.name},${s.roll_number},${s.department},${s.semester},${s.section},${s.status},${s.enrollment_year},${s.expiry_year}`
);

const csv = [headers, ...rows].join('\n');
const outPath = require('path').join(__dirname, 'students_6200.csv');
require('fs').writeFileSync(outPath, csv);

// Print stats
const stats = { active: 0, dropped: 0, frozen: 0, graduated: 0 };
students.forEach(s => stats[s.status]++);
console.log(`Generated ${students.length} students:`);
console.log(`  Active:    ${stats.active}`);
console.log(`  Dropped:   ${stats.dropped}`);
console.log(`  Frozen:    ${stats.frozen}`);
console.log(`  Graduated: ${stats.graduated}`);
console.log(`Saved to: ${outPath}`);
