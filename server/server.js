'use strict';

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const multer    = require('multer');
const Database  = require('better-sqlite3');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bni2024';
const DISPLAY_MAX_LIGHTS = 20;
const REWARD_THRESHOLD   = 15;

const DB_DIR  = process.env.DB_DIR || path.join(__dirname, '..', 'database');
const DB_FILE = path.join(DB_DIR, 'event.db');

// ─────────────────────────────────────────────
// Database — better-sqlite3
// ─────────────────────────────────────────────
let db;

function dbRun(sql, params = []) {
  const stmt = db.prepare(sql);
  const result = stmt.run(...params);
  return { lastInsertRowid: result.lastInsertRowid };
}

function dbAll(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function dbGet(sql, params = []) {
  return db.prepare(sql).get(...params) ?? null;
}

function dbScalar(sql, params = []) {
  const row = dbGet(sql, params);
  return row ? Object.values(row)[0] : null;
}

function dbTransaction(fn) {
  db.transaction(fn)();
}

function initDB() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // 建立基本表格
  db.exec(`
    CREATE TABLE IF NOT EXISTS participants (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT    NOT NULL,
      industry           TEXT    NOT NULL DEFAULT '',
      table_number       TEXT    NOT NULL DEFAULT '',
      needs              TEXT    NOT NULL DEFAULT '',
      identity           TEXT    NOT NULL DEFAULT '',
      email              TEXT    DEFAULT NULL,
      is_current_speaker INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT    DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      role         TEXT NOT NULL,
      table_number TEXT NOT NULL DEFAULT '',
      created_at   TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS connections (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL,
      participant_id INTEGER NOT NULL,
      type           TEXT    NOT NULL,
      source         TEXT    NOT NULL DEFAULT 'speaker',
      reason         TEXT    NOT NULL DEFAULT '',
      timestamp      TEXT    DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id, participant_id, type)
    );

    CREATE TABLE IF NOT EXISTS event_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_conn_user    ON connections(user_id);
    CREATE INDEX IF NOT EXISTS idx_conn_part    ON connections(participant_id);
    CREATE INDEX IF NOT EXISTS idx_part_speaker ON participants(is_current_speaker);
  `);

  // ── 遷移：舊 participants 缺少新欄位 ──
  const partCols = db.prepare('PRAGMA table_info(participants)').all().map(c => c.name);
  if (!partCols.includes('identity')) {
    db.exec("ALTER TABLE participants ADD COLUMN identity TEXT NOT NULL DEFAULT ''");
    console.log('✅ 遷移：participants.identity 已新增');
  }
  if (!partCols.includes('email')) {
    db.exec("ALTER TABLE participants ADD COLUMN email TEXT DEFAULT NULL");
    console.log('✅ 遷移：participants.email 已新增');
  }

  // ── 遷移：舊 connections 缺少 reason 欄位 ──
  const connCols = db.prepare('PRAGMA table_info(connections)').all().map(c => c.name);
  if (!connCols.includes('reason')) {
    db.exec("ALTER TABLE connections ADD COLUMN reason TEXT NOT NULL DEFAULT ''");
    console.log('✅ 遷移：connections.reason 已新增');
  }

  // ── 遷移：舊 users 缺少 table_number ──
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('table_number')) {
    db.exec("ALTER TABLE users ADD COLUMN table_number TEXT NOT NULL DEFAULT ''");
    console.log('✅ 遷移：users.table_number 已新增');
  }

  // 初始化 event_state 預設值
  const initPhase = dbGet("SELECT value FROM event_state WHERE key = 'phase'");
  if (!initPhase) {
    db.exec("INSERT OR IGNORE INTO event_state (key, value) VALUES ('phase', 'warmup')");
    db.exec("INSERT OR IGNORE INTO event_state (key, value) VALUES ('countdown_target', '')");
    db.exec("INSERT OR IGNORE INTO event_state (key, value) VALUES ('draw_result', '')");
  }

  console.log('✅ 資料庫初始化完成');
}

// ─────────────────────────────────────────────
// SSE 廣播基礎設施
// ─────────────────────────────────────────────
const sseClients = new Set();

function getEventState() {
  const phase = dbScalar("SELECT value FROM event_state WHERE key = 'phase'") || 'warmup';
  const countdownTarget = dbScalar("SELECT value FROM event_state WHERE key = 'countdown_target'") || '';
  const drawResult = dbScalar("SELECT value FROM event_state WHERE key = 'draw_result'") || '';

  const speaker = dbGet(
    'SELECT id, name, industry, identity, table_number, needs FROM participants WHERE is_current_speaker = 1 LIMIT 1'
  );

  const lightCount = speaker
    ? Math.min(Number(dbScalar(
        "SELECT COUNT(*) FROM connections WHERE participant_id = ? AND type = 'can_provide'",
        [speaker.id]
      )) || 0, DISPLAY_MAX_LIGHTS)
    : 0;

  const totalCanProvide = speaker
    ? Number(dbScalar(
        "SELECT COUNT(*) FROM connections WHERE participant_id = ? AND type = 'can_provide'",
        [speaker.id]
      )) || 0
    : 0;

  const memberCount = Number(dbScalar('SELECT COUNT(*) FROM participants')) || 0;

  return {
    phase,
    countdownTarget,
    drawResult: drawResult ? JSON.parse(drawResult) : null,
    speaker: speaker || null,
    lightCount,
    totalCanProvide,
    isReward:  lightCount >= REWARD_THRESHOLD,
    isJackpot: lightCount >= DISPLAY_MAX_LIGHTS,
    memberCount,
  };
}

function broadcastEventState() {
  if (sseClients.size === 0) return;
  const data = JSON.stringify(getEventState());
  for (const res of sseClients) {
    try { res.write(`event: event-state\ndata: ${data}\n\n`); } catch (_) {}
  }
}

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const adminAuth = (req, res, next) => {
  const pw = req.headers['x-admin-password'] || req.query.ap;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: '管理員密碼錯誤' });
  next();
};

// ─────────────────────────────────────────────
// SSE — GET /api/event-stream
// ─────────────────────────────────────────────
app.get('/api/event-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // 立即推送目前狀態
  const data = JSON.stringify(getEventState());
  res.write(`event: event-state\ndata: ${data}\n\n`);

  // 每 25 秒心跳，避免連線超時
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// ─────────────────────────────────────────────
// 使用者 API
// ─────────────────────────────────────────────

// POST /api/login — 寫入 participants（第一次建立，之後以 name+table_number 恢復）
app.post('/api/login', (req, res) => {
  const { name, tableNumber, needs, identity, email, isFirstTime } = req.body;
  if (!name?.trim())        return res.status(400).json({ error: '請輸入名字' });
  if (!tableNumber?.toString().trim()) return res.status(400).json({ error: '請輸入桌號' });

  const nm = name.trim();
  const tn = tableNumber.toString().trim();

  // Session 恢復：name + table_number 已存在
  const existing = dbGet(
    'SELECT id, name, identity, email, table_number, needs FROM participants WHERE name = ? AND table_number = ?',
    [nm, tn]
  );
  if (existing) {
    return res.json({
      userId:      existing.id,
      name:        existing.name,
      identity:    existing.identity,
      email:       existing.email,
      tableNumber: existing.table_number,
      needs:       existing.needs,
      isNew:       false,
    });
  }

  // 第一次：需要完整資料
  const VALID_IDENTITY = ['長榮會員', '來賓', '親友'];
  if (!VALID_IDENTITY.includes(identity)) return res.status(400).json({ error: '請選擇身份' });

  const r = dbRun(
    'INSERT INTO participants (name, table_number, needs, identity, email) VALUES (?, ?, ?, ?, ?)',
    [nm, tn, (needs || '').trim(), identity, email?.trim() || null]
  );
  broadcastEventState(); // 人數增加，通知預熱頁
  res.json({
    userId:      r.lastInsertRowid,
    name:        nm,
    identity,
    email:       email?.trim() || null,
    tableNumber: tn,
    needs:       (needs || '').trim(),
    isNew:       true,
  });
});

// GET /api/participants
app.get('/api/participants', (_req, res) => {
  const rows = dbAll(
    `SELECT id, name, industry, identity, table_number, needs, is_current_speaker
     FROM participants
     ORDER BY CAST(table_number AS INTEGER), name`
  );
  res.json(rows);
});

// GET /api/current-speaker
app.get('/api/current-speaker', (_req, res) => {
  const row = dbGet(
    `SELECT id, name, industry, identity, table_number, needs
     FROM participants WHERE is_current_speaker = 1 LIMIT 1`
  );
  res.json(row || null);
});

// GET /api/connections?userId=X
app.get('/api/connections', (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: '缺少 userId' });
  const rows = dbAll(
    'SELECT participant_id, type, source, reason FROM connections WHERE user_id = ?',
    [userId]
  );
  res.json(rows);
});

// POST /api/connect — 送出互動（不可撤銷，reason 必填）
app.post('/api/connect', (req, res) => {
  const { userId, participantId, type, source, reason } = req.body;
  if (!userId || !participantId || !type) return res.status(400).json({ error: '缺少必要欄位' });
  if (!reason?.trim()) return res.status(400).json({ error: '請填寫原因' });

  const VALID_T = ['want_to_meet', 'can_provide'];
  const VALID_S = ['speaker', 'browse'];
  if (!VALID_T.includes(type))   return res.status(400).json({ error: '無效的類型' });
  if (source && !VALID_S.includes(source)) return res.status(400).json({ error: '無效的來源' });

  // user_id 現在參照 participants 表
  if (!dbGet('SELECT 1 FROM participants WHERE id = ?', [Number(userId)]))
    return res.status(404).json({ error: '找不到成員' });
  if (!dbGet('SELECT 1 FROM participants WHERE id = ?', [Number(participantId)]))
    return res.status(404).json({ error: '找不到參與者' });

  try {
    dbRun(
      'INSERT INTO connections (user_id, participant_id, type, source, reason) VALUES (?, ?, ?, ?, ?)',
      [Number(userId), Number(participantId), type, source || 'speaker', reason.trim()]
    );
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: '您已送出過這個互動' });
    }
    throw err;
  }

  broadcastEventState();
  res.json({ success: true });
});

// GET /api/warmup-stats — 預熱頁輪詢用
app.get('/api/warmup-stats', (_req, res) => {
  const state = getEventState();
  res.json({
    memberCount:     state.memberCount,
    phase:           state.phase,
    countdownTarget: state.countdownTarget,
  });
});

// GET /api/event-state — 完整活動狀態（一次性請求，SSE 的 fallback）
app.get('/api/event-state', (_req, res) => {
  res.json(getEventState());
});

// GET /api/lights — 取得燈號數（只計 can_provide）
app.get('/api/lights', (_req, res) => {
  const speaker = dbGet('SELECT id FROM participants WHERE is_current_speaker = 1 LIMIT 1');
  if (!speaker) return res.json({ count: 0, speakerId: null, isReward: false, isJackpot: false });
  const total = Number(dbScalar(
    "SELECT COUNT(*) FROM connections WHERE participant_id = ? AND type = 'can_provide'",
    [speaker.id]
  )) || 0;
  const count = Math.min(total, DISPLAY_MAX_LIGHTS);
  res.json({
    count,
    speakerId: speaker.id,
    isReward:  count >= REWARD_THRESHOLD,
    isJackpot: count >= DISPLAY_MAX_LIGHTS,
  });
});

// ─────────────────────────────────────────────
// 管理員 API
// ─────────────────────────────────────────────

// GET /api/admin/stats
app.get('/api/admin/stats', adminAuth, (_req, res) => {
  res.json({
    participants: dbScalar('SELECT COUNT(*) FROM participants'),
    users:        dbScalar('SELECT COUNT(*) FROM users'),
    connections:  dbScalar('SELECT COUNT(*) FROM connections'),
    wantToMeet:   dbScalar("SELECT COUNT(*) FROM connections WHERE type='want_to_meet'"),
    canProvide:   dbScalar("SELECT COUNT(*) FROM connections WHERE type='can_provide'"),
    phase:        dbScalar("SELECT value FROM event_state WHERE key='phase'") || 'warmup',
  });
});

// GET /api/admin/participants
app.get('/api/admin/participants', adminAuth, (_req, res) => {
  res.json(dbAll('SELECT * FROM participants ORDER BY CAST(table_number AS INTEGER), name'));
});

// POST /api/admin/upload — CSV 匯入
app.post('/api/admin/upload', adminAuth, upload.single('csv'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上傳檔案' });

  let content = req.file.buffer.toString('utf-8');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return res.status(400).json({ error: 'CSV 格式錯誤' });

  let imported = 0;
  const errors = [];

  try {
    dbTransaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        const [name = '', industry = '', table_number = '', needs = '', identity = '', email = ''] = cols;
        if (!name.trim()) { errors.push(`第 ${i + 1} 行：名字為空，跳過`); continue; }
        dbRun(
          `INSERT OR REPLACE INTO participants (name, industry, table_number, needs, identity, email)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [name.trim(), industry.trim(), table_number.trim(), needs.trim(),
           identity.trim(), email.trim() || null]
        );
        imported++;
      }
    });
    broadcastEventState();
    res.json({ success: true, imported, errors });
  } catch (err) {
    res.status(500).json({ error: '匯入失敗：' + err.message });
  }
});

// POST /api/admin/set-speaker
app.post('/api/admin/set-speaker', adminAuth, (req, res) => {
  const { participantId } = req.body;
  dbRun('UPDATE participants SET is_current_speaker = 0');
  if (participantId) {
    dbRun('UPDATE participants SET is_current_speaker = 1 WHERE id = ?', [Number(participantId)]);
  }
  // 切換發言者時自動進入 speaking 狀態
  if (participantId) {
    dbRun("INSERT OR REPLACE INTO event_state (key, value) VALUES ('phase', 'speaking')");
  }
  broadcastEventState();
  res.json({ success: true });
});

// POST /api/admin/set-phase — 設定活動階段
app.post('/api/admin/set-phase', adminAuth, (req, res) => {
  const { phase, countdownTarget } = req.body;
  const VALID_PHASES = ['warmup', 'drawing', 'speaking', 'ended'];
  if (!VALID_PHASES.includes(phase)) return res.status(400).json({ error: '無效階段' });

  dbRun("INSERT OR REPLACE INTO event_state (key, value) VALUES ('phase', ?)", [phase]);
  if (countdownTarget !== undefined) {
    dbRun("INSERT OR REPLACE INTO event_state (key, value) VALUES ('countdown_target', ?)", [countdownTarget]);
  }
  broadcastEventState();
  res.json({ success: true });
});

// POST /api/admin/draw — 從 participants 隨機抽一人
app.post('/api/admin/draw', adminAuth, (req, res) => {
  const { excludeSpeakers } = req.body;

  let sql = 'SELECT id, name, identity, table_number, needs FROM participants';
  if (excludeSpeakers) {
    // 排除曾被設為發言者（目前只排除 is_current_speaker=1，可擴充）
    sql += ' WHERE is_current_speaker = 0';
  }

  const pool = dbAll(sql);
  if (pool.length === 0) return res.status(404).json({ error: '沒有可抽選的成員' });

  const winner = pool[Math.floor(Math.random() * pool.length)];

  // 儲存抽選結果並切換到 drawing 階段
  dbRun("INSERT OR REPLACE INTO event_state (key, value) VALUES ('phase', 'drawing')");
  dbRun(
    "INSERT OR REPLACE INTO event_state (key, value) VALUES ('draw_result', ?)",
    [JSON.stringify(winner)]
  );
  broadcastEventState();
  res.json({ success: true, winner });
});

// DELETE /api/admin/connections/:participantId — 清除單一參與者的所有互動記錄（保留本人帳號）
app.delete('/api/admin/connections/:participantId', adminAuth, (req, res) => {
  const id = Number(req.params.participantId);
  if (!id) return res.status(400).json({ error: '無效的 participantId' });
  const result = dbRun('DELETE FROM connections WHERE participant_id = ?', [id]);
  broadcastEventState();
  res.json({ success: true, deleted: result.changes ?? 0 });
});

// DELETE /api/admin/participant/:id
app.delete('/api/admin/participant/:id', adminAuth, (req, res) => {
  const id = Number(req.params.id);
  dbRun('DELETE FROM connections WHERE participant_id = ?', [id]);
  dbRun('DELETE FROM connections WHERE user_id = ?', [id]);
  dbRun('DELETE FROM participants WHERE id = ?', [id]);
  broadcastEventState();
  res.json({ success: true });
});

// DELETE /api/admin/participants — 清除所有參與者
app.delete('/api/admin/participants', adminAuth, (_req, res) => {
  dbRun('DELETE FROM connections');
  dbRun('DELETE FROM participants');
  dbRun("INSERT OR REPLACE INTO event_state (key, value) VALUES ('phase', 'warmup')");
  dbRun("INSERT OR REPLACE INTO event_state (key, value) VALUES ('draw_result', '')");
  broadcastEventState();
  res.json({ success: true });
});

// DELETE /api/admin/users — 清除所有舊 users 表資料
app.delete('/api/admin/users', adminAuth, (_req, res) => {
  dbRun('DELETE FROM users');
  res.json({ success: true });
});

// GET /api/admin/export — 匯出媒合報表 CSV
app.get('/api/admin/export', adminAuth, (_req, res) => {
  const rows = dbAll(`
    SELECT
      p_user.name        AS user_name,
      p_user.identity    AS user_identity,
      p_user.email       AS user_email,
      p_target.name      AS target_name,
      p_target.identity  AS target_identity,
      p_target.table_number AS target_table,
      CASE c.type
        WHEN 'want_to_meet' THEN '我想認識他'
        WHEN 'can_provide'  THEN '我可以幫助他'
        ELSE c.type
      END                AS connection_type,
      c.reason,
      c.source,
      c.timestamp
    FROM connections c
    JOIN participants p_user   ON c.user_id        = p_user.id
    JOIN participants p_target ON c.participant_id  = p_target.id
    ORDER BY c.timestamp
  `);

  const header = 'user_name,user_identity,user_email,target_name,target_identity,target_table,connection_type,reason,source,timestamp';
  const csv = rows.map(r =>
    [r.user_name, r.user_identity, r.user_email || '', r.target_name, r.target_identity,
     r.target_table, r.connection_type, r.reason, r.source, r.timestamp].map(escapeCSV).join(',')
  ).join('\n');

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bni-connections-${date}.csv"`);
  res.send('\uFEFF' + header + '\n' + csv);
});

// GET /api/admin/report — 活動後聯絡包（JSON）
app.get('/api/admin/report', adminAuth, (_req, res) => {
  const members = dbAll("SELECT id, name, identity, email FROM participants WHERE email IS NOT NULL AND email != ''");

  const report = members.map(member => {
    const helpers = dbAll(`
      SELECT p.name, p.email, c.reason, c.timestamp
      FROM connections c
      JOIN participants p ON c.user_id = p.id
      WHERE c.participant_id = ? AND c.type = 'can_provide'
    `, [member.id]);

    const meeters = dbAll(`
      SELECT p.name, p.email, c.reason, c.timestamp
      FROM connections c
      JOIN participants p ON c.user_id = p.id
      WHERE c.participant_id = ? AND c.type = 'want_to_meet'
    `, [member.id]);

    return {
      name:     member.name,
      identity: member.identity,
      email:    member.email,
      helpers,
      meeters,
    };
  });

  res.json(report);
});

// POST /api/my-report — 使用者個人商機小錦囊（以姓名+Email 驗證）
app.post('/api/my-report', (req, res) => {
  const { name, email } = req.body;
  if (!name?.trim() || !email?.trim())
    return res.status(400).json({ error: '請輸入姓名與 Email' });

  const member = dbGet(
    "SELECT id, name, identity FROM participants WHERE name = ? AND LOWER(email) = LOWER(?)",
    [name.trim(), email.trim()]
  );
  if (!member)
    return res.status(404).json({ error: '找不到符合的帳號，請確認姓名與 Email 是否正確' });

  // 誰想認識我
  const meeters = dbAll(`
    SELECT p.name, p.identity, p.email, c.reason
    FROM connections c JOIN participants p ON c.user_id = p.id
    WHERE c.participant_id = ? AND c.type = 'want_to_meet'
    ORDER BY c.timestamp
  `, [member.id]);

  // 誰可以幫助我
  const helpers = dbAll(`
    SELECT p.name, p.identity, p.email, c.reason
    FROM connections c JOIN participants p ON c.user_id = p.id
    WHERE c.participant_id = ? AND c.type = 'can_provide'
    ORDER BY c.timestamp
  `, [member.id]);

  // 我想認識的人（含桌號與 email 作為聯絡線索）
  const myWants = dbAll(`
    SELECT p.name, p.identity, p.email, p.table_number, p.needs, c.reason
    FROM connections c JOIN participants p ON c.participant_id = p.id
    WHERE c.user_id = ? AND c.type = 'want_to_meet'
    ORDER BY c.timestamp
  `, [member.id]);

  res.json({ name: member.name, identity: member.identity, meeters, helpers, myWants });
});

// ─────────────────────────────────────────────
// 頁面路由
// ─────────────────────────────────────────────
app.get('/admin',   (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/display', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'display.html')));
app.get('/warmup',  (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'warmup.html')));

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (line[i] === ',' && !inQ) {
      result.push(cur); cur = '';
    } else {
      cur += line[i];
    }
  }
  result.push(cur);
  return result;
}

function escapeCSV(v) {
  if (v == null) return '';
  const s = String(v);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

// ─────────────────────────────────────────────
// 啟動
// ─────────────────────────────────────────────
try {
  initDB();
} catch (err) {
  console.error('❌ 資料庫初始化失敗:', err);
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  BNI 長榮 20 周年慶 商機變變變  已啟動  ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  用戶:  http://localhost:${PORT}              ║`);
  console.log(`║  管理:  http://localhost:${PORT}/admin        ║`);
  console.log(`║  展示:  http://localhost:${PORT}/display      ║`);
  console.log(`║  預熱:  http://localhost:${PORT}/warmup       ║`);
  console.log(`║  密碼:  ${ADMIN_PASSWORD.padEnd(30)}║`);
  console.log('╚══════════════════════════════════════════╝');
});
