// ═══════════════════════════════════════════════
// ContentForge Studio V2 — Backend Server
// Express.js + sql.js (pure JS SQLite) + JWT Auth + Poe API Proxy
// ═══════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const initSqlJs = require('sql.js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const { marked } = require('marked');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db; // sql.js database instance
const dbDir = path.join(__dirname, 'db');
const dbPath = path.join(dbDir, 'contentforge.db');

// ═══════ DB HELPERS ═══════
function dbRun(sql, params = []) { return db.run(sql, params); }
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free(); return null;
}
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free(); return rows;
}
function dbInsert(sql, params = []) { db.run(sql, params); return db.exec("SELECT last_insert_rowid() as id")[0]?.values[0][0] || 0; }
function saveDb() {
  try { const data = db.export(); fs.writeFileSync(dbPath, Buffer.from(data)); } catch (e) { console.error('DB save error:', e.message); }
}
// Auto-save every 30 seconds
setInterval(saveDb, 30000);

// ═══════ INIT ═══════
async function init() {
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Create tables
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', quota_daily INTEGER DEFAULT 10,
    quota_monthly INTEGER DEFAULT 200, quota_used_today INTEGER DEFAULT 0, quota_used_month INTEGER DEFAULT 0,
    plan TEXT DEFAULT 'free', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_login DATETIME)`);

  db.run(`CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, keyword TEXT NOT NULL,
    field TEXT, company TEXT, style TEXT, extra_keywords TEXT, reference_info TEXT,
    intent_data TEXT, outline TEXT, article TEXT, article_html TEXT, images TEXT,
    word_count INTEGER DEFAULT 0, status TEXT DEFAULT 'draft', outline_status TEXT DEFAULT NULL,
    url TEXT, wp_post_id INTEGER,
    topic_id INTEGER, batch_id TEXT, review_mode TEXT DEFAULT 'manual',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, published_at DATETIME)`);

  // Migration: add outline_status if missing
  try { db.run("ALTER TABLE articles ADD COLUMN outline_status TEXT DEFAULT NULL"); } catch {}

  db.run(`CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    description TEXT, wp_category_id INTEGER, parent_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  db.run(`CREATE TABLE IF NOT EXISTS urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE NOT NULL, title TEXT, keyword TEXT,
    topic_id INTEGER, is_priority INTEGER DEFAULT 0, article_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  db.run(`CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key_name TEXT NOT NULL, api_key TEXT NOT NULL,
    is_active INTEGER DEFAULT 1, priority INTEGER DEFAULT 1, usage_count INTEGER DEFAULT 0,
    last_error TEXT, last_used_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  db.run(`CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, topic_id INTEGER,
    keywords_queue TEXT NOT NULL, articles_per_day INTEGER DEFAULT 1, post_time TEXT DEFAULT '08:00',
    auto_publish INTEGER DEFAULT 0, review_mode TEXT DEFAULT 'auto', status TEXT DEFAULT 'active',
    next_run_at DATETIME, field TEXT, company TEXT, style TEXT, bot_config TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  db.run(`CREATE TABLE IF NOT EXISTS wp_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, site_name TEXT NOT NULL, site_url TEXT NOT NULL,
    username TEXT NOT NULL, app_password TEXT NOT NULL, is_default INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  db.run(`CREATE TABLE IF NOT EXISTS keyword_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL, keyword_normalized TEXT NOT NULL,
    article_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_keyword_normalized ON keyword_history(keyword_normalized)"); } catch {}

  db.run(`CREATE TABLE IF NOT EXISTS prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, content TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  db.run(`CREATE TABLE IF NOT EXISTS bot_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, step_type TEXT NOT NULL, bot_name TEXT NOT NULL,
    display_name TEXT, is_default INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  // Migration: add user_id to urls if missing
  try { db.run("ALTER TABLE urls ADD COLUMN user_id INTEGER DEFAULT NULL"); } catch {}

  // Auto-init admin
  const adminExists = dbGet('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!adminExists) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    db.run('INSERT INTO users (username,password_hash,display_name,role,plan,quota_daily,quota_monthly) VALUES (?,?,?,?,?,?,?)',
      ['admin', hash, 'Administrator', 'admin', 'enterprise', 9999, 99999]);
  }

  // Auto-init API keys
  if (process.env.POE_API_KEY) {
    if (!dbGet('SELECT id FROM api_keys WHERE api_key = ?', [process.env.POE_API_KEY]))
      db.run('INSERT INTO api_keys (key_name,api_key,priority) VALUES (?,?,?)', ['Primary Key', process.env.POE_API_KEY, 1]);
  }
  if (process.env.POE_API_KEY_2) {
    if (!dbGet('SELECT id FROM api_keys WHERE api_key = ?', [process.env.POE_API_KEY_2]))
      db.run('INSERT INTO api_keys (key_name,api_key,priority) VALUES (?,?,?)', ['Fallback Key', process.env.POE_API_KEY_2, 2]);
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

======== INTENT JSON ========
{intent_json}
=============================

======== OUTLINE CAN DANH GIA ========
{outline}
======================================

MUC TIEU: Kiem tra outline co thuc su bam insight hay khong / Phat hien diem yeu / Dua ra huong cai thien cu the.

UU TIEN DANH GIA insight alignment hon format. Outline "dung structure nhung sai insight" = FAIL.
KHONG khen xa giao / nhan xet chung chung. Moi nhan xet: cu the / co ly do / co huong sua.

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

NGUYEN TAC:
1. Bo sung DAY DU cac y tu missing_insights va improvement_suggestions vao outline
2. THEM H2/H3 moi neu can de bao phu cac goc nhin con thieu — KHONG gioi han so heading
3. Moi thay doi phai bam: core_problem / misconceptions / desired_outcome
4. KHONG gom y, KHONG giam so heading. Chi duoc THEM hoac SUA, han che XOA
5. Ke thua cau truc hop ly tu original_outline, bo sung them cac phan moi
6. Moi H2 phai co it nhat 3-5 bullet notes cu the

NGUYEN TAC NGON TU (BAT BUOC):
- TUYET DOI KHONG them nam vao Tieu de (Vi du: "nam 2024", "moi nhat 2025") vi du lieu tien doan co the sai lech thoi gian.
- TUYET DOI KHONG dung cac tu ngu tieu cuc, thai qua (nhu "chet nguoi").
- KHONG dung cac thuat ngu giat tit y khoa (nhu "chuan y khoa", "than duoc", "xuong mau", "bi kip").
- Giu ngon tu khach quan, trung thuc va tu nhien.

OUTPUT FORMAT: MARKDOWN OUTLINE TRUC TIEP (KHONG JSON, KHONG code block)
- Bat dau bang: # Title
- Tiep theo: **Meta:** mota meta description
- **H1:** tieu de H1
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
{Nếu có internal_links: "======== INTERNAL LINKS (BẮT BUỘC CHÈN) ========\n{internal_links}\n\nHƯỚNG DẪN CHÈN LINK:\n1. Ưu tiên cao nhất: Chèn tự nhiên vào đúng ngữ cảnh của bài viết (chèn vào text có liên quan).\n2. Nếu không tìm được ngữ cảnh phù hợp: Thêm một phần nhỏ dạng 'Xem thêm', 'Đọc thêm', 'Tham khảo thêm' hoặc viết một đoạn ngắn giới thiệu ở phần có liên quan nhất để chèn link.\n3. Bắt buộc phải giữ nguyên định dạng Markdown của link: [Từ khóa/Tiêu đề](URL).\n================================"}

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

KEYWORD: {keywords} — chen tu nhien, khong nhoi nhet.

YEU CAU CUOI:
- Markdown, bat dau bang H1
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
    const old = dbGet('SELECT id FROM prompt_templates WHERE key = ?', [oldKey]);
    if (old) {
      // Rename old key to new key if new doesn't exist
      if (!dbGet('SELECT id FROM prompt_templates WHERE key = ?', [newKey])) {
        db.run('UPDATE prompt_templates SET key = ? WHERE key = ?', [newKey, oldKey]);
      } else {
        db.run('DELETE FROM prompt_templates WHERE key = ?', [oldKey]);
      }
    }
  }

  // Force-update ALL prompts to latest version on every server start
  for (const [k, v] of Object.entries(defaultPrompts)) {
    const existing = dbGet('SELECT id FROM prompt_templates WHERE key = ?', [k]);
    if (existing) {
      db.run('UPDATE prompt_templates SET content = ?, updated_at = ? WHERE key = ?', [v, new Date().toISOString(), k]);
    } else {
      db.run('INSERT INTO prompt_templates (key,content) VALUES (?,?)', [k, v]);
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
      db.run('INSERT INTO bot_configs (step_type,bot_name,display_name,is_default,sort_order) VALUES (?,?,?,?,?)',
        [b.step, b.name, b.display, b.def, b.order]);
    }
  }

  saveDb();
  startServer();
}

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

// ═══════ POE API — AUTO KEY ROTATION ═══════
async function callPoeAPI(bot, prompt, stream, params = {}) {
  const keys = dbAll('SELECT * FROM api_keys WHERE is_active = 1 ORDER BY priority ASC');
  if (!keys.length) throw new Error('No active API keys. Vui lòng thêm API key trong Admin > API Keys.');
  let lastError = null;
  for (const key of keys) {
    try {
      const body = { model: bot, messages: [{ role: 'user', content: prompt }], stream: !!stream, ...params };
      const resp = await fetch('https://api.poe.com/v1/chat/completions', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + key.api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!resp.ok) {
        // Read error body for detailed message
        let errorDetail = 'HTTP ' + resp.status;
        try {
          const errBody = await resp.text();
          errorDetail += ': ' + errBody.substring(0, 200);
        } catch {}
        
        // 402 = Payment Required, 403 = Forbidden (credit exhausted), 429 = Rate Limit, 5xx = Server Error
        // All these are "try next key" situations
        if (resp.status === 402 || resp.status === 403 || resp.status === 429 || resp.status >= 500) {
          const now = new Date().toISOString();
          db.run('UPDATE api_keys SET last_error = ?, last_used_at = ? WHERE id = ?', [errorDetail, now, key.id]);
          
          // Auto-disable key if credit exhausted (402/403)
          if (resp.status === 402 || resp.status === 403) {
            db.run('UPDATE api_keys SET is_active = 0, last_error = ? WHERE id = ?', 
              ['⚠ Tự động tắt — hết tín dụng (' + resp.status + '): ' + errorDetail.substring(0, 100), key.id]);
            console.log(`[API ROTATION] Key "${key.key_name}" (ID:${key.id}) disabled — credit exhausted (${resp.status})`);
          } else {
            console.log(`[API ROTATION] Key "${key.key_name}" (ID:${key.id}) failed (${resp.status}), trying next...`);
          }
          saveDb();
          lastError = errorDetail;
          continue; // Try next key
        }
        // Other errors (400, 404, etc.) — still try next key
        db.run('UPDATE api_keys SET last_error = ? WHERE id = ?', [errorDetail, key.id]);
        saveDb();
        lastError = errorDetail;
        continue;
      }
      // Success!
      db.run('UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = ?, last_error = NULL WHERE id = ?', [new Date().toISOString(), key.id]);
      saveDb(); 
      console.log(`[API] Using key "${key.key_name}" (ID:${key.id}) for ${bot}`);
      return resp;
    } catch (err) {
      // Network errors, timeouts, etc — try next key
      const errMsg = err.message || 'Unknown error';
      db.run('UPDATE api_keys SET last_error = ? WHERE id = ?', [errMsg, key.id]); 
      saveDb();
      lastError = errMsg;
      console.log(`[API ROTATION] Key "${key.key_name}" (ID:${key.id}) network error: ${errMsg}, trying next...`);
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
    const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
    db.run('UPDATE users SET last_login = ? WHERE id = ?', [new Date().toISOString(), user.id]); saveDb();
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET || 'default-secret', { expiresIn: '24h' });
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(new_password, 10), req.user.id]);
  saveDb(); res.json({ success: true });
});

// ═══════ CHAT PROXY ═══════
app.post('/api/chat', authMiddleware, async (req, res) => {
  try {
    const user = dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (user.quota_used_today >= user.quota_daily)
      return res.status(403).json({ error: 'Hết quota hôm nay' });
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
    let where = req.user.role === 'admin' ? '1=1' : 'user_id = ' + req.user.id;
    const p = [];
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
  if (req.user.role !== 'admin' && a.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
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
    db.run('INSERT INTO keyword_history (keyword,keyword_normalized,article_id,user_id) VALUES (?,?,?,?)', [b.keyword, norm, id, req.user.id]);
    // Only count quota when article is actually written (not outline_only)
    if (b.status !== 'outline_only') {
      db.run('UPDATE users SET quota_used_today = quota_used_today + 1, quota_used_month = quota_used_month + 1 WHERE id = ?', [req.user.id]);
    }
    saveDb();
    res.json({ id, success: true });
  } catch (e) { console.error('[POST /api/articles] ERROR:', e.message, e.stack); res.status(500).json({ error: e.message }); }
});

app.put('/api/articles/:id', authMiddleware, (req, res) => {
  try {
    const a = dbGet('SELECT * FROM articles WHERE id = ?', [+req.params.id]);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && a.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const fields = ['keyword','field','company','style','extra_keywords','reference_info','intent_data','outline','article','article_html','images','word_count','status','outline_status','url','wp_post_id','topic_id','review_mode'];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        let v = req.body[f]; if (typeof v === 'object') v = JSON.stringify(v);
        db.run(`UPDATE articles SET ${f} = ? WHERE id = ?`, [v, +req.params.id]);
      }
    }
    
    // Update quota if transitioning from outline_only to a written status (draft/published)
    if (a.status === 'outline_only' && req.body.status && req.body.status !== 'outline_only') {
      db.run('UPDATE users SET quota_used_today = quota_used_today + 1, quota_used_month = quota_used_month + 1 WHERE id = ?', [req.user.id]);
    }
    
    db.run('UPDATE articles SET updated_at = ? WHERE id = ?', [new Date().toISOString(), +req.params.id]);
    saveDb(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/articles/:id', authMiddleware, (req, res) => {
  const a = dbGet('SELECT * FROM articles WHERE id = ?', [+req.params.id]);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && a.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  db.run('DELETE FROM articles WHERE id = ?', [+req.params.id]); saveDb();
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
  const b = req.body; db.run('UPDATE urls SET url=?,title=?,keyword=?,topic_id=?,is_priority=? WHERE id=?',
    [b.url,b.title,b.keyword,b.topic_id,b.is_priority?1:0,+req.params.id]); saveDb(); res.json({ success: true });
});
app.delete('/api/urls/:id', authMiddleware, (req, res) => {
  db.run('DELETE FROM urls WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});
app.post('/api/urls/bulk', authMiddleware, (req, res) => {
  let count = 0;
  for (const u of (req.body.urls || [])) {
    try { db.run('INSERT OR IGNORE INTO urls (url,title,keyword,topic_id,is_priority,user_id) VALUES (?,?,?,?,?,?)',
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
  db.run('UPDATE topics SET name=?,slug=?,description=?,wp_category_id=?,parent_id=? WHERE id=?',
    [name,slug,description,wp_category_id,parent_id,+req.params.id]); saveDb(); res.json({ success: true });
});
app.delete('/api/topics/:id', authMiddleware, (req, res) => {
  db.run('DELETE FROM topics WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
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
      db.run('INSERT INTO keyword_history (keyword,keyword_normalized,article_id,user_id) VALUES (?,?,?,?)',
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
  db.run('DELETE FROM schedules WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});
app.post('/api/schedules/:id/pause', authMiddleware, (req, res) => {
  db.run("UPDATE schedules SET status = 'paused' WHERE id = ?", [+req.params.id]); saveDb(); res.json({ success: true });
});
app.post('/api/schedules/:id/resume', authMiddleware, (req, res) => {
  db.run("UPDATE schedules SET status = 'active' WHERE id = ?", [+req.params.id]); saveDb(); res.json({ success: true });
});

// ═══════ WORDPRESS ═══════
app.get('/api/wp/configs', authMiddleware, (req, res) => {
  res.json({ configs: dbAll('SELECT id,site_name,site_url,username,is_default,status,created_at FROM wp_configs ORDER BY is_default DESC') });
});
app.post('/api/wp/configs', authMiddleware, adminOnly, (req, res) => {
  const b = req.body;
  const id = dbInsert('INSERT INTO wp_configs (site_name,site_url,username,app_password) VALUES (?,?,?,?)',
    [b.site_name, b.site_url, b.username, b.app_password]); saveDb(); res.json({ id, success: true });
});
app.post('/api/wp/configs/:id/test', authMiddleware, async (req, res) => {
  try {
    const c = dbGet('SELECT * FROM wp_configs WHERE id = ?', [+req.params.id]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const r = await fetch(c.site_url + '/wp-json/wp/v2/posts?per_page=1', {
      headers: { 'Authorization': 'Basic ' + Buffer.from(c.username + ':' + c.app_password).toString('base64') }
    });
    res.json({ success: r.ok, error: r.ok ? null : 'HTTP ' + r.status });
  } catch (e) { res.json({ success: false, error: e.message }); }
});
app.delete('/api/wp/configs/:id', authMiddleware, adminOnly, (req, res) => {
  db.run('DELETE FROM wp_configs WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});
app.post('/api/wp/publish', authMiddleware, async (req, res) => {
  try {
    const { article_id, wp_config_id, status = 'publish', category_id, tags } = req.body;
    const article = dbGet('SELECT * FROM articles WHERE id = ?', [+article_id]);
    const config = dbGet('SELECT * FROM wp_configs WHERE id = ?', [+wp_config_id]);
    if (!article || !config) return res.status(404).json({ error: 'Not found' });
    const html = article.article_html || marked(article.article || '');
    const title = (article.article || '').split('\n').find(l => l.startsWith('# '))?.replace('# ', '') || article.keyword;
    const wpBody = { title, content: html, status };
    if (category_id) wpBody.categories = [+category_id];
    const r = await fetch(config.site_url + '/wp-json/wp/v2/posts', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + Buffer.from(config.username + ':' + config.app_password).toString('base64'), 'Content-Type': 'application/json' },
      body: JSON.stringify(wpBody)
    });
    const wpData = await r.json();
    if (r.ok) {
      const postUrl = wpData.link || config.site_url + '/?p=' + wpData.id;
      db.run('UPDATE articles SET wp_post_id=?,url=?,status=?,published_at=? WHERE id=?',
        [wpData.id, postUrl, 'published', new Date().toISOString(), +article_id]);
      try { db.run('INSERT OR IGNORE INTO urls (url,title,keyword,topic_id,article_id) VALUES (?,?,?,?,?)',
        [postUrl, title, article.keyword, article.topic_id, +article_id]); } catch {}
      saveDb(); res.json({ success: true, url: postUrl });
    } else { res.status(400).json({ error: 'WP error', details: wpData }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/wp/configs/:id/categories', authMiddleware, async (req, res) => {
  try {
    const c = dbGet('SELECT * FROM wp_configs WHERE id = ?', [+req.params.id]);
    const r = await fetch(c.site_url + '/wp-json/wp/v2/categories?per_page=100', {
      headers: { 'Authorization': 'Basic ' + Buffer.from(c.username+':'+c.app_password).toString('base64') }
    }); res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════ ADMIN ═══════
app.get('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  res.json({ users: dbAll('SELECT id,username,display_name,role,plan,quota_daily,quota_monthly,quota_used_today,quota_used_month,created_at,last_login FROM users ORDER BY id') });
});
app.post('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body; const hash = bcrypt.hashSync(b.password, 10);
    const id = dbInsert('INSERT INTO users (username,password_hash,display_name,role,plan,quota_daily,quota_monthly) VALUES (?,?,?,?,?,?,?)',
      [b.username, hash, b.display_name||b.username, b.role||'user', b.plan||'free', b.quota_daily||10, b.quota_monthly||200]);
    saveDb(); res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/users/:id', authMiddleware, adminOnly, (req, res) => {
  const b = req.body;
  if (b.password) db.run('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(b.password,10), +req.params.id]);
  db.run('UPDATE users SET display_name=?,role=?,plan=?,quota_daily=?,quota_monthly=? WHERE id=?',
    [b.display_name, b.role, b.plan, b.quota_daily, b.quota_monthly, +req.params.id]);
  saveDb(); res.json({ success: true });
});
app.delete('/api/admin/users/:id', authMiddleware, adminOnly, (req, res) => {
  if (+req.params.id === 1) return res.status(400).json({ error: 'Cannot delete admin' });
  db.run('DELETE FROM users WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
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
    // Upsert: update if exists, insert if not
    const exists = dbGet('SELECT id FROM prompt_templates WHERE key = ?', [k]);
    if (exists) {
      db.run('UPDATE prompt_templates SET content=?,updated_at=? WHERE key=?', [v, new Date().toISOString(), k]);
    } else {
      db.run('INSERT INTO prompt_templates (key,content) VALUES (?,?)', [k, v]);
    }
  }
  saveDb(); res.json({ success: true });
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
    // Partial update — only update provided fields
    if (b.api_key !== undefined) db.run('UPDATE api_keys SET api_key = ? WHERE id = ?', [b.api_key, id]);
    if (b.key_name !== undefined && b.key_name !== '') db.run('UPDATE api_keys SET key_name = ? WHERE id = ?', [b.key_name, id]);
    if (b.is_active !== undefined) db.run('UPDATE api_keys SET is_active = ? WHERE id = ?', [b.is_active ? 1 : 0, id]);
    if (b.priority !== undefined) db.run('UPDATE api_keys SET priority = ? WHERE id = ?', [b.priority, id]);
    if (b.last_error !== undefined) db.run('UPDATE api_keys SET last_error = ? WHERE id = ?', [b.last_error, id]);
    saveDb(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/api-keys/:id', authMiddleware, adminOnly, (req, res) => {
  db.run('DELETE FROM api_keys WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
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
    if (b.is_default) db.run('UPDATE bot_configs SET is_default = 0 WHERE step_type = ?', [b.step_type]);
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
      db.run('UPDATE bot_configs SET is_default = 0 WHERE step_type = ?', [stepType]);
    }
    const fields = ['bot_name','display_name','is_default','sort_order','is_active','step_type'];
    for (const f of fields) {
      if (b[f] !== undefined) {
        let v = f === 'is_default' || f === 'is_active' ? (b[f] ? 1 : 0) : b[f];
        db.run(`UPDATE bot_configs SET ${f} = ? WHERE id = ?`, [v, id]);
      }
    }
    saveDb(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/bot-configs/:id', authMiddleware, adminOnly, (req, res) => {
  db.run('DELETE FROM bot_configs WHERE id = ?', [+req.params.id]); saveDb(); res.json({ success: true });
});

// ═══════ QUOTA ═══════
app.get('/api/quota', authMiddleware, (req, res) => {
  const u = dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json({ daily: { used: u.quota_used_today, limit: u.quota_daily, remaining: u.quota_daily - u.quota_used_today },
    monthly: { used: u.quota_used_month, limit: u.quota_monthly, remaining: u.quota_monthly - u.quota_used_month }, plan: u.plan });
});

// ═══════ CRON ═══════
cron.schedule('0 0 * * *', () => { db.run('UPDATE users SET quota_used_today = 0'); saveDb(); console.log('[CRON] Daily quota reset'); });
cron.schedule('0 0 1 * *', () => { db.run('UPDATE users SET quota_used_month = 0'); saveDb(); console.log('[CRON] Monthly quota reset'); });

// ═══════ START ═══════
function startServer() {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║   ContentForge Studio V2 — Running!      ║`);
    console.log(`  ║   http://localhost:${PORT}                  ║`);
    console.log(`  ║   Admin: admin / ${(process.env.ADMIN_PASSWORD || 'admin123').slice(0, 8).padEnd(8)}             ║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);
  });
}

// Handle graceful shutdown
process.on('SIGINT', () => { saveDb(); process.exit(); });
process.on('SIGTERM', () => { saveDb(); process.exit(); });

init().catch(e => { console.error('Init failed:', e); process.exit(1); });
