# CONTENTFORGE STUDIO V2 — ĐẶC TẢ ĐẦY ĐỦ (SaaS Platform)

> **Phiên bản:** 2.0 — Nâng cấp từ single-page app thành nền tảng SaaS
> **File này mô tả chi tiết toàn bộ hệ thống ContentForge Studio V2.**
> Copy vào Antigravity / Cursor / Windsurf (Ctrl+L) để AI build.
> Kèm file `POE-API-RULES.md` trong cùng project.

---

## MỤC LỤC

1. [Tổng quan kiến trúc](#1-tổng-quan-kiến-trúc)
2. [Database Schema](#2-database-schema)
3. [Backend API](#3-backend-api)
4. [Frontend — Single Mode (7 bước)](#4-frontend-single-mode)
5. [Frontend — Batch Mode](#5-frontend-batch-mode)
6. [Frontend — Admin Dashboard](#6-frontend-admin-dashboard)
7. [13 Tính năng mới chi tiết](#7-tính-năng-mới)
8. [Prompt Templates (Outline + Article)](#8-prompt-templates)
9. [Deploy](#9-deploy)
10. [Cách A: Prompt ALL-IN-ONE](#10-prompt-all-in-one)
11. [Cách B: Prompt tuần tự (8 prompt)](#11-prompt-tuần-tự)

---

## 1. TỔNG QUAN KIẾN TRÚC

```
┌─────────────────────────────────────────────────────┐
│                   FRONTEND (SPA)                     │
│  index.html — HTML + CSS + JS (single file)         │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │Single    │ │Batch     │ │Admin Dashboard    │   │
│  │Mode      │ │Mode      │ │(chỉ role=admin)   │   │
│  │(7 bước)  │ │(keywords)│ │                   │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└────────────────────┬────────────────────────────────┘
                     │ fetch /api/*
┌────────────────────▼────────────────────────────────┐
│              BACKEND (Express.js)                    │
│  server.js — REST API + Auth middleware             │
│                                                      │
│  ┌──────┐ ┌──────┐ ┌───────┐ ┌────────┐ ┌──────┐  │
│  │Auth  │ │Chat  │ │CRUD   │ │Schedule│ │WP    │  │
│  │Login │ │Proxy │ │API    │ │Cron    │ │Proxy │  │
│  │JWT   │ │to Poe│ │DB ops │ │        │ │      │  │
│  └──────┘ └──────┘ └───────┘ └────────┘ └──────┘  │
└────────────────────┬────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
┌──────────────┐        ┌──────────────┐
│  Poe API     │        │  SQLite /    │
│  (LLM, IMG)  │        │  PostgreSQL  │
└──────────────┘        └──────────────┘
                              │
                     ┌────────┴────────┐
                     ▼                 ▼
              ┌────────────┐    ┌────────────┐
              │ WordPress  │    │ File       │
              │ REST API   │    │ Storage    │
              └────────────┘    └────────────┘
```

### Stack công nghệ

| Layer | Công nghệ | Lý do |
|-------|-----------|-------|
| Frontend | Vanilla HTML/CSS/JS (1 file index.html) | Đơn giản, không cần build tool |
| Backend | Express.js + better-sqlite3 (hoặc PostgreSQL) | Nhẹ, dễ deploy |
| Database | SQLite (dev) / PostgreSQL (production) | SQLite cho localhost, PG cho cloud |
| Auth | JWT (jsonwebtoken) | Stateless, đơn giản |
| Scheduling | node-cron | Cron job trong process |
| Poe API | REST proxy qua /api/chat | Ẩn API key |
| WordPress | REST API qua /api/wp/* | Proxy, ẩn credentials |

### Cấu trúc thư mục

```
📁 contentforge-studio-v2/
├── 📄 server.js              ← Backend chính
├── 📄 package.json
├── 📄 .env.example
├── 📄 .gitignore
├── 📄 POE-API-RULES.md       ← Tham chiếu Poe API
├── 📁 public/
│   └── 📄 index.html         ← Frontend SPA (tất cả trong 1 file)
├── 📁 db/
│   └── 📄 contentforge.db    ← SQLite database (auto-created)
```

---

## 2. DATABASE SCHEMA

### Bảng `users`
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,           -- bcrypt hash
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',     -- 'admin' | 'user'
  quota_daily INTEGER DEFAULT 10,       -- bài/ngày
  quota_monthly INTEGER DEFAULT 200,    -- bài/tháng
  quota_used_today INTEGER DEFAULT 0,
  quota_used_month INTEGER DEFAULT 0,
  plan TEXT DEFAULT 'free',             -- 'free' | 'basic' | 'pro' | 'enterprise'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);

-- Admin mặc định (tạo khi init)
INSERT INTO users (username, password_hash, display_name, role, plan, quota_daily, quota_monthly)
VALUES ('admin', '$2b$10$...', 'Administrator', 'admin', 'enterprise', 9999, 99999);
```

### Bảng `articles`
```sql
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  field TEXT,
  company TEXT,
  style TEXT,
  extra_keywords TEXT,
  reference_info TEXT,
  intent_data TEXT,                      -- JSON string
  outline TEXT,                          -- Markdown
  article TEXT,                          -- Markdown
  article_html TEXT,                     -- Rendered HTML
  images TEXT,                           -- JSON: [{heading, url}]
  word_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',           -- 'draft' | 'published' | 'scheduled'
  url TEXT,                              -- URL bài viết sau khi publish
  wp_post_id INTEGER,                   -- WordPress post ID
  topic_id INTEGER,
  batch_id TEXT,                         -- NULL nếu single mode
  review_mode TEXT DEFAULT 'manual',    -- 'manual' | 'auto'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (topic_id) REFERENCES topics(id)
);
```

### Bảng `topics`
```sql
CREATE TABLE topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  wp_category_id INTEGER,               -- Map sang WordPress category
  parent_id INTEGER,                     -- Cho phép topic con
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES topics(id)
);
```

### Bảng `urls` (Internal linking)
```sql
CREATE TABLE urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  keyword TEXT,                          -- Keyword chính của bài
  topic_id INTEGER,
  is_priority BOOLEAN DEFAULT 0,        -- URL ưu tiên (luôn dùng cho internal link)
  article_id INTEGER,                    -- Liên kết với bài đã tạo (nếu có)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (topic_id) REFERENCES topics(id),
  FOREIGN KEY (article_id) REFERENCES articles(id)
);
```

### Bảng `api_keys`
```sql
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_name TEXT NOT NULL,                -- "Key 1", "Key 2"
  api_key TEXT NOT NULL,                 -- Encrypted hoặc plain (env)
  is_active BOOLEAN DEFAULT 1,
  priority INTEGER DEFAULT 1,           -- 1 = primary, 2 = fallback
  usage_count INTEGER DEFAULT 0,
  last_error TEXT,
  last_used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Bảng `schedules`
```sql
CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  topic_id INTEGER,
  keywords_queue TEXT NOT NULL,          -- JSON array: ["kw1", "kw2", ...]
  articles_per_day INTEGER DEFAULT 1,
  post_time TEXT DEFAULT '08:00',       -- HH:MM format
  auto_publish BOOLEAN DEFAULT 0,       -- Tự đăng lên WP
  review_mode TEXT DEFAULT 'auto',      -- 'manual' | 'auto'
  status TEXT DEFAULT 'active',         -- 'active' | 'paused' | 'completed'
  next_run_at DATETIME,
  field TEXT,
  company TEXT,
  style TEXT,
  bot_config TEXT,                       -- JSON: {intentBot, outlineBot, ...}
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (topic_id) REFERENCES topics(id)
);
```

### Bảng `wp_configs` (WordPress connections)
```sql
CREATE TABLE wp_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_name TEXT NOT NULL,
  site_url TEXT NOT NULL,                -- https://example.com
  username TEXT NOT NULL,
  app_password TEXT NOT NULL,            -- WordPress Application Password
  is_default BOOLEAN DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Bảng `keyword_history` (Duplicate detection)
```sql
CREATE TABLE keyword_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  keyword_normalized TEXT NOT NULL,      -- lowercase, bỏ dấu, trim
  article_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (article_id) REFERENCES articles(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_keyword_normalized ON keyword_history(keyword_normalized);
```

---

## 3. BACKEND API

### 3.1 Authentication

```
POST /api/auth/login
  Body: { username, password }
  Response: { token, user: { id, username, display_name, role, plan, quota } }

POST /api/auth/register          ← Chỉ admin tạo user mới
  Headers: Authorization: Bearer <admin-token>
  Body: { username, password, display_name, role, plan, quota_daily, quota_monthly }

GET /api/auth/me
  Headers: Authorization: Bearer <token>
  Response: { user object }

PUT /api/auth/change-password
  Headers: Authorization: Bearer <token>
  Body: { old_password, new_password }
```

### 3.2 Chat Proxy (Poe API) — có dual key rotation

```
POST /api/chat
  Headers: Authorization: Bearer <token>
  Body: { bot, prompt, stream, parameters }
  Logic:
    1. Check user quota → reject nếu hết
    2. Lấy API key theo priority (key1 trước, key2 fallback)
    3. Proxy tới Poe API:
       {
         model: bot,
         messages: [{ role: "user", content: prompt }],
         stream: !!stream,
         ...parameters     // spread top-level!
       }
    4. Nếu key1 fail (429/5xx) → tự động chuyển key2
    5. Streaming: pipe SSE body
    6. Non-streaming: forward JSON
    7. Log usage count cho API key
```

### 3.3 Articles CRUD

```
GET /api/articles
  Query: ?page=1&limit=20&status=draft&topic_id=1&search=keyword
  Response: { articles: [...], total, page, totalPages }

GET /api/articles/:id
POST /api/articles                    ← Lưu bài viết mới
PUT /api/articles/:id                 ← Cập nhật
DELETE /api/articles/:id

GET /api/articles/:id/export?format=md|html
  → Trả file download
```

### 3.4 Keywords

```
GET /api/keywords/check-duplicate
  Query: ?keyword=xxx
  Response: { isDuplicate, existingArticles: [{id, keyword, created_at}], suggestedAngles: [...] }
  Logic:
    1. Normalize keyword (lowercase, bỏ dấu, trim extra spaces)
    2. Tìm trong keyword_history bằng LIKE hoặc fuzzy match
    3. Nếu trùng: gọi Poe API để suggest góc tiếp cận khác
    4. Trả kết quả

POST /api/keywords/suggest
  Body: { keyword, field, count }
  Response: { suggestions: ["keyword1", "keyword2", ...] }
  Logic: Gọi Poe API để AI suggest keywords liên quan
```

### 3.5 URLs (Internal Linking)

```
GET /api/urls
  Query: ?topic_id=1&is_priority=1&search=xxx
  Response: { urls: [...] }

POST /api/urls
  Body: { url, title, keyword, topic_id, is_priority }

PUT /api/urls/:id
DELETE /api/urls/:id

POST /api/urls/bulk
  Body: { urls: [{ url, title, keyword, topic_id, is_priority }] }

GET /api/urls/for-linking
  Query: ?keyword=xxx&topic_id=1&limit=5
  Response: { priority_urls: [...], related_urls: [...] }
  Logic:
    1. Lấy tất cả priority URLs
    2. Lấy URLs cùng topic
    3. Lấy URLs có keyword liên quan
    4. Sắp xếp: priority > cùng topic > liên quan
```

### 3.6 Topics

```
GET /api/topics
POST /api/topics
  Body: { name, description, wp_category_id, parent_id }
PUT /api/topics/:id
DELETE /api/topics/:id
```

### 3.7 Batch Processing

```
POST /api/batch/start
  Body: {
    keywords: ["kw1", "kw2", ...],     // Danh sách keywords
    field, company, style,
    review_mode: "auto" | "manual",     // Auto = AI tự duyệt, Manual = dừng chờ user
    topic_id,
    bot_config: { intentBot, outlineBot, evalBot, articleBot, imageBot },
    enable_images: true|false,
    group_by_ai: true|false             // AI nhóm keywords theo insight
  }
  Response: { batch_id, groups?: [...] }

GET /api/batch/:batch_id/status
  Response: {
    batch_id, status, total, completed, failed,
    articles: [{ keyword, status, article_id }]
  }

POST /api/batch/:batch_id/review/:article_id
  Body: { action: "approve" | "edit" | "regenerate", outline_edited?: "..." }

POST /api/batch/:batch_id/cancel
```

### 3.8 Scheduling

```
GET /api/schedules
POST /api/schedules
  Body: {
    topic_id, keywords_queue: ["kw1", "kw2", ...],
    articles_per_day, post_time, auto_publish,
    review_mode, field, company, style, bot_config
  }

PUT /api/schedules/:id
DELETE /api/schedules/:id
POST /api/schedules/:id/pause
POST /api/schedules/:id/resume
```

### 3.9 WordPress Integration

```
GET /api/wp/configs                        ← Danh sách WP sites
POST /api/wp/configs
  Body: { site_name, site_url, username, app_password }

POST /api/wp/configs/:id/test              ← Test connection
  Response: { success, site_info }

DELETE /api/wp/configs/:id

POST /api/wp/publish
  Body: { article_id, wp_config_id, status: "publish"|"draft", category_id, tags }
  Logic:
    1. Lấy article từ DB
    2. Convert Markdown → HTML (nếu chưa có)
    3. Gửi POST https://{site}/wp-json/wp/v2/posts
       Headers: Authorization: Basic base64(username:app_password)
       Body: { title, content, status, categories, tags }
    4. Lưu wp_post_id + URL vào articles table
    5. Tự thêm URL vào bảng urls (cho internal linking)

GET /api/wp/configs/:id/categories         ← Lấy categories từ WP
GET /api/wp/configs/:id/tags               ← Lấy tags từ WP
```

### 3.10 Admin APIs (chỉ role=admin)

```
GET /api/admin/users                       ← Danh sách users
POST /api/admin/users                      ← Tạo user mới
PUT /api/admin/users/:id                   ← Edit user (role, quota, plan)
DELETE /api/admin/users/:id

GET /api/admin/articles                    ← Xem tất cả bài của mọi user
GET /api/admin/stats                       ← Thống kê tổng
  Response: {
    total_articles, total_users, articles_today,
    quota_usage: { used, total },
    api_key_status: [{ name, usage_count, last_error }]
  }

GET /api/admin/prompts                     ← Lấy prompt templates hiện tại
PUT /api/admin/prompts                     ← Chỉnh sửa prompt templates
  Body: { outline_prompt, article_prompt, intent_prompt }

GET /api/admin/api-keys                    ← Quản lý API keys
POST /api/admin/api-keys
PUT /api/admin/api-keys/:id
DELETE /api/admin/api-keys/:id
```

### 3.11 Quota Management

```
GET /api/quota
  Response: {
    daily: { used, limit, remaining },
    monthly: { used, limit, remaining },
    plan, upgrade_options: [...]
  }

-- Backend tự động:
-- - Reset quota_used_today mỗi ngày 00:00 (cron)
-- - Reset quota_used_month ngày 1 mỗi tháng (cron)
-- - Tăng quota_used_today + quota_used_month sau mỗi bài
```

### 3.12 Auth Middleware

```javascript
// middleware/auth.js
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;  // { id, username, role }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
```

### 3.13 Dual API Key Rotation Logic

```javascript
async function callPoeAPI(bot, prompt, stream, parameters) {
  const keys = db.prepare(
    'SELECT * FROM api_keys WHERE is_active = 1 ORDER BY priority ASC'
  ).all();

  for (const key of keys) {
    try {
      const result = await fetchPoe(key.api_key, bot, prompt, stream, parameters);
      db.prepare('UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?')
        .run(new Date().toISOString(), key.id);
      return result;
    } catch (err) {
      const status = err.status || 0;
      if (status === 429 || status >= 500) {
        db.prepare('UPDATE api_keys SET last_error = ? WHERE id = ?')
          .run(err.message, key.id);
        continue;  // Thử key tiếp theo
      }
      throw err;  // Lỗi khác → throw ngay
    }
  }
  throw new Error('Tất cả API keys đều thất bại');
}
```

### 3.14 Cron Jobs

```javascript
const cron = require('node-cron');

// Reset daily quota mỗi ngày 00:00
cron.schedule('0 0 * * *', () => {
  db.prepare('UPDATE users SET quota_used_today = 0').run();
});

// Reset monthly quota ngày 1 mỗi tháng
cron.schedule('0 0 1 * *', () => {
  db.prepare('UPDATE users SET quota_used_month = 0').run();
});

// Schedule runner — check mỗi phút
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const schedules = db.prepare(
    `SELECT * FROM schedules
     WHERE status = 'active' AND next_run_at <= ?`
  ).all(now.toISOString());

  for (const sched of schedules) {
    await processScheduledArticle(sched);
  }
});
```

---

## 4. FRONTEND — SINGLE MODE (7 bước)

### 4.0 Layout tổng quan

```
┌────────────────────────────────────────────┐
│ HEADER: ContentForge Studio V2             │
│ Nav: [Single] [Batch] [Lịch sử] [Admin?]  │
├────────────────────────────────────────────┤
│ LOGIN SCREEN (nếu chưa đăng nhập)         │
│  - Username / Password                     │
│  - Nút Đăng nhập                          │
├────────────────────────────────────────────┤
│ MAIN CONTENT (sau đăng nhập)              │
│                                            │
│ [Tab Single Mode]                          │
│   Progress bar: 7 steps                    │
│   Step 1-7 (như cũ + tính năng mới)       │
│                                            │
│ [Tab Batch Mode]                           │
│   Nhập danh sách keywords                  │
│   AI nhóm + batch processing              │
│                                            │
│ [Tab Lịch sử]                             │
│   Bảng articles đã tạo                    │
│   Tìm kiếm, lọc, export                  │
│                                            │
│ [Tab Admin] (role=admin only)              │
│   Users, API keys, Prompts, Stats         │
├────────────────────────────────────────────┤
│ FOOTER: Quota: 3/10 bài hôm nay          │
└────────────────────────────────────────────┘
```

### 4.1 Login Screen

```
TRƯỚC KHI HIỆN BẤT KỲ NỘI DUNG NÀO, kiểm tra token trong memory:
- Nếu chưa login → hiện form login (username + password)
- Nếu đã login → hiện app chính
- Token lưu trong biến JS (KHÔNG localStorage vì không có trong iframe sandbox)
- Mỗi API call đính kèm header: Authorization: Bearer <token>

UI Login:
- Card giữa màn hình
- Input username (font-size 16px để tránh zoom mobile)
- Input password (type=password)
- Nút "Đăng nhập"
- Error message nếu sai
- KHÔNG có nút "Đăng ký" (admin tạo user)
```

### 4.2 STEP 1 — NHẬP LIỆU (cập nhật)

Thêm các field mới so với V1:

```
... (giữ nguyên tất cả field cũ: lĩnh vực, công ty, từ khóa, văn phong,
     từ khóa bổ sung, thông tin tham khảo, file upload, toggle ảnh, bot chọn)

THÊM MỚI:

1. CHỌN TOPIC:
   - Dropdown chọn topic (lấy từ /api/topics)
   - Option "— Không chọn —" (mặc định)
   - Option "+ Tạo topic mới" → hiện inline form

2. CHẾ ĐỘ REVIEW (Toggle):
   - Card toggle giống image toggle
   - Mặc định: "Duyệt thủ công" (manual)
   - Tùy chọn: "AI tự động duyệt" (auto)
   - Khi auto: pipeline chạy thẳng Step 2 → 3 → (AI eval) → 5 → 6 → 7
   - Khi manual: pipeline DỪNG ở Step 4 chờ user (như V1)
   - Tooltip: "AI tự động duyệt sẽ bỏ qua bước chỉnh sửa thủ công"

3. KIỂM TRA TRÙNG LẶP:
   - Khi user nhập xong keyword → debounce 500ms → gọi /api/keywords/check-duplicate
   - Nếu trùng: hiện warning banner VÀNG:
     "⚠ Từ khóa này đã viết ngày DD/MM/YYYY. Gợi ý góc tiếp cận khác:"
     - Danh sách 3 góc tiếp cận AI suggest
     - Nút "Vẫn viết lại" | "Chọn góc: [dropdown]"
   - Nếu không trùng: hiện ✓ xanh nhỏ bên cạnh input

4. INTERNAL LINKS (collapsible, dưới "Tùy chọn nâng cao"):
   - Hiện danh sách priority URLs (từ /api/urls/for-linking)
   - Toggle "Tự động chèn internal link" (mặc định BẬT)
   - Nếu BẬT: khi viết bài, prompt sẽ kèm danh sách URLs để AI chèn link
```

### 4.3 STEP 2-3 — Giữ nguyên logic V1

- Step 2: Phân tích ý định tìm kiếm → JSON → cards
- Step 3: Lên dàn ý (dùng prompt template mới — xem phần 8)

### 4.4 STEP 4 — ĐÁNH GIÁ & CHỈNH SỬA (cập nhật)

```
2 CHẾ ĐỘ:

A) review_mode = "manual" (mặc định):
   → Giống V1: pipeline DỪNG, chờ user
   → UI: preview/edit toggle, textarea ghi chú
   → 3 nút: "Duyệt & viết bài" | "AI đánh giá" | "Tạo lại dàn ý"
   → Khi duyệt: pipeline tiếp tục Step 5

B) review_mode = "auto":
   → Pipeline KHÔNG DỪNG
   → Tự động gọi evalBot đánh giá
   → Nếu AI đánh giá >= 7/10 → tự động duyệt, pipeline tiếp Step 5
   → Nếu < 7/10 → tự gọi outlineBot tạo lại dàn ý (tối đa 2 lần regenerate)
   → Sau 2 lần regenerate mà vẫn < 7/10 → dùng bản tốt nhất
   → UI: hiện loading + thông báo "AI đang tự đánh giá..."
   → Bên dưới: timeline nhỏ:
     ✓ Đánh giá lần 1: 6/10 — Tạo lại
     ✓ Đánh giá lần 2: 8/10 — Duyệt
   → User vẫn có thể click "Chuyển sang duyệt thủ công" để can thiệp

   PROMPT CHO AUTO-EVAL:
   "@{evalBot} Đánh giá dàn ý SEO cho "{keywords}" ({field}).
   Cho điểm 1-10 và lý do ngắn gọn.
   Trả JSON: {"score": 8, "reason": "...", "improvements": ["..."]}"
```

### 4.5 STEP 5 — VIẾT BÀI (cập nhật)

```
Thêm vào prompt khi viết bài:
- Nếu có internal links → thêm section:
  "INTERNAL LINKS (chèn tự nhiên vào bài, dạng [anchor text](url)):
  - {url1} — {title1}
  - {url2} — {title2}
  ..."
- Prompt template đầy đủ: xem phần 8
```

### 4.6 STEP 6-7 — Giữ nguyên logic V1

- Step 6: Tạo hình ảnh (nếu bật)
- Step 7: Kết quả + export

### 4.7 STEP 7 — KẾT QUẢ (cập nhật)

```
THÊM MỚI sau khi hoàn thành:

1. NÚT LƯU & ĐĂNG:
   - "Lưu vào DB" → POST /api/articles
   - "Đăng lên WordPress" → hiện modal chọn WP site + category → POST /api/wp/publish
   - "Lưu & Đăng" (combo)

2. NHẬP URL:
   - Input "URL bài viết" (hiện sau khi đăng hoặc user paste)
   - Checkbox "Đánh dấu URL ưu tiên" (internal linking)
   - Nút "Lưu URL" → POST /api/urls

3. GỢI Ý KEYWORD:
   - Section "Gợi ý keyword tiếp theo":
   - AI suggest 5 keywords liên quan dựa trên bài vừa viết
   - Mỗi keyword có nút "Viết bài mới" → quay về Step 1, điền sẵn keyword
   - Gọi: POST /api/keywords/suggest { keyword: state.keywords, field: state.field, count: 5 }

4. QUOTA INDICATOR:
   - "Còn lại: X/Y bài hôm nay | X/Y tháng này"
   - Nếu gần hết → warning bar
```

---

## 5. FRONTEND — BATCH MODE

### 5.1 UI Batch Mode

```
TAB "Viết hàng loạt":

STEP A — NHẬP KEYWORDS:
- Textarea lớn: "Nhập mỗi keyword một dòng" (max 50 keywords/lần)
- Hoặc upload file CSV (1 cột keyword)
- Nút "Dán từ clipboard"
- Counter: "12 keywords"
- Hiện danh sách preview + nút xoá từng keyword

STEP B — CẤU HÌNH:
- Giống Step 1 single mode: field, company, style, bot chọn, enable_images
- Toggle "AI nhóm keywords theo insight" (mặc định BẬT):
  Khi BẬT: gọi AI để nhóm keywords thành clusters có cùng chủ đề
  VD: Input: ["mua nhà trả góp", "lãi suất vay mua nhà", "kinh nghiệm mua nhà lần đầu"]
      → AI nhóm: Cluster 1: Tài chính mua nhà (mua nhà trả góp, lãi suất vay mua nhà)
                  Cluster 2: Kinh nghiệm (kinh nghiệm mua nhà lần đầu)
- Chọn topic
- Review mode: "AI tự động duyệt" (mặc định cho batch) | "Duyệt thủ công từng bài"

STEP C — CHẠY BATCH:
- Nút "Bắt đầu viết hàng loạt"
- Table theo dõi tiến trình:
  | # | Keyword           | Status       | Actions          |
  |---|-------------------|-------------|------------------|
  | 1 | mua nhà trả góp  | ✓ Hoàn thành | [Xem] [Đăng WP] |
  | 2 | lãi suất vay      | ⏳ Đang viết  | —                |
  | 3 | kinh nghiệm mua   | ⏸ Chờ duyệt  | [Duyệt] [Bỏ qua]|
  | 4 | thủ tục mua nhà   | ○ Chưa bắt đầu| —               |

- Nút "Tạm dừng" / "Tiếp tục" / "Hủy tất cả"
- Progress bar tổng: "3/12 bài hoàn thành"
- Nếu review_mode = "manual": khi keyword đến bước 4 → highlight + nút "Duyệt"
  → Click "Duyệt" → mở modal/panel xem outline + chỉnh sửa → approve → tiếp tục
- Sau khi hoàn thành tất cả: nút "Đăng tất cả lên WP"

STEP D — KẾT QUẢ:
- Tổng kết: X bài thành công, Y lỗi
- Danh sách bài với nút: Xem | Tải MD | Tải HTML | Đăng WP | Lưu URL
- Nút "Tải tất cả (.zip)" — tải tất cả bài thành file zip
```

### 5.2 Batch Processing Logic

```javascript
// Frontend gọi API khởi tạo batch
const batchResult = await fetch('/api/batch/start', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    keywords: keywordList,
    field, company, style,
    review_mode: 'auto',   // hoặc 'manual'
    topic_id: selectedTopic,
    bot_config: { intentBot, outlineBot, evalBot, articleBot, imageBot },
    enable_images: false,   // batch thường tắt ảnh để nhanh
    group_by_ai: true
  })
});

// Nếu group_by_ai = true, backend sẽ:
// 1. Gọi AI: "@GPT-5.2 Nhóm các keywords sau theo chủ đề/insight:
//    [list keywords]. Trả JSON: [{group: '...', keywords: ['...']}]"
// 2. Trả về groups cho frontend hiển thị
// 3. Bắt đầu xử lý tuần tự từng keyword

// Frontend poll status mỗi 5s
setInterval(async () => {
  const status = await fetch('/api/batch/' + batchId + '/status', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => r.json());
  updateBatchUI(status);
}, 5000);
```

---

## 6. FRONTEND — ADMIN DASHBOARD

### 6.1 Chỉ hiện tab Admin khi role === 'admin'

```
TAB "Quản trị" (icon: ⚙️):

┌─────────────────────────────────────────────────┐
│ ADMIN DASHBOARD                                  │
│                                                   │
│ Sub-tabs:                                        │
│ [Tổng quan] [Users] [API Keys] [Prompts]        │
│ [Topics] [URLs] [WP Sites] [Lịch đặt]          │
├─────────────────────────────────────────────────┤
│                                                   │
│ [SUB: Tổng quan]                                 │
│ Stats cards:                                     │
│ - Tổng bài viết: 156                            │
│ - Bài hôm nay: 12                               │
│ - Users: 5                                       │
│ - API Keys: 2 (1 active, 1 fallback)            │
│                                                   │
│ [SUB: Users]                                     │
│ Table users + nút Thêm/Sửa/Xoá                 │
│ Mỗi user: username, display_name, role,          │
│   plan, quota (daily/monthly), actions           │
│                                                   │
│ [SUB: API Keys]                                  │
│ - Danh sách API keys (masked: sk-***xxx)         │
│ - Priority: Primary / Fallback                   │
│ - Usage count, last error                        │
│ - Nút: Thêm key, Set priority, Enable/Disable   │
│                                                   │
│ [SUB: Prompts]                                   │
│ - 3 textarea lớn cho 3 prompt templates:         │
│   • Prompt phân tích ý định (Step 2)             │
│   • Prompt dàn ý (Step 3) — QUAN TRỌNG          │
│   • Prompt viết bài (Step 5) — QUAN TRỌNG       │
│ - Nút "Lưu" + "Reset về mặc định"              │
│ - Các biến có thể dùng: {keywords}, {field},     │
│   {company}, {style}, {intent_data}, {outline},  │
│   {extra_keywords}, {reference_info},             │
│   {internal_links}, {user_notes}                 │
│                                                   │
│ [SUB: Topics]                                    │
│ - CRUD topics                                    │
│ - Map sang WP category                           │
│                                                   │
│ [SUB: URLs]                                      │
│ - Bảng URLs với toggle priority                  │
│ - Bulk import/export                             │
│ - Filter theo topic                              │
│                                                   │
│ [SUB: WP Sites]                                  │
│ - Danh sách WordPress connections                │
│ - Test connection                                │
│ - Set default                                    │
│                                                   │
│ [SUB: Lịch đặt]                                 │
│ - Danh sách schedules                            │
│ - Xem keywords queue                             │
│ - Pause/Resume/Delete                            │
│                                                   │
└─────────────────────────────────────────────────┘
```

### 6.2 User Management

```
ADMIN CÓ THỂ:
1. Tạo user mới (username, password, display_name, role, plan)
2. Đổi role user (user ↔ admin)
3. Đổi plan user (free/basic/pro/enterprise)
4. Thay đổi quota (daily, monthly)
5. Reset password
6. Xoá user (confirm modal)
7. Xem lịch sử bài viết của bất kỳ user nào

USER CHỈ CÓ THỂ:
1. Viết bài (single/batch)
2. Xem lịch sử bài của MÌNH
3. Đổi password của mình
4. Xem quota còn lại
```

### 6.3 Plan & Quota

```
4 PLAN GỢI Ý:

| Plan       | Daily | Monthly | Batch | Schedule | Giá gợi ý |
|------------|-------|---------|-------|----------|-----------|
| Free       | 3     | 30      | ❌     | ❌        | $0        |
| Basic      | 10    | 200     | ✓ (max 10) | ❌  | ~$19/mo   |
| Pro        | 30    | 600     | ✓ (max 30) | ✓   | ~$49/mo   |
| Enterprise | 9999  | 99999   | ✓ (unlimited) | ✓ | ~$99/mo   |

Frontend hiện quota bar ở footer:
  "[████████░░] 7/10 bài hôm nay | 45/200 tháng này"

Khi hết quota → hiện modal:
  "Bạn đã hết quota hôm nay (10/10 bài).
   Nâng cấp lên plan Pro để viết 30 bài/ngày.
   [Liên hệ admin] [Đóng]"
```

---

## 7. TÍNH NĂNG MỚI CHI TIẾT

### 7.1 Auto AI Review (Tính năng #1, #4)

```
KHI review_mode === 'auto':

1. Sau Step 3 (Outline), thay vì dừng:
2. Gọi evalBot: "Đánh giá dàn ý. Trả JSON: {score: 1-10, reason, improvements}"
3. Parse JSON response
4. Nếu score >= 7: → pipeline tiếp Step 5
5. Nếu score < 7:
   a. Gọi outlineBot tạo lại dàn ý (kèm improvements)
   b. Eval lại
   c. Tối đa 2 lần regenerate
   d. Chọn bản score cao nhất
6. UI timeline hiện quá trình:
   "Đánh giá lần 1: 6/10 → Tạo lại
    Đánh giá lần 2: 8/10 → Duyệt ✓"

CÙNG LOGIC CHO BATCH MODE:
- Mỗi keyword trong batch đều apply auto-review
- Nếu manual: batch dừng ở keyword đó, chờ user duyệt
```

### 7.2 Dual API Keys (Tính năng #2)

```
ADMIN quản lý qua Admin Dashboard > API Keys:
- Thêm 2+ API keys
- Set priority: Primary (1) → Fallback (2)
- Enable/Disable từng key

BACKEND logic:
1. Lấy keys theo priority ASC
2. Gọi key 1 → nếu 429/5xx → log error → chuyển key 2
3. Nếu tất cả fail → trả error cho frontend
4. Log usage_count + last_error cho mỗi key

FRONTEND hiển thị (Admin):
- Key 1: sk-***abc — Active — 1,234 calls — Last error: none
- Key 2: sk-***xyz — Fallback — 89 calls — Last error: 429 rate limit (2h ago)
```

### 7.3 Batch Writing (Tính năng #3)

```
XEM CHI TIẾT Ở PHẦN 5 (BATCH MODE)

TÓM TẮT:
1. User nhập danh sách keywords
2. (Optional) AI nhóm keywords theo insight
3. Chạy pipeline tuần tự cho từng keyword
4. Review mode: auto (mặc định) hoặc manual
5. Theo dõi tiến trình real-time
6. Export/publish khi xong
```

### 7.4 Keyword Suggestions (Tính năng #5)

```
SAU KHI HOÀN THÀNH BÀI VIẾT (Step 7):

1. Gọi AI: "@GPT-5.2 Dựa trên bài viết vừa tạo cho "{keywords}" ({field}),
   gợi ý 5 từ khóa SEO liên quan có thể viết tiếp.
   Trả JSON: [{keyword: '...', search_volume_estimate: '...', reason: '...'}]"
2. Hiện section "Gợi ý keyword tiếp theo":
   - Cards: keyword + lý do + nút "Viết bài" (→ quay Step 1, fill keyword)
   - Nút "Viết tất cả" (→ chuyển sang Batch mode với 5 keywords)
```

### 7.5 Duplicate Detection (Tính năng #6)

```
LOGIC:
1. User nhập keyword vào Step 1
2. Debounce 500ms → gọi GET /api/keywords/check-duplicate?keyword=xxx
3. Backend: normalize keyword → search trong keyword_history
4. Nếu tìm thấy bài trùng:
   a. Gọi AI: "@GPT-5.2 Keyword '{keyword}' đã viết trước đó. Gợi ý 3 góc tiếp cận
      KHÁC HOÀN TOÀN để viết lại, tránh trùng nội dung. Trả JSON: [{angle, description}]"
   b. Trả về: { isDuplicate: true, existingArticles: [...], suggestedAngles: [...] }
5. Frontend hiện warning + gợi ý

NORMALIZE KEYWORD:
- lowercase
- Bỏ dấu tiếng Việt (optional) hoặc giữ nguyên nhưng so sánh case-insensitive
- Trim whitespace, collapse multiple spaces
- Remove special chars
```

### 7.6 URL Storage & Internal Linking (Tính năng #7, #8)

```
TỰ ĐỘNG:
- Sau khi publish lên WP → URL tự lưu vào DB
- Sau khi user nhập URL ở Step 7 → lưu vào DB

PRIORITY URLs:
- Admin/user đánh dấu URL ưu tiên
- Khi viết bài → priority URLs LUÔN được đưa vào prompt để AI chèn link
- Non-priority URLs: chỉ đưa vào nếu cùng topic hoặc keyword liên quan

KHI VIẾT BÀI, thêm vào prompt:
"INTERNAL LINKS — Chèn tự nhiên vào bài viết dưới dạng [anchor text](url):
Bắt buộc:
- [Hướng dẫn mua nhà trả góp](https://example.com/mua-nha-tra-gop)
- [Kinh nghiệm vay ngân hàng](https://example.com/vay-ngan-hang)
Tùy chọn (chèn nếu phù hợp):
- [So sánh lãi suất](https://example.com/lai-suat)
Quy tắc: mỗi link xuất hiện 1 lần, anchor text tự nhiên, không spam."
```

### 7.7 Topic Management (Tính năng #9)

```
TOPICS cho phép:
- Phân loại bài viết theo chủ đề
- Map sang WordPress categories
- Filter URLs theo topic (cho internal linking chính xác hơn)
- Filter lịch sử theo topic

UI:
- CRUD topics trong Admin dashboard
- Dropdown chọn topic ở Step 1 (single mode) và Batch mode
- Topic tree: hỗ trợ parent-child (1 cấp)
```

### 7.8 Quota Management (Tính năng #10)

```
XEM CHI TIẾT Ở PHẦN 6.3

TÓM TẮT:
- 4 plans: Free (3/day), Basic (10/day), Pro (30/day), Enterprise (unlimited)
- Admin set plan + custom quota cho từng user
- Auto-reset daily (00:00) và monthly (ngày 1)
- Frontend hiện quota bar ở footer
- Khi hết quota → modal thông báo + gợi ý nâng cấp
```

### 7.9 Daily Scheduling (Tính năng #11)

```
UI:
- Tab "Lịch đặt" hoặc section trong Batch mode
- Form tạo schedule:
  - Chọn topic
  - Danh sách keywords (text area hoặc upload)
  - Số bài/ngày (1-10)
  - Giờ đăng (time picker, VD: 08:00)
  - Toggle "Tự động đăng WP" (cần WP config)
  - Review mode: auto (mặc định)
  - Cấu hình: field, company, style, bots

LOGIC:
1. Cron job chạy mỗi phút check schedules
2. Nếu đến giờ chạy + còn keywords trong queue:
   a. Lấy N keywords tiếp theo (N = articles_per_day)
   b. Chạy pipeline cho từng keyword
   c. Nếu auto_publish = true → đăng lên WP
   d. Cập nhật next_run_at = ngày hôm sau + post_time
   e. Nếu hết keywords → status = 'completed'

UI THEO DÕI:
- Table schedules:
  | Topic        | Keywords | Đã viết | Tiếp theo      | Status  |
  |-------------|----------|---------|----------------|---------|
  | Bất động sản | 15/50   | 15      | 08:00 ngày mai | Active  |
  | Y tế         | 3/10    | 3       | Paused         | Paused  |

- Nút: Pause | Resume | Xem bài | Delete
```

### 7.10 User Management (Tính năng #12)

```
XEM CHI TIẾT Ở PHẦN 6.2

AUTH FLOW:
1. User mở app → hiện login screen
2. POST /api/auth/login { username, password }
3. Server: bcrypt.compare → issue JWT { id, username, role }
4. Frontend lưu token trong biến JS (memory only)
5. Mọi API call kèm header Authorization: Bearer <token>
6. Token expire: 24h → auto logout

QUYỀN:
- Admin: TOÀN QUYỀN — edit prompts, manage users, manage API keys,
  xem tất cả bài, manage DB, manage WP
- User: viết bài (single/batch), xem BÀI CỦA MÌNH, đổi password
```

### 7.11 WordPress Integration (Tính năng #13)

```
THIẾT LẬP:
1. Admin > WP Sites > Thêm site mới
2. Nhập: Site name, URL, Username, Application Password
3. Test connection → hiện site info
4. Set default (nếu muốn)

CÁCH LẤY APPLICATION PASSWORD:
- WordPress Dashboard > Users > Profile > Application Passwords
- Nhập tên app: "ContentForge" → Generate → copy

ĐĂNG BÀI:
1. Ở Step 7 (hoặc Batch results): nút "Đăng lên WordPress"
2. Modal:
   - Chọn WP site (nếu có nhiều)
   - Chọn Category (lấy từ GET /api/wp/configs/:id/categories)
   - Nhập tags (comma separated)
   - Status: "Publish" | "Draft"
   - Nút "Đăng bài"
3. Backend:
   a. Convert Markdown → HTML
   b. POST https://{site}/wp-json/wp/v2/posts
      Headers: Authorization: Basic base64(user:app_pass)
      Body: { title, content, status, categories: [id], tags: [id] }
   c. Lưu wp_post_id + URL vào DB
   d. Tự thêm URL vào bảng urls

BATCH PUBLISH:
- Sau batch hoàn thành → nút "Đăng tất cả"
- Đăng tuần tự, mỗi bài cách nhau 2s (tránh rate limit WP)
- Progress: "Đăng 5/12 bài..."
```

---

## 8. PROMPT TEMPLATES

### 8.1 Prompt Step 2 — Phân tích ý định

```
Bạn là chuyên gia phân tích SEO với 10 năm kinh nghiệm trong lĩnh vực {field}.

Phân tích ý định tìm kiếm cho từ khóa: "{keywords}"

Trả lời HOÀN TOÀN bằng JSON (không có text khác):
{
  "primary_intent": "...",
  "secondary_intents": ["..."],
  "target_audience": "...",
  "content_angle": "...",
  "related_keywords": ["..."]
}
```

### 8.2 Prompt Step 3 — Dàn ý (QUAN TRỌNG)

```
NHIỆM VỤ:
Tạo dàn ý bài viết SEO chuyên sâu cho "{keywords}" với văn phong {style}.
{Nếu style trống: "Sử dụng văn phong tự nhiên, rõ ràng, có chiều sâu nhưng dễ đọc."}

Mục tiêu:
- Đáp ứng đúng search intent
- Có chiều sâu insight
- Có thể triển khai thành bài viết dài chất lượng cao
- Đọc tự nhiên như người thật, không giống AI

────────────────────────
TƯ DUY CỐT LÕI (ÁP DỤNG NGẦM)
────────────────────────

Áp dụng NGẦM (không lộ ra trong wording):
- Socratic (dẫn dắt bằng câu hỏi)
- First Principles (phân tích bản chất)
- Critical Thinking (chỉ ra hiểu sai)
- Storytelling (tình huống thực tế)
- Actionable Thinking (có thể hành động)

QUAN TRỌNG:
- KHÔNG viết lộ các bước: "nghi vấn → phản biện → kết luận"
- KHÔNG dùng giọng giảng dạy
- Người đọc phải cảm thấy "đang được dẫn dắt hiểu ra" chứ không phải "đang học bài"

────────────────────────
KẾT QUẢ PHÂN TÍCH Ý ĐỊNH TÌM KIẾM:
{intent data từ Step 2}
────────────────────────

{Nếu có extraKeywords: "Từ khóa bổ sung: {extraKeywords}"}
{Nếu có referenceInfo: "THÔNG TIN THAM KHẢO: {referenceInfo}"}

────────────────────────
BƯỚC 1 – SEARCH INTENT (NGẮN GỌN)
────────────────────────
Phân tích:
- Primary Intent
- Secondary Intent (nếu cần)
Trả lời: Người đọc đang gặp vấn đề gì? Hiểu sai ở đâu? Muốn đạt gì?
Viết ngắn, đúng insight, không lan man.

────────────────────────
BƯỚC 2 – TITLE & META
────────────────────────
Title: có keyword, tự nhiên, phản ánh đúng nhu cầu
Meta: ngắn gọn, nhấn mạnh giá trị thực tế

────────────────────────
BƯỚC 3 – OUTLINE (SEO + NATURAL FLOW)
────────────────────────
Cấu trúc: H1 + Intro (2-3 dòng) + H2 (3-5 mục chính)

QUY TẮC VIẾT OUTLINE (CỰC QUAN TRỌNG):

1. Outline = Ý THÔ, KHÔNG phải bài viết
   CẤM: viết câu hoàn chỉnh, viết như đoạn văn, dùng phrasing "văn mẫu"
   Chỉ dùng: bullet point, keyword + direction

2. H2 phải tự nhiên, không framework
   Tránh: "Phản biện nhận thức", "Tình huống thực tế", "Checklist", "Kết luận"
   Nên dùng: "Nhiều người đang hiểu sai điều này", "Điểm quan trọng thường bị bỏ qua", "Nếu bạn đang gặp tình huống này"

3. Bên trong mỗi H2:
   - Ý chính cần giải thích
   - Sai lầm phổ biến (nếu có)
   - Góc nhìn bản chất (first principles)
   - 2-3 câu hỏi Socratic (dạng note): "thực chất là gì?", "vì sao hay làm sai?", "nếu làm khác thì sao?"
   - Ví dụ / tình huống (ngắn, dạng note)
   KHÔNG viết thành đoạn hoàn chỉnh

4. Section hướng dẫn (nếu có): "Nếu bạn đang chuẩn bị…", "Cách chọn / cách làm đúng". Không dùng từ "checklist"

5. Kết bài: insight chính + mở thêm góc nhìn / câu hỏi

────────────────────────
ANTI-AI OUTLINE
────────────────────────
- Không viết như sách giáo khoa
- Không dùng câu sáo rỗng
- Không "đóng khung format"
- Không lộ tư duy framework
Outline phải giống ghi chú của một người viết giỏi. KHÔNG giống slide / tài liệu / AI template.

SEO: bao phủ đầy đủ search intent, heading rõ ràng dễ scan, logic flow hợp lý, phát triển thành 1500-3000+ từ.
```

### 8.3 Prompt Step 5 — Viết bài (QUAN TRỌNG)

```
NHIỆM VỤ:
Viết bài viết SEO chuyên sâu cho "{keywords}" với văn phong {style}.
Lĩnh vực: {field}. Công ty: {company}.
{Nếu style trống: "Sử dụng văn phong tự nhiên, rõ ràng, có chiều sâu nhưng dễ đọc."}

Mục tiêu:
- Đáp ứng đúng search intent
- Có chiều sâu insight
- Bài viết dài chất lượng cao (1500-3000+ từ)
- Đọc tự nhiên như người thật, không giống AI

────────────────────────
TƯ DUY CỐT LÕI (ÁP DỤNG NGẦM)
────────────────────────

Áp dụng NGẦM (không lộ ra trong wording):
- Socratic (dẫn dắt bằng câu hỏi)
- First Principles (phân tích bản chất)
- Critical Thinking (chỉ ra hiểu sai)
- Storytelling (tình huống thực tế)
- Actionable Thinking (có thể hành động)

QUAN TRỌNG:
- KHÔNG viết lộ các bước: "nghi vấn → phản biện → kết luận"
- KHÔNG dùng giọng giảng dạy
- Người đọc phải cảm thấy "đang được dẫn dắt hiểu ra" chứ không phải "đang học bài"

────────────────────────
DÀN Ý ĐÃ DUYỆT:
{outline từ Step 4}
────────────────────────

{Nếu có extraKeywords: "Từ khóa bổ sung (in đậm khi xuất hiện): {extraKeywords}"}
{Nếu có referenceInfo: "THÔNG TIN THAM KHẢO: {referenceInfo}"}
{Nếu có userReviewNotes: "GHI CHÚ CỦA NGƯỜI DÙNG: {userReviewNotes}"}
{Nếu có file upload: "DỮ LIỆU TỪ FILE: {fileContent}"}

────────────────────────
INTERNAL LINKS
────────────────────────
{Nếu có internal links:
"Chèn tự nhiên vào bài viết dưới dạng [anchor text](url):
Bắt buộc:
{danh sách priority URLs: "- [title](url)"}
Tùy chọn (chèn nếu phù hợp):
{danh sách related URLs: "- [title](url)"}
Quy tắc: mỗi link xuất hiện tối đa 1 lần, anchor text tự nhiên, không spam link."}

────────────────────────
QUY TẮC VIẾT BÀI (CỰC QUAN TRỌNG)
────────────────────────

1. Viết ĐÚNG theo dàn ý — không thêm/bớt section
2. In đậm keyword chính khi xuất hiện tự nhiên
3. Ví dụ cụ thể, số liệu thực tế (từ tham khảo nếu có)
4. KHÔNG dùng nguồn trích dẫn dạng [1][2]
5. KHÔNG viết kiểu sách giáo khoa hoặc văn mẫu
6. H2 tự nhiên — không lộ framework
7. Mỗi đoạn ngắn, dễ scan
8. Intro hấp dẫn, đặt vấn đề ngay
9. Kết bài mở — có insight, không sáo rỗng

────────────────────────
ANTI-AI WRITING
────────────────────────
- Không dùng câu sáo rỗng, câu mở đầu generic
- Không "đóng khung format"
- Không lộ tư duy framework
- Bài viết phải giống bài của một người viết giỏi thực sự

────────────────────────
SEO & E-E-A-T
────────────────────────
- Keyword trong H1, H2, intro, kết
- Heading rõ ràng, dễ scan
- Thể hiện Experience, Expertise, Authority, Trust
- Trả lời Markdown format

Kết quả: Trả lời HOÀN TOÀN bằng Markdown. Bắt đầu ngay bằng H1.
```

### 8.4 Prompt Auto-Eval (Step 4 auto mode)

```
Đánh giá dàn ý SEO sau đây cho từ khóa "{keywords}" trong lĩnh vực {field}.

DÀN Ý:
{outline}

Đánh giá theo các tiêu chí:
1. SEO coverage (bao phủ search intent)
2. Chiều sâu insight
3. Cấu trúc logic
4. Anti-AI (không giống template)
5. Tiềm năng phát triển thành bài 1500-3000+ từ

Trả lời HOÀN TOÀN bằng JSON:
{"score": 8, "reason": "...", "improvements": ["...", "..."]}
```

### 8.5 Prompt Keyword Suggestion (Step 7)

```
Dựa trên bài viết vừa tạo cho từ khóa "{keywords}" trong lĩnh vực {field}:

Gợi ý 5 từ khóa SEO liên quan có thể viết tiếp để tạo content cluster.
Ưu tiên:
- Từ khóa có search volume tốt
- Bổ sung cho bài viết hiện tại
- Có thể internal link qua lại

Trả lời HOÀN TOÀN bằng JSON:
[{"keyword": "...", "reason": "..."}]
```

### 8.6 Prompt Keyword Grouping (Batch mode)

```
Nhóm các keywords sau theo chủ đề/insight chung.
Mục tiêu: nhóm keywords cùng cluster để viết theo nhóm, tăng chất lượng internal linking.

Keywords:
{keyword_list — mỗi dòng 1 keyword}

Trả lời HOÀN TOÀN bằng JSON:
[{"group": "Tên nhóm", "keywords": ["kw1", "kw2"], "insight": "Lý do nhóm"}]
```

### 8.7 Prompt Duplicate Angle Suggestion (Dedup)

```
Từ khóa "{keyword}" đã được viết trước đó trong lĩnh vực {field}.
Gợi ý 3 góc tiếp cận KHÁC HOÀN TOÀN để viết lại, tránh trùng nội dung.

Trả lời HOÀN TOÀN bằng JSON:
[{"angle": "...", "description": "..."}]
```

---

## 9. DEPLOY

### 9.1 Local Development

```bash
cd contentforge-studio-v2
cp .env.example .env
# Edit .env: POE_API_KEY, JWT_SECRET, ADMIN_PASSWORD
npm install
node server.js
# Mở http://localhost:8080
# Login: admin / [password trong .env]
```

### 9.2 Google Cloud Run

```
Tạo Dockerfile:
- Base: node:20-alpine
- Install dependencies
- Copy code
- Expose 8080
- CMD: node server.js

Deploy:
gcloud run deploy contentforge-v2 \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --set-env-vars "POE_API_KEY=sk-xxx,JWT_SECRET=xxx,ADMIN_PASSWORD=xxx" \
  --timeout 300 \
  --memory 512Mi

Lưu ý: SQLite trên Cloud Run sẽ mất data khi container restart.
→ Dùng PostgreSQL (Cloud SQL) hoặc mount volume persistent.
```

### 9.3 Vercel

```
Chuyển server.js thành nhiều Edge Functions:
api/auth.js — /api/auth/*
api/chat.js — /api/chat
api/articles.js — /api/articles/*
...

Lưu ý: Vercel không hỗ trợ SQLite → dùng Vercel Postgres hoặc PlanetScale.
Vercel không hỗ trợ cron natively → dùng Vercel Cron hoặc external cron service.
```

### 9.4 VPS (DigitalOcean, AWS EC2, etc.)

```bash
# Đơn giản nhất: chạy trực tiếp + pm2
npm install -g pm2
cd contentforge-studio-v2
npm install
pm2 start server.js --name contentforge
pm2 save

# Nginx reverse proxy:
server {
    listen 80;
    server_name contentforge.yourdomain.com;
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}

# SSL: certbot --nginx -d contentforge.yourdomain.com
```

---

## 10. CÁCH A: PROMPT ALL-IN-ONE

> **Copy từ đây đến hết section 10 → paste vào Antigravity/Cursor → Enter.**
> **Lưu ý: Prompt rất dài. Nếu Antigravity giới hạn length, dùng Cách B (8 prompt nhỏ) thay thế.**

```
Đọc file POE-API-RULES.md trong project để biết cách gọi Poe API.

Tạo app "ContentForge Studio V2" — nền tảng SaaS tạo nội dung SEO 7 bước, hỗ trợ batch, scheduling, WordPress, user management.

Toàn bộ gồm 2 file:
- server.js (backend Express.js + SQLite)
- public/index.html (frontend SPA, tất cả HTML+CSS+JS trong 1 file)

═══════════════════════════════════════════════
BACKEND (server.js)
═══════════════════════════════════════════════

Tech: Express.js + better-sqlite3 + jsonwebtoken + bcryptjs + node-cron
Dependencies (package.json): express, better-sqlite3, jsonwebtoken, bcryptjs, node-cron, marked

ENV vars (.env): POE_API_KEY, POE_API_KEY_2 (optional), JWT_SECRET, ADMIN_PASSWORD

KHỞI TẠO DATABASE (auto-create):
- Bảng users: id, username, password_hash, display_name, role ('admin'|'user'), quota_daily, quota_monthly, quota_used_today, quota_used_month, plan ('free'|'basic'|'pro'|'enterprise'), created_at, last_login
- Bảng articles: id, user_id, keyword, field, company, style, extra_keywords, reference_info, intent_data (JSON), outline, article, article_html, images (JSON), word_count, status, url, wp_post_id, topic_id, batch_id, review_mode, created_at, updated_at, published_at
- Bảng topics: id, name, slug, description, wp_category_id, parent_id, created_at
- Bảng urls: id, url, title, keyword, topic_id, is_priority, article_id, created_at
- Bảng api_keys: id, key_name, api_key, is_active, priority, usage_count, last_error, last_used_at
- Bảng schedules: id, user_id, topic_id, keywords_queue (JSON), articles_per_day, post_time, auto_publish, review_mode, status, next_run_at, field, company, style, bot_config (JSON)
- Bảng wp_configs: id, site_name, site_url, username, app_password, is_default, status
- Bảng keyword_history: id, keyword, keyword_normalized, article_id, user_id, created_at + INDEX

Tạo admin mặc định khi init (username: 'admin', password: env.ADMIN_PASSWORD)
Tạo API key mặc định từ env.POE_API_KEY (+ key 2 nếu có)

AUTH:
- POST /api/auth/login → bcrypt compare → issue JWT { id, username, role } (24h expire)
- GET /api/auth/me → decode token → return user
- PUT /api/auth/change-password → bcrypt hash new password
- Middleware: authMiddleware (check JWT), adminOnly (check role)

CHAT PROXY (Poe API):
- POST /api/chat → auth required
  1. Check quota → reject nếu hết
  2. Dual key: lấy api_keys ORDER BY priority, thử key 1, nếu 429/5xx → key 2
  3. Proxy: { model: bot, messages: [{role:"user",content:prompt}], stream, ...parameters }
  4. Streaming: pipe SSE. Non-streaming: forward JSON.
  5. Log usage_count, increment user quota

ARTICLES CRUD:
- GET /api/articles (paginated, filter by user_id unless admin)
- POST /api/articles (save new)
- PUT /api/articles/:id
- DELETE /api/articles/:id
- Khi save: tự thêm vào keyword_history

KEYWORDS:
- GET /api/keywords/check-duplicate?keyword=xxx → normalize → search keyword_history → return matches
- POST /api/keywords/suggest → proxy to Poe API for suggestions

URLs:
- GET /api/urls (filter: topic_id, is_priority)
- POST /api/urls, PUT /api/urls/:id, DELETE /api/urls/:id
- POST /api/urls/bulk
- GET /api/urls/for-linking?keyword=xxx&topic_id=1 → priority first, then related

TOPICS:
- CRUD: GET/POST/PUT/DELETE /api/topics

BATCH:
- POST /api/batch/start → create batch, return batch_id, optionally group keywords by AI
- GET /api/batch/:id/status
- POST /api/batch/:id/cancel
- Batch processing: lưu tiến trình in-memory hoặc trong DB

SCHEDULES:
- CRUD: GET/POST/PUT/DELETE /api/schedules
- POST /api/schedules/:id/pause, /resume
- Cron: mỗi phút check schedules, xử lý keywords queue

WORDPRESS:
- CRUD: /api/wp/configs
- POST /api/wp/configs/:id/test → GET {site_url}/wp-json/wp/v2/posts?per_page=1
- POST /api/wp/publish → convert markdown→HTML → POST {site_url}/wp-json/wp/v2/posts (Basic Auth)
- GET /api/wp/configs/:id/categories, /tags

ADMIN:
- GET/POST/PUT/DELETE /api/admin/users (adminOnly)
- GET /api/admin/stats
- GET/PUT /api/admin/prompts (lưu trong DB hoặc file JSON)
- GET/POST/PUT/DELETE /api/admin/api-keys

QUOTA:
- GET /api/quota → daily/monthly usage + plan info
- Cron reset: daily 00:00, monthly ngày 1

═══════════════════════════════════════════════
FRONTEND (public/index.html)
═══════════════════════════════════════════════

Ngôn ngữ: Tiếng Việt
CDN: Google Fonts (Be Vietnam Pro + Playfair Display), Font Awesome 6, marked.js
Tone: warm earth — accent amber #B45309, background #FAF8F2
Responsive, dark mode tự động, KHÔNG dùng alert/confirm/prompt

--- LOGIN ---
Form login card giữa màn hình
Token lưu trong biến JS (KHÔNG localStorage)
Mọi API call kèm Authorization: Bearer

--- NAV TABS ---
Header + 4 tabs: [Viết bài] [Viết hàng loạt] [Lịch sử] [Quản trị (admin only)]
Footer: quota bar "X/Y bài hôm nay"

--- TAB 1: VIẾT BÀI (Single Mode — 7 bước) ---

PROGRESS BAR: sticky, 7 dots, clickable completed steps

[STEP 1 — NHẬP LIỆU]
Giữ nguyên V1: field*, company*, keywords*, style, extra keywords, reference, file upload, image toggle, advanced bots
THÊM:
- Dropdown chọn Topic (từ /api/topics)
- Toggle Review Mode: "Duyệt thủ công" (mặc định) | "AI tự động duyệt"
- Kiểm tra trùng keyword: debounce 500ms → /api/keywords/check-duplicate
  Nếu trùng → warning banner vàng + suggest angles
- Internal links section (collapsible): hiện priority URLs, toggle auto-insert

[STEP 2 — PHÂN TÍCH Ý ĐỊNH]
Gọi /api/chat: intentBot, stream=false, prompt yêu cầu JSON
Parse → render cards

[STEP 3 — DÀN Ý]
Gọi /api/chat: outlineBot, stream=true, render Markdown streaming
Prompt template CHÍNH XÁC — xem phần prompt templates đính kèm bên dưới:

--- BẮT ĐẦU OUTLINE PROMPT ---
NHIỆM VỤ:
Tạo dàn ý bài viết SEO chuyên sâu cho "{keywords}" với văn phong {style}.

TƯ DUY CỐT LÕI (ÁP DỤNG NGẦM): Socratic · First Principles · Critical Thinking · Storytelling · Actionable.
KHÔNG viết lộ framework. "Dẫn dắt hiểu ra" chứ không "đang học bài".

KẾT QUẢ PHÂN TÍCH Ý ĐỊNH: {intent data}

BƯỚC 1 – SEARCH INTENT: Primary/Secondary. Vấn đề? Hiểu sai? Muốn đạt?
BƯỚC 2 – TITLE & META
BƯỚC 3 – OUTLINE: H1 + Intro + H2 (3-5 mục)
QUY TẮC: Outline = Ý THÔ. CẤM câu hoàn chỉnh. H2 tự nhiên. Mỗi H2: ý chính + sai lầm + first principles + câu hỏi Socratic + ví dụ ngắn.
ANTI-AI: giống ghi chú người viết giỏi, KHÔNG giống AI template.
--- KẾT THÚC OUTLINE PROMPT ---

[STEP 4 — ĐÁNH GIÁ]
NẾU manual: dừng pipeline, preview/edit, 3 nút (như V1)
NẾU auto:
  1. Gọi evalBot: "Đánh giá. JSON: {score, reason, improvements}"
  2. Score >= 7 → tiếp Step 5
  3. Score < 7 → regenerate (max 2 lần) → chọn bản tốt nhất
  4. UI: timeline "Đánh giá lần 1: X/10 → ..."
  5. Nút "Chuyển sang duyệt thủ công" (interrupt auto)

[STEP 5 — VIẾT BÀI]
Gọi /api/chat: articleBot, stream=true
Prompt template CHÍNH XÁC:

--- BẮT ĐẦU ARTICLE PROMPT ---
NHIỆM VỤ: Viết bài SEO cho "{keywords}", văn phong {style}. Lĩnh vực: {field}. Công ty: {company}.
TƯ DUY CỐT LÕI NGẦM: Socratic · First Principles · Critical Thinking · Storytelling · Actionable.
DÀN Ý ĐÃ DUYỆT: {outline}
{extra keywords, reference, user notes, file content nếu có}
INTERNAL LINKS: {danh sách URLs bắt buộc + tùy chọn}
QUY TẮC: ĐÚNG dàn ý, in đậm keyword, ví dụ cụ thể, không [1][2], không sách giáo khoa, H2 tự nhiên, đoạn ngắn, intro hấp dẫn, kết bài mở.
ANTI-AI: không sáo rỗng, không đóng khung.
SEO E-E-A-T: keyword H1/H2/intro/kết. Markdown. Bắt đầu bằng H1.
--- KẾT THÚC ARTICLE PROMPT ---

[STEP 6 — HÌNH ẢNH] (nếu bật)
a) Gọi articleBot → tạo JSON image prompts
b) asyncPool(limit=2): song song 2 ảnh
c) Params đúng: Imagen/Nano→aspect_ratio, GPT-Image/Flux→aspect
d) Error panel: retry/tiếp tục/bỏ qua

[STEP 7 — KẾT QUẢ]
Render + word count + badges
Nút: Copy MD | Copy HTML | Tải .md | .html | Bắt đầu lại
THÊM:
- "Lưu vào DB" → POST /api/articles
- "Đăng WordPress" → modal chọn site/category → POST /api/wp/publish
- Nhập URL bài viết + toggle priority → POST /api/urls
- Gợi ý 5 keyword tiếp theo (AI suggest) → nút "Viết bài" / "Viết tất cả" (→ batch)
- Quota indicator

--- TAB 2: VIẾT HÀNG LOẠT (Batch Mode) ---

Step A: Textarea nhập keywords (1 dòng = 1 keyword, max 50)
Step B: Cấu hình (field, company, style, bots, topic, review_mode, enable_images)
  Toggle "AI nhóm keywords theo insight"
Step C: Chạy batch — bảng tiến trình real-time (poll mỗi 5s)
  | # | Keyword | Status | Actions |
  Nút: Tạm dừng | Tiếp tục | Hủy | Đăng tất cả WP
Step D: Kết quả — tổng kết + export + publish

--- TAB 3: LỊCH SỬ ---

Bảng articles đã tạo (user thường: chỉ bài của mình)
Cột: Keyword | Topic | Status | Ngày tạo | Actions (Xem|Tải|Đăng WP|Xoá)
Search + filter theo topic/status/date

--- TAB 4: QUẢN TRỊ (admin only) ---

Sub-tabs: [Tổng quan] [Users] [API Keys] [Prompts] [Topics] [URLs] [WP Sites] [Lịch đặt]

Tổng quan: stats cards (total articles, today, users, API key status)
Users: table + CRUD (username, role, plan, quota)
API Keys: table + CRUD (masked key, priority, usage, error)
Prompts: 3 textareas (intent/outline/article prompt templates) + save/reset
Topics: CRUD table
URLs: table + toggle priority + bulk import
WP Sites: CRUD + test connection
Lịch đặt: table schedules + pause/resume/delete

--- JS FEATURES ---
1. Guard double-click: if(pipelineActive)return
2. Cancel pipeline
3. Custom modal (thay confirm())
4. Toast (auto dismiss 5s)
5. Form validation inline
6. Char counter
7. File upload drag&drop
8. Auto-retry 3 lần (429/502)
9. Throttled render (250ms)
10. asyncPool(limit=2) cho images
11. Clickable progress bar
12. Download files (blob URL)
13. Dark mode auto detect
14. Clipboard fallback
15. XSS prevention (createElement)
16. Auth: token in memory, headers on every fetch
17. Quota check before pipeline
18. Keyword dedup check (debounce 500ms)

--- LƯU Ý QUAN TRỌNG ---
1. Khi gọi /api/chat, prompt KHÔNG có prefix @BotName
   (Backend sẽ dùng tên bot trong field "bot" để set "model" trong Poe request)
2. Tên bot CHÍNH XÁC case-sensitive
3. Image params: aspect_ratio cho Imagen/Nano, aspect cho GPT-Image/Flux
4. Image bot luôn stream:false, text bot nên stream:true
5. KHÔNG BAO GIỜ dùng alert(), confirm(), prompt()
6. API key chỉ ở backend
7. Token auth: JWT trong memory, không localStorage (iframe sandbox)
```

---

## 11. CÁCH B: PROMPT TUẦN TỰ (8 prompt)

### PROMPT 1/8 — Backend: Server + Database + Auth

```
Đọc file POE-API-RULES.md trong project.

Tạo server.js — Express.js backend cho ContentForge Studio V2 (SaaS SEO content platform).

PHẦN 1 — Setup + Database:
1. Dependencies: express, better-sqlite3, jsonwebtoken, bcryptjs, node-cron, marked
2. Tự tạo SQLite database (db/contentforge.db) với 8 bảng:
   - users (id, username, password_hash, display_name, role, quota_daily, quota_monthly, quota_used_today, quota_used_month, plan, created_at, last_login)
   - articles (id, user_id, keyword, field, company, style, extra_keywords, reference_info, intent_data, outline, article, article_html, images, word_count, status, url, wp_post_id, topic_id, batch_id, review_mode, created_at, updated_at, published_at)
   - topics (id, name, slug, description, wp_category_id, parent_id, created_at)
   - urls (id, url, title, keyword, topic_id, is_priority, article_id, created_at)
   - api_keys (id, key_name, api_key, is_active, priority, usage_count, last_error, last_used_at)
   - schedules (id, user_id, topic_id, keywords_queue, articles_per_day, post_time, auto_publish, review_mode, status, next_run_at, field, company, style, bot_config)
   - wp_configs (id, site_name, site_url, username, app_password, is_default, status)
   - keyword_history (id, keyword, keyword_normalized, article_id, user_id, created_at) + INDEX on keyword_normalized
3. Auto-init: tạo admin user (username='admin', password=env.ADMIN_PASSWORD, role='admin', plan='enterprise')
4. Auto-init: tạo API key từ env.POE_API_KEY (priority=1), env.POE_API_KEY_2 nếu có (priority=2)

PHẦN 2 — Auth:
1. POST /api/auth/login — bcrypt compare → JWT { id, username, role } (24h)
2. GET /api/auth/me — decode + return user info
3. PUT /api/auth/change-password
4. Middleware: authMiddleware (verify JWT), adminOnly (check role=admin)

PHẦN 3 — Chat Proxy (Poe API):
1. POST /api/chat (auth required)
2. Check user quota → reject 403 nếu hết
3. Dual key rotation: lấy api_keys ORDER BY priority, thử từng key
4. Build body: { model: bot, messages: [{role:"user",content:prompt}], stream, ...parameters }
   ← parameters spread top-level!
5. Streaming: pipe SSE. Non-streaming: forward JSON.
6. Log usage, increment quota

Tạo package.json, .env.example (POE_API_KEY, POE_API_KEY_2, JWT_SECRET, ADMIN_PASSWORD), .gitignore
```

### PROMPT 2/8 — Backend: CRUD APIs

```
Tiếp tục server.js. Thêm các REST API:

ARTICLES:
- GET /api/articles (auth, paginated, user chỉ xem bài mình, admin xem tất cả)
- POST /api/articles (auth, tự thêm keyword_history)
- PUT /api/articles/:id (auth, check ownership)
- DELETE /api/articles/:id

KEYWORDS:
- GET /api/keywords/check-duplicate?keyword=xxx (normalize: lowercase+trim → LIKE search)
- POST /api/keywords/suggest (body: {keyword, field, count} → proxy to Poe API)

URLs:
- CRUD: GET/POST/PUT/DELETE /api/urls
- POST /api/urls/bulk
- GET /api/urls/for-linking?keyword=xxx&topic_id=1 (priority URLs first)

TOPICS:
- CRUD: GET/POST/PUT/DELETE /api/topics

ADMIN (adminOnly):
- GET/POST/PUT/DELETE /api/admin/users
- GET /api/admin/stats
- GET/PUT /api/admin/prompts
- GET/POST/PUT/DELETE /api/admin/api-keys

QUOTA:
- GET /api/quota (daily/monthly + plan info)

BATCH:
- POST /api/batch/start (body: {keywords[], field, company, style, review_mode, topic_id, bot_config, enable_images, group_by_ai})
  → nếu group_by_ai: gọi Poe API nhóm keywords → trả groups
  → lưu batch state in-memory (Map)
- GET /api/batch/:id/status
- POST /api/batch/:id/cancel

SCHEDULES:
- CRUD + /pause + /resume

WORDPRESS:
- CRUD: /api/wp/configs
- POST /api/wp/configs/:id/test → test connection
- POST /api/wp/publish (body: {article_id, wp_config_id, status, category_id, tags})
  → convert MD→HTML → POST wp-json/wp/v2/posts (Basic Auth)
  → save wp_post_id + url
- GET /api/wp/configs/:id/categories, /tags

CRON JOBS (node-cron):
1. Daily 00:00: reset quota_used_today
2. Monthly 1st 00:00: reset quota_used_month
3. Every minute: check schedules → process due items

Serve static files từ public/. Port: env.PORT || 8080.
```

### PROMPT 3/8 — Frontend: Layout + Login + Navigation

```
Đọc file POE-API-RULES.md.

Tạo file public/index.html — Single-page app ContentForge Studio V2 (HTML+CSS+JS trong 1 file).

PHẦN NÀY: Layout tổng, Login, Navigation

THIẾT KẾ:
- Ngôn ngữ: Tiếng Việt
- Font: Google Fonts "Be Vietnam Pro" + "Playfair Display"
- Icon: Font Awesome 6 (CDN)
- Markdown: marked.js (CDN)
- Tone: warm earth — accent amber #B45309, bg #FAF8F2
  Dark mode: bg #0C0A09, surface #1C1917
- Responsive mobile-first
- KHÔNG dùng alert/confirm/prompt — custom modal

LOGIN SCREEN:
- Card giữa màn hình, logo ContentForge
- Input username (font-size 16px!)
- Input password
- Nút "Đăng nhập"
- Error message
- Gọi POST /api/auth/login
- Lưu token trong biến JS (KHÔNG localStorage)

SAU LOGIN:
- Header: "ContentForge Studio V2" + user info + nút Logout
- Nav tabs: [Viết bài] [Viết hàng loạt] [Lịch sử] [Quản trị]
  → Tab "Quản trị" chỉ hiện khi role=admin
- Main content area: hiện tab đang chọn
- Footer: quota bar "[████░░] X/Y bài hôm nay | X/Y tháng"

UI COMPONENTS (tái sử dụng):
- showModal(title, msg, buttons) — custom dialog
- showToast(msg, type) — notification
- Custom modal for confirm/prompt actions
- Loading spinner
- Toast container
- Form validation helpers
```

### PROMPT 4/8 — Frontend: Single Mode (Tab Viết bài — 7 bước)

```
Tiếp tục public/index.html. Tab "Viết bài" — Pipeline 7 bước.

PROGRESS BAR: sticky, 7 dots, clickable completed steps

STEP 1 — NHẬP LIỆU (form card):
- field*, company*, keywords* (required, inline validation)
- style (optional)
- extra keywords (textarea + char counter)
- reference info (textarea, max 6000, counter)
- File upload (drag&drop, .txt/.csv/.json/.md/.tsv, max 5 files, 2MB each)
- Image toggle card (BẬT/TẮT)
- Dropdown chọn Topic (fetch /api/topics)
- Toggle Review Mode: "Duyệt thủ công" | "AI tự động duyệt"
- Collapsible "Tùy chọn nâng cao": 6 dropdown chọn bot
  Bot phân tích: Gemini-3.1-Pro | Claude-Sonnet-4.5 | GPT-5.2 | Gemini-3-Flash
  Bot dàn ý: Gemini-3.1-Pro | Claude-Sonnet-4.5 | GPT-5.2 | Gemini-3-Flash
  Bot đánh giá: GPT-5.2 | Claude-Sonnet-4.5 | Claude-Opus-4.6
  Bot viết bài: Gemini-2.5-Pro | Claude-Sonnet-4.5 | GPT-5.2 | Gemini-3.1-Pro
  Bot ảnh: Nano-Banana-Pro | Imagen-4-Ultra | Imagen-4-Fast | Flux-2-Turbo | GPT-Image-1.5
- Internal links section (collapsible): hiện priority URLs
- Keyword dedup: debounce 500ms → GET /api/keywords/check-duplicate
  Trùng → warning banner + suggest angles
- Nút "Bắt đầu tạo nội dung"

STEP 2 — PHÂN TÍCH Ý ĐỊNH:
Gọi /api/chat { bot: intentBot, prompt: "Phân tích intent cho X. JSON: {...}", stream: false }
Parse JSON → render cards

STEP 3 — DÀN Ý:
Gọi /api/chat { bot: outlineBot, prompt: outlinePromptTemplate, stream: true }
Render Markdown streaming. Prompt template CỰC QUAN TRỌNG — copy chính xác:

(Dán nguyên prompt outline từ phần 8.2 của CONTENTFORGE-BUILD-SPEC-V2.md)

STEP 4 — ĐÁNH GIÁ:
A) manual: DỪNG pipeline. Preview/edit toggle, ghi chú, 3 nút.
B) auto: Không dừng. Gọi evalBot → JSON {score, reason, improvements}
   Score>=7: tiếp. Score<7: regenerate (max 2). Timeline UI.
   Nút "Chuyển sang duyệt thủ công"

STEP 5 — VIẾT BÀI:
Gọi /api/chat { bot: articleBot, prompt: articlePromptTemplate, stream: true }
Prompt template CỰC QUAN TRỌNG — copy chính xác:

(Dán nguyên prompt article từ phần 8.3 — BAO GỒM phần INTERNAL LINKS)

STEP 6 — HÌNH ẢNH (nếu bật):
Phân tích headings → JSON prompts → asyncPool(2) → tạo ảnh
Params đúng: Imagen/Nano→aspect_ratio, GPT-Image/Flux→aspect
Error panel: retry/tiếp/bỏ qua

STEP 7 — KẾT QUẢ:
Render article + images + word count + badges
Nút export: Copy MD | HTML | Download .md | .html | Bắt đầu lại
THÊM: Lưu DB | Đăng WP (modal) | Nhập URL (+ priority) | Gợi ý 5 keywords

MỌI API CALL đều kèm headers: { Authorization: 'Bearer ' + token }
Khi gọi /api/chat: prompt KHÔNG có @BotName (backend xử lý)
```

### PROMPT 5/8 — Frontend: Batch Mode

```
Tiếp tục public/index.html. Tab "Viết hàng loạt".

Step A — NHẬP KEYWORDS:
- Textarea "Mỗi dòng 1 keyword" (max 50)
- Upload CSV option
- Counter "X keywords"
- Preview list + nút xoá từng keyword

Step B — CẤU HÌNH:
- Field, company, style, bot selection (giống Step 1 single)
- Chọn topic
- Toggle "AI nhóm keywords" (mặc định BẬT)
- Review mode: "AI tự động duyệt" (mặc định) | "Duyệt thủ công"
- Toggle enable_images (mặc định TẮT cho batch)

Step C — CHẠY:
- Nút "Bắt đầu viết hàng loạt"
- POST /api/batch/start → nhận batch_id
- Poll GET /api/batch/:id/status mỗi 5s
- Table tiến trình:
  | # | Keyword | Status | Actions |
  Status: ○ Chưa | ⏳ Đang | ⏸ Chờ duyệt | ✓ Xong | ✗ Lỗi
- Nếu manual + chờ duyệt: nút [Duyệt] → modal xem/sửa outline → approve
- Progress bar: "X/Y bài hoàn thành"
- Nút: Tạm dừng | Tiếp tục | Hủy | Đăng tất cả WP

Step D — KẾT QUẢ:
- Tổng kết: X thành công, Y lỗi
- Bảng bài viết + actions (Xem|Tải|Đăng WP|URL)
```

### PROMPT 6/8 — Frontend: Admin Dashboard

```
Tiếp tục public/index.html. Tab "Quản trị" (chỉ admin).

Sub-tabs: [Tổng quan] [Users] [API Keys] [Prompts] [Topics] [URLs] [WP Sites] [Lịch đặt]

[Tổng quan]
Stats cards: total articles, articles today, users, API key status
Fetch GET /api/admin/stats

[Users]
Table + CRUD. Fetch GET /api/admin/users
Modal tạo/sửa user: username, display_name, role (admin/user), plan (free/basic/pro/enterprise), quota_daily, quota_monthly
Modal reset password

[API Keys]
Table: key_name, masked key, priority, is_active, usage_count, last_error
Thêm/sửa/xoá/toggle active

[Prompts]
3 textarea LỚN (min-height 300px):
- Prompt phân tích ý định (Step 2)
- Prompt dàn ý (Step 3)
- Prompt viết bài (Step 5)
Biến: {keywords}, {field}, {company}, {style}, {intent_data}, {outline}, {extra_keywords}, {reference_info}, {internal_links}, {user_notes}, {file_content}
Nút: Lưu | Reset mặc định
Fetch GET/PUT /api/admin/prompts

[Topics]
CRUD table: name, slug, description, wp_category_id
Modal tạo/sửa

[URLs]
Table: url, title, keyword, topic, is_priority (toggle), article_id
Bulk import textarea
Filter by topic

[WP Sites]
Table: site_name, site_url, username, is_default, status
Nút Test Connection, Set Default
Modal thêm/sửa (site_name, site_url, username, app_password)

[Lịch đặt]
Table schedules: topic, keyword count, articles_per_day, post_time, status
Nút: Pause | Resume | Xem chi tiết | Delete
Modal chi tiết: xem keywords queue, progress
```

### PROMPT 7/8 — Frontend: Lịch sử + Scheduling

```
Tiếp tục public/index.html.

TAB "Lịch sử":
- Bảng articles đã tạo
- User thường: chỉ bài mình
- Admin: tất cả (kèm cột username)
- Cột: Keyword | Topic | Status | Words | Ngày tạo | Actions
- Search bar + filter: topic, status (draft/published/scheduled), date range
- Actions: Xem (modal/expand) | Tải MD | Tải HTML | Đăng WP | Xoá
- Pagination

SCHEDULING UI (section trong tab Viết hàng loạt hoặc tab riêng):
- Form tạo schedule:
  - Chọn topic
  - Textarea keywords queue
  - Số bài/ngày (number input, 1-10)
  - Giờ đăng (time input)
  - Toggle "Tự động đăng WP"
  - Review mode
  - Field, company, style, bots
  - Nút "Tạo lịch đặt"
- POST /api/schedules
- Danh sách schedules hiện tại (fetch từ API)
```

### PROMPT 8/8 — Kiểm tra + Deploy

```
Kiểm tra toàn bộ code:

1. Tên bot CHÍNH XÁC (case-sensitive):
   Text: Gemini-3.1-Pro, Claude-Sonnet-4.5, GPT-5.2, Gemini-3-Flash, Gemini-2.5-Pro, Claude-Opus-4.6
   Image: Nano-Banana-Pro, Imagen-4-Ultra, Imagen-4-Fast, Flux-2-Turbo, GPT-Image-1.5

2. Image params: aspect_ratio cho Imagen/Nano, aspect cho GPT-Image/Flux

3. KHÔNG alert/confirm/prompt trong code

4. stream=true text, stream=false image

5. SSE parse đúng

6. Auto-retry 429/502 (3 lần)

7. Auth middleware trên mọi protected route

8. Admin-only middleware trên admin routes

9. CORS headers

10. Dark mode hoạt động

11. Mobile responsive

12. Quota check trước pipeline

13. Keyword dedup check

14. WordPress publish flow

15. Dual API key rotation

Tạo cấu hình deploy:

Google Cloud Run:
- Dockerfile (node:20-alpine, npm install, copy, expose 8080, CMD node server.js)
- Lưu ý: dùng persistent volume cho SQLite, hoặc đổi sang PostgreSQL

VPS (pm2):
- ecosystem.config.js cho pm2
- Nginx reverse proxy config

.env.example đầy đủ tất cả biến.
```

---

## PHỤ LỤC: CÁCH SỬ DỤNG

### A. Antigravity / Cursor

```
1. Tạo thư mục project
2. Copy POE-API-RULES.md + CONTENTFORGE-BUILD-SPEC-V2.md vào
3. Mở IDE → mở project
4. Ctrl+L → paste prompt (Cách A hoặc Cách B)
5. Chờ AI build
6. Test: npm install && node server.js → http://localhost:8080
```

### B. Khi bị lỗi

```
Kiểm tra theo POE-API-RULES.md:
- Tên bot case-sensitive
- aspect_ratio vs aspect
- stream:false cho image bot
- Parameters spread top-level
- Auth header trên mọi API call
```

### C. Tài khoản mặc định

```
Username: admin
Password: (giá trị ADMIN_PASSWORD trong .env)
```

### D. Tạo user mới

```
Login admin → Quản trị → Users → Thêm user mới
```
