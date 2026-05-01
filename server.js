// ═══════════════════════════════════════════════
// ContentForge Studio V2 — Backend Server
// Express.js + better-sqlite3 (native, sync) + JWT Auth + Poe API Proxy
// Phase 3: better-sqlite3, round-robin API keys, queue monitor, worker process
// ═══════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const BetterSqlite3 = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const { marked } = require('marked');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

// Pipeline worker process (child_process.fork)
let pipelineWorker = null;
let _workerReady = false;
let _workerStatus = { running: 0, pids: [] }; // Updated via IPC
let _workerRestarts = 0;

// ═══════ EMAIL NOTIFICATION (Optional — cần cấu hình SMTP trong .env) ═══════
let _mailTransporter = null;
try {
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_HOST) {
    _mailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    console.log('[EMAIL] SMTP configured:', process.env.SMTP_HOST);
  }
} catch { console.log('[EMAIL] nodemailer not installed — email notifications disabled. Run: npm i nodemailer'); }

function sendAdminNotification(type, data) {
  // Lấy admin_email từ settings
  try {
    const adminEmail = db ? (dbGet("SELECT value FROM app_settings WHERE key='admin_email'")?.value || '') : '';
    if (!adminEmail || !_mailTransporter) return;
    let subject = '', html = '';
    if (type === 'purchase_request') {
      subject = `[ContentForge] Yêu cầu mua ${data.points.toLocaleString()} pts — ${data.username}`;
      html = `<h2>🛒 Yêu cầu mua Points mới</h2>
        <p><strong>User:</strong> ${data.username}</p>
        <p><strong>Gói:</strong> ${data.points.toLocaleString()} pts (${data.price_label})</p>
        <p><strong>Request ID:</strong> #${data.request_id}</p>
        <p>Đăng nhập Admin panel để duyệt hoặc từ chối.</p>`;
    } else if (type === 'new_registration') {
      subject = `[ContentForge] User mới đăng ký — ${data.email}`;
      html = `<h2>👤 User mới đăng ký</h2>
        <p><strong>Email:</strong> ${data.email}</p>
        <p><strong>Tên:</strong> ${data.display_name}</p>`;
    }
    _mailTransporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: adminEmail, subject, html
    }).catch(err => console.error('[EMAIL] Send failed:', err.message));
  } catch (e) { console.error('[EMAIL] Error:', e.message); }
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db; // better-sqlite3 database instance
const dbDir = path.join(__dirname, 'db');
const dbPath = path.join(dbDir, 'contentforge.db');

// ═══════ DB HELPERS (better-sqlite3 — synchronous, native speed) ═══════
const _p = (p) => Array.isArray(p) ? p : (p === undefined || p === null ? [] : [p]);
function dbRun(sql, params = []) { return db.prepare(sql).run(..._p(params)); }
function dbGet(sql, params = []) { return db.prepare(sql).get(..._p(params)) || null; }
function dbAll(sql, params = []) { return db.prepare(sql).all(..._p(params)); }
function dbInsert(sql, params = []) { return Number(db.prepare(sql).run(..._p(params)).lastInsertRowid) || 0; }
// dbExec: for DDL statements (CREATE TABLE, CREATE INDEX, PRAGMA, etc.)
function dbExec(sql) { try { db.exec(sql); } catch(e) { /* ignore migration errors */ } }
// better-sqlite3 writes directly to disk — saveDb is a lightweight WAL checkpoint
function saveDb() {
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (e) { console.error('DB checkpoint error:', e.message); }
}
// Checkpoint every 30 seconds to keep WAL small
setInterval(saveDb, 30000);

// ═══════ API KEY ROUND-ROBIN STATE ═══════
let _apiKeyRRIndex = 0; // Tracks last-used key index for round-robin rotation

// ═══════ INIT ═══════
async function init() {
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  // better-sqlite3: opens or creates file directly (no async init needed)
  db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL'); // Faster than FULL, safe with WAL

  // Create tables
  dbExec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', quota_daily INTEGER DEFAULT 10,
    quota_monthly INTEGER DEFAULT 200, quota_used_today INTEGER DEFAULT 0, quota_used_month INTEGER DEFAULT 0,
    plan TEXT DEFAULT 'free', owner_id INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_login DATETIME)`);
  // Migration: add owner_id for existing installs
  dbExec("ALTER TABLE users ADD COLUMN owner_id INTEGER DEFAULT NULL");
  // Migration: rename legacy 'user' role to 'member'
  dbRun("UPDATE users SET role = 'member' WHERE role = 'user'");
  // Migration: add points_balance for points system
  dbExec("ALTER TABLE users ADD COLUMN points_balance INTEGER DEFAULT 100");

  // ═══════ POINTS SYSTEM TABLES ═══════
  dbExec(`CREATE TABLE IF NOT EXISTS point_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    step_type TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    cost INTEGER NOT NULL DEFAULT 5,
    sort_order INTEGER DEFAULT 0)`);

  dbExec(`CREATE TABLE IF NOT EXISTS point_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    points INTEGER NOT NULL,
    price INTEGER NOT NULL,
    price_label TEXT NOT NULL,
    bonus_label TEXT,
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0)`);

  dbExec(`CREATE TABLE IF NOT EXISTS point_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    pipeline_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  dbExec("CREATE INDEX IF NOT EXISTS idx_pt_user ON point_transactions(user_id)");

  // Seed default point costs if empty
  const pointCostCount = dbGet('SELECT COUNT(*) as c FROM point_costs')?.c || 0;
  if (pointCostCount === 0) {
    const defaultCosts = [
      ['keyword_grouping', 'Keyword Grouping (Batch)', 5, 0],
      ['intent', 'Intent Research', 5, 1],
      ['outline', 'Outline Generation', 5, 2],
      ['eval', 'AI Review', 5, 3],
      ['regenerate', 'Regenerate Outline', 5, 4],
      ['article', 'Viết bài', 15, 5],
      ['image_context', 'Image Context', 5, 6],
      ['image_gen', 'Image Generation (per H2)', 3, 7],
      ['wp_publish', 'WordPress Publish', 2, 8],
    ];
    for (const [type, name, cost, sort] of defaultCosts) {
      dbInsert('INSERT INTO point_costs (step_type,display_name,cost,sort_order) VALUES (?,?,?,?)', [type, name, cost, sort]);
    }
  }
  // Migration: ensure keyword_grouping exists for already-seeded DBs
  const hasGrouping = dbGet("SELECT id FROM point_costs WHERE step_type='keyword_grouping'");
  if (!hasGrouping) {
    dbInsert('INSERT INTO point_costs (step_type,display_name,cost,sort_order) VALUES (?,?,?,?)', ['keyword_grouping', 'Keyword Grouping (Batch)', 5, 0]);
  }

  // Seed default point packages if empty
  const pointPkgCount = dbGet('SELECT COUNT(*) as c FROM point_packages')?.c || 0;
  if (pointPkgCount === 0) {
    const defaultPkgs = [
      [1000, 100000, '100,000đ', null, 0],
      [5000, 400000, '400,000đ', 'Tiết kiệm 20%', 1],
      [10000, 700000, '700,000đ', 'Tiết kiệm 30%', 2],
      [50000, 3000000, '3,000,000đ', 'Tiết kiệm 40%', 3],
    ];
    for (const [pts, price, label, bonus, sort] of defaultPkgs) {
      dbInsert('INSERT INTO point_packages (points,price,price_label,bonus_label,sort_order) VALUES (?,?,?,?,?)', [pts, price, label, bonus, sort]);
    }
  }


  dbExec(`CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, keyword TEXT NOT NULL,
    field TEXT, company TEXT, style TEXT, extra_keywords TEXT, reference_info TEXT,
    intent_data TEXT, outline TEXT, article TEXT, article_html TEXT, images TEXT,
    word_count INTEGER DEFAULT 0, status TEXT DEFAULT 'draft', outline_status TEXT DEFAULT NULL,
    url TEXT, wp_post_id INTEGER,
    topic_id INTEGER, batch_id TEXT, review_mode TEXT DEFAULT 'manual',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, published_at DATETIME)`);

  // Migration: add outline_status if missing
  dbExec("ALTER TABLE articles ADD COLUMN outline_status TEXT DEFAULT NULL");

  dbExec(`CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    description TEXT, wp_category_id INTEGER, parent_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  dbExec(`CREATE TABLE IF NOT EXISTS urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE NOT NULL, title TEXT, keyword TEXT,
    topic_id INTEGER, is_priority INTEGER DEFAULT 0, article_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  dbExec(`CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key_name TEXT NOT NULL, api_key TEXT NOT NULL,
    is_active INTEGER DEFAULT 1, priority INTEGER DEFAULT 1, usage_count INTEGER DEFAULT 0,
    last_error TEXT, last_used_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  dbExec(`CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, topic_id INTEGER,
    keywords_queue TEXT NOT NULL, articles_per_day INTEGER DEFAULT 1, post_time TEXT DEFAULT '08:00',
    auto_publish INTEGER DEFAULT 0, review_mode TEXT DEFAULT 'auto', status TEXT DEFAULT 'active',
    next_run_at DATETIME, field TEXT, company TEXT, style TEXT, bot_config TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  dbExec(`CREATE TABLE IF NOT EXISTS wp_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, site_name TEXT NOT NULL, site_url TEXT NOT NULL,
    username TEXT NOT NULL, app_password TEXT NOT NULL, is_default INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  dbExec(`CREATE TABLE IF NOT EXISTS keyword_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL, keyword_normalized TEXT NOT NULL,
    article_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  dbExec("CREATE INDEX IF NOT EXISTS idx_keyword_normalized ON keyword_history(keyword_normalized)");

  dbExec(`CREATE TABLE IF NOT EXISTS prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, content TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  dbExec(`CREATE TABLE IF NOT EXISTS bot_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, step_type TEXT NOT NULL, bot_name TEXT NOT NULL,
    display_name TEXT, is_default INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  // Migration: add user_id to urls if missing
  dbExec("ALTER TABLE urls ADD COLUMN user_id INTEGER DEFAULT NULL");

  // ═══════ PIPELINES TABLE (server-side pipeline state) ═══════
  dbExec(`CREATE TABLE IF NOT EXISTS pipelines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'single', status TEXT NOT NULL DEFAULT 'queued',
    current_step INTEGER DEFAULT 0, step_label TEXT DEFAULT 'Đang chờ...',
    priority INTEGER DEFAULT 5, config TEXT NOT NULL,
    intent_data TEXT, outline TEXT, approved_outline TEXT, review_feedback TEXT,
    eval_history TEXT, article TEXT, article_with_images TEXT, images TEXT,
    article_id INTEGER, raw_keywords TEXT, groups_data TEXT, batch_items TEXT,
    error_message TEXT, retry_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME, completed_at DATETIME)`);
  dbExec("CREATE INDEX IF NOT EXISTS idx_pipelines_user_status ON pipelines(user_id, status)");
  dbExec("CREATE INDEX IF NOT EXISTS idx_pipelines_status ON pipelines(status)");

  // ═══════ PIPELINE LOGS TABLE (event tracking for debug/audit) ═══════
  dbExec(`CREATE TABLE IF NOT EXISTS pipeline_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id INTEGER NOT NULL,
    item_id TEXT,
    step TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    metadata TEXT,
    duration_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  dbExec("CREATE INDEX IF NOT EXISTS idx_pl_pipeline ON pipeline_logs(pipeline_id)");
  dbExec("CREATE INDEX IF NOT EXISTS idx_pl_step ON pipeline_logs(step, status)");

  // Migration: add max_batch_size to users if missing
  dbExec("ALTER TABLE users ADD COLUMN max_batch_size INTEGER DEFAULT 5");
  dbExec("ALTER TABLE users ADD COLUMN contact_info TEXT DEFAULT NULL");
  // Set correct max_batch_size for existing users based on plan
  dbRun("UPDATE users SET max_batch_size = 5 WHERE plan = 'free' AND max_batch_size IS NULL");
  dbRun("UPDATE users SET max_batch_size = 20 WHERE plan = 'basic' AND max_batch_size IS NULL");
  dbRun("UPDATE users SET max_batch_size = 50 WHERE plan = 'pro' AND max_batch_size IS NULL");
  dbRun("UPDATE users SET max_batch_size = 9999 WHERE plan = 'enterprise' AND max_batch_size IS NULL");

  // ═══════ QUOTA UPGRADE REQUESTS TABLE ═══════
  dbExec(`CREATE TABLE IF NOT EXISTS quota_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    current_plan TEXT,
    requested_plan TEXT NOT NULL,
    add_daily INTEGER DEFAULT 0,
    add_monthly INTEGER DEFAULT 0,
    message TEXT,
    contact TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    reviewed_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME)`);
  dbExec("CREATE INDEX IF NOT EXISTS idx_qr_user ON quota_requests(user_id)");
  dbExec("CREATE INDEX IF NOT EXISTS idx_qr_status ON quota_requests(status)");

  // ═══════ POINT PURCHASE REQUESTS TABLE ═══════
  dbExec(`CREATE TABLE IF NOT EXISTS point_purchase_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    package_id INTEGER NOT NULL,
    points INTEGER NOT NULL,
    price_label TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    reviewed_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME)`);
  dbExec("CREATE INDEX IF NOT EXISTS idx_ppr_status ON point_purchase_requests(status)");
  dbExec("CREATE INDEX IF NOT EXISTS idx_ppr_user ON point_purchase_requests(user_id)");

  // ═══════ APP SETTINGS TABLE ═══════
  dbExec(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  // Seed defaults
  if (!dbGet("SELECT key FROM app_settings WHERE key='allow_registration'")) {
    dbRun("INSERT INTO app_settings (key, value) VALUES ('allow_registration', '0')");
  }
  if (!dbGet("SELECT key FROM app_settings WHERE key='admin_email'")) {
    dbRun("INSERT INTO app_settings (key, value) VALUES ('admin_email', '')");
  }

  // Migration: add email column to users
  dbExec("ALTER TABLE users ADD COLUMN email TEXT");
  dbExec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL");

  // ═══════ PUBLISH SCHEDULE TABLE ═══════
  dbExec(`CREATE TABLE IF NOT EXISTS publish_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    wp_config_id INTEGER NOT NULL,
    category_id INTEGER,
    wp_status TEXT DEFAULT 'publish',
    scheduled_at DATETIME NOT NULL,
    timezone TEXT DEFAULT 'Asia/Ho_Chi_Minh',
    status TEXT DEFAULT 'pending',
    error_msg TEXT,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    published_at DATETIME)`);

  // ═══════ PLAN CONFIGS TABLE ═══════
  dbExec(`CREATE TABLE IF NOT EXISTS plan_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_key TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    quota_daily INTEGER DEFAULT 10,
    quota_monthly INTEGER DEFAULT 200,
    max_batch_size INTEGER DEFAULT 5,
    price_label TEXT DEFAULT '',
    description TEXT,
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0)`);
  // Seed default plans if empty
  const planCount = dbGet('SELECT COUNT(*) as c FROM plan_configs')?.c || 0;
  if (planCount === 0) {
    const plans = [
      ['free', 'Free', 10, 200, 5, 'Miễn phí', 'Dành cho cá nhân dùng thử', 1, 0],
      ['basic', 'Basic', 30, 600, 20, '299.000đ/tháng', 'Phù hợp blogger cá nhân', 1, 1],
      ['pro', 'Pro', 100, 2000, 50, '699.000đ/tháng', 'Dành cho content team', 1, 2],
      ['enterprise', 'Enterprise', 9999, 99999, 9999, 'Liên hệ', 'Cho doanh nghiệp lớn', 1, 3],
    ];
    for (const [key, name, qd, qm, mb, price, desc, active, sort] of plans) {
      dbInsert('INSERT INTO plan_configs (plan_key,display_name,quota_daily,quota_monthly,max_batch_size,price_label,description,is_active,sort_order) VALUES (?,?,?,?,?,?,?,?,?)',
        [key, name, qd, qm, mb, price, desc, active, sort]);
    }
  }

  // Auto-resume: running → queued on server restart
  const stuckCount = dbGet("SELECT COUNT(*) as c FROM pipelines WHERE status = 'running'")?.c || 0;
  if (stuckCount > 0) {
    dbRun("UPDATE pipelines SET status = 'queued', step_label = 'Tiếp tục sau restart...' WHERE status = 'running'");
    console.log(`[PIPELINE] Auto-resume: ${stuckCount} stuck pipelines re-queued`);
  }

  // Init pipeline engine on server (for cancel/approve IPC)
  // Worker process handles actual execution; server only sets DB state
  // (PipelineQueue is NOT started on server; worker runs it)
  initPipelineEngineLocal();

  // Auto-init admin
  const adminExists = dbGet('SELECT id FROM users WHERE username = ?', 'admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    dbInsert('INSERT INTO users (username,password_hash,display_name,role,plan,quota_daily,quota_monthly) VALUES (?,?,?,?,?,?,?)',
      ['admin', hash, 'Administrator', 'admin', 'enterprise', 9999, 99999]);
  }

  // Auto-init API keys
  if (process.env.POE_API_KEY) {
    if (!dbGet('SELECT id FROM api_keys WHERE api_key = ?', process.env.POE_API_KEY))
      dbInsert('INSERT INTO api_keys (key_name,api_key,priority) VALUES (?,?,?)', ['Primary Key', process.env.POE_API_KEY, 1]);
  }
  if (process.env.POE_API_KEY_2) {
    if (!dbGet('SELECT id FROM api_keys WHERE api_key = ?', process.env.POE_API_KEY_2))
      dbInsert('INSERT INTO api_keys (key_name,api_key,priority) VALUES (?,?,?)', ['Fallback Key', process.env.POE_API_KEY_2, 2]);
  }

  // Default prompt templates — full versions
  const defaultPrompts = {
    intent_prompt: `NHIEM VU: Phan tich search intent + insight nguoi tim kiem + dinh huong EEAT.
Keyword chinh: {keywords}
{context_info}

NGUYEN TAC: Khong dung o 'keyword nghia la gi'. Phai dao sau: van de that su phia sau / nhan thuc sai / dong co tim kiem. Tranh: dinh nghia lai keyword / tra loi chung chung.

OUTPUT (JSON ONLY — khong giai thich them):
{
  "primary_intent": "...",
  "secondary_intents": ["...", "..."],
  "target_audience": "...",
  "search_stage": "...",
  "core_problem": "...",
  "misconceptions": ["...", "..."],
  "desired_outcome": "...",
  "content_angle": "...",
  "related_keywords": ["...", "..."],
  "eeat_signals": {
    "experience": { "user_situations": ["..."], "common_failures": ["..."] },
    "expertise": { "core_mechanisms": ["..."], "deep_topics": ["..."] },
    "trust": { "validation_points": ["..."], "risk_clarifications": ["..."] },
    "authoritativeness": { "decision_factors": ["..."], "selection_criteria": ["..."] }
  }
}

ANTI-AI: Moi field: ngan / ro / usable ngay. Khong viet chung chung, khong lap lai y.`,

    outline_prompt: `NHIEM VU: Tao outline SEO chuyen sau tu intent_json duoi day.
{context_info}

======== INTENT JSON (INPUT) ========
{intent_json}
=====================================

MUC TIEU: Bien insight thanh cau truc bai viet / Flow tu nhien nhu nguoi that / Tich hop EEAT ngam (khong lo).

MOI PHAN PHAI BAM: core_problem / misconceptions / desired_outcome.
Flow: nhan ra van de -> hieu sai o dau -> lam ro ban chat -> cach xu ly -> ap dung.

EEAT (NGAM tu eeat_signals):
- Experience -> tao cho cho tinh huong thuc te, loi thuong gap
- Expertise -> section di vao ban chat, co che
- Trust -> so sanh dung-sai, giai thich ro
- Authoritativeness -> tieu chi lua chon
(KHONG ghi chu EEAT trong outline)

OUTPUT (chi xuat ra):
1. Title
2. Meta
3. Outline: H1 + Intro (2-3 dong) + H2 (toi thieu 3, khong gioi han — tuy do sau cua keyword) + Conclusion

QUY TAC VIET OUTLINE:
- Outline = Y THO. CAM viet cau hoan chinh / doan van. Chi: bullet / keyword + direction.
- H2 phai bam van de: dang "Nhieu nguoi dang hieu sai..." / "Diem khien ban lam mai khong hieu qua"
- Trong moi H2: y chinh / sai lam pho bien / goc nhin ban chat / cau hoi Socratic / vi du thuc te ngan
- Intro: cham core_problem, tao cam giac "dung cai minh dang gap"
- Conclusion: insight chinh, mo them goc nhin

NGUYEN TAC NGON TU (BAT BUOC):
- TUYET DOI KHONG them nam vao Tieu de (Vi du: "nam 2024", "moi nhat 2025") vi du lieu tien doan co the sai lech thoi gian.
- TUYET DOI KHONG dung cac tu ngu tieu cuc, thai qua (nhu "chet nguoi").
- KHONG dung cac thuat ngu giat tit y khoa (nhu "chuan y khoa", "than duoc", "xuong mau", "bi kip").
- Giu ngon tu khach quan, trung thuc va tu nhien.

ANTI-AI: outline phai giong ghi chu cua nguoi viet gioi`,

    eval_prompt: `NHIEM VU: Danh gia chat luong outline dua tren intent da phan tich.
TU KHOA CHINH (KHONG DUOC THAY DOI): {keywords}

======== INTENT JSON ========
{intent_json}
=============================

======== OUTLINE CAN DANH GIA ========
{outline}
======================================

MUC TIEU: Kiem tra outline co thuc su bam insight hay khong / Phat hien diem yeu / Dua ra huong cai thien cu the.

UU TIEN DANH GIA insight alignment hon format. Outline "dung structure nhung sai insight" = FAIL.
KHONG khen xa giao / nhan xet chung chung. Moi nhan xet: cu the / co ly do / co huong sua.

RANG BUOC TUYET DOI:
- KHONG DUOC de xuat thay doi TU KHOA CHINH. Tu khoa phai giu nguyen: {keywords}
- KHONG DUOC de xuat thay doi core_problem, misconceptions, desired_outcome tu intent.
- Chi danh gia va goi y cai thien CAU TRUC, DO SAU, FLOW cua outline.

OUTPUT (JSON ONLY):
{
  "overall_score": 0-100,
  "insight_alignment_score": 0-100,
  "depth_score": 0-100,
  "flow_score": 0-100,
  "seo_score": 0-100,
  "anti_ai_score": 0-100,
  "verdict": "pass | needs_improvement | fail",
  "key_issues": ["...", "..."],
  "missing_insights": ["...", "..."],
  "weak_sections": [{"section":"...","problem":"...","why_it_matters":"...","suggestion":"..."}],
  "improvement_suggestions": ["...", "..."]
}`,

    regenerate_prompt: `NHIEM VU: Cai thien outline hien tai dua tren intent va ban danh gia.
TU KHOA CHINH (GIU NGUYEN, KHONG DOI): {keywords}
{context_info}

======== INTENT JSON ========
{intent_json}
=============================

======== ORIGINAL OUTLINE ========
{original_outline}
==================================

======== EVALUATION JSON ========
{evaluation_json}
=================================

RANG BUOC TUYET DOI:
1. TU KHOA CHINH KHONG DUOC THAY DOI: {keywords} — giu nguyen trong title, H1, cac heading
2. KHONG duoc thay doi core_problem, misconceptions, desired_outcome tu intent_json
3. KHONG duoc doi insight goc — chi cai thien CACH TRINH BAY va CAU TRUC

NGUYEN TAC CAI THIEN:
1. Bo sung DAY DU cac y tu missing_insights va improvement_suggestions vao outline
2. THEM H2/H3 moi neu can de bao phu cac goc nhin con thieu — KHONG gioi han so heading
3. Moi thay doi phai bam: core_problem / misconceptions / desired_outcome
4. KHONG gom y, KHONG giam so heading. Chi duoc THEM hoac SUA, han che XOA
5. Ke thua cau truc hop ly tu original_outline, bo sung them cac phan moi
6. Moi H2 phai co it nhat 3-5 bullet notes cu the

NGUYEN TAC NGON TU (BAT BUOC):
- TUYET DOI KHONG them nam vao Tieu de
- TUYET DOI KHONG dung cac tu ngu tieu cuc, thai qua
- KHONG dung cac thuat ngu giat tit y khoa
- Giu ngon tu khach quan, trung thuc va tu nhien.

OUTPUT FORMAT: MARKDOWN OUTLINE TRUC TIEP (KHONG JSON, KHONG code block)
- Bat dau bang: # Title (PHAI chua tu khoa: {keywords})
- Tiep theo: **Meta:** mota meta description
- **H1:** tieu de H1 (PHAI chua tu khoa: {keywords})
- **Intro:** 2-3 dong gioi thieu
- Cac heading dung ## cho H2, ### cho H3
- Notes/y chinh dung bullet (-)
- Ket thuc outline bang: **Ket:** ket luan

Sau outline, them 1 dong --- roi liet ke ngan gon nhung gi da thay doi.

KHONG tra JSON. KHONG boc trong code block. Chi xuat MARKDOWN TRUC TIEP.
Van giu: Outline = y tho / bullet / keyword + direction / Khong viet thanh doan`,

    article_prompt: `NHIEM VU: Viet bai content hoan chinh cho tu khoa: {keywords}
{context_info}

======== INTENT JSON ========
{intent_json}
=============================

======== OUTLINE (VIET DUNG THEO) ========
{outline}
==========================================
{Nếu có review_feedback: "======== GHI CHU BO SUNG ========\n{review_feedback}\n================================="}
{Nếu có internal_links: "======== CHU DE LIEN QUAN ========\n{internal_links}\nLuu y: KHONG tu y chen link hay URL vao bai viet. Chi nhac den cac chu de tren mot cach TU NHIEN trong noi dung.\n================================="}

SEO TU KHOA (BAT BUOC):
- Tu khoa chinh: {keywords}
- Tu khoa PHAI xuat hien trong: Tieu de H1, doan mo dau (intro), it nhat 2 heading H2, va phan ket luan
- Mat do tu khoa: 1-2% tong so tu — chen TU NHIEN, khong nhoi nhet
- Tu khoa phu (related_keywords tu intent_json): rai deu trong bai

MUC TIEU: Viet bai chat luong cao, tu nhien nhu nguoi that / Co chieu sau insight / Giai quyet dung van de nguoi doc dang gap / Chi xuat ra bai viet cuoi cung.

INSIGHT ALIGNMENT (COT LOI):
Toan bo bai viet phai xoay quanh: core_problem / misconceptions / desired_outcome tu intent_json.
Uu tien: Insight dung > bam outline may moc.

FLOW DAN DAT:
Bat dau tu van de nguoi doc dang gap -> dan dat nhan ra diem chua dung -> lam ro ban chat -> cach xu ly phu hop.

HUMAN WRITING (BAT BUOC):
- Cau ngan - dai xen ke, co nhip dieu tu nhien
- Chuyen y mem: "Nhung van de la..." / "Thuc ra..." / "Neu nhin ky hon..."
- TRANH: lap cau truc cau / van phong may moc / noi dung "dung nhung nhat"

NGUYEN TAC NGON TU (BAT BUOC):
- TUYET DOI KHONG dung cac tu ngu tieu cuc, thai qua (vi du: "chet nguoi").
- KHONG dung cac thuat ngu danh trao khai niem, giat tit kieu y khoa / than thanh hoa (vi du: "chuan y khoa", "than duoc", "xuong mau", "bi kip").
- Su dung ngon tu khach quan, chan thuc, gan gui va do tin cay cao.

PHAN BIEN & INSIGHT:
- Chi ra misconceptions
- Giai thich vi sao "co ve dung nhung chua du"
- Tao cam giac "a, ra la vay"

YEU CAU CUOI:
- Markdown, bat dau bang H1 (PHAI chua tu khoa: {keywords})
- Khong giai thich cach lam, khong nhac lai yeu cau
- Chi xuat ra: BAI VIET HOAN CHINH`,

    image_context_prompt: `Đọc heading và nội dung đoạn văn dưới đây.
Viết 1 prompt mô tả ảnh minh họa PHÙ HỢP VỚI NGỮ CẢNH đoạn văn.

HEADING: {heading}
NỘI DUNG ĐOẠN:
{paragraph_content}

Lĩnh vực: {field}
Keyword: {keywords}

YÊU CẦU:
- Prompt phải mô tả ảnh CỤ THỂ liên quan đến nội dung đoạn
- KHÔNG tạo ảnh chung chung
- BẮT BUỘC thêm "notext" vào cuối prompt (ảnh không có chữ)
- Phong cách: professional, clean, modern

Trả lời CHỈ prompt mô tả ảnh (1 đoạn, tiếng Anh), kết thúc bằng ", notext"
KHÔNG trả JSON, KHÔNG giải thích.`
  };

  // Migrate: rename old keys to new format
  const keyMigration = { intent: 'intent_prompt', outline: 'outline_prompt', article: 'article_prompt' };
  for (const [oldKey, newKey] of Object.entries(keyMigration)) {
    const old = dbGet('SELECT id FROM prompt_templates WHERE key = ?', oldKey);
    if (old) {
      if (!dbGet('SELECT id FROM prompt_templates WHERE key = ?', newKey)) {
        dbRun('UPDATE prompt_templates SET key = ? WHERE key = ?', [newKey, oldKey]);
      } else {
        dbRun('DELETE FROM prompt_templates WHERE key = ?', [oldKey]);
      }
    }
  }

  // Force-update ALL prompts to latest version on every server start
  for (const [k, v] of Object.entries(defaultPrompts)) {
    const existing = dbGet('SELECT id FROM prompt_templates WHERE key = ?', k);
    if (existing) {
      dbRun('UPDATE prompt_templates SET content = ?, updated_at = ? WHERE key = ?', [v, new Date().toISOString(), k]);
    } else {
      dbInsert('INSERT INTO prompt_templates (key,content) VALUES (?,?)', [k, v]);
    }
  }

  // Default bot configs (seed only if table is empty)
  const botCount = dbGet('SELECT COUNT(*) as c FROM bot_configs')?.c || 0;
  if (botCount === 0) {
    const defaultBots = [
      // intent
      { step: 'intent', name: 'Gemini-3.1-Pro', display: 'Gemini 3.1 Pro', def: 1, order: 1 },
      { step: 'intent', name: 'Claude-Sonnet-4.5', display: 'Claude Sonnet 4.5', def: 0, order: 2 },
      { step: 'intent', name: 'GPT-5.4', display: 'GPT 5.4', def: 0, order: 3 },
      { step: 'intent', name: 'Gemini-3-Flash', display: 'Gemini 3 Flash (nhanh)', def: 0, order: 4 },
      // outline
      { step: 'outline', name: 'Gemini-3.1-Pro', display: 'Gemini 3.1 Pro', def: 1, order: 1 },
      { step: 'outline', name: 'Claude-Sonnet-4.5', display: 'Claude Sonnet 4.5', def: 0, order: 2 },
      { step: 'outline', name: 'GPT-5.4', display: 'GPT 5.4', def: 0, order: 3 },
      { step: 'outline', name: 'Gemini-3-Flash', display: 'Gemini 3 Flash (nhanh)', def: 0, order: 4 },
      // eval
      { step: 'eval', name: 'GPT-5.4', display: 'GPT 5.4', def: 1, order: 1 },
      { step: 'eval', name: 'Claude-Sonnet-4.5', display: 'Claude Sonnet 4.5', def: 0, order: 2 },
      { step: 'eval', name: 'Claude-Opus-4.6', display: 'Claude Opus 4.6', def: 0, order: 3 },
      // article
      { step: 'article', name: 'Gemini-3.1-Pro', display: 'Gemini 3.1 Pro', def: 1, order: 1 },
      { step: 'article', name: 'Claude-Sonnet-4.5', display: 'Claude Sonnet 4.5', def: 0, order: 2 },
      { step: 'article', name: 'GPT-5.4', display: 'GPT 5.4', def: 0, order: 3 },
      // image_prompt (text bot for writing image prompts)
      { step: 'image_prompt', name: 'Gemini-3-Flash', display: 'Gemini 3 Flash (nhanh, rẻ)', def: 1, order: 1 },
      { step: 'image_prompt', name: 'Gemini-3.1-Pro', display: 'Gemini 3.1 Pro', def: 0, order: 2 },
      { step: 'image_prompt', name: 'GPT-5.4', display: 'GPT 5.4', def: 0, order: 3 },
      // image
      { step: 'image', name: 'Imagen-4-Ultra', display: 'Imagen 4 Ultra', def: 1, order: 1 },
      { step: 'image', name: 'Imagen-4-Fast', display: 'Imagen 4 Fast (nhanh)', def: 0, order: 2 },
      { step: 'image', name: 'Nano-Banana-Pro', display: 'Nano Banana Pro', def: 0, order: 3 },
      { step: 'image', name: 'Flux-2-Turbo', display: 'Flux 2 Turbo (nhanh)', def: 0, order: 4 },
      { step: 'image', name: 'GPT-Image-1.5', display: 'GPT Image 1.5', def: 0, order: 5 },
    ];
    for (const b of defaultBots) {
      dbInsert('INSERT INTO bot_configs (step_type,bot_name,display_name,is_default,sort_order) VALUES (?,?,?,?,?)',
        [b.step, b.name, b.display, b.def, b.order]);
    }
  }

  saveDb();
  startServer();
}

// ═══════ PIPELINE LOG HELPER (server-side) ═══════
function _logPipelineEvent(pipelineId, step, status, message, metadata, itemId, durationMs) {
  try {
    dbRun(
      'INSERT INTO pipeline_logs (pipeline_id, item_id, step, status, message, metadata, duration_ms) VALUES (?,?,?,?,?,?,?)',
      [pipelineId, itemId || null, step, status, message || null,
       metadata ? JSON.stringify(metadata) : null, durationMs || null]
    );
  } catch (e) { console.error('[LOG] Error writing pipeline log:', e.message); }
}

// ═══════ PIPELINE ENGINE — SERVER-SIDE STUBS ═══════
// The server only uses these for direct cancel/approve; actual execution is in the worker process
let _serverCancelMap = new Map(); // Track cancellable pipelines for server-initiated cancel
function initPipelineEngineLocal() {
  // No-op: worker process handles all execution
  // Server only provides cancel/approve via DB state changes
  console.log('[SERVER] Pipeline execution delegated to worker process');
}

// ═══════ WORKER PROCESS MANAGEMENT ═══════
function startPipelineWorker() {
  const workerPath = path.join(__dirname, 'pipeline-worker.js');
  if (!fs.existsSync(workerPath)) {
    console.warn('[SERVER] pipeline-worker.js not found — running queue in-process (legacy mode)');
    // Fallback: run in-process
    const { initPipelineEngine, PipelineQueue } = require('./pipeline-engine');
    initPipelineEngine({ dbGet, dbRun, dbAll, dbInsert, callPoeAPI, saveDb, logPipelineEvent: _logPipelineEvent });
    const q = new PipelineQueue();
    q.start();
    _workerStatus = { running: q.running.size, pids: [...q.running.keys()], mode: 'in-process' };
    // Expose cancel for admin
    global._legacyQueue = q;
    return;
  }

  pipelineWorker = fork(workerPath, [], {
    env: { ...process.env },
    silent: false // Worker stdout/stderr inherit to terminal
  });

  pipelineWorker.on('message', async (msg) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'ready':
        _workerReady = true;
        console.log(`[SERVER] Pipeline worker ready (PID: ${msg.pid})`);
        break;

      case 'status':
        _workerStatus = { running: msg.running, pids: msg.pids || [], mode: 'worker' };
        break;

      case 'api_call': {
        // Worker needs to make a Poe API call — proxy it through server
        // (so server's rate limiting, key rotation, and _apiKeyRRIndex are used)
        try {
          const resp = await callPoeAPI(msg.bot, msg.prompt, msg.stream, msg.params || {});
          const body = await resp.json();
          pipelineWorker.send({
            type: 'api_response', id: msg.id,
            ok: resp.ok || true, status: 200, body
          });
        } catch (err) {
          pipelineWorker.send({
            type: 'api_response', id: msg.id,
            ok: false, error: err.message
          });
        }
        break;
      }

      case 'error':
        console.error(`[WORKER ERROR] ${msg.message}`);
        break;

      case 'pong':
        // Health check response
        break;
    }
  });

  pipelineWorker.on('exit', (code, signal) => {
    _workerReady = false;
    _workerStatus = { running: 0, pids: [], mode: 'worker' };
    if (code !== 0 && signal !== 'SIGTERM') {
      _workerRestarts++;
      const delay = Math.min(5000 * _workerRestarts, 30000);
      console.error(`[SERVER] Worker exited (code=${code}), restarting in ${delay/1000}s (restart #${_workerRestarts})...`);
      setTimeout(startPipelineWorker, delay);
    } else {
      console.log(`[SERVER] Worker exited cleanly (code=${code})`);
    }
  });

  pipelineWorker.on('error', (err) => {
    console.error('[SERVER] Worker process error:', err.message);
  });

  // Health check every 30s
  setInterval(() => {
    if (pipelineWorker && _workerReady) {
      pipelineWorker.send({ type: 'ping' });
    }
  }, 30000);
}

// Send cancel to worker (called from /api/pipeline/:id/cancel)
function workerCancel(pipelineId) {
  if (pipelineWorker && _workerReady) {
    pipelineWorker.send({ type: 'cancel', pipelineId });
  } else if (global._legacyQueue) {
    global._legacyQueue.cancel(pipelineId);
  }
  // Also mark in DB directly so it sticks even if worker hasn't processed yet
  dbRun(`UPDATE pipelines SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [pipelineId]);
}


// ═══════ RATE LIMITER (in-memory, per user) ═══════
const _rateBuckets = new Map(); // key: "userId:route" → { count, resetAt }
function rateLimiter(route, maxPerMin) {
  return (req, res, next) => {
    if (!req.user) return next(); // skip if no auth
    const key = `${req.user.id}:${route}`;
    const now = Date.now();
    let bucket = _rateBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60000 };
      _rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > maxPerMin) {
      console.log(`[RATE LIMIT] User ${req.user.id} exceeded ${maxPerMin}/min on ${route}`);
      return res.status(429).json({ error: `Quá giới hạn ${maxPerMin} request/phút. Vui lòng thử lại sau.` });
    }
    next();
  };
}
// Cleanup stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of _rateBuckets) {
    if (now > bucket.resetAt) _rateBuckets.delete(key);
  }
}, 300000);

// ═══════ AUTH MIDDLEWARE ═══════
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET || 'default-secret'); next(); }
  catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
function ownerOrAdmin(req, res, next) {
  if (req.user.role !== 'owner' && req.user.role !== 'admin') return res.status(403).json({ error: 'Owner or Admin only' });
  next();
}

// ═══════ POINTS HELPER ═══════
// For members: points tracked on the owner's account (shared pool)
// For owners/admins: points on their own account
function getPointsUser(userId) {
  const u = dbGet('SELECT * FROM users WHERE id = ?', [userId]);
  if (!u) return null;
  if (u.role === 'member' && u.owner_id) {
    return dbGet('SELECT * FROM users WHERE id = ?', [u.owner_id]) || u;
  }
  return u;
}
// Backward compat alias
function getQuotaUser(userId) { return getPointsUser(userId); }

// Get cost for a step type from point_costs table
function getStepCost(stepType) {
  const row = dbGet('SELECT cost FROM point_costs WHERE step_type = ?', [stepType]);
  return row?.cost ?? 0;
}

// Deduct points for a specific step
function deductPoints(userId, stepType, description, pipelineId) {
  const cost = getStepCost(stepType);
  if (cost <= 0) return { cost: 0, balance: 0 };
  const pu = getPointsUser(userId);
  if (!pu) throw new Error('User not found');
  if ((pu.points_balance || 0) < cost) {
    throw new Error(`Không đủ points! Cần ${cost} pts cho ${stepType}, còn ${pu.points_balance || 0} pts`);
  }
  dbRun('UPDATE users SET points_balance = points_balance - ? WHERE id = ?', [cost, pu.id]);
  const newBalance = dbGet('SELECT points_balance FROM users WHERE id = ?', [pu.id])?.points_balance || 0;
  dbInsert('INSERT INTO point_transactions (user_id,amount,balance_after,type,description,pipeline_id) VALUES (?,?,?,?,?,?)',
    [pu.id, -cost, newBalance, 'deduct', description || stepType, pipelineId || null]);
  return { cost, balance: newBalance };
}

// Add points (purchase, admin add, bonus)
function addPoints(userId, amount, type, description) {
  const pu = getPointsUser(userId);
  if (!pu) throw new Error('User not found');
  dbRun('UPDATE users SET points_balance = points_balance + ? WHERE id = ?', [amount, pu.id]);
  const newBalance = dbGet('SELECT points_balance FROM users WHERE id = ?', [pu.id])?.points_balance || 0;
  dbInsert('INSERT INTO point_transactions (user_id,amount,balance_after,type,description) VALUES (?,?,?,?,?)',
    [pu.id, amount, newBalance, type, description]);
  saveDb();
  return { balance: newBalance };
}

// Legacy compat — no-op since we deduct per step now
function deductQuota(userId) {
  // Points are deducted per step in pipeline engine, not per article
}


// ═══════ POE API — ROUND-ROBIN KEY ROTATION ═══════
async function callPoeAPI(bot, prompt, stream, params = {}) {
  const allKeys = dbAll('SELECT * FROM api_keys WHERE is_active = 1 ORDER BY priority ASC, id ASC');
  if (!allKeys.length) throw new Error('No active API keys. Vui lòng thêm API key trong Admin > API Keys.');

  // Round-robin: start from the key AFTER the last successful one
  const n = allKeys.length;
  const startIdx = _apiKeyRRIndex % n;
  const orderedKeys = [...allKeys.slice(startIdx), ...allKeys.slice(0, startIdx)];

  let lastError = null;
  for (const key of orderedKeys) {
    try {
      const body = { model: bot, messages: [{ role: 'user', content: prompt }], stream: !!stream, ...params };
      const resp = await fetch('https://api.poe.com/v1/chat/completions', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + key.api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!resp.ok) {
        let errorDetail = 'HTTP ' + resp.status;
        try { const errBody = await resp.text(); errorDetail += ': ' + errBody.substring(0, 200); } catch {}

        if (resp.status === 402 || resp.status === 403 || resp.status === 429 || resp.status >= 500) {
          const now = new Date().toISOString();
          dbRun('UPDATE api_keys SET last_error = ?, last_used_at = ? WHERE id = ?', [errorDetail, now, key.id]);
          if (resp.status === 402 || resp.status === 403) {
            dbRun('UPDATE api_keys SET is_active = 0, last_error = ? WHERE id = ?',
              ['⚠ Tự động tắt — hết tín dụng (' + resp.status + '): ' + errorDetail.substring(0, 100), key.id]);
            console.log(`[API RR] Key "${key.key_name}" (ID:${key.id}) disabled — credit exhausted (${resp.status})`);
          } else {
            console.log(`[API RR] Key "${key.key_name}" (ID:${key.id}) failed (${resp.status}), trying next...`);
          }
          saveDb();
          lastError = errorDetail;
          continue;
        }
        dbRun('UPDATE api_keys SET last_error = ? WHERE id = ?', [errorDetail, key.id]);
        saveDb();
        lastError = errorDetail;
        continue;
      }
      // ✅ Success — advance round-robin index for next call
      const keyIdx = allKeys.findIndex(k => k.id === key.id);
      _apiKeyRRIndex = (keyIdx + 1) % n;
      dbRun('UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = ?, last_error = NULL WHERE id = ?', [new Date().toISOString(), key.id]);
      saveDb();
      console.log(`[API RR] key="${key.key_name}" (ID:${key.id}) idx=${keyIdx} bot=${bot}`);
      return resp;
    } catch (err) {
      const errMsg = err.message || 'Unknown error';
      dbRun('UPDATE api_keys SET last_error = ? WHERE id = ?', [errMsg, key.id]);
      saveDb();
      lastError = errMsg;
      console.log(`[API RR] Key "${key.key_name}" (ID:${key.id}) network error: ${errMsg}, trying next...`);
      continue;
    }
  }
  throw new Error('Tất cả API keys đều thất bại. Lỗi cuối: ' + (lastError || 'Unknown'));
}

function normalizeKeyword(kw) { return (kw || '').toLowerCase().trim().replace(/\s+/g, ' '); }

// ═══════ AUTH ROUTES ═══════
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    // Cho phép login bằng username HOẶC email
    let user;
    try {
      user = dbGet('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
    } catch {
      // Fallback nếu cột email chưa tồn tại
      user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
    }
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
    dbRun('UPDATE users SET last_login = ? WHERE id = ?', [new Date().toISOString(), user.id]); saveDb();
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, owner_id: user.owner_id || null },
      process.env.JWT_SECRET || 'default-secret', { expiresIn: '24h' });
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', (req, res) => {
  try {
    // Kiểm tra admin có bật đăng ký không
    const allowReg = dbGet("SELECT value FROM app_settings WHERE key='allow_registration'")?.value;
    if (allowReg !== '1') return res.status(403).json({ error: 'Đăng ký tạm thời đã đóng. Vui lòng liên hệ Admin.' });

    const { email, password, display_name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email và mật khẩu là bắt buộc' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email không hợp lệ' });
    if (password.length < 6) return res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự' });

    // Kiểm tra email đã tồn tại chưa
    const exists = dbGet('SELECT id FROM users WHERE email = ? OR username = ?', [email, email]);
    if (exists) return res.status(400).json({ error: 'Email này đã được đăng ký' });

    const hash = bcrypt.hashSync(password, 10);
    const name = display_name || email.split('@')[0];
    // Dùng email làm username, role member, 0 pts
    const id = dbInsert(
      'INSERT INTO users (username, email, password_hash, display_name, role, plan, quota_daily, quota_monthly, points_balance) VALUES (?,?,?,?,?,?,?,?,?)',
      [email, email, hash, name, 'member', 'free', 10, 200, 0]
    );
    saveDb();
    console.log(`[AUTH] New user registered: ${email} (ID: ${id})`);

    // Auto-login
    const token = jwt.sign({ id, username: email, role: 'member', owner_id: null },
      process.env.JWT_SECRET || 'default-secret', { expiresIn: '24h' });
    const user = dbGet('SELECT * FROM users WHERE id = ?', [id]);
    const { password_hash, ...safeUser } = user;

    // Thông báo admin
    sendAdminNotification('new_registration', { email, display_name: name });

    res.json({ token, user: safeUser });
  } catch (e) { 
    console.error('[REGISTER] Error:', e.message);
    res.status(500).json({ error: e.message }); 
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password_hash, ...safe } = user;
  res.json({ user: safe });
});

app.put('/api/auth/change-password', authMiddleware, (req, res) => {
  const { old_password, new_password } = req.body;
  const user = dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!bcrypt.compareSync(old_password, user.password_hash))
    return res.status(400).json({ error: 'Mật khẩu cũ không đúng' });
  dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(new_password, 10), req.user.id]);
  saveDb(); res.json({ success: true });
});

// ═══════ CHAT PROXY ═══════
app.post('/api/chat', authMiddleware, rateLimiter('chat', 30), async (req, res) => {
  try {
    // Points check for direct chat calls (eval, regenerate from UI)
    const pu = getPointsUser(req.user.id);
    if (pu && (pu.points_balance || 0) <= 0)
      return res.status(403).json({ error: 'Hết points! Vui lòng mua thêm points.' });
    const { bot, prompt, stream, parameters } = req.body;
    const poeRes = await callPoeAPI(bot, prompt, stream, parameters || {});
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = poeRes.body.getReader();
      const decoder = new TextDecoder();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          res.write(decoder.decode(value, { stream: true }));
        }
      };
      pump().catch(() => res.end());
    } else {
      const data = await poeRes.json();
      res.json(data);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════ ARTICLES CRUD ═══════
app.get('/api/articles', authMiddleware, (req, res) => {
  try {
    const { page = 1, limit = 20, status, topic_id, search, outline_status } = req.query;
    const offset = (page - 1) * limit;
    let where, p = [];
    if (req.user.role === 'admin') {
      where = '1=1';
    } else if (req.user.role === 'owner') {
      // Owner sees their own articles + all their group members'
      const memberIds = dbAll('SELECT id FROM users WHERE owner_id = ?', [req.user.id]).map(u => u.id);
      const ids = [req.user.id, ...memberIds];
      where = `user_id IN (${ids.map(() => '?').join(',')})`;
      p.push(...ids);
    } else {
      where = 'user_id = ?';
      p.push(req.user.id);
    }
    if (status) { where += ' AND status = ?'; p.push(status); }
    if (outline_status) { where += ' AND outline_status = ?'; p.push(outline_status); }
    if (topic_id) { where += ' AND topic_id = ?'; p.push(+topic_id); }
    if (search) { where += ' AND keyword LIKE ?'; p.push('%' + search + '%'); }
    const total = dbGet('SELECT COUNT(*) as c FROM articles WHERE ' + where, p)?.c || 0;
    const articles = dbAll('SELECT * FROM articles WHERE ' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?', [...p, +limit, +offset]);
    res.json({ articles, total, page: +page, totalPages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/articles/:id', authMiddleware, (req, res) => {
  const a = dbGet('SELECT * FROM articles WHERE id = ?', [+req.params.id]);
  if (!a) return res.status(404).json({ error: 'Not found' });
  // Admin: all; Owner: own + group; Member: own only
  if (req.user.role === 'admin') { return res.json(a); }
  if (req.user.role === 'owner') {
    const memberIds = dbAll('SELECT id FROM users WHERE owner_id = ?', [req.user.id]).map(u => u.id);
    if (a.user_id !== req.user.id && !memberIds.includes(a.user_id)) return res.status(403).json({ error: 'Forbidden' });
    return res.json(a);
  }
  if (a.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  res.json(a);
});

app.post('/api/articles', authMiddleware, (req, res) => {
  try {
    const b = req.body;
    console.log('[POST /api/articles] status:', b.status, 'keyword:', b.keyword, 'has_article:', !!b.article, 'has_outline:', !!b.outline);
    const id = dbInsert('INSERT INTO articles (user_id,keyword,field,company,style,extra_keywords,reference_info,intent_data,outline,article,article_html,images,word_count,status,outline_status,topic_id,batch_id,review_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [req.user.id, b.keyword, b.field, b.company, b.style, b.extra_keywords, b.reference_info,
       typeof b.intent_data === 'object' ? JSON.stringify(b.intent_data) : b.intent_data,
       b.outline, b.article || null, b.article_html || (b.article ? marked(b.article) : null),
       typeof b.images === 'object' ? JSON.stringify(b.images) : (b.images || null),
       b.word_count || 0, b.status || 'draft', b.outline_status || null, b.topic_id || null, b.batch_id || null, b.review_mode || 'manual']);
    const norm = normalizeKeyword(b.keyword);
    dbRun('INSERT INTO keyword_history (keyword,keyword_normalized,article_id,user_id) VALUES (?,?,?,?)', [b.keyword, norm, id, req.user.id]);
    // Quota: deduct from owner pool if member, own account if owner/admin
    if (b.status !== 'outline_only') {
      deductQuota(req.user.id);
    }
    saveDb();
    res.json({ id, success: true });
  } catch (e) { console.error('[POST /api/articles] ERROR:', e.message, e.stack); res.status(500).json({ error: e.message }); }
});

app.put('/api/articles/:id', authMiddleware, (req, res) => {
  try {
    const a = dbGet('SELECT * FROM articles WHERE id = ?', [+req.params.id]);
    if (!a) return res.status(404).json({ error: 'Not found' });
    // Access control
    if (req.user.role === 'member' && a.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (req.user.role === 'owner') {
      const memberIds = dbAll('SELECT id FROM users WHERE owner_id = ?', [req.user.id]).map(u => u.id);
      if (a.user_id !== req.user.id && !memberIds.includes(a.user_id)) return res.status(403).json({ error: 'Forbidden' });
    }
    const fields = ['keyword','field','company','style','extra_keywords','reference_info','intent_data','outline','article','article_html','images','word_count','status','outline_status','url','wp_post_id','topic_id','review_mode'];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        let v = req.body[f]; if (typeof v === 'object') v = JSON.stringify(v);
        dbRun(`UPDATE articles SET ${f} = ? WHERE id = ?`, [v, +req.params.id]);
      }
    }
    // Update quota if transitioning from outline_only to written (deduct from owner pool)
    if (a.status === 'outline_only' && req.body.status && req.body.status !== 'outline_only') {
      deductQuota(req.user.id);
    }
    dbRun('UPDATE articles SET updated_at = ? WHERE id = ?', [new Date().toISOString(), +req.params.id]);
    saveDb(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/articles/:id', authMiddleware, (req, res) => {
  const a = dbGet('SELECT * FROM articles WHERE id = ?', [+req.params.id]);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'member' && a.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (req.user.role === 'owner') {
    const memberIds = dbAll('SELECT id FROM users WHERE owner_id = ?', [req.user.id]).map(u => u.id);
    if (a.user_id !== req.user.id && !memberIds.includes(a.user_id)) return res.status(403).json({ error: 'Forbidden' });
  }
  dbRun('DELETE FROM articles WHERE id = ?', [+req.params.id]); saveDb();
  res.json({ success: true });
});

// ═══════ KEYWORDS ═══════
app.get('/api/keywords/check-duplicate', authMiddleware, (req, res) => {
  try {
    const norm = normalizeKeyword(req.query.keyword);
    const matches = dbAll("SELECT kh.*, a.keyword as original_keyword, a.created_at as article_date FROM keyword_history kh LEFT JOIN articles a ON kh.article_id = a.id WHERE kh.keyword_normalized LIKE ? LIMIT 5", ['%' + norm + '%']);
    res.json({ isDuplicate: matches.length > 0, existingArticles: matches });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/keywords/suggest', authMiddleware, async (req, res) => {
  try {
    const { keyword, field, count = 5 } = req.body;
    const defaultBot = dbGet("SELECT bot_name FROM bot_configs WHERE step_type = 'intent' AND is_default = 1 AND is_active = 1");
    const botName = defaultBot?.bot_name || 'GPT-5.4';
    const prompt = `Gợi ý ${count} từ khóa SEO liên quan cho "${keyword}" (${field || 'chung'}). JSON: [{"keyword":"...","reason":"..."}]`;
    const r = await callPoeAPI(botName, prompt, false);
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || '[]';
    let suggestions = [];
    try { const m = content.match(/\[[\s\S]*\]/); if (m) suggestions = JSON.parse(m[0]); } catch {}
    res.json({ suggestions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════ URLs ═══════
app.get('/api/urls', authMiddleware, (req, res) => {
  let where = '1=1'; const p = [];
  if (req.query.topic_id) { where += ' AND topic_id = ?'; p.push(+req.query.topic_id); }
  if (req.query.is_priority) where += ' AND is_priority = 1';
  if (req.query.search) { where += ' AND (url LIKE ? OR title LIKE ?)'; p.push('%'+req.query.search+'%','%'+req.query.search+'%'); }
  res.json({ urls: dbAll('SELECT * FROM urls WHERE ' + where + ' ORDER BY is_priority DESC', p) });
});
app.post('/api/urls', authMiddleware, (req, res) => {
  try { const b = req.body; const id = dbInsert('INSERT INTO urls (url,title,keyword,topic_id,is_priority,article_id,user_id) VALUES (?,?,?,?,?,?,?)',
    [b.url, b.title, b.keyword, b.topic_id||null, b.is_priority?1:0, b.article_id||null, req.user.id]); saveDb(); res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/urls/:id', authMiddleware, (req, res) => {
  const b = req.body; dbRun('UPDATE urls SET url=?,title=?,keyword=?,topic_id=?,is_priority=? WHERE id=?',
    [b.url,b.title,b.keyword,b.topic_id,b.is_priority?1:0,+req.params.id]); saveDb(); res.json({ success: true });
});
app.delete('/api/urls/:id', authMiddleware, (req, res) => {
  dbRun('DELETE FROM urls WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});
app.post('/api/urls/bulk', authMiddleware, (req, res) => {
  let count = 0;
  for (const u of (req.body.urls || [])) {
    try { dbRun('INSERT OR IGNORE INTO urls (url,title,keyword,topic_id,is_priority,user_id) VALUES (?,?,?,?,?,?)',
      [u.url,u.title,u.keyword,u.topic_id||null,u.is_priority?1:0,req.user.id]); count++; } catch {}
  } saveDb(); res.json({ success: true, count });
});
app.get('/api/urls/for-linking', authMiddleware, (req, res) => {
  const priority = dbAll('SELECT * FROM urls WHERE is_priority = 1');
  let related = [];
  if (req.query.topic_id) related = dbAll('SELECT * FROM urls WHERE topic_id = ? AND is_priority = 0 LIMIT 10', [+req.query.topic_id]);
  res.json({ priority_urls: priority, related_urls: related });
});

// ═══════ TOPICS ═══════
app.get('/api/topics', authMiddleware, (req, res) => { res.json({ topics: dbAll('SELECT * FROM topics ORDER BY name') }); });
app.post('/api/topics', authMiddleware, (req, res) => {
  const { name, description, wp_category_id, parent_id } = req.body;
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '') || 'topic-' + Date.now();
  const id = dbInsert('INSERT INTO topics (name,slug,description,wp_category_id,parent_id) VALUES (?,?,?,?,?)',
    [name, slug, description, wp_category_id, parent_id]); saveDb(); res.json({ id, success: true });
});
app.put('/api/topics/:id', authMiddleware, (req, res) => {
  const { name, description, wp_category_id, parent_id } = req.body;
  const slug = name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'');
  dbRun('UPDATE topics SET name=?,slug=?,description=?,wp_category_id=?,parent_id=? WHERE id=?',
    [name,slug,description,wp_category_id,parent_id,+req.params.id]); saveDb(); res.json({ success: true });
});
app.delete('/api/topics/:id', authMiddleware, (req, res) => {
  dbRun('DELETE FROM topics WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});

// ═══════ BATCH ═══════
const batches = new Map();
app.post('/api/batch/start', authMiddleware, async (req, res) => {
  try {
    const { keywords, field, company, style, review_mode, topic_id, bot_config, enable_images, group_by_ai } = req.body;
    const batchId = 'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const batch = { id: batchId, status: 'running', total: keywords.length, completed: 0, failed: 0,
      articles: keywords.map(kw => ({ keyword: kw, status: 'pending', article_id: null })),
      config: { field, company, style, review_mode, topic_id, bot_config, enable_images } };
    batches.set(batchId, batch);
    processBatch(batchId, req.user).catch(console.error);
    res.json({ batch_id: batchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function processBatch(batchId, user) {
  const batch = batches.get(batchId);
  if (!batch) return;
  for (let i = 0; i < batch.articles.length; i++) {
    if (batch.status === 'cancelled') return;
    const item = batch.articles[i];
    item.status = 'processing';
    try {
      const prompt = `Viết bài SEO cho "${item.keyword}". Lĩnh vực: ${batch.config.field||'chung'}. 1500-3000 từ. Markdown. Bắt đầu bằng H1.`;
      const defaultABot = dbGet("SELECT bot_name FROM bot_configs WHERE step_type = 'article' AND is_default = 1 AND is_active = 1");
      const r = await callPoeAPI(batch.config.bot_config?.articleBot || defaultABot?.bot_name || 'Gemini-3.1-Pro', prompt, false);
      const data = await r.json();
      const content = data.choices?.[0]?.message?.content || '';
      const id = dbInsert('INSERT INTO articles (user_id,keyword,field,company,style,article,article_html,word_count,status,topic_id,batch_id,review_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [user.id, item.keyword, batch.config.field, batch.config.company, batch.config.style, content, marked(content), content.split(/\s+/).length, 'draft', batch.config.topic_id, batchId, 'auto']);
      dbRun('INSERT INTO keyword_history (keyword,keyword_normalized,article_id,user_id) VALUES (?,?,?,?)',
        [item.keyword, normalizeKeyword(item.keyword), id, user.id]);
      saveDb();
      item.status = 'completed'; item.article_id = id; batch.completed++;
    } catch (err) { item.status = 'failed'; item.error = err.message; batch.failed++; }
    await new Promise(r => setTimeout(r, 1000));
  }
  batch.status = batch.failed === batch.total ? 'failed' : 'completed';
}

app.get('/api/batch/:id/status', authMiddleware, (req, res) => {
  const b = batches.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  res.json(b);
});
app.post('/api/batch/:id/cancel', authMiddleware, (req, res) => {
  const b = batches.get(req.params.id); if (b) b.status = 'cancelled';
  res.json({ success: true });
});

// ═══════ SCHEDULES ═══════
app.get('/api/schedules', authMiddleware, (req, res) => {
  const w = req.user.role === 'admin' ? '1=1' : 'user_id = ' + req.user.id;
  res.json({ schedules: dbAll('SELECT * FROM schedules WHERE ' + w + ' ORDER BY created_at DESC') });
});
app.post('/api/schedules', authMiddleware, (req, res) => {
  try {
    const b = req.body; const now = new Date();
    const [h, m] = (b.post_time || '08:00').split(':');
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, +h, +m);
    const id = dbInsert('INSERT INTO schedules (user_id,topic_id,keywords_queue,articles_per_day,post_time,auto_publish,review_mode,status,next_run_at,field,company,style,bot_config) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [req.user.id, b.topic_id, JSON.stringify(b.keywords_queue), b.articles_per_day||1, b.post_time||'08:00',
       b.auto_publish?1:0, b.review_mode||'auto', 'active', next.toISOString(), b.field, b.company, b.style, JSON.stringify(b.bot_config||{})]);
    saveDb(); res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/schedules/:id', authMiddleware, (req, res) => {
  dbRun('DELETE FROM schedules WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});
app.post('/api/schedules/:id/pause', authMiddleware, (req, res) => {
  dbRun("UPDATE schedules SET status = 'paused' WHERE id = ?", [+req.params.id]); saveDb(); res.json({ success: true });
});
app.post('/api/schedules/:id/resume', authMiddleware, (req, res) => {
  dbRun("UPDATE schedules SET status = 'active' WHERE id = ?", [+req.params.id]); saveDb(); res.json({ success: true });
});

// ═══════ WORDPRESS ═══════
app.get('/api/wp/configs', authMiddleware, (req, res) => {
  res.json({ configs: dbAll('SELECT id,site_name,site_url,username,is_default,status,created_at FROM wp_configs ORDER BY is_default DESC') });
});
// Owner and Admin can add WP sites
// Helper: Normalize WP URL
function normalizeWpUrl(url) {
  if (!url) return '';
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/+$/, ''); // Remove trailing slashes
}

app.post('/api/wp/configs', authMiddleware, ownerOrAdmin, (req, res) => {
  const b = req.body;
  const safeUrl = normalizeWpUrl(b.site_url);
  const safePass = (b.app_password || '').replace(/\s+/g, ''); // Xóa dấu cách trong password
  const id = dbInsert('INSERT INTO wp_configs (site_name,site_url,username,app_password) VALUES (?,?,?,?)',
    [b.site_name, safeUrl, b.username, safePass]); saveDb(); res.json({ id, success: true });
});

app.post('/api/wp/configs/:id/test', authMiddleware, async (req, res) => {
  try {
    const c = dbGet('SELECT * FROM wp_configs WHERE id = ?', [+req.params.id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const cleanPass = (c.app_password || '').replace(/\s+/g, '');
    const r = await fetch(c.site_url + '/wp-json/wp/v2/posts?per_page=1', {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(c.username + ':' + cleanPass).toString('base64'),
        'User-Agent': 'ContentForge/1.0' // Fix cho một số plugin chặn request ko có UA
      }
    });
    
    if (r.ok) {
      res.json({ success: true, error: null });
    } else {
      let errStr = `HTTP ${r.status}`;
      if (r.status === 401) errStr = 'HTTP 401: Lỗi xác thực. Sai Username hoặc Mật khẩu Ứng dụng.';
      else if (r.status === 404) errStr = 'HTTP 404: Không tìm thấy REST API. Kiểm tra lại URL.';
      else if (r.status === 403) errStr = 'HTTP 403: Bị chặn. Có thể do plugin bảo mật (Wordfence...).';
      res.json({ success: false, error: errStr });
    }
  } catch (e) { res.json({ success: false, error: 'Lỗi mạng: ' + e.message }); }
});
app.delete('/api/wp/configs/:id', authMiddleware, ownerOrAdmin, (req, res) => {
  dbRun('DELETE FROM wp_configs WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});
function createSlug(str) {
  if (!str) return '';
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Helper: Xử lý và upload ảnh từ POE lên WP trước khi đăng từ lịch sử
async function processArticleImagesForWP(article, config) {
  let md = article.article || '';
  let html = article.article_html || (typeof marked !== 'undefined' ? marked(md) : md);
  const urlRegex = /https?:\/\/[a-zA-Z0-9.-]*poecdn\.net[^\s"'\)]+/g;
  const poeUrls = [...new Set((md.match(urlRegex) || []).concat(html.match(urlRegex) || []))];
  
  let imagesArr = [];
  try { imagesArr = JSON.parse(article.images || '[]'); } catch(e) {}
  
  let firstMediaId = null;
  if (imagesArr.length > 0 && imagesArr[0].mediaId) {
    firstMediaId = imagesArr[0].mediaId;
  }

  if (poeUrls.length === 0) return { html, firstMediaId };

  let updated = false;
  let sharp;
  try { sharp = require('sharp'); } catch(e) { return { html, firstMediaId }; } // fail gracefully
  const cleanPass = (config.app_password || '').replace(/\s+/g, '');
  const authHeader = 'Basic ' + Buffer.from(config.username + ':' + cleanPass).toString('base64');

  for (const originalUrl of poeUrls) {
    try {
      const res = await fetch(originalUrl);
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());

      let optimizedBuffer = await sharp(buffer).resize({ width: 800, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      if (optimizedBuffer.length > 204800) {
        optimizedBuffer = await sharp(buffer).resize({ width: 800, withoutEnlargement: true }).webp({ quality: 60 }).toBuffer();
      }

      const filename = `image-${Date.now()}-${Math.floor(Math.random()*1000)}.webp`;

      const wpRes = await fetch(`${config.site_url}/wp-json/wp/v2/media`, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/webp',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Authorization': authHeader,
          'User-Agent': 'ContentForge/1.0'
        },
        body: optimizedBuffer
      });

      if (wpRes.ok) {
        const wpData = await wpRes.json();
        const newUrl = wpData.source_url;
        if (!firstMediaId) firstMediaId = wpData.id;
        
        md = md.split(originalUrl).join(newUrl);
        html = html.split(originalUrl).join(newUrl);
        
        for (let img of imagesArr) {
          if (img.url === originalUrl) {
            img.url = newUrl;
            img.mediaId = wpData.id;
          }
        }
        updated = true;
        console.log(`[IMG-WP] Bulk uploaded POE image to WP: ${newUrl}`);
      }
    } catch (e) {
      console.error(`[IMG-WP] Failed to process image ${originalUrl}:`, e.message);
    }
  }

  if (updated) {
    dbRun('UPDATE articles SET article=?, article_html=?, images=? WHERE id=?', 
      [md, html, JSON.stringify(imagesArr), article.id]);
  }

  return { html, firstMediaId };
}

app.post('/api/wp/publish', authMiddleware, async (req, res) => {
  try {
    const { article_id, wp_config_id, status = 'publish', category_id, tags } = req.body;
    const article = dbGet('SELECT * FROM articles WHERE id = ?', [+article_id]);
    const config = dbGet('SELECT * FROM wp_configs WHERE id = ?', [+wp_config_id]);
    if (!article || !config) return res.status(404).json({ error: 'Not found' });
    
    const intendedSlug = createSlug(article.keyword);
    const { html, firstMediaId } = await processArticleImagesForWP(article, config);
    const title = (article.article || '').split('\n').find(l => l.startsWith('# '))?.replace('# ', '') || article.keyword;
    const wpBody = { title, content: html, status, slug: intendedSlug };
    if (firstMediaId) wpBody.featured_media = firstMediaId;
    
    if (category_id) wpBody.categories = [+category_id];
    const cleanPass = (config.app_password || '').replace(/\s+/g, '');
    const r = await fetch(config.site_url + '/wp-json/wp/v2/posts', {
      method: 'POST',
      headers: { 
        'Authorization': 'Basic ' + Buffer.from(config.username + ':' + cleanPass).toString('base64'),
        'Content-Type': 'application/json',
        'User-Agent': 'ContentForge/1.0'
      },
      body: JSON.stringify(wpBody)
    });
    const wpData = await r.json();
    if (r.ok) {
      let warning = null;
      if (wpData.slug && wpData.slug !== intendedSlug) {
        warning = `Bị trùng URL: ${wpData.slug}`;
      }
      
      const postUrl = wpData.link || config.site_url + '/?p=' + wpData.id;
      dbRun('UPDATE articles SET wp_post_id=?,url=?,status=?,published_at=? WHERE id=?',
        [wpData.id, postUrl, 'published', new Date().toISOString(), +article_id]);
      try { dbRun('INSERT OR IGNORE INTO urls (url,title,keyword,topic_id,article_id) VALUES (?,?,?,?,?)',
        [postUrl, title, article.keyword, article.topic_id, +article_id]); } catch {}
      saveDb(); res.json({ success: true, url: postUrl, warning });
    } else { res.status(400).json({ error: 'WP error', details: wpData }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/wp/configs/:id/categories', authMiddleware, async (req, res) => {
  try {
    const c = dbGet('SELECT * FROM wp_configs WHERE id = ?', [+req.params.id]);
    const cleanPass = (c.app_password || '').replace(/\s+/g, '');
    const r = await fetch(c.site_url + '/wp-json/wp/v2/categories?per_page=100', {
      headers: { 
        'Authorization': 'Basic ' + Buffer.from(c.username+':'+cleanPass).toString('base64'),
        'User-Agent': 'ContentForge/1.0'
      }
    }); res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════ WP BULK PUBLISH & SCHEDULE ═══════

// Helper: publish 1 article to WP (reused by bulk + scheduler)
async function wpPublishOne(articleId, wpConfigId, categoryId, wpStatus = 'publish') {
  const article = dbGet('SELECT * FROM articles WHERE id = ?', [+articleId]);
  const config = dbGet('SELECT * FROM wp_configs WHERE id = ?', [+wpConfigId]);
  if (!article || !config) return { success: false, error: 'Article or WP config not found' };
  
  const intendedSlug = createSlug(article.keyword);
  const { html, firstMediaId } = await processArticleImagesForWP(article, config);
  const title = (article.article || '').split('\n').find(l => l.startsWith('# '))?.replace('# ', '') || article.keyword;
  const wpBody = { title, content: html, status: wpStatus, slug: intendedSlug };
  if (firstMediaId) wpBody.featured_media = firstMediaId;
  
  if (categoryId) wpBody.categories = [+categoryId];
  const cleanPass = (config.app_password || '').replace(/\s+/g, '');
  const r = await fetch(config.site_url + '/wp-json/wp/v2/posts', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(config.username + ':' + cleanPass).toString('base64'),
      'Content-Type': 'application/json',
      'User-Agent': 'ContentForge/1.0'
    },
    body: JSON.stringify(wpBody)
  });
  const wpData = await r.json();
  if (r.ok) {
    let warning = null;
    if (wpData.slug && wpData.slug !== intendedSlug) {
      warning = `Bị trùng URL: ${wpData.slug}`;
    }
    const postUrl = wpData.link || config.site_url + '/?p=' + wpData.id;
    dbRun('UPDATE articles SET wp_post_id=?,url=?,status=?,published_at=? WHERE id=?',
      [wpData.id, postUrl, 'published', new Date().toISOString(), +articleId]);
    try { dbRun('INSERT OR IGNORE INTO urls (url,title,keyword,topic_id,article_id) VALUES (?,?,?,?,?)',
      [postUrl, title, article.keyword, article.topic_id, +articleId]); } catch {}
    saveDb();
    return { success: true, url: postUrl, wp_id: wpData.id, warning };
  }
  return { success: false, error: wpData.message || 'WP error HTTP ' + r.status };
}

// Bulk publish — đăng ngay nhiều bài
app.post('/api/wp/bulk-publish', authMiddleware, async (req, res) => {
  try {
    const { article_ids, wp_config_id, category_id, status = 'publish' } = req.body;
    if (!article_ids?.length || !wp_config_id) return res.status(400).json({ error: 'Missing article_ids or wp_config_id' });
    const results = [];
    for (const id of article_ids) {
      try {
        const r = await wpPublishOne(id, wp_config_id, category_id, status);
        results.push({ article_id: id, ...r });
      } catch (e) {
        results.push({ article_id: id, success: false, error: e.message });
      }
      // Delay 2s giữa mỗi bài tránh rate limit
      if (article_ids.indexOf(id) < article_ids.length - 1) {
        await new Promise(ok => setTimeout(ok, 2000));
      }
    }
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Schedule — lên lịch 1 bài
app.post('/api/wp/schedule', authMiddleware, (req, res) => {
  try {
    const { article_id, wp_config_id, category_id, wp_status = 'publish', scheduled_at, timezone = 'Asia/Ho_Chi_Minh' } = req.body;
    if (!article_id || !wp_config_id || !scheduled_at) return res.status(400).json({ error: 'Missing required fields' });
    const id = dbInsert('INSERT INTO publish_schedule (article_id,wp_config_id,category_id,wp_status,scheduled_at,timezone,status,created_by) VALUES (?,?,?,?,?,?,?,?)',
      [+article_id, +wp_config_id, category_id || null, wp_status, scheduled_at, timezone, 'pending', req.user.id]);
    saveDb();
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk Schedule — lên lịch hàng loạt
app.post('/api/wp/bulk-schedule', authMiddleware, (req, res) => {
  try {
    const { article_ids, wp_config_id, category_id, wp_status = 'publish', mode, start_date, post_time = '08:00', articles_per_day, total_days, timezone = 'Asia/Ho_Chi_Minh' } = req.body;
    if (!article_ids?.length || !wp_config_id || !start_date) return res.status(400).json({ error: 'Missing required fields' });

    // Tính lịch đăng
    const schedule = [];
    const startD = new Date(start_date + 'T' + post_time + ':00');

    if (mode === 'per_day') {
      // Chế độ: N bài/ngày
      const perDay = Math.max(1, +articles_per_day || 1);
      let dayOffset = 0, countInDay = 0;
      for (const artId of article_ids) {
        const d = new Date(startD);
        d.setDate(d.getDate() + dayOffset);
        // Rải giờ trong ngày: mỗi bài cách nhau 1 giờ từ post_time
        d.setHours(d.getHours() + countInDay);
        schedule.push({ article_id: artId, scheduled_at: d.toISOString() });
        countInDay++;
        if (countInDay >= perDay) { countInDay = 0; dayOffset++; }
      }
    } else {
      // Chế độ: chia đều trong X ngày
      const days = Math.max(1, +total_days || 1);
      const perDay = Math.ceil(article_ids.length / days);
      let dayOffset = 0, countInDay = 0;
      for (const artId of article_ids) {
        const d = new Date(startD);
        d.setDate(d.getDate() + dayOffset);
        d.setHours(d.getHours() + countInDay);
        schedule.push({ article_id: artId, scheduled_at: d.toISOString() });
        countInDay++;
        if (countInDay >= perDay) { countInDay = 0; dayOffset++; }
      }
    }

    // Insert all
    const ids = [];
    for (const s of schedule) {
      const id = dbInsert('INSERT INTO publish_schedule (article_id,wp_config_id,category_id,wp_status,scheduled_at,timezone,status,created_by) VALUES (?,?,?,?,?,?,?,?)',
        [+s.article_id, +wp_config_id, category_id || null, wp_status, s.scheduled_at, timezone, 'pending', req.user.id]);
      ids.push(id);
    }
    saveDb();
    res.json({ success: true, count: ids.length, schedule });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get schedule list
app.get('/api/wp/schedule', authMiddleware, (req, res) => {
  try {
    const rows = dbAll(`SELECT ps.*, a.keyword, a.status as article_status, wc.site_name
      FROM publish_schedule ps
      LEFT JOIN articles a ON a.id = ps.article_id
      LEFT JOIN wp_configs wc ON wc.id = ps.wp_config_id
      WHERE ps.created_by = ? OR ? IN ('admin','owner')
      ORDER BY ps.scheduled_at ASC`,
      [req.user.id, req.user.role]);
    res.json({ schedule: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete schedule item
app.delete('/api/wp/schedule/:id', authMiddleware, (req, res) => {
  try {
    const row = dbGet('SELECT * FROM publish_schedule WHERE id = ?', [+req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status === 'published') return res.status(400).json({ error: 'Đã đăng rồi, không thể xóa' });
    dbRun('DELETE FROM publish_schedule WHERE id = ?', [+req.params.id]);
    saveDb();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════ BACKGROUND SCHEDULER WORKER ═══════
setInterval(async () => {
  try {
    const now = new Date().toISOString();
    const pending = dbAll("SELECT * FROM publish_schedule WHERE status = 'pending' AND scheduled_at <= ?", [now]);
    for (const job of pending) {
      try {
        console.log(`[SCHEDULER] Publishing article #${job.article_id} to WP config #${job.wp_config_id}`);
        const result = await wpPublishOne(job.article_id, job.wp_config_id, job.category_id, job.wp_status);
        if (result.success) {
          dbRun("UPDATE publish_schedule SET status='published', published_at=? WHERE id=?", [new Date().toISOString(), job.id]);
          console.log(`[SCHEDULER] ✅ Article #${job.article_id} published: ${result.url}`);
        } else {
          dbRun("UPDATE publish_schedule SET status='error', error_msg=? WHERE id=?", [result.error, job.id]);
          console.log(`[SCHEDULER] ❌ Article #${job.article_id} failed: ${result.error}`);
        }
        saveDb();
        // Delay 3s between posts
        await new Promise(ok => setTimeout(ok, 3000));
      } catch (e) {
        dbRun("UPDATE publish_schedule SET status='error', error_msg=? WHERE id=?", [e.message, job.id]);
        saveDb();
      }
    }
  } catch (e) { console.error('[SCHEDULER] Error:', e.message); }
}, 60000); // Mỗi 60 giây

// ═══════ PIPELINE API ═══════

app.post('/api/pipeline/start', authMiddleware, rateLimiter('pipeline-start', 10), (req, res) => {
  try {
    const { type = 'single', config, keywords } = req.body;
    if (!config || (type === 'single' && !config.keyword)) {
      return res.status(400).json({ error: 'Missing config or keyword' });
    }
    
    // Points check — use owner pool for members
    const pu = getPointsUser(req.user.id);
    const minCost = getStepCost('intent');
    if (pu && (pu.points_balance || 0) < minCost) return res.status(403).json({ error: `Không đủ points! Cần ít nhất ${minCost} pts, còn ${pu.points_balance || 0} pts` });

    if (type === 'single') {
      const pipelineId = dbInsert(
        "INSERT INTO pipelines (user_id, type, config, raw_keywords) VALUES (?, ?, ?, ?)",
        [req.user.id, type, JSON.stringify(config), JSON.stringify([config.keyword])]
      );
      saveDb();
      res.json({ success: true, pipeline_id: pipelineId });
    } else if (type === 'batch') {
      const kws = keywords || [];
      if (kws.length === 0) return res.status(400).json({ error: 'No keywords' });
      
      // Points check: user must have enough points for at least intent step × keywords
      const batchPu = getPointsUser(req.user.id);
      const intentCost = getStepCost('intent');
      const totalMinCost = intentCost * kws.length;
      if (batchPu && (batchPu.points_balance || 0) < totalMinCost) {
        return res.status(400).json({ error: `Không đủ points! Cần ít nhất ${totalMinCost} pts (${intentCost} × ${kws.length} keywords), còn ${batchPu.points_balance || 0} pts` });
      }
      
      const pipelineId = dbInsert(
        "INSERT INTO pipelines (user_id, type, config, raw_keywords) VALUES (?, ?, ?, ?)",
        [req.user.id, 'batch', JSON.stringify(config), JSON.stringify(kws)]
      );
      _logPipelineEvent(pipelineId, 'pipeline_create', 'done', `Batch created: ${kws.length} keywords`, { keyword_count: kws.length, points_balance: batchPu?.points_balance });
      saveDb();
      res.json({ success: true, pipeline_id: pipelineId });
    } else {
      res.status(400).json({ error: 'Invalid type' });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pipeline/active', authMiddleware, (req, res) => {
  try {
    const pipelines = dbAll(
      "SELECT id, type, status, current_step, step_label, priority, config, raw_keywords, groups_data, batch_items, created_at, started_at, error_message FROM pipelines WHERE user_id = ? AND status IN ('queued', 'running', 'paused') ORDER BY created_at DESC", 
      [req.user.id]
    );
    const recent = dbAll(
      "SELECT id, type, status, current_step, step_label, priority, config, raw_keywords, groups_data, batch_items, article_with_images, created_at, started_at, completed_at, error_message FROM pipelines WHERE user_id = ? AND status IN ('done', 'error', 'cancelled') ORDER BY created_at DESC LIMIT 20", 
      [req.user.id]
    );
    // Parse JSON fields for frontend
    const all = [...pipelines, ...recent].map(p => {
      const parsed = { ...p };
      ['config', 'raw_keywords', 'groups_data', 'batch_items'].forEach(k => {
        try { if (parsed[k]) parsed[k] = JSON.parse(parsed[k]); } catch { parsed[k] = null; }
      });
      return parsed;
    });
    res.json({ pipelines: all });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pipeline/:id/status', authMiddleware, (req, res) => {
  try {
    const p = dbGet("SELECT * FROM pipelines WHERE id=? AND user_id=?", [+req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Not found' });
    
    // Parse JSON fields
    ['config', 'intent_data', 'images', 'raw_keywords', 'groups_data', 'batch_items', 'eval_history'].forEach(k => {
      try { if (p[k]) p[k] = JSON.parse(p[k]); } catch {}
    });
    
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pipeline/:id/approve', authMiddleware, async (req, res) => {
  try {
    const { outline_edited, notes } = req.body;
    const p = dbGet("SELECT * FROM pipelines WHERE id=? AND user_id=?", [+req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.status !== 'paused') return res.status(400).json({ error: 'Pipeline not paused' });

    // Also update config to auto review so it doesn't pause again
    let cfg = JSON.parse(p.config || '{}');
    cfg.reviewMode = 'auto';

    // Update state and queue it back
    dbRun(
      "UPDATE pipelines SET approved_outline=?, review_feedback=?, config=?, status='queued', step_label='Tiếp tục sau duyệt...' WHERE id=?", 
      [outline_edited || p.outline, notes || p.review_feedback, JSON.stringify(cfg), p.id]
    );
    saveDb();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save AI evaluation results to pipeline
app.post('/api/pipeline/:id/eval', authMiddleware, (req, res) => {
  try {
    const { eval_data } = req.body;
    const p = dbGet("SELECT * FROM pipelines WHERE id=? AND user_id=?", [+req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Not found' });
    dbRun("UPDATE pipelines SET eval_history=? WHERE id=?", [JSON.stringify(eval_data), p.id]);
    saveDb();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update pipeline outline (after frontend regeneration/optimization)
app.post('/api/pipeline/:id/update-outline', authMiddleware, (req, res) => {
  try {
    const { outline, original_outline } = req.body;
    const pid = +req.params.id;
    const p = dbGet("SELECT * FROM pipelines WHERE id=? AND user_id=?", [pid, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (!outline) return res.status(400).json({ error: 'No outline provided' });
    
    // Save new outline + keep original for comparison
    if (original_outline) {
      dbRun("UPDATE pipelines SET outline=?, approved_outline=? WHERE id=?", [outline, original_outline, pid]);
    } else {
      dbRun("UPDATE pipelines SET outline=? WHERE id=?", [outline, pid]);
    }
    saveDb();
    console.log(`[PIPELINE] Outline updated for pipeline #${pid} (${outline.length} chars)`);
    res.json({ success: true, saved_length: outline.length });
  } catch (e) { 
    console.error('[PIPELINE] Error saving outline:', e.message);
    res.status(500).json({ error: e.message }); 
  }
});

app.post('/api/pipeline/:id/cancel', authMiddleware, (req, res) => {
  try {
    const p = dbGet("SELECT * FROM pipelines WHERE id=? AND user_id=?", [+req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Not found' });
    workerCancel(p.id); // Send IPC to worker + mark DB cancelled
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Batch: confirm groups (resume from group-review pause)
app.post('/api/pipeline/:id/confirm-groups', authMiddleware, (req, res) => {
  try {
    const { groups } = req.body;
    const p = dbGet("SELECT * FROM pipelines WHERE id=? AND user_id=?", [+req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.status !== 'paused' || !p.groups_data) return res.status(400).json({ error: 'Pipeline not paused or no groups to confirm' });
    
    // Update groups and re-queue
    const updates = { status: 'queued', step_label: 'Tiếp tục sau xác nhận nhóm...' };
    if (groups) updates.groups_data = JSON.stringify(groups);
    
    dbRun(`UPDATE pipelines SET status=?, step_label=?${groups ? ', groups_data=?' : ''} WHERE id=? AND status='paused'`,
      groups ? [updates.status, updates.step_label, updates.groups_data, p.id] : [updates.status, updates.step_label, p.id]);
    saveDb();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pipeline/:id/confirm-review', authMiddleware, (req, res) => {
  try {
    const { items, notes } = req.body;
    const p = dbGet("SELECT * FROM pipelines WHERE id=? AND user_id=?", [+req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.status !== 'paused' || !p.batch_items) return res.status(400).json({ error: 'Pipeline not paused or no items to review' });
    
    // Also update config to auto review so batch doesn't pause again
    let cfg = JSON.parse(p.config || '{}');
    cfg.reviewMode = 'auto';
    
    const updates = { status: 'queued', step_label: 'Tiếp tục sau duyệt...', config: JSON.stringify(cfg) };
    if (items) updates.batch_items = JSON.stringify(items);
    if (notes) updates.review_feedback = notes;
    
    const setClauses = Object.keys(updates).map(k => `${k}=?`).join(', ');
    dbRun(`UPDATE pipelines SET ${setClauses} WHERE id=? AND status='paused'`, [...Object.values(updates), p.id]);
    saveDb();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════ PIPELINE LOGS & RETRY ═══════
app.get('/api/pipeline/:id/logs', authMiddleware, (req, res) => {
  try {
    const p = dbGet("SELECT * FROM pipelines WHERE id=? AND user_id=?", [+req.params.id, req.user.id]);
    if (!p && req.user.role !== 'admin') return res.status(404).json({ error: 'Not found' });
    const logs = dbAll('SELECT * FROM pipeline_logs WHERE pipeline_id=? ORDER BY created_at ASC', [+req.params.id]);
    logs.forEach(l => { try { if (l.metadata) l.metadata = JSON.parse(l.metadata); } catch {} });
    res.json({ logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pipeline/:id/retry', authMiddleware, (req, res) => {
  try {
    const p = dbGet("SELECT * FROM pipelines WHERE id=? AND user_id=?", [+req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.status !== 'error' && p.status !== 'cancelled') {
      return res.status(400).json({ error: 'Chỉ retry được pipeline bị lỗi hoặc đã hủy' });
    }
    if ((p.retry_count || 0) >= 3) {
      return res.status(400).json({ error: 'Đã vượt quá giới hạn retry (tối đa 3 lần)' });
    }
    dbRun(
      "UPDATE pipelines SET status='queued', error_message=NULL, retry_count=retry_count+1, step_label='Đang retry...' WHERE id=? AND status IN ('error','cancelled')",
      [p.id]
    );
    _logPipelineEvent(p.id, 'retry', 'start', `Manual retry #${(p.retry_count||0)+1}`, { previous_error: p.error_message });
    saveDb();
    res.json({ success: true, retry_count: (p.retry_count || 0) + 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pipeline/:id/retry-item', authMiddleware, (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id required' });
    const p = dbGet("SELECT * FROM pipelines WHERE id=? AND user_id=?", [+req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.type !== 'batch') return res.status(400).json({ error: 'Chỉ áp dụng cho batch pipeline' });
    
    let items = [];
    try { items = JSON.parse(p.batch_items || '[]'); } catch {}
    const item = items.find(it => it.id === item_id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    
    // Reset item status
    item.articleStatus = 'pending';
    item.error = null;
    if (item.outlineStatus === 'error') { item.outlineStatus = 'pending'; item.outline = ''; }
    if (item.intentStatus === 'error') { item.intentStatus = 'pending'; item.intentData = null; }
    
    dbRun('UPDATE pipelines SET batch_items=? WHERE id=?', [JSON.stringify(items), p.id]);
    
    // If pipeline is done/error, re-queue it
    if (p.status === 'done' || p.status === 'error') {
      dbRun("UPDATE pipelines SET status='queued', step_label='Retry item...', error_message=NULL WHERE id=?", [p.id]);
    }
    _logPipelineEvent(p.id, 'retry_item', 'start', `Retry item: ${item.keyword}`, { item_id }, item_id);
    saveDb();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════ ADMIN ═══════
app.get('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  const users = dbAll('SELECT id,username,display_name,role,plan,quota_daily,quota_monthly,quota_used_today,quota_used_month,owner_id,created_at,last_login FROM users ORDER BY role ASC, id ASC');
  // Attach owner info for members
  users.forEach(u => {
    if (u.owner_id) {
      const owner = dbGet('SELECT id,username,display_name FROM users WHERE id=?', [u.owner_id]);
      u.owner_name = owner?.display_name || owner?.username || null;
    }
  });
  res.json({ users });
});
app.post('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body; const hash = bcrypt.hashSync(b.password, 10);
    const role = b.role || 'member'; // default to member
    const ownerId = (role === 'member' && b.owner_id) ? +b.owner_id : null;
    const id = dbInsert('INSERT INTO users (username,password_hash,display_name,role,plan,quota_daily,quota_monthly,owner_id) VALUES (?,?,?,?,?,?,?,?)',
      [b.username, hash, b.display_name||b.username, role, b.plan||'free', b.quota_daily||10, b.quota_monthly||200, ownerId]);
    saveDb(); res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/users/:id', authMiddleware, adminOnly, (req, res) => {
  const b = req.body;
  if (b.password) dbRun('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(b.password,10), +req.params.id]);
  const ownerId = (b.role === 'member' && b.owner_id) ? +b.owner_id : (b.role !== 'member' ? null : undefined);
  if (ownerId !== undefined) {
    dbRun('UPDATE users SET display_name=?,role=?,plan=?,quota_daily=?,quota_monthly=?,owner_id=? WHERE id=?',
      [b.display_name, b.role, b.plan, b.quota_daily, b.quota_monthly, ownerId, +req.params.id]);
  } else {
    dbRun('UPDATE users SET display_name=?,role=?,plan=?,quota_daily=?,quota_monthly=? WHERE id=?',
      [b.display_name, b.role, b.plan, b.quota_daily, b.quota_monthly, +req.params.id]);
  }
  saveDb(); res.json({ success: true });
});
app.delete('/api/admin/users/:id', authMiddleware, adminOnly, (req, res) => {
  if (+req.params.id === 1) return res.status(400).json({ error: 'Cannot delete admin' });
  dbRun('DELETE FROM users WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});
app.get('/api/admin/stats', authMiddleware, adminOnly, (req, res) => {
  const totalArticles = dbGet('SELECT COUNT(*) as c FROM articles')?.c || 0;
  const today = new Date().toISOString().slice(0, 10);
  const articlesToday = dbGet("SELECT COUNT(*) as c FROM articles WHERE DATE(created_at) = ?", [today])?.c || 0;
  const totalUsers = dbGet('SELECT COUNT(*) as c FROM users')?.c || 0;
  const apiKeys = dbAll('SELECT key_name,is_active,priority,usage_count,last_error,last_used_at FROM api_keys');
  res.json({ total_articles: totalArticles, articles_today: articlesToday, total_users: totalUsers, api_keys: apiKeys });
});
app.get('/api/admin/prompts', authMiddleware, adminOnly, (req, res) => {
  const prompts = dbAll('SELECT * FROM prompt_templates');
  const result = {}; for (const p of prompts) result[p.key] = p.content;
  res.json(result);
});
app.put('/api/admin/prompts', authMiddleware, adminOnly, (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    const exists = dbGet('SELECT id FROM prompt_templates WHERE key = ?', [k]);
    if (exists) {
      dbRun('UPDATE prompt_templates SET content=?,updated_at=? WHERE key=?', [v, new Date().toISOString(), k]);
    } else {
      dbInsert('INSERT INTO prompt_templates (key,content) VALUES (?,?)', [k, v]);
    }
  }
  saveDb(); res.json({ success: true });
});

// ═══════ ADMIN QUEUE MONITOR ═══════
app.get('/api/admin/queue', authMiddleware, adminOnly, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const stats = {
      running: _workerStatus.running,           // Live from worker IPC
      queued: dbGet("SELECT COUNT(*) as c FROM pipelines WHERE status = 'queued'")?.c || 0,
      paused: dbGet("SELECT COUNT(*) as c FROM pipelines WHERE status = 'paused'")?.c || 0,
      error: dbGet("SELECT COUNT(*) as c FROM pipelines WHERE status = 'error'")?.c || 0,
      done_today: dbGet("SELECT COUNT(*) as c FROM pipelines WHERE status = 'done' AND DATE(completed_at) = ?", [today])?.c || 0,
      total_keys: dbGet("SELECT COUNT(*) as c FROM api_keys WHERE is_active = 1")?.c || 0,
      rr_index: _apiKeyRRIndex,
      worker_ready: _workerReady,
      worker_mode: _workerStatus.mode || 'unknown',
      worker_restarts: _workerRestarts,
      worker_pid: pipelineWorker?.pid || null,
    };
    const pipelines = dbAll(`
      SELECT p.id, p.type, p.status, p.current_step, p.step_label, p.priority,
             p.config, p.raw_keywords, p.batch_items, p.error_message, p.retry_count,
             p.created_at, p.started_at, p.completed_at,
             u.username, u.display_name, u.plan
      FROM pipelines p LEFT JOIN users u ON p.user_id = u.id
      WHERE p.status IN ('queued', 'running', 'paused', 'error')
      ORDER BY p.priority ASC, p.created_at ASC
      LIMIT 100
    `);
    // Parse JSON fields
    pipelines.forEach(p => {
      try { p.config = p.config ? JSON.parse(p.config) : {}; } catch { p.config = {}; }
      try { p.raw_keywords = p.raw_keywords ? JSON.parse(p.raw_keywords) : []; } catch { p.raw_keywords = []; }
      try {
        const items = p.batch_items ? JSON.parse(p.batch_items) : [];
        p.batch_count = items.length;
        p.batch_done = items.filter(i => i.articleStatus === 'done').length;
        delete p.batch_items;
      } catch { p.batch_count = 0; p.batch_done = 0; }
    });
    // API key stats
    const apiKeys = dbAll('SELECT id, key_name, is_active, priority, usage_count, last_error, last_used_at FROM api_keys ORDER BY priority ASC');
    res.json({ stats, pipelines, api_keys: apiKeys });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public prompts endpoint (all authenticated users can read)
app.get('/api/prompts', authMiddleware, (req, res) => {
  const prompts = dbAll('SELECT * FROM prompt_templates');
  const result = {}; for (const p of prompts) result[p.key] = p.content;
  res.json(result);
});
app.get('/api/admin/api-keys', authMiddleware, adminOnly, (req, res) => {
  const keys = dbAll("SELECT id,key_name,SUBSTR(api_key,1,6)||'***'||SUBSTR(api_key,-4) as masked_key,is_active,priority,usage_count,last_error,last_used_at,created_at FROM api_keys ORDER BY priority");
  res.json({ keys });
});
app.post('/api/admin/api-keys', authMiddleware, adminOnly, (req, res) => {
  const b = req.body;
  const id = dbInsert('INSERT INTO api_keys (key_name,api_key,priority) VALUES (?,?,?)', [b.key_name, b.api_key, b.priority||1]);
  saveDb(); res.json({ id, success: true });
});
app.put('/api/admin/api-keys/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body;
    const id = +req.params.id;
    const existing = dbGet('SELECT * FROM api_keys WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (b.api_key !== undefined) dbRun('UPDATE api_keys SET api_key = ? WHERE id = ?', [b.api_key, id]);
    if (b.key_name !== undefined && b.key_name !== '') dbRun('UPDATE api_keys SET key_name = ? WHERE id = ?', [b.key_name, id]);
    if (b.is_active !== undefined) dbRun('UPDATE api_keys SET is_active = ? WHERE id = ?', [b.is_active ? 1 : 0, id]);
    if (b.priority !== undefined) dbRun('UPDATE api_keys SET priority = ? WHERE id = ?', [b.priority, id]);
    if (b.last_error !== undefined) dbRun('UPDATE api_keys SET last_error = ? WHERE id = ?', [b.last_error, id]);
    saveDb(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/api-keys/:id', authMiddleware, adminOnly, (req, res) => {
  dbRun('DELETE FROM api_keys WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});

// ═══════ BOT CONFIGS ═══════
app.get('/api/bot-configs', authMiddleware, (req, res) => {
  try {
    let where = 'is_active = 1'; const p = [];
    if (req.query.step_type) { where += ' AND step_type = ?'; p.push(req.query.step_type); }
    const bots = dbAll('SELECT id,step_type,bot_name,display_name,is_default,sort_order,is_active FROM bot_configs WHERE ' + where + ' ORDER BY sort_order ASC', p);
    res.json({ bots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/bot-configs/all', authMiddleware, adminOnly, (req, res) => {
  try {
    let where = '1=1'; const p = [];
    if (req.query.step_type) { where += ' AND step_type = ?'; p.push(req.query.step_type); }
    const bots = dbAll('SELECT * FROM bot_configs WHERE ' + where + ' ORDER BY step_type, sort_order ASC', p);
    res.json({ bots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/bot-configs', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body;
    if (!b.step_type || !b.bot_name) return res.status(400).json({ error: 'step_type and bot_name required' });
    if (b.is_default) dbRun('UPDATE bot_configs SET is_default = 0 WHERE step_type = ?', [b.step_type]);
    const id = dbInsert('INSERT INTO bot_configs (step_type,bot_name,display_name,is_default,sort_order) VALUES (?,?,?,?,?)',
      [b.step_type, b.bot_name, b.display_name || b.bot_name, b.is_default ? 1 : 0, b.sort_order || 0]);
    saveDb(); res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/bot-configs/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body; const id = +req.params.id;
    const existing = dbGet('SELECT * FROM bot_configs WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (b.is_default) {
      const stepType = b.step_type || existing.step_type;
      dbRun('UPDATE bot_configs SET is_default = 0 WHERE step_type = ?', [stepType]);
    }
    const fields = ['bot_name','display_name','is_default','sort_order','is_active','step_type'];
    for (const f of fields) {
      if (b[f] !== undefined) {
        let v = f === 'is_default' || f === 'is_active' ? (b[f] ? 1 : 0) : b[f];
        dbRun(`UPDATE bot_configs SET ${f} = ? WHERE id = ?`, [v, id]);
      }
    }
    saveDb(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/bot-configs/:id', authMiddleware, adminOnly, (req, res) => {
  dbRun('DELETE FROM bot_configs WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});

// ═══════ POINTS API ═══════
app.get('/api/points', authMiddleware, (req, res) => {
  const pu = getPointsUser(req.user.id);
  const u = dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const isShared = pu && pu.id !== req.user.id;
  const costs = dbAll('SELECT step_type, display_name, cost FROM point_costs ORDER BY sort_order ASC');
  res.json({
    balance: pu?.points_balance || 0,
    plan: pu?.plan || u?.plan,
    is_shared_pool: isShared,
    pool_owner: isShared ? pu?.display_name : null,
    costs
  });
});

// Keep legacy /api/quota for backward compat
app.get('/api/quota', authMiddleware, (req, res) => {
  const pu = getPointsUser(req.user.id);
  res.json({
    daily: { used: 0, limit: 9999, remaining: 9999 },
    monthly: { used: 0, limit: 99999, remaining: 99999 },
    plan: pu?.plan || 'free',
    points_balance: pu?.points_balance || 0,
    is_shared_pool: false, pool_owner: null
  });
});

app.get('/api/points/packages', (req, res) => {
  const packages = dbAll('SELECT * FROM point_packages WHERE is_active = 1 ORDER BY sort_order ASC');
  res.json({ packages });
});

app.post('/api/points/purchase', authMiddleware, (req, res) => {
  try {
    const { package_id } = req.body;
    const pkg = dbGet('SELECT * FROM point_packages WHERE id = ? AND is_active = 1', [+package_id]);
    if (!pkg) return res.status(404).json({ error: 'Gói không tồn tại' });
    // Tạo pending request thay vì cộng ngay
    const reqId = dbInsert(
      'INSERT INTO point_purchase_requests (user_id, package_id, points, price_label) VALUES (?,?,?,?)',
      [req.user.id, pkg.id, pkg.points, pkg.price_label]
    );
    saveDb();
    console.log(`[POINTS] User ${req.user.username} requested ${pkg.points} pts (${pkg.price_label}) → pending #${reqId}`);
    // Gửi email thông báo admin (nếu có config)
    sendAdminNotification('purchase_request', {
      username: req.user.username || req.user.display_name,
      points: pkg.points,
      price_label: pkg.price_label,
      request_id: reqId
    });
    res.json({ success: true, status: 'pending', request_id: reqId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// User xem danh sách yêu cầu mua points của mình
app.get('/api/points/my-requests', authMiddleware, (req, res) => {
  try {
    const requests = dbAll(
      'SELECT * FROM point_purchase_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json({ requests });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/points/history', authMiddleware, (req, res) => {
  const { page = 1, limit = 30 } = req.query;
  const offset = (page - 1) * limit;
  const pu = getPointsUser(req.user.id);
  const total = dbGet('SELECT COUNT(*) as c FROM point_transactions WHERE user_id = ?', [pu.id])?.c || 0;
  const transactions = dbAll('SELECT * FROM point_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [pu.id, +limit, +offset]);
  res.json({ transactions, total, page: +page, totalPages: Math.ceil(total / +limit) });
});

// Admin: add points to a user
app.post('/api/admin/points/add', authMiddleware, adminOnly, (req, res) => {
  try {
    const { user_id, amount, note } = req.body;
    if (!user_id || !amount || amount <= 0) return res.status(400).json({ error: 'user_id và amount (>0) required' });
    const result = addPoints(user_id, +amount, 'admin_add', note || `Admin nạp ${amount} pts`);
    res.json({ success: true, balance: result.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════ ADMIN: PURCHASE REQUESTS ═══════
app.get('/api/admin/purchase-requests', authMiddleware, adminOnly, (req, res) => {
  try {
    const status = req.query.status || '';
    let sql = `SELECT ppr.*, u.username, u.display_name 
               FROM point_purchase_requests ppr 
               LEFT JOIN users u ON ppr.user_id = u.id`;
    const params = [];
    if (status) { sql += ' WHERE ppr.status = ?'; params.push(status); }
    sql += ' ORDER BY ppr.created_at DESC LIMIT 100';
    const requests = dbAll(sql, params);
    const pendingCount = dbGet("SELECT COUNT(*) as c FROM point_purchase_requests WHERE status='pending'")?.c || 0;
    res.json({ requests, pending_count: pendingCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/purchase-requests/:id/approve', authMiddleware, adminOnly, (req, res) => {
  try {
    const pr = dbGet('SELECT * FROM point_purchase_requests WHERE id = ?', [+req.params.id]);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status !== 'pending') return res.status(400).json({ error: 'Yêu cầu đã được xử lý' });
    // Cộng points cho user
    const result = addPoints(pr.user_id, pr.points, 'purchase', `Mua ${pr.points.toLocaleString()} pts (${pr.price_label}) — Admin duyệt`);
    // Cập nhật trạng thái
    dbRun('UPDATE point_purchase_requests SET status=?, reviewed_by=?, admin_note=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?',
      ['approved', req.user.id, req.body.note || '', pr.id]);
    saveDb();
    console.log(`[POINTS] Admin approved purchase #${pr.id}: ${pr.points} pts for user #${pr.user_id} → balance: ${result.balance}`);
    res.json({ success: true, balance: result.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/purchase-requests/:id/reject', authMiddleware, adminOnly, (req, res) => {
  try {
    const pr = dbGet('SELECT * FROM point_purchase_requests WHERE id = ?', [+req.params.id]);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status !== 'pending') return res.status(400).json({ error: 'Yêu cầu đã được xử lý' });
    dbRun('UPDATE point_purchase_requests SET status=?, reviewed_by=?, admin_note=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?',
      ['rejected', req.user.id, req.body.note || '', pr.id]);
    saveDb();
    console.log(`[POINTS] Admin rejected purchase #${pr.id}: ${pr.points} pts for user #${pr.user_id}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════ APP SETTINGS ═══════
app.get('/api/settings/public', (req, res) => {
  // Public settings — không cần auth
  const allowReg = dbGet("SELECT value FROM app_settings WHERE key='allow_registration'")?.value === '1';
  res.json({ allow_registration: allowReg });
});

app.get('/api/admin/settings', authMiddleware, adminOnly, (req, res) => {
  const settings = dbAll('SELECT * FROM app_settings');
  const obj = {};
  settings.forEach(s => { obj[s.key] = s.value; });
  res.json({ settings: obj });
});

app.put('/api/admin/settings', authMiddleware, adminOnly, (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    dbRun('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [key, String(value)]);
    saveDb();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: view/edit point costs
app.get('/api/admin/point-costs', authMiddleware, adminOnly, (req, res) => {
  res.json({ costs: dbAll('SELECT * FROM point_costs ORDER BY sort_order ASC') });
});
app.put('/api/admin/point-costs/:stepType', authMiddleware, adminOnly, (req, res) => {
  try {
    const { display_name, cost } = req.body;
    dbRun('UPDATE point_costs SET display_name=?, cost=? WHERE step_type=?', [display_name, +cost, req.params.stepType]);
    saveDb(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: manage point packages
app.get('/api/admin/point-packages', authMiddleware, adminOnly, (req, res) => {
  res.json({ packages: dbAll('SELECT * FROM point_packages ORDER BY sort_order ASC') });
});
app.post('/api/admin/point-packages', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body;
    const id = dbInsert('INSERT INTO point_packages (points,price,price_label,bonus_label,is_active,sort_order) VALUES (?,?,?,?,?,?)',
      [b.points, b.price, b.price_label, b.bonus_label||null, b.is_active?1:0, b.sort_order||0]);
    saveDb(); res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/point-packages/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body;
    dbRun('UPDATE point_packages SET points=?,price=?,price_label=?,bonus_label=?,is_active=?,sort_order=? WHERE id=?',
      [b.points, b.price, b.price_label, b.bonus_label||null, b.is_active?1:0, b.sort_order||0, +req.params.id]);
    saveDb(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/point-packages/:id', authMiddleware, adminOnly, (req, res) => {
  dbRun('DELETE FROM point_packages WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});

// Legacy plan configs
app.get('/api/plans', (req, res) => {
  res.json({ plans: dbAll('SELECT * FROM plan_configs WHERE is_active = 1 ORDER BY sort_order ASC') });
});
app.get('/api/admin/plans', authMiddleware, adminOnly, (req, res) => {
  res.json({ plans: dbAll('SELECT * FROM plan_configs ORDER BY sort_order ASC') });
});
app.put('/api/admin/plans/:key', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body;
    dbRun('UPDATE plan_configs SET display_name=?,quota_daily=?,quota_monthly=?,max_batch_size=?,price_label=?,description=?,is_active=?,sort_order=? WHERE plan_key=?',
      [b.display_name, b.quota_daily, b.quota_monthly, b.max_batch_size, b.price_label, b.description, b.is_active?1:0, b.sort_order||0, req.params.key]);
    saveDb(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy quota request stubs
app.post('/api/quota/request', authMiddleware, (req, res) => { res.json({ success: true, message: 'Đã chuyển sang Points system' }); });
app.get('/api/quota/requests', authMiddleware, (req, res) => { res.json({ requests: [] }); });
app.get('/api/admin/quota-requests', authMiddleware, adminOnly, (req, res) => { res.json({ requests: [], pending_count: 0 }); });
app.post('/api/admin/quota-requests/:id/approve', authMiddleware, adminOnly, (req, res) => { res.json({ success: true }); });
app.post('/api/admin/quota-requests/:id/reject', authMiddleware, adminOnly, (req, res) => { res.json({ success: true }); });

// ═══════ CRON ═══════
// Points system doesn't need daily/monthly reset

// ═══════ OWNER WORKSPACE API ═══════

// Owner: list members in their group
app.get('/api/owner/members', authMiddleware, ownerOrAdmin, (req, res) => {
  const ownerId = req.user.role === 'admin' ? (req.query.owner_id ? +req.query.owner_id : null) : req.user.id;
  if (!ownerId) return res.json({ members: [] });
  const members = dbAll(
    'SELECT id,username,display_name,role,plan,quota_used_today,quota_used_month,created_at,last_login FROM users WHERE owner_id = ? ORDER BY id',
    [ownerId]
  );
  res.json({ members });
});

// Owner: add a new member to their group
app.post('/api/owner/members', authMiddleware, ownerOrAdmin, (req, res) => {
  try {
    const b = req.body;
    if (!b.username || !b.password) return res.status(400).json({ error: 'username and password required' });
    const ownerId = req.user.role === 'admin' && b.owner_id ? +b.owner_id : req.user.id;
    const hash = bcrypt.hashSync(b.password, 10);
    const id = dbInsert(
      'INSERT INTO users (username,password_hash,display_name,role,plan,quota_daily,quota_monthly,owner_id) VALUES (?,?,?,?,?,?,?,?)',
      [b.username, hash, b.display_name || b.username, 'member', b.plan || 'free', b.quota_daily || 10, b.quota_monthly || 200, ownerId]
    );
    saveDb(); res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Owner: edit a member
app.put('/api/owner/members/:id', authMiddleware, ownerOrAdmin, (req, res) => {
  try {
    const member = dbGet('SELECT * FROM users WHERE id = ?', [+req.params.id]);
    if (!member) return res.status(404).json({ error: 'Not found' });
    // Ensure owner can only edit their own members
    if (req.user.role === 'owner' && member.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const b = req.body;
    if (b.password) dbRun('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(b.password,10), +req.params.id]);
    dbRun('UPDATE users SET display_name=?,plan=?,quota_daily=?,quota_monthly=? WHERE id=?',
      [b.display_name || member.display_name, b.plan || member.plan, b.quota_daily || member.quota_daily, b.quota_monthly || member.quota_monthly, +req.params.id]);
    saveDb(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Owner: remove member from their group
app.delete('/api/owner/members/:id', authMiddleware, ownerOrAdmin, (req, res) => {
  try {
    const member = dbGet('SELECT * FROM users WHERE id = ?', [+req.params.id]);
    if (!member) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'owner' && member.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    dbRun('DELETE FROM users WHERE id = ?', [+req.params.id]); saveDb();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Owner: group stats
app.get('/api/owner/stats', authMiddleware, ownerOrAdmin, (req, res) => {
  try {
    const ownerId = req.user.role === 'admin' && req.query.owner_id ? +req.query.owner_id : req.user.id;
    const memberIds = dbAll('SELECT id FROM users WHERE owner_id = ?', [ownerId]).map(u => u.id);
    const ids = [ownerId, ...memberIds];
    const idList = ids.map(() => '?').join(',');
    const today = new Date().toISOString().slice(0,10);
    const totalArticles = dbGet(`SELECT COUNT(*) as c FROM articles WHERE user_id IN (${idList})`, ids)?.c || 0;
    const articlesToday = dbGet(`SELECT COUNT(*) as c FROM articles WHERE user_id IN (${idList}) AND DATE(created_at) = ?`, [...ids, today])?.c || 0;
    const qu = getQuotaUser(ownerId) || dbGet('SELECT * FROM users WHERE id=?', [ownerId]);
    const owner = dbGet('SELECT id,username,display_name,plan,quota_daily,quota_monthly,quota_used_today,quota_used_month FROM users WHERE id=?', [ownerId]);
    res.json({
      total_articles: totalArticles,
      articles_today: articlesToday,
      member_count: memberIds.length,
      quota: { daily: qu.quota_daily, used_today: qu.quota_used_today, monthly: qu.quota_monthly, used_month: qu.quota_used_month },
      owner
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Owner: group articles (all members' history)
app.get('/api/owner/articles', authMiddleware, ownerOrAdmin, (req, res) => {
  try {
    const ownerId = req.user.role === 'admin' && req.query.owner_id ? +req.query.owner_id : req.user.id;
    const memberIds = dbAll('SELECT id FROM users WHERE owner_id = ?', [ownerId]).map(u => u.id);
    const ids = [ownerId, ...memberIds];
    const { page = 1, limit = 30, search } = req.query;
    const offset = (page-1)*limit;
    const idList = ids.map(() => '?').join(',');
    let where = `a.user_id IN (${idList})`;
    const p = [...ids];
    if (search) { where += ' AND a.keyword LIKE ?'; p.push('%'+search+'%'); }
    const total = dbGet(`SELECT COUNT(*) as c FROM articles a WHERE ${where}`, p)?.c || 0;
    const articles = dbAll(
      `SELECT a.*, u.username, u.display_name FROM articles a LEFT JOIN users u ON a.user_id=u.id WHERE ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
      [...p, +limit, +offset]
    );
    res.json({ articles, total, page: +page, totalPages: Math.ceil(total/limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Owner: group queue monitor
app.get('/api/owner/queue', authMiddleware, ownerOrAdmin, (req, res) => {
  try {
    const ownerId = req.user.role === 'admin' && req.query.owner_id ? +req.query.owner_id : req.user.id;
    const memberIds = dbAll('SELECT id FROM users WHERE owner_id = ?', [ownerId]).map(u => u.id);
    const ids = [ownerId, ...memberIds];
    const idList = ids.map(() => '?').join(',');
    const today = new Date().toISOString().slice(0,10);
    const stats = {
      running: dbGet(`SELECT COUNT(*) as c FROM pipelines WHERE user_id IN (${idList}) AND status='running'`, ids)?.c || 0,
      queued: dbGet(`SELECT COUNT(*) as c FROM pipelines WHERE user_id IN (${idList}) AND status='queued'`, ids)?.c || 0,
      paused: dbGet(`SELECT COUNT(*) as c FROM pipelines WHERE user_id IN (${idList}) AND status='paused'`, ids)?.c || 0,
      error: dbGet(`SELECT COUNT(*) as c FROM pipelines WHERE user_id IN (${idList}) AND status='error'`, ids)?.c || 0,
      done_today: dbGet(`SELECT COUNT(*) as c FROM pipelines WHERE user_id IN (${idList}) AND status='done' AND DATE(completed_at)=?`, [...ids, today])?.c || 0,
    };
    const pipelines = dbAll(
      `SELECT p.id,p.type,p.status,p.step_label,p.config,p.raw_keywords,p.error_message,p.created_at,p.started_at,
              u.username,u.display_name FROM pipelines p
       LEFT JOIN users u ON p.user_id=u.id
       WHERE p.user_id IN (${idList}) AND p.status IN ('queued','running','paused','error')
       ORDER BY p.created_at ASC LIMIT 50`, ids
    );
    pipelines.forEach(p => {
      try { p.config = p.config ? JSON.parse(p.config) : {}; } catch { p.config = {}; }
      try { p.raw_keywords = p.raw_keywords ? JSON.parse(p.raw_keywords) : []; } catch { p.raw_keywords = []; }
    });
    res.json({ stats, pipelines });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Owner: add topic in their workspace
app.post('/api/owner/topics', authMiddleware, ownerOrAdmin, (req, res) => {
  try {
    const { name, description, wp_category_id, parent_id } = req.body;
    const slug = name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'') || 'topic-'+Date.now();
    const id = dbInsert('INSERT INTO topics (name,slug,description,wp_category_id,parent_id) VALUES (?,?,?,?,?)',
      [name, slug, description, wp_category_id, parent_id]);
    saveDb(); res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// ═══════ START ═══════
function startServer() {
  const PORT = process.env.PORT || 8080;

  // Start pipeline worker process (separated from HTTP server event loop)
  startPipelineWorker();

  app.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║   ContentForge Studio V2 — Running!      ║`);
    console.log(`  ║   http://localhost:${PORT}                  ║`);
    console.log(`  ║   Admin: admin / ${(process.env.ADMIN_PASSWORD || 'admin123').slice(0, 8).padEnd(8)}             ║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);
  });
}

// Handle graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n[SERVER] ${signal} received — shutting down gracefully...`);
  // Tell worker to stop
  if (pipelineWorker && _workerReady) {
    pipelineWorker.send({ type: 'stop' });
    setTimeout(() => {
      if (pipelineWorker) pipelineWorker.kill('SIGTERM');
    }, 3000); // Give 3s for graceful stop
  }
  saveDb();
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

init().catch(e => { console.error('Init failed:', e); process.exit(1); });
