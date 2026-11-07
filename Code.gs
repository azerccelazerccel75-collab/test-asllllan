/**
 * ============================================================
 *  ASLAN LESSONS — server (Google Apps Script)
 *  Bütün məlumatlar Google Cədvəldə saxlanılır.
 * ============================================================
 *
 *  1) SPREADSHEET_URL — Google Cədvəlin linki.
 *     Skript cədvəlin içindən (Genişləndirmələr → Apps Script) açılıbsa, boş saxlaya bilərsiniz.
 *  2) MAIN_ADMIN — baş adminin ilkin login və şifrəsi. setup() funksiyasını işə salmazdan əvvəl dəyişin.
 *  3) Redaktorda setup() funksiyasını bir dəfə işə salın (vərəqlər və baş admin yaradılacaq).
 *  4) Yerləşdir → Yeni yerləşdirmə → Veb tətbiq → «İcra edən: Mən», «Giriş: Hər kəs».
 *     Alınan URL-i index.html faylında API_URL sabitinə yazın.
 */

// ===================== AYARLAR =====================
const SPREADSHEET_URL = '';            // məsələn: 'https://docs.google.com/spreadsheets/d/XXXXXXXX/edit'
const TIMEZONE = 'Asia/Baku';
const TZ_OFFSET = '+04:00';
const MAIN_ADMIN = { name: 'Baş admin', login: 'admin', password: 'admin123' };
const SESSION_SECONDS = 6 * 60 * 60;   // sessiya müddəti (maksimum 6 saat), hər sorğuda yenilənir
const EDIT_WINDOW_HOURS = 24;          // müəllim öz qeydini neçə saat ərzində düzəldə bilər
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MINUTES = 10;

// ===================== STRUKTUR =====================
const SCHEMA = {
  Users:    ['id', 'name', 'login', 'password', 'role', 'phone', 'permissions', 'theme', 'createdAt', 'updatedAt'],
  Students: ['id', 'name', 'phone', 'parentName', 'parentPhone', 'note', 'createdAt', 'updatedAt'],
  Courses:  ['id', 'title', 'type', 'teacherId', 'studentIds', 'lessonsPerMonth', 'monthNo', 'monthStart', 'createdAt', 'updatedAt'],
  Lessons:  ['id', 'lessonId', 'courseId', 'monthNo', 'date', 'studentId', 'status', 'reason', 'topic', 'markedBy', 'markedAt', 'editedBy', 'editedAt'],
  Payments: ['id', 'studentId', 'courseId', 'monthNo', 'amount', 'date', 'note', 'createdBy', 'createdAt'],
  Logs:     ['id', 'time', 'userId', 'userName', 'role', 'type', 'action', 'details']
};

const ROLE_LABELS = { superadmin: 'Baş admin', teacher: 'Müəllim', helper: 'Köməkçi' };
const TYPE_LABELS = { individual: 'Fərdi', group: 'Qrup' };
const HELD = 'keçdi';
const ABSENT = 'qayıb';

const PERMISSIONS = [
  { group: 'Tələbələr', items: [
    { key: 'students.view', label: 'Tələbələrə bax' },
    { key: 'students.add', label: 'Tələbə əlavə et' },
    { key: 'students.edit', label: 'Tələbəni redaktə et' },
    { key: 'students.delete', label: 'Tələbəni sil' }
  ]},
  { group: 'Müəllimlər', items: [
    { key: 'teachers.view', label: 'Müəllimlərə bax' },
    { key: 'teachers.add', label: 'Müəllim əlavə et' },
    { key: 'teachers.edit', label: 'Müəllimi redaktə et' },
    { key: 'teachers.delete', label: 'Müəllimi sil' },
    { key: 'teachers.passwords', label: 'Şifrələrə bax' }
  ]},
  { group: 'Məşğələlər', items: [
    { key: 'courses.view', label: 'Məşğələlərə bax' },
    { key: 'courses.add', label: 'Məşğələ yarat' },
    { key: 'courses.edit', label: 'Məşğələni redaktə et' },
    { key: 'courses.delete', label: 'Məşğələni sil' },
    { key: 'month.new', label: 'Yeni ay başlat' }
  ]},
  { group: 'Dərs qeydləri', items: [
    { key: 'attendance.view', label: 'Dərs tarixçəsinə bax' },
    { key: 'attendance.mark', label: 'İstənilən məşğələdə dərs qeyd et' },
    { key: 'attendance.edit', label: 'Dərs qeydlərini düzəlt' },
    { key: 'attendance.delete', label: 'Dərs qeydlərini sil' }
  ]},
  { group: 'Ödənişlər', items: [
    { key: 'payments.view', label: 'Ödənişlərə bax' },
    { key: 'payments.add', label: 'Ödəniş əlavə et' },
    { key: 'payments.delete', label: 'Ödənişi sil' }
  ]},
  { group: 'Jurnal', items: [
    { key: 'logs.view', label: 'Jurnala bax' }
  ]}
];

const ALL_PERMS = [];
const PERM_LABEL = {};
PERMISSIONS.forEach(function (g) { g.items.forEach(function (i) { ALL_PERMS.push(i.key); PERM_LABEL[i.key] = i.label; }); });

// Bir icazə digərini tələb edirsə (məs. «Tələbə əlavə et» → «Tələbələrə bax»)
const IMPLIED = {
  'students.add': ['students.view'], 'students.edit': ['students.view'], 'students.delete': ['students.view'],
  'teachers.add': ['teachers.view'], 'teachers.edit': ['teachers.view'], 'teachers.delete': ['teachers.view'], 'teachers.passwords': ['teachers.view'],
  'courses.add': ['courses.view'], 'courses.edit': ['courses.view'], 'courses.delete': ['courses.view'], 'month.new': ['courses.view'],
  'attendance.mark': ['courses.view'],
  'attendance.edit': ['attendance.view', 'courses.view'], 'attendance.delete': ['attendance.view', 'courses.view'],
  'payments.view': ['students.view'], 'payments.add': ['payments.view', 'students.view'], 'payments.delete': ['payments.view', 'students.view']
};

const STUDENT_FIELDS = { name: 'Ad Soyad', phone: 'Telefon', parentName: 'Valideyn', parentPhone: 'Valideynin telefonu', note: 'Qeyd' };

// ===================== GİRİŞ NÖQTƏLƏRİ =====================
function doGet() {
  return json_({ ok: true, message: 'Aslan Lessons API işləyir.' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Sorğu düzgün deyil.' });
  }
  try {
    return json_(handle_(req));
  } catch (err) {
    if (err && err.userMsg) return json_({ ok: false, error: err.message, code: err.code || '' });
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'Serverdə xəta baş verdi: ' + (err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

const ROUTES = {
  bootstrap:      { fn: function () { return {}; }, data: true },
  logout:         { fn: logout_, lock: true },
  setTheme:       { fn: setTheme_, lock: true },
  changePassword: { fn: changePassword_, lock: true },

  addStudent:     { fn: addStudent_, lock: true, data: true },
  editStudent:    { fn: editStudent_, lock: true, data: true },
  deleteStudent:  { fn: deleteStudent_, lock: true, data: true },
  getStudentCard: { fn: getStudentCard_, lock: true },

  addUser:        { fn: addUser_, lock: true, data: true },
  editUser:       { fn: editUser_, lock: true, data: true },
  deleteUser:     { fn: deleteUser_, lock: true, data: true },
  revealPassword: { fn: revealPassword_, lock: true },

  addCourse:      { fn: addCourse_, lock: true, data: true },
  editCourse:     { fn: editCourse_, lock: true, data: true },
  deleteCourse:   { fn: deleteCourse_, lock: true, data: true },
  newMonth:       { fn: newMonth_, lock: true, data: true },

  markLesson:     { fn: markLesson_, lock: true, data: true },
  editLesson:     { fn: editLesson_, lock: true, data: true },
  deleteLesson:   { fn: deleteLesson_, lock: true, data: true },
  getLessons:     { fn: getLessons_ },

  addPayment:     { fn: addPayment_, lock: true, data: true },
  deletePayment:  { fn: deletePayment_, lock: true, data: true },

  getLogs:        { fn: getLogs_ },
  setPermissions: { fn: setPermissions_, lock: true, data: true }
};

function handle_(req) {
  var action = String(req.action || '');
  if (action === 'login') return withLock_(function () { return login_(req); });
  var route = ROUTES[action];
  if (!route) throw fail_('Naməlum əməliyyat.');
  var user = auth_(req.token);
  var run = function () {
    var res;
    try {
      res = route.fn(user, req) || {};
    } catch (err) {
      if (err && err.code === 'PERM') log_(user, 'security', 'İcazəsiz əməliyyat cəhdi', 'Əməliyyat: ' + action + ' — ' + err.message);
      throw err;
    }
    var out = { ok: true };
    Object.keys(res).forEach(function (k) { out[k] = res[k]; });
    if (route.data) out.data = bootstrap_(findUser_(user.id) || user);
    return out;
  };
  return route.lock ? withLock_(run) : run();
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw fail_('Server hazırda məşğuldur. Bir neçə saniyədən sonra yenidən cəhd edin.');
  try {
    var res = fn();
    SpreadsheetApp.flush();
    return res;
  } finally {
    lock.releaseLock();
  }
}

function fail_(msg, code) {
  var e = new Error(msg);
  e.userMsg = true;
  e.code = code || '';
  return e;
}

// ===================== QURAŞDIRMA =====================
/** Redaktordan bir dəfə işə salın. */
function setup() {
  Object.keys(SCHEMA).forEach(function (name) {
    var m = meta_(name);
    m.sh.getRange('A:' + colLetter_(m.head.length)).setNumberFormat('@'); // hamısı mətn kimi (0 ilə başlayan nömrələr itməsin)
  });
  var users = rows_('Users');
  var main = users.filter(function (u) { return u.role === 'superadmin'; })[0];
  if (!main) {
    if (users.some(function (u) { return lower_(u.login) === lower_(MAIN_ADMIN.login); })) {
      throw new Error('«' + MAIN_ADMIN.login + '» loginli istifadəçi artıq var. MAIN_ADMIN.login-i dəyişin.');
    }
    insertMany_('Users', [{
      id: newId_('U'), name: MAIN_ADMIN.name, login: MAIN_ADMIN.login, password: MAIN_ADMIN.password,
      role: 'superadmin', phone: '', permissions: '', theme: 'light', createdAt: now_(), updatedAt: ''
    }]);
    log_(null, 'system', 'Sistem quruldu', 'Baş admin yaradıldı. Login: ' + MAIN_ADMIN.login);
    Logger.log('Hazırdır! Baş admin yaradıldı. Login: ' + MAIN_ADMIN.login + ' | Şifrə: ' + MAIN_ADMIN.password);
  } else {
    Logger.log('Vərəqlər yoxlanıldı. Baş admin artıq mövcuddur: ' + main.login);
  }
}

// ===================== CƏDVƏL QATI =====================
var _ss = null;
var _meta = {};
var _rows = {};

function ss_() {
  if (_ss) return _ss;
  _ss = SPREADSHEET_URL ? SpreadsheetApp.openByUrl(SPREADSHEET_URL) : SpreadsheetApp.getActiveSpreadsheet();
  if (!_ss) throw fail_('Google Cədvəl tapılmadı. Code.gs faylında SPREADSHEET_URL-i yoxlayın.');
  return _ss;
}

function meta_(name) {
  if (_meta[name]) return _meta[name];
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  while (head.length && head[head.length - 1] === '') head.pop();
  var changed = false;
  SCHEMA[name].forEach(function (h) {
    if (head.indexOf(h) === -1) { head.push(h); changed = true; }
  });
  if (changed) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:' + colLetter_(head.length)).setNumberFormat('@');
  }
  _meta[name] = { sh: sh, head: head };
  return _meta[name];
}

function rows_(name) {
  if (_rows[name]) return _rows[name];
  var m = meta_(name);
  var last = m.sh.getLastRow();
  var out = [];
  if (last >= 2) {
    var vals = m.sh.getRange(2, 1, last - 1, m.head.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var o = { _row: i + 2 };
      for (var j = 0; j < m.head.length; j++) if (m.head[j]) o[m.head[j]] = cell_(vals[i][j]);
      if (o.id) out.push(o);
    }
  }
  _rows[name] = out;
  return out;
}

function insertMany_(name, objs) {
  if (!objs.length) return;
  var m = meta_(name);
  var data = objs.map(function (o) { return m.head.map(function (h) { return val_(o[h]); }); });
  var start = m.sh.getLastRow() + 1;
  var need = start + data.length - 1 - m.sh.getMaxRows();
  if (need > 0) m.sh.insertRowsAfter(m.sh.getMaxRows(), need + 20);
  m.sh.getRange(start, 1, data.length, m.head.length).setValues(data);
  delete _rows[name];
}

function update_(name, rowObj, changes) {
  var m = meta_(name);
  Object.keys(changes).forEach(function (k) { rowObj[k] = changes[k]; });
  m.sh.getRange(rowObj._row, 1, 1, m.head.length).setValues([m.head.map(function (h) { return val_(rowObj[h]); })]);
}

function removeRows_(name, nums) {
  if (!nums.length) return;
  var m = meta_(name);
  var s = nums.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return b - a; });
  if (m.sh.getMaxRows() - s.length < 3) m.sh.insertRowsAfter(m.sh.getMaxRows(), 10);
  var i = 0;
  while (i < s.length) {
    var start = s[i], count = 1;
    while (i + count < s.length && s[i + count] === start - count) count++;
    m.sh.deleteRows(start - count + 1, count);
    i += count;
  }
  delete _rows[name];
}

function cell_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    var full = Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    return /\s00:00:00$/.test(full) ? full.slice(0, 10) : full;
  }
  return String(v);
}

function val_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (/^=/.test(s)) s = "'" + s; // düstur kimi oxunmasın
  return s;
}

function colLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ===================== KÖMƏKÇİ FUNKSİYALAR =====================
function newId_(p) {
  return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function now_() { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd'); }
function lower_(s) { return String(s || '').toLowerCase(); }
function fold_(s) {
  return String(s || '').toLocaleLowerCase('az')
    .replace(/ə/g, 'e').replace(/ı/g, 'i').replace(/i̇/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ç/g, 'c').replace(/ş/g, 's').replace(/ğ/g, 'g');
}
function ageHours_(s) {
  if (!s) return Infinity;
  var t = new Date(String(s).replace(' ', 'T') + TZ_OFFSET).getTime();
  return isNaN(t) ? Infinity : (Date.now() - t) / 36e5;
}
function str_(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 200); }
function reqStr_(v, label, min, max) {
  var s = str_(v, max);
  if (s.length < (min || 1)) throw fail_('«' + label + '» sahəsini doldurun' + (min > 1 ? ' (ən azı ' + min + ' simvol).' : '.'));
  return s;
}
function phone_(v, label) {
  var s = str_(v, 30);
  if (s && !/^[0-9+()\-\s]{5,25}$/.test(s)) throw fail_('«' + (label || 'Telefon') + '» düzgün deyil.');
  return s;
}
function date_(v) {
  var s = str_(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw fail_('Tarix düzgün deyil.');
  var d = new Date(s + 'T12:00:00' + TZ_OFFSET);
  if (isNaN(d.getTime()) || Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd') !== s) throw fail_('Tarix düzgün deyil.');
  if (s > today_()) throw fail_('Gələcək tarixi seçmək olmaz.');
  return s;
}
function idList_(s) { return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(String); }

function findUser_(id) { return rows_('Users').filter(function (x) { return x.id === String(id); })[0] || null; }
function findStudent_(id) { return rows_('Students').filter(function (x) { return x.id === String(id); })[0] || null; }
function findCourse_(id) { return rows_('Courses').filter(function (x) { return x.id === String(id); })[0] || null; }
function mustStudent_(id) { var s = findStudent_(id); if (!s) throw fail_('Tələbə tapılmadı. Səhifəni yeniləyin.'); return s; }
function mustCourse_(id) { var c = findCourse_(id); if (!c) throw fail_('Məşğələ tapılmadı. Səhifəni yeniləyin.'); return c; }
function mustUser_(id) { var u = findUser_(id); if (!u) throw fail_('İstifadəçi tapılmadı. Səhifəni yeniləyin.'); return u; }

function studentName_(id) { var s = findStudent_(id); return s ? s.name : '(silinmiş tələbə)'; }
function userName_(id) { var u = findUser_(id); return u ? u.name : (id ? '(silinmiş istifadəçi)' : '—'); }

function courseLabel_(c) {
  if (!c) return '(silinmiş məşğələ)';
  if (c.title) return c.title;
  var names = idList_(c.studentIds).map(studentName_);
  if (c.type === 'individual') return names[0] || 'Fərdi məşğələ';
  return names.slice(0, 2).join(', ') + (names.length > 2 ? ' +' + (names.length - 2) : '');
}

// ===================== İCAZƏLƏR =====================
function permsOf_(u) {
  if (!u) return [];
  if (u.role === 'superadmin') return ALL_PERMS.slice();
  var list = idList_(u.permissions).filter(function (k) { return ALL_PERMS.indexOf(k) !== -1; });
  return expandPerms_(list);
}
function expandPerms_(list) {
  var set = {};
  list.forEach(function (k) { set[k] = true; (IMPLIED[k] || []).forEach(function (x) { set[x] = true; }); });
  return ALL_PERMS.filter(function (k) { return set[k]; });
}
function can_(u, key) { return u.role === 'superadmin' || permsOf_(u).indexOf(key) !== -1; }
function need_(u, key) {
  if (!can_(u, key)) throw fail_('Bu əməliyyat üçün icazəniz yoxdur («' + PERM_LABEL[key] + '»).', 'PERM');
}

// ===================== JURNAL =====================
function log_(user, type, action, details) {
  var m = meta_('Logs');
  var row = {
    id: newId_('L'), time: now_(),
    userId: user ? user.id : '', userName: user ? user.name : '—',
    role: user ? (ROLE_LABELS[user.role] || user.role) : '—',
    type: type, action: action, details: details || ''
  };
  m.sh.appendRow(m.head.map(function (h) { return val_(row[h]); }));
  delete _rows.Logs;
}

// ===================== SESSİYA =====================
function auth_(token) {
  if (!token) throw fail_('Sessiya bitib. Yenidən daxil olun.', 'AUTH');
  var cache = CacheService.getScriptCache();
  var uid = cache.get('s_' + token);
  if (!uid) throw fail_('Sessiyanın vaxtı bitib. Yenidən daxil olun.', 'AUTH');
  var u = findUser_(uid);
  if (!u) { cache.remove('s_' + token); throw fail_('Hesabınız tapılmadı. Administratorla əlaqə saxlayın.', 'AUTH'); }
  cache.put('s_' + token, uid, SESSION_SECONDS);
  u._token = token;
  return u;
}

function login_(req) {
  var login = str_(req.login, 60);
  var pass = String(req.password || '');
  if (!login || !pass) throw fail_('Login və şifrəni daxil edin.');
  var cache = CacheService.getScriptCache();
  var key = 'f_' + lower_(login);
  var fails = Number(cache.get(key) || 0);
  if (fails >= MAX_LOGIN_FAILS) {
    log_(null, 'auth', 'Bloklanmış giriş cəhdi', 'Login: ' + login);
    throw fail_('Çoxlu uğursuz cəhd edildi. ' + LOGIN_LOCK_MINUTES + ' dəqiqədən sonra yenidən yoxlayın.');
  }
  var u = rows_('Users').filter(function (x) { return lower_(x.login) === lower_(login); })[0];
  if (!u || String(u.password) !== pass) {
    cache.put(key, String(fails + 1), LOGIN_LOCK_MINUTES * 60);
    log_(null, 'auth', 'Uğursuz giriş cəhdi', 'Login: ' + login + (u ? ' (şifrə yanlışdır)' : ' (belə login yoxdur)'));
    throw fail_('Login və ya şifrə yanlışdır.');
  }
  cache.remove(key);
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  cache.put('s_' + token, u.id, SESSION_SECONDS);
  log_(u, 'auth', 'Sistemə daxil oldu', 'Login: ' + u.login);
  return { ok: true, token: token, data: bootstrap_(u) };
}

function logout_(u) {
  CacheService.getScriptCache().remove('s_' + u._token);
  log_(u, 'auth', 'Sistemdən çıxdı', '');
  return {};
}

function setTheme_(u, req) {
  var theme = req.theme === 'dark' ? 'dark' : 'light';
  if (u.theme !== theme) {
    update_('Users', u, { theme: theme });
    log_(u, 'profile', 'Görünüşü dəyişdi', theme === 'dark' ? 'Qaranlıq rejim' : 'İşıqlı rejim');
  }
  return { theme: theme };
}

function changePassword_(u, req) {
  if (String(req.oldPassword || '') !== String(u.password)) throw fail_('Hazırkı şifrə yanlışdır.');
  var np = String(req.newPassword || '');
  if (np.length < 4 || np.length > 50) throw fail_('Yeni şifrə 4–50 simvol olmalıdır.');
  if (/\s/.test(np)) throw fail_('Şifrədə boşluq olmamalıdır.');
  update_('Users', u, { password: np, updatedAt: now_() });
  log_(u, 'profile', 'Öz şifrəsini dəyişdi', '');
  return {};
}

// ===================== İLKİN MƏLUMAT (BOOTSTRAP) =====================
function bootstrap_(u) {
  var P = permsOf_(u);
  var has = function (k) { return P.indexOf(k) !== -1; };
  var isSuper = u.role === 'superadmin';
  var users = rows_('Users'), students = rows_('Students'), courses = rows_('Courses'), lessons = rows_('Lessons');

  var sMap = {}; students.forEach(function (s) { sMap[s.id] = s; });
  var uMap = {}; users.forEach(function (x) { uMap[x.id] = x; });
  var byCourse = {};
  lessons.forEach(function (l) { (byCourse[l.courseId] = byCourse[l.courseId] || []).push(l); });

  var visible = has('courses.view') ? courses : courses.filter(function (c) { return c.teacherId === u.id; });
  var outCourses = visible.map(function (c) {
    var withLessons = c.teacherId === u.id || has('attendance.view') || has('attendance.mark');
    return courseView_(c, byCourse[c.id] || [], u, P, sMap, uMap, withLessons);
  });

  var outStudents;
  if (has('students.view')) {
    outStudents = students.map(function (s) {
      return { id: s.id, name: s.name, phone: s.phone, parentName: s.parentName, parentPhone: s.parentPhone, note: s.note, createdAt: s.createdAt };
    });
  } else {
    var need = {};
    if (has('courses.add') || has('courses.edit')) students.forEach(function (s) { need[s.id] = true; });
    visible.forEach(function (c) { idList_(c.studentIds).forEach(function (id) { need[id] = true; }); });
    outStudents = students.filter(function (s) { return need[s.id]; }).map(function (s) { return { id: s.id, name: s.name }; });
  }

  var outUsers = users.map(function (x) {
    var o = { id: x.id, name: x.name, role: x.role };
    var hideSuper = x.role === 'superadmin' && !isSuper;
    if (has('teachers.view') && !hideSuper) { o.login = x.login; o.phone = x.phone; o.createdAt = x.createdAt; }
    if (isSuper && x.role !== 'superadmin') o.permissions = permsOf_(x);
    return o;
  });

  return {
    me: { id: u.id, name: u.name, login: u.login, role: u.role, phone: u.phone, theme: u.theme === 'dark' ? 'dark' : 'light', perms: P, isSuper: isSuper },
    courses: outCourses,
    students: outStudents,
    users: outUsers,
    permCatalog: isSuper ? PERMISSIONS : [],
    permImplied: isSuper ? IMPLIED : {},
    today: today_(),
    now: now_(),
    editWindowHours: EDIT_WINDOW_HOURS
  };
}

function courseView_(c, rows, u, P, sMap, uMap, withLessons) {
  var N = Number(c.lessonsPerMonth) === 12 ? 12 : 8;
  var m = Number(c.monthNo) || 1;
  var ids = idList_(c.studentIds);
  var cur = rows.filter(function (r) { return Number(r.monthNo) === m; });
  var ev = events_(cur, u, P, sMap, uMap);
  var held = ev.filter(function (e) { return e.held; }).length;
  var per = {};
  ids.forEach(function (id) { per[id] = { held: 0, absent: 0 }; });
  var absent = 0;
  cur.forEach(function (r) {
    if (r.status === ABSENT) absent++;
    if (!per[r.studentId]) return;
    if (r.status === HELD) per[r.studentId].held++; else per[r.studentId].absent++;
  });
  var t = uMap[c.teacherId];
  return {
    id: c.id, title: c.title, type: c.type === 'group' ? 'group' : 'individual',
    teacherId: c.teacherId, teacherName: t ? t.name : '(silinmiş müəllim)',
    studentIds: ids, lessonsPerMonth: N, monthNo: m, monthStart: c.monthStart,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
    held: held, absent: absent, complete: held >= N, perStudent: per,
    lastDate: ev.length ? ev[ev.length - 1].date : '',
    lessons: withLessons ? ev : null
  };
}

/** Sətirləri dərs hadisələrinə (lessonId üzrə) birləşdirir və nömrələyir. */
function events_(rows, u, P, sMap, uMap) {
  var g = {}, order = [];
  rows.forEach(function (r) {
    if (!g[r.lessonId]) {
      g[r.lessonId] = {
        lessonId: r.lessonId, courseId: r.courseId, monthNo: Number(r.monthNo) || 1, date: r.date, topic: r.topic,
        markedBy: r.markedBy, markedByName: uMap[r.markedBy] ? uMap[r.markedBy].name : (r.markedBy ? '(silinmiş istifadəçi)' : '—'),
        markedAt: r.markedAt, editedBy: r.editedBy,
        editedByName: r.editedBy ? (uMap[r.editedBy] ? uMap[r.editedBy].name : '(silinmiş istifadəçi)') : '',
        editedAt: r.editedAt, entries: []
      };
      order.push(r.lessonId);
    }
    g[r.lessonId].entries.push({
      studentId: r.studentId,
      studentName: sMap[r.studentId] ? sMap[r.studentId].name : '(silinmiş tələbə)',
      status: r.status === HELD ? HELD : ABSENT,
      reason: r.reason
    });
  });
  var list = order.map(function (k) { return g[k]; });
  list.forEach(function (e) { e.held = e.entries.some(function (x) { return x.status === HELD; }); });
  list.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.markedAt < b.markedAt ? -1 : (a.markedAt > b.markedAt ? 1 : 0);
  });
  var cnt = {};
  list.forEach(function (e) {
    var k = e.courseId + '|' + e.monthNo;
    if (e.held) { cnt[k] = (cnt[k] || 0) + 1; e.no = cnt[k]; } else e.no = null;
    var age = ageHours_(e.markedAt);
    var own = e.markedBy === u.id && age < EDIT_WINDOW_HOURS;
    e.canEdit = P.indexOf('attendance.edit') !== -1 || own;
    e.canDelete = P.indexOf('attendance.delete') !== -1 || own;
    e.editHoursLeft = e.markedBy === u.id && age < EDIT_WINDOW_HOURS ? Math.max(0, Math.round((EDIT_WINDOW_HOURS - age) * 10) / 10) : null;
  });
  return list;
}

// ===================== TƏLƏBƏLƏR =====================
function studentPayload_(req) {
  return {
    name: reqStr_(req.name, 'Ad Soyad', 2, 80),
    phone: phone_(req.phone, 'Telefon'),
    parentName: str_(req.parentName, 80),
    parentPhone: phone_(req.parentPhone, 'Valideynin telefonu'),
    note: str_(req.note, 500)
  };
}

function diffText_(oldObj, newObj, labels) {
  var out = [];
  Object.keys(labels).forEach(function (k) {
    if (!(k in newObj)) return;
    var a = String(oldObj[k] || ''), b = String(newObj[k] || '');
    if (a !== b) out.push(labels[k] + ': «' + (a || '—') + '» → «' + (b || '—') + '»');
  });
  return out.join('; ');
}

function addStudent_(u, req) {
  need_(u, 'students.add');
  var p = studentPayload_(req);
  var s = { id: newId_('S'), createdAt: now_(), updatedAt: '' };
  Object.keys(p).forEach(function (k) { s[k] = p[k]; });
  insertMany_('Students', [s]);
  log_(u, 'student', 'Tələbə əlavə etdi', s.name + (s.phone ? ' · Tel: ' + s.phone : '') + (s.parentName ? ' · Valideyn: ' + s.parentName : ''));
  return { id: s.id };
}

function editStudent_(u, req) {
  need_(u, 'students.edit');
  var s = mustStudent_(req.id);
  var p = studentPayload_(req);
  var oldName = s.name;
  var diff = diffText_(s, p, STUDENT_FIELDS);
  p.updatedAt = now_();
  update_('Students', s, p);
  log_(u, 'student', 'Tələbəni redaktə etdi', oldName + ' — ' + (diff || 'dəyişiklik edilmədi'));
  return { id: s.id };
}

function deleteStudent_(u, req) {
  need_(u, 'students.delete');
  var s = mustStudent_(req.id);
  var inCourses = rows_('Courses').filter(function (c) { return idList_(c.studentIds).indexOf(s.id) !== -1; });
  if (inCourses.length) {
    throw fail_('Bu tələbə ' + inCourses.length + ' məşğələdə iştirak edir: ' + inCourses.map(courseLabel_).join(', ') +
      '. Əvvəlcə onu məşğələlərdən çıxarın və ya həmin məşğələləri silin.');
  }
  removeRows_('Students', [s._row]);
  log_(u, 'student', 'Tələbəni sildi', s.name + (s.phone ? ' · Tel: ' + s.phone : ''));
  return {};
}

function getStudentCard_(u, req) {
  need_(u, 'students.view');
  var s = mustStudent_(req.id);
  var P = permsOf_(u);
  var users = rows_('Users'), students = rows_('Students'), courses = rows_('Courses'), lessons = rows_('Lessons');
  var sMap = {}; students.forEach(function (x) { sMap[x.id] = x; });
  var uMap = {}; users.forEach(function (x) { uMap[x.id] = x; });
  var cMap = {}; courses.forEach(function (c) { cMap[c.id] = c; });

  var myCourses = courses.filter(function (c) { return idList_(c.studentIds).indexOf(s.id) !== -1; });
  var touched = {};
  lessons.forEach(function (l) { if (l.studentId === s.id) touched[l.courseId] = true; });
  myCourses.forEach(function (c) { touched[c.id] = true; });

  var byCourse = {};
  lessons.forEach(function (l) { if (touched[l.courseId]) (byCourse[l.courseId] = byCourse[l.courseId] || []).push(l); });

  var history = [];
  Object.keys(byCourse).forEach(function (cid) {
    var c = cMap[cid];
    events_(byCourse[cid], u, P, sMap, uMap).forEach(function (e) {
      var mine = e.entries.filter(function (x) { return x.studentId === s.id; })[0];
      if (!mine) return;
      history.push({
        lessonId: e.lessonId, courseId: cid, courseExists: !!c,
        courseTitle: c ? courseLabelFrom_(c, sMap) : '(silinmiş məşğələ)', courseType: c ? c.type : '',
        teacherName: c && uMap[c.teacherId] ? uMap[c.teacherId].name : '—',
        monthNo: e.monthNo, no: e.no, date: e.date, topic: e.topic, status: mine.status, reason: mine.reason,
        markedByName: e.markedByName, markedAt: e.markedAt, editedByName: e.editedByName, editedAt: e.editedAt,
        canEdit: e.canEdit && !!c, canDelete: e.canDelete, groupSize: e.entries.length
      });
    });
  });
  history.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.markedAt < b.markedAt ? 1 : -1;
  });

  var courseViews = myCourses.map(function (c) {
    var v = courseView_(c, byCourse[c.id] || [], u, P, sMap, uMap, false);
    v.mine = v.perStudent[s.id] || { held: 0, absent: 0 };
    v.studentNames = v.studentIds.map(function (id) { return sMap[id] ? sMap[id].name : '(silinmiş tələbə)'; });
    return v;
  });

  var payments = null, total = 0;
  if (P.indexOf('payments.view') !== -1) {
    payments = rows_('Payments').filter(function (p) { return p.studentId === s.id; }).map(function (p) {
      total += Number(p.amount) || 0;
      return {
        id: p.id, amount: Number(p.amount) || 0, date: p.date, note: p.note, monthNo: p.monthNo,
        courseId: p.courseId, courseTitle: p.courseId ? (cMap[p.courseId] ? courseLabelFrom_(cMap[p.courseId], sMap) : '(silinmiş məşğələ)') : '',
        createdByName: uMap[p.createdBy] ? uMap[p.createdBy].name : '—', createdAt: p.createdAt
      };
    }).sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)); });
  }

  log_(u, 'view', 'Tələbə kartına baxdı', s.name);
  return {
    card: {
      student: { id: s.id, name: s.name, phone: s.phone, parentName: s.parentName, parentPhone: s.parentPhone, note: s.note, createdAt: s.createdAt },
      courses: courseViews,
      history: history,
      stats: {
        held: history.filter(function (h) { return h.status === HELD; }).length,
        absent: history.filter(function (h) { return h.status === ABSENT; }).length
      },
      payments: payments,
      paymentsTotal: Math.round(total * 100) / 100
    }
  };
}

function courseLabelFrom_(c, sMap) {
  if (c.title) return c.title;
  var names = idList_(c.studentIds).map(function (id) { return sMap[id] ? sMap[id].name : '(silinmiş tələbə)'; });
  if (c.type === 'individual') return names[0] || 'Fərdi məşğələ';
  return names.slice(0, 2).join(', ') + (names.length > 2 ? ' +' + (names.length - 2) : '');
}

// ===================== İSTİFADƏÇİLƏR =====================
function userPayload_(req, isNew, target) {
  var p = {};
  p.name = reqStr_(req.name, 'Ad Soyad', 2, 80);
  p.login = str_(req.login, 30);
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(p.login)) {
    throw fail_('Login 3–30 simvol olmalı və yalnız latın hərfləri, rəqəmlər, nöqtə, alt xətt və ya tire daxil etməlidir.');
  }
  var dup = rows_('Users').filter(function (x) { return lower_(x.login) === lower_(p.login) && (!target || x.id !== target.id); })[0];
  if (dup) throw fail_('«' + p.login + '» logini artıq istifadə olunur.');
  var pw = String(req.password || '');
  if (isNew || pw) {
    if (pw.length < 4 || pw.length > 50) throw fail_('Şifrə 4–50 simvol olmalıdır.');
    if (/\s/.test(pw)) throw fail_('Şifrədə boşluq olmamalıdır.');
    p.password = pw;
  }
  p.phone = phone_(req.phone, 'Telefon');
  return p;
}

function addUser_(u, req) {
  need_(u, 'teachers.add');
  var role = req.role === 'helper' ? 'helper' : 'teacher';
  var p = userPayload_(req, true, null);
  var row = { id: newId_('U'), role: role, permissions: '', theme: 'light', createdAt: now_(), updatedAt: '' };
  Object.keys(p).forEach(function (k) { row[k] = p[k]; });
  insertMany_('Users', [row]);
  log_(u, 'teacher', role === 'helper' ? 'Yeni köməkçi əlavə etdi' : 'Yeni müəllim əlavə etdi',
    row.name + ' · Login: ' + row.login + (row.phone ? ' · Tel: ' + row.phone : ''));
  return { id: row.id };
}

function editUser_(u, req) {
  var t = mustUser_(req.id);
  if (t.role === 'superadmin') {
    if (u.id !== t.id) throw fail_('Baş admini yalnız özü redaktə edə bilər.', 'PERM');
  } else {
    need_(u, 'teachers.edit');
  }
  var p = userPayload_(req, false, t);
  var newRole = t.role;
  if (t.role !== 'superadmin') {
    newRole = req.role === 'helper' ? 'helper' : 'teacher';
    if (newRole === 'helper' && t.role === 'teacher') {
      var cs = rows_('Courses').filter(function (c) { return c.teacherId === t.id; });
      if (cs.length) throw fail_('Bu müəllimin ' + cs.length + ' məşğələsi var. Köməkçi etməzdən əvvəl məşğələləri başqa müəllimə verin.');
    }
  }
  var changes = [];
  var d = diffText_(t, p, { name: 'Ad Soyad', login: 'Login', phone: 'Telefon' });
  if (d) changes.push(d);
  if (newRole !== t.role) changes.push('Rol: «' + ROLE_LABELS[t.role] + '» → «' + ROLE_LABELS[newRole] + '»');
  if (p.password && p.password !== t.password) changes.push('Şifrə dəyişdirildi');
  var oldName = t.name;
  p.role = newRole;
  p.updatedAt = now_();
  update_('Users', t, p);
  var title = t.role === 'superadmin' ? 'Öz profilini redaktə etdi' : (newRole === 'helper' ? 'Köməkçini redaktə etdi' : 'Müəllimi redaktə etdi');
  log_(u, 'teacher', title, oldName + ' — ' + (changes.join('; ') || 'dəyişiklik edilmədi'));
  return { id: t.id };
}

function deleteUser_(u, req) {
  need_(u, 'teachers.delete');
  var t = mustUser_(req.id);
  if (t.role === 'superadmin') throw fail_('Baş admini silmək olmaz.', 'PERM');
  if (t.id === u.id) throw fail_('Öz hesabınızı silə bilməzsiniz.');
  var cs = rows_('Courses').filter(function (c) { return c.teacherId === t.id; });
  if (cs.length) {
    throw fail_('Bu müəllimin ' + cs.length + ' məşğələsi var: ' + cs.map(courseLabel_).join(', ') +
      '. Əvvəlcə məşğələləri başqa müəllimə verin və ya silin.');
  }
  removeRows_('Users', [t._row]);
  log_(u, 'teacher', t.role === 'helper' ? 'Köməkçini sildi' : 'Müəllimi sildi', t.name + ' · Login: ' + t.login);
  return {};
}

function revealPassword_(u, req) {
  need_(u, 'teachers.passwords');
  var t = mustUser_(req.id);
  if (t.role === 'superadmin' && u.role !== 'superadmin') throw fail_('Baş adminin şifrəsinə baxmaq olmaz.', 'PERM');
  log_(u, 'security', 'Şifrəyə baxdı', t.name + ' (' + ROLE_LABELS[t.role] + ')');
  return { password: t.password };
}

// ===================== MƏŞĞƏLƏLƏR =====================
function coursePayload_(req) {
  var type = req.type === 'group' ? 'group' : (req.type === 'individual' ? 'individual' : '');
  if (!type) throw fail_('Məşğələnin növünü seçin.');
  var teacher = findUser_(req.teacherId);
  if (!teacher || (teacher.role !== 'teacher' && teacher.role !== 'superadmin')) throw fail_('Müəllim seçin.');
  var ids = (Array.isArray(req.studentIds) ? req.studentIds : []).map(String).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  ids.forEach(function (id) { if (!findStudent_(id)) throw fail_('Seçilmiş tələbələrdən biri tapılmadı. Səhifəni yeniləyin.'); });
  if (type === 'individual' && ids.length !== 1) throw fail_('Fərdi məşğələ üçün bir tələbə seçin.');
  if (type === 'group' && ids.length < 2) throw fail_('Qrup məşğələsi üçün ən azı iki tələbə seçin.');
  var N = Number(req.lessonsPerMonth);
  if (N !== 8 && N !== 12) throw fail_('Aylıq dərs sayı 8 və ya 12 olmalıdır.');
  return { type: type, title: str_(req.title, 80), teacherId: teacher.id, studentIds: ids.join(','), lessonsPerMonth: String(N) };
}

function addCourse_(u, req) {
  need_(u, 'courses.add');
  var p = coursePayload_(req);
  var c = { id: newId_('C'), monthNo: '1', monthStart: today_(), createdAt: now_(), updatedAt: '' };
  Object.keys(p).forEach(function (k) { c[k] = p[k]; });
  insertMany_('Courses', [c]);
  log_(u, 'course', TYPE_LABELS[c.type] + ' məşğələ yaratdı',
    '«' + courseLabel_(c) + '» · Müəllim: ' + userName_(c.teacherId) + ' · Tələbə' + (c.type === 'group' ? 'lər' : '') + ': ' +
    idList_(c.studentIds).map(studentName_).join(', ') + ' · Ayda ' + c.lessonsPerMonth + ' dərs');
  return { id: c.id };
}

function editCourse_(u, req) {
  need_(u, 'courses.edit');
  var c = mustCourse_(req.id);
  var p = coursePayload_(req);
  var label = courseLabel_(c);
  var ch = [];
  if (c.type !== p.type) ch.push('Növ: ' + TYPE_LABELS[c.type] + ' → ' + TYPE_LABELS[p.type]);
  if (String(c.title || '') !== p.title) ch.push('Ad: «' + (c.title || '—') + '» → «' + (p.title || '—') + '»');
  if (c.teacherId !== p.teacherId) ch.push('Müəllim: ' + userName_(c.teacherId) + ' → ' + userName_(p.teacherId));
  var oldIds = idList_(c.studentIds), newIds = idList_(p.studentIds);
  var added = newIds.filter(function (x) { return oldIds.indexOf(x) === -1; });
  var removed = oldIds.filter(function (x) { return newIds.indexOf(x) === -1; });
  if (added.length) ch.push('Əlavə edilən tələbələr: ' + added.map(studentName_).join(', '));
  if (removed.length) ch.push('Çıxarılan tələbələr: ' + removed.map(studentName_).join(', '));
  if (String(c.lessonsPerMonth) !== p.lessonsPerMonth) ch.push('Aylıq dərs sayı: ' + c.lessonsPerMonth + ' → ' + p.lessonsPerMonth);
  p.updatedAt = now_();
  update_('Courses', c, p);
  log_(u, 'course', 'Məşğələni redaktə etdi', '«' + label + '» — ' + (ch.join('; ') || 'dəyişiklik edilmədi'));
  return { id: c.id };
}

function deleteCourse_(u, req) {
  need_(u, 'courses.delete');
  var c = mustCourse_(req.id);
  var label = courseLabel_(c);
  var lr = rows_('Lessons').filter(function (l) { return l.courseId === c.id; });
  var events = {};
  lr.forEach(function (l) { events[l.lessonId] = true; });
  if (lr.length) removeRows_('Lessons', lr.map(function (l) { return l._row; }));
  removeRows_('Courses', [findCourse_(c.id)._row]);
  log_(u, 'course', 'Məşğələni sildi',
    '«' + label + '» (' + TYPE_LABELS[c.type] + ') · Müəllim: ' + userName_(c.teacherId) + ' · Silinən dərs qeydləri: ' + Object.keys(events).length);
  return {};
}

function newMonth_(u, req) {
  need_(u, 'month.new');
  var c = mustCourse_(req.id);
  var m = Number(c.monthNo) || 1;
  var held = {};
  rows_('Lessons').forEach(function (l) {
    if (l.courseId === c.id && Number(l.monthNo) === m && l.status === HELD) held[l.lessonId] = true;
  });
  var h = Object.keys(held).length;
  update_('Courses', c, { monthNo: String(m + 1), monthStart: today_(), updatedAt: now_() });
  log_(u, 'month', 'Yeni ay başlatdı', '«' + courseLabel_(c) + '» · Ay ' + m + ' → Ay ' + (m + 1) + ' · Bitən ayda keçirilən dərslər: ' + h + '/' + c.lessonsPerMonth);
  return {};
}

// ===================== DƏRS QEYDLƏRİ =====================
function normEntries_(entries, ids) {
  var map = {};
  (Array.isArray(entries) ? entries : []).forEach(function (e) { if (e && e.studentId) map[String(e.studentId)] = e; });
  Object.keys(map).forEach(function (k) { if (ids.indexOf(k) === -1) throw fail_('Siyahıda məşğələyə aid olmayan tələbə var. Səhifəni yeniləyin.'); });
  return ids.map(function (id) {
    var e = map[id];
    if (!e) throw fail_('Bütün tələbələr üçün qeyd seçin. Səhifəni yeniləyin.');
    var status = e.status === HELD ? HELD : (e.status === ABSENT ? ABSENT : '');
    if (!status) throw fail_('Qeyd növü düzgün deyil.');
    var reason = status === ABSENT ? str_(e.reason, 300) : '';
    if (status === ABSENT && !reason) throw fail_('Qayıb üçün səbəb yazın: ' + studentName_(id) + '.');
    return { studentId: id, status: status, reason: reason };
  });
}

function heldIn_(courseId, monthNo, exceptLessonId) {
  var set = {};
  rows_('Lessons').forEach(function (l) {
    if (l.courseId === courseId && Number(l.monthNo) === Number(monthNo) && l.status === HELD && l.lessonId !== exceptLessonId) set[l.lessonId] = true;
  });
  return Object.keys(set).length;
}

function entriesText_(entries) {
  return entries.map(function (e) {
    return studentName_(e.studentId) + ': ' + e.status + (e.reason ? ' (' + e.reason + ')' : '');
  }).join('; ');
}

function markLesson_(u, req) {
  var c = mustCourse_(req.courseId);
  if (c.teacherId !== u.id && !can_(u, 'attendance.mark')) {
    throw fail_('Bu məşğələdə dərs qeyd etmək üçün icazəniz yoxdur.', 'PERM');
  }
  var date = date_(req.date);
  var topic = str_(req.topic, 200);
  var ids = idList_(c.studentIds);
  if (!ids.length) throw fail_('Məşğələdə tələbə yoxdur.');
  var entries = normEntries_(req.entries, ids);
  var N = Number(c.lessonsPerMonth) || 8;
  var m = Number(c.monthNo) || 1;
  var held = heldIn_(c.id, m, null);
  if (held >= N) throw fail_('Bu ayın bütün dərsləri (' + N + '/' + N + ') artıq qeyd olunub. Tələbə davam edirsə, admin yeni ay başlatmalıdır.');
  var isHeld = entries.some(function (e) { return e.status === HELD; });
  var lessonId = newId_('D');
  var stamp = now_();
  insertMany_('Lessons', entries.map(function (e) {
    return {
      id: newId_('A'), lessonId: lessonId, courseId: c.id, monthNo: String(m), date: date,
      studentId: e.studentId, status: e.status, reason: e.reason, topic: topic,
      markedBy: u.id, markedAt: stamp, editedBy: '', editedAt: ''
    };
  }));
  var action = isHeld ? 'Dərsi keçirilmiş kimi qeyd etdi' : 'Dərsi qayıb kimi qeyd etdi';
  log_(u, 'lesson', action,
    '«' + courseLabel_(c) + '» · Ay ' + m + ' · Tarix: ' + date + ' · ' + (isHeld ? 'Keçirilən dərslər: ' + (held + 1) + '/' + N : 'Dərs sayına daxil edilmədi') +
    (topic ? ' · Mövzu: ' + topic : '') + ' · ' + entriesText_(entries));
  return { lessonId: lessonId, complete: isHeld && held + 1 >= N };
}

function lessonRows_(lessonId) {
  var rows = rows_('Lessons').filter(function (l) { return l.lessonId === String(lessonId); });
  if (!rows.length) throw fail_('Dərs qeydi tapılmadı. Səhifəni yeniləyin.');
  return rows;
}

function canTouchLesson_(u, rows, permKey) {
  if (can_(u, permKey)) return true;
  var r = rows[0];
  return r.markedBy === u.id && ageHours_(r.markedAt) < EDIT_WINDOW_HOURS;
}

function editLesson_(u, req) {
  var rows = lessonRows_(req.lessonId);
  if (!canTouchLesson_(u, rows, 'attendance.edit')) {
    throw fail_('Qeydi düzəltmək üçün vaxt (' + EDIT_WINDOW_HOURS + ' saat) bitib. Düzəliş üçün adminə müraciət edin.', 'PERM');
  }
  var c = findCourse_(rows[0].courseId);
  if (!c) throw fail_('Bu qeydin aid olduğu məşğələ silinib.');
  var ids = rows.map(function (r) { return r.studentId; });
  var date = date_(req.date);
  var topic = str_(req.topic, 200);
  var entries = normEntries_(req.entries, ids);
  var wasHeld = rows.some(function (r) { return r.status === HELD; });
  var isHeld = entries.some(function (e) { return e.status === HELD; });
  var m = Number(rows[0].monthNo) || 1;
  var N = Number(c.lessonsPerMonth) || 8;
  if (isHeld && !wasHeld && heldIn_(c.id, m, rows[0].lessonId) >= N) {
    throw fail_('Bu ayın bütün dərsləri (' + N + '/' + N + ') artıq qeyd olunub. Bu qeydi «keçdi» etmək olmaz.');
  }
  var before = 'Tarix: ' + rows[0].date + (rows[0].topic ? ', Mövzu: ' + rows[0].topic : '') + ', ' +
    entriesText_(rows.map(function (r) { return { studentId: r.studentId, status: r.status, reason: r.reason }; }));
  var stamp = now_();
  var byId = {};
  entries.forEach(function (e) { byId[e.studentId] = e; });
  rows.forEach(function (r) {
    var e = byId[r.studentId];
    update_('Lessons', r, { date: date, topic: topic, status: e.status, reason: e.reason, editedBy: u.id, editedAt: stamp });
  });
  var after = 'Tarix: ' + date + (topic ? ', Mövzu: ' + topic : '') + ', ' + entriesText_(entries);
  log_(u, 'lesson', 'Dərs qeydini düzəltdi', '«' + courseLabel_(c) + '» · Ay ' + m + ' · Əvvəl: [' + before + '] → Sonra: [' + after + ']');
  return {};
}

function deleteLesson_(u, req) {
  var rows = lessonRows_(req.lessonId);
  if (!canTouchLesson_(u, rows, 'attendance.delete')) {
    throw fail_('Qeydi silmək üçün vaxt (' + EDIT_WINDOW_HOURS + ' saat) bitib. Silmək üçün adminə müraciət edin.', 'PERM');
  }
  var c = findCourse_(rows[0].courseId);
  var desc = '«' + courseLabel_(c) + '» · Ay ' + rows[0].monthNo + ' · Tarix: ' + rows[0].date + ' · ' +
    entriesText_(rows.map(function (r) { return { studentId: r.studentId, status: r.status, reason: r.reason }; })) +
    ' · Qeyd edən: ' + userName_(rows[0].markedBy);
  removeRows_('Lessons', rows.map(function (r) { return r._row; }));
  log_(u, 'lesson', 'Dərs qeydini sildi', desc);
  return {};
}

function getLessons_(u, req) {
  var courseId = str_(req.courseId, 40);
  var own = false;
  if (courseId) {
    var cc = findCourse_(courseId);
    own = !!cc && cc.teacherId === u.id;
  }
  if (!own && !can_(u, 'attendance.view')) throw fail_('Dərs tarixçəsinə baxmaq üçün icazəniz yoxdur.', 'PERM');
  var P = permsOf_(u);
  var users = rows_('Users'), students = rows_('Students'), courses = rows_('Courses');
  var sMap = {}; students.forEach(function (x) { sMap[x.id] = x; });
  var uMap = {}; users.forEach(function (x) { uMap[x.id] = x; });
  var cMap = {}; courses.forEach(function (c) { cMap[c.id] = c; });
  var rows = rows_('Lessons');
  if (courseId) rows = rows.filter(function (l) { return l.courseId === courseId; });
  var list = events_(rows, u, P, sMap, uMap);
  list.forEach(function (e) {
    var c = cMap[e.courseId];
    e.courseExists = !!c;
    e.courseTitle = c ? courseLabelFrom_(c, sMap) : '(silinmiş məşğələ)';
    e.courseType = c ? c.type : '';
    e.teacherName = c && uMap[c.teacherId] ? uMap[c.teacherId].name : '—';
    e.lessonsPerMonth = c ? Number(c.lessonsPerMonth) : null;
    if (!c) e.canEdit = false;
  });
  var from = str_(req.from, 10), to = str_(req.to, 10), status = str_(req.status, 10), q = fold_(str_(req.q, 80));
  list = list.filter(function (e) {
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    if (status === HELD && !e.held) return false;
    if (status === ABSENT && !e.entries.some(function (x) { return x.status === ABSENT; })) return false;
    if (q) {
      var hay = fold_([e.courseTitle, e.teacherName, e.markedByName, e.topic].concat(e.entries.map(function (x) { return x.studentName + ' ' + (x.reason || ''); })).join(' '));
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
  list.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.markedAt < b.markedAt ? 1 : -1;
  });
  var offset = Math.max(0, Number(req.offset) || 0);
  var limit = Math.min(200, Math.max(1, Number(req.limit) || 50));
  return { lessons: list.slice(offset, offset + limit), total: list.length };
}

// ===================== ÖDƏNİŞLƏR =====================
function addPayment_(u, req) {
  need_(u, 'payments.add');
  var s = mustStudent_(req.studentId);
  var amount = Number(String(req.amount || '').replace(',', '.'));
  if (!isFinite(amount) || amount <= 0 || amount > 100000) throw fail_('Məbləği düzgün daxil edin.');
  amount = Math.round(amount * 100) / 100;
  var date = date_(req.date);
  var courseId = str_(req.courseId, 40);
  var c = null;
  if (courseId) {
    c = mustCourse_(courseId);
    if (idList_(c.studentIds).indexOf(s.id) === -1) throw fail_('Bu tələbə seçilmiş məşğələdə iştirak etmir.');
  }
  var p = {
    id: newId_('P'), studentId: s.id, courseId: c ? c.id : '', monthNo: c ? String(c.monthNo || 1) : '',
    amount: String(amount), date: date, note: str_(req.note, 200), createdBy: u.id, createdAt: now_()
  };
  insertMany_('Payments', [p]);
  log_(u, 'payment', 'Ödəniş əlavə etdi',
    s.name + ' · ' + amount + ' AZN · Tarix: ' + date + (c ? ' · Məşğələ: «' + courseLabel_(c) + '», Ay ' + p.monthNo : '') + (p.note ? ' · Qeyd: ' + p.note : ''));
  return { id: p.id };
}

function deletePayment_(u, req) {
  need_(u, 'payments.delete');
  var p = rows_('Payments').filter(function (x) { return x.id === String(req.id); })[0];
  if (!p) throw fail_('Ödəniş tapılmadı. Səhifəni yeniləyin.');
  removeRows_('Payments', [p._row]);
  log_(u, 'payment', 'Ödənişi sildi', studentName_(p.studentId) + ' · ' + p.amount + ' AZN · Tarix: ' + p.date + (p.note ? ' · Qeyd: ' + p.note : ''));
  return {};
}

// ===================== JURNAL =====================
function getLogs_(u, req) {
  need_(u, 'logs.view');
  var type = str_(req.type, 20), userId = str_(req.userId, 40), from = str_(req.from, 10), to = str_(req.to, 10), q = fold_(str_(req.q, 80));
  var list = rows_('Logs').slice().reverse().filter(function (l) {
    if (type && l.type !== type) return false;
    if (userId && l.userId !== userId) return false;
    var d = String(l.time).slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (q && fold_(l.userName + ' ' + l.action + ' ' + l.details).indexOf(q) === -1) return false;
    return true;
  });
  var offset = Math.max(0, Number(req.offset) || 0);
  var limit = Math.min(300, Math.max(1, Number(req.limit) || 100));
  return {
    logs: list.slice(offset, offset + limit).map(function (l) {
      return { id: l.id, time: l.time, userId: l.userId, userName: l.userName, role: l.role, type: l.type, action: l.action, details: l.details };
    }),
    total: list.length
  };
}

// ===================== İCAZƏLƏR (yalnız baş admin) =====================
function setPermissions_(u, req) {
  if (u.role !== 'superadmin') throw fail_('«İcazələr» bölməsi yalnız baş admin üçündür.', 'PERM');
  var t = mustUser_(req.userId);
  if (t.role === 'superadmin') throw fail_('Baş adminin icazələrini dəyişmək olmaz.');
  var wanted = (Array.isArray(req.permissions) ? req.permissions : []).map(String).filter(function (k) { return ALL_PERMS.indexOf(k) !== -1; });
  var next = expandPerms_(wanted);
  var prev = permsOf_(t);
  var added = next.filter(function (k) { return prev.indexOf(k) === -1; });
  var removed = prev.filter(function (k) { return next.indexOf(k) === -1; });
  update_('Users', t, { permissions: next.join(','), updatedAt: now_() });
  added.forEach(function (k) {
    log_(u, 'permission', 'İcazə verdi', '«' + t.name + '» istifadəçisinə «' + PERM_LABEL[k] + '» icazəsini verdi');
  });
  removed.forEach(function (k) {
    log_(u, 'permission', 'İcazəni geri aldı', '«' + t.name + '» istifadəçisindən «' + PERM_LABEL[k] + '» icazəsini geri aldı');
  });
  if (!added.length && !removed.length) log_(u, 'permission', 'İcazələri yadda saxladı', '«' + t.name + '» — dəyişiklik edilmədi');
  return { added: added.length, removed: removed.length };
}
