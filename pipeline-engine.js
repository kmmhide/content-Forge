// ═══════════════════════════════════════════════
// ContentForge Studio V2 — Pipeline Engine
// Runs pipelines in the background, interacting with DB and Poe API
// ═══════════════════════════════════════════════

let deps = {}; // { dbGet, dbRun, dbAll, dbInsert, callPoeAPI, saveDb, logPipelineEvent }

function initPipelineEngine(dependencies) {
  deps = dependencies;
}

// ═══════ EVENT LOG HELPER ═══════
function logEvent(pipelineId, step, status, message, metadata, itemId, durationMs) {
  if (deps.logPipelineEvent) {
    deps.logPipelineEvent(pipelineId, step, status, message, metadata, itemId, durationMs);
  }
  // Also console.log for immediate debugging
  const prefix = itemId ? `[PIPE #${pipelineId} item:${itemId}]` : `[PIPE #${pipelineId}]`;
  const dur = durationMs ? ` (${durationMs}ms)` : '';
  console.log(`${prefix} ${step}:${status} — ${message || ''}${dur}`);
}

// ═══════ RATE LIMITING (SEMAPHORE) ═══════
class Semaphore {
  constructor(max) { this.max = max; this.current = 0; this.queue = []; }
  async acquire() {
    if (this.current < this.max) { this.current++; return; }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }
  release() {
    this.current--;
    if (this.queue.length > 0) this.queue.shift()();
  }
}
const poeApiSemaphore = new Semaphore(8); // Max 8 concurrent Poe API calls globally (tối ưu cho nhiều API key)

// ═══════ DEBOUNCED DB SAVE ═══════
let _saveTimer = null;
function debouncedSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (deps.saveDb) deps.saveDb();
  }, 2000);
}
function flushSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (deps.saveDb) deps.saveDb();
}

// ═══════ INTERNAL CHAT HELPER ═══════
async function internalChat(bot, prompt, signal) {
  await poeApiSemaphore.acquire();
  try {
    const resp = await deps.callPoeAPI(bot, prompt, false);
    if (signal?.aborted) throw new Error('Aborted');
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    poeApiSemaphore.release();
  }
}

function parseJSON(raw) {
  if (!raw) return {};
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch (e) {
    return {};
  }
}

// ═══════ PROMPT BUILDERS ═══════
function buildPrompt(template, variables) {
  if (!template) return '';
  let result = template;

  // Pass 1: Replace {key} AND resolve conditional blocks
  for (const [key, value] of Object.entries(variables)) {
    const strVal = (value === null || value === undefined) ? '' : String(value);
    if (strVal.trim() !== '') {
      const condRegex = new RegExp('\{Nếu có ' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ': "([^"]*)"\}', 'g');
      result = result.replace(condRegex, (match, inner) => inner.replaceAll('{' + key + '}', strVal));
      result = result.replaceAll('{' + key + '}', strVal);
    }
  }

  // Pass 2: Remove empty conditional blocks
  for (const [key, value] of Object.entries(variables)) {
    const strVal = (value === null || value === undefined) ? '' : String(value);
    if (strVal.trim() === '') {
      const condRegex = new RegExp('\{Nếu có ' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ': "[^"]*"\}', 'g');
      result = result.replace(condRegex, '');
      result = result.replaceAll('{' + key + '}', '');
    }
  }

  result = result.replace(/\{Nếu có [^}]*\}/g, '');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

function buildContextInfo(field, company, style) {
  const parts = [];
  if (field) parts.push('Linh vuc: ' + field);
  if (company) parts.push('Cong ty/Thuong hieu: ' + company);
  if (style) parts.push('Van phong: ' + style);
  return parts.length > 0 ? parts.join(' | ') : '';
}

function formatInternalLinks(links) {
  // Chỉ gợi ý CHỦ ĐỀ cho bot viết tự nhiên, KHÔNG gửi URL
  // URL sẽ được code tự chèn sau khi viết bài xong (programmaticLinkInjection)
  if (!links || links.length === 0) return '';
  let s = '\nCHU DE LIEN QUAN (ghi nho de viet bai tu nhien hon):\n';
  for (const l of links) {
    const topic = l.keyword || l.title || '';
    if (topic) s += `- ${topic}\n`;
  }
  s += 'Hay nhac den cac chu de tren mot cach TU NHIEN trong bai viet (KHONG chen link, KHONG chen URL — chi nhac den chu de thoi).\n';
  return s;
}

// ═══════ PROGRAMMATIC LINK INJECTION ═══════
// Sau khi bot viết bài xong, code tự tìm keyword trong bài và wrap thành link
// Đảm bảo 100% URL chính xác, không phụ thuộc vào LLM
function programmaticLinkInjection(article, links) {
  if (!links || links.length === 0 || !article) return article;
  
  let result = article;
  const injected = [];
  const failed = [];
  
  // Xóa tất cả link sai mà bot có thể đã tự ý chèn (link markdown chứa domain tương tự)
  // Chỉ xóa link nếu URL không khớp chính xác với bất kỳ link nào trong danh sách
  const validUrls = new Set(links.map(l => l.url));
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match, text, url) => {
    if (validUrls.has(url)) return match; // Giữ nguyên link đúng
    // Kiểm tra xem URL sai có cùng domain với link nào trong danh sách không
    for (const l of links) {
      try {
        const wrongDomain = new URL(url).hostname;
        const correctDomain = new URL(l.url).hostname;
        // Nếu domain tương tự (ví dụ .vn vs .com cùng brand) → đây là link bot bịa
        const wrongBase = wrongDomain.replace(/\.(com|vn|net|org|info)$/, '');
        const correctBase = correctDomain.replace(/\.(com|vn|net|org|info)$/, '');
        if (wrongBase === correctBase && url !== l.url) {
          console.log(`[LINK-FIX] Removed fake link: ${url} (bot fabricated)`);
          return text; // Chỉ giữ lại text, xóa link sai
        }
      } catch {}
    }
    return match; // Giữ nguyên link không liên quan
  });
  
  // Sắp xếp: link ưu tiên trước, keyword dài trước (tránh match partial)
  const sortedLinks = [...links].sort((a, b) => {
    if (a.is_priority !== b.is_priority) return (b.is_priority ? 1 : 0) - (a.is_priority ? 1 : 0);
    return (b.keyword || b.title || '').length - (a.keyword || a.title || '').length;
  });
  
  for (const link of sortedLinks) {
    const keyword = link.keyword || link.title || '';
    if (!keyword || !link.url) continue;
    
    // Kiểm tra xem URL đã được chèn đúng chưa
    if (result.includes(link.url)) {
      injected.push(keyword);
      continue;
    }
    
    // Tìm keyword trong bài viết (case-insensitive, whole word-ish)
    // Không tìm trong heading (# lines) hoặc trong link đã có
    const escapedKw = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const kwRegex = new RegExp(`(?<![\\[\\(])${escapedKw}(?![\\]\\)])`, 'i');
    
    // Tìm vị trí phù hợp nhất (trong body text, không phải heading)
    const lines = result.split('\n');
    let inserted = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Bỏ qua headings, danh sách link đã có, dòng trống
      if (line.startsWith('#') || line.trim() === '') continue;
      // Bỏ qua nếu dòng đã có link markdown
      if (line.includes('](http')) continue;
      
      if (kwRegex.test(line)) {
        lines[i] = line.replace(kwRegex, `[${keyword}](${link.url})`);
        injected.push(keyword);
        inserted = true;
        break;
      }
    }
    
    // Nếu tìm trong heading nếu vẫn chưa chèn được
    if (!inserted) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('](http')) continue;
        if (kwRegex.test(line)) {
          lines[i] = line.replace(kwRegex, `[${keyword}](${link.url})`);
          injected.push(keyword);
          inserted = true;
          break;
        }
      }
    }
    
    if (inserted) {
      result = lines.join('\n');
    } else {
      failed.push(link);
    }
  }
  
  // Chèn các link không tìm được keyword vào phần "Xem thêm"
  if (failed.length > 0) {
    let section = '\n\n### Xem thêm\n';
    for (const link of failed) {
      const anchor = link.title || link.keyword || link.url;
      section += `- [${anchor}](${link.url})\n`;
    }
    
    // Chèn trước phần kết luận nếu có
    const conclusionMatch = result.match(/\n(## (?:Kết luận|Ket luan|Lời kết|Tổng kết|Kết))/i);
    if (conclusionMatch && conclusionMatch.index) {
      result = result.slice(0, conclusionMatch.index) + section + result.slice(conclusionMatch.index);
    } else {
      result = result + section;
    }
  }
  
  console.log(`[LINK-INJECT] Injected: ${injected.length}/${links.length} links inline, ${failed.length} in "Xem thêm"`);
  return result;
}

function cleanRegenOutline(raw, fallbackKeyword) {
  if (!raw || !raw.trim()) return raw;
  let text = raw.replace(/^```[\w]*\n?/gm, '').replace(/```\s*$/gm, '');
  
  // Strip change_log section (usually starts with --- or "Changes:")
  const sepIdx = text.lastIndexOf('\n---');
  if (sepIdx > 0 && sepIdx > text.length * 0.5) text = text.substring(0, sepIdx);
  
  // If it's already markdown, return it
  if (/^\s*#/m.test(text)) return text.trim();
  
  // JSON fallback
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const rj = JSON.parse(m[0]);
      if (rj.improved_outline?.structure) {
        const s = rj.improved_outline.structure;
        let md = `# ${rj.improved_outline.title || fallbackKeyword || ''}\n\n`;
        md += `**Meta:** ${rj.improved_outline.meta || ''}\n\n**H1:** ${s.H1 || ''}\n\n**Intro:** ${s.intro || ''}\n\n`;
        (s.H2 || []).forEach(h => {
          md += `## ${h.heading}\n`;
          (h.notes || []).forEach(n => (md += `- ${n}\n`));
          const subs = h.sub_sections || h.h3 || [];
          subs.forEach(sub => {
            md += `### ${sub.heading || sub}\n`;
            if (sub.notes) sub.notes.forEach(n => (md += `- ${n}\n`));
          });
          md += '\n';
        });
        md += `**Kết:** ${s.conclusion || ''}\n`;
        return md.trim();
      }
    }
  } catch {}
  return text.trim();
}

function parseH2Sections(article) {
  const lines = article.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^## (.+)/);
    if (m) {
      if (current) sections.push(current);
      current = { heading: m[1].trim(), content: '' };
    } else if (current) { current.content += line + '\n'; }
  }
  if (current) sections.push(current);
  return sections;
}

function findBestMatch(heading, imageMap) {
  if (imageMap[heading]) return imageMap[heading];
  const keys = Object.keys(imageMap);
  for (const k of keys) {
    if (k.includes(heading) || heading.includes(k)) return imageMap[k];
  }
  for (const k of keys) {
    const nk = k.replace(/\d+\./, '').trim(), nh = heading.replace(/\d+\./, '').trim();
    if (nk === nh) return imageMap[k];
    const kw = nk.split(/\s+/), hw = nh.split(/\s+/);
    if (kw.filter(w => hw.includes(w)).length / kw.length > 0.7) return imageMap[k];
  }
  return null;
}

function createSlug(str) {
  if (!str) return '';
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ═══════ IMAGE OPTIMIZATION & UPLOAD ═══════
async function processAndUploadImage(originalUrl, wpConfigId, heading) {
  if (!wpConfigId) return originalUrl; // Bỏ qua nếu không chọn WP Site

  try {
    const sharp = require('sharp');
    const res = await fetch(originalUrl);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    let optimizedBuffer = await sharp(buffer)
      .resize({ width: 800, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    
    if (optimizedBuffer.length > 204800) { // Nếu > 200KB thì nén thêm
      optimizedBuffer = await sharp(buffer)
        .resize({ width: 800, withoutEnlargement: true })
        .webp({ quality: 60 })
        .toBuffer();
    }

    // Convert heading "Kích thước tấm cemboard" -> "kich-thuoc-tam-cemboard-16812345.webp"
    const safeHeading = (heading || 'image').normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const filename = `${safeHeading}-${Date.now()}.webp`;

    const wpCfg = deps.dbGet('SELECT * FROM wp_configs WHERE id=?', [+wpConfigId]);
    if (wpCfg) {
      const cleanPass = (wpCfg.app_password || '').replace(/\s+/g, '');
      const wpRes = await fetch(`${wpCfg.site_url}/wp-json/wp/v2/media`, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/webp',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Authorization': 'Basic ' + Buffer.from(`${wpCfg.username}:${cleanPass}`).toString('base64'),
          'User-Agent': 'ContentForge/1.0'
        },
        body: optimizedBuffer
      });
      
      if (wpRes.ok) {
        const wpData = await wpRes.json();
        console.log(`[IMG] Uploaded ${filename} to WP, size: ${Math.round(optimizedBuffer.length/1024)}KB`);
        return { url: wpData.source_url, id: wpData.id }; // Trả về link WP và ID
      } else {
        console.error(`WP Upload failed:`, await wpRes.text());
      }
    }
    
    return { url: originalUrl, id: null };
  } catch (e) {
    console.error(`Image processing error: ${e.message}`);
    return { url: originalUrl, id: null }; // Fallback về link gốc
  }
}

function insertImagesIntoArticle(articleMd, images) {
  if (!images || !images.length) return articleMd;
  const imageMap = {};
  images.forEach(img => { imageMap[img.heading.trim().toLowerCase()] = img; });
  const lines = articleMd.split('\n'), result = [];
  for (const line of lines) {
    result.push(line);
    const m = line.match(/^## (.+)/);
    if (m) {
      const matched = findBestMatch(m[1].trim().toLowerCase(), imageMap);
      if (matched) { result.push(''); result.push(`![${matched.heading}](${matched.url})`); result.push(`*${matched.heading}*`); result.push(''); }
    }
  }
  return result.join('\n');
}

async function asyncPool(limit, items, fn) {
  const results = [];
  const executing = new Set();
  for (const [i, item] of items.entries()) {
    const p = Promise.resolve().then(() => fn(item, i));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.allSettled(results);
}


// ═══════ PIPELINE RUNNER (SINGLE) ═══════
function updatePipelineStatus(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sql = `UPDATE pipelines SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
  const params = [...keys.map(k => fields[k]), id];
  deps.dbRun(sql, params);
  // Dùng debounce cho status updates thường xuyên, flush cho bước quan trọng
  const critical = fields.status === 'done' || fields.status === 'error' || fields.status === 'paused';
  if (critical) flushSave(); else debouncedSave();
}

// Helper: deduct points for a step in pipeline context
function pipelineDeductPoints(userId, stepType, keyword, pipelineId) {
  try {
    const costRow = deps.dbGet('SELECT cost FROM point_costs WHERE step_type = ?', [stepType]);
    const cost = costRow?.cost ?? 0;
    if (cost <= 0) return;
    // Get points user (shared pool for members)
    let pu = deps.dbGet('SELECT * FROM users WHERE id=?', [userId]);
    if (pu && pu.role === 'member' && pu.owner_id) {
      pu = deps.dbGet('SELECT * FROM users WHERE id=?', [pu.owner_id]) || pu;
    }
    if (!pu) return;
    if ((pu.points_balance || 0) < cost) {
      throw new Error(`Không đủ points! Cần ${cost} pts cho ${stepType}, còn ${pu.points_balance || 0} pts`);
    }
    deps.dbRun('UPDATE users SET points_balance = points_balance - ? WHERE id = ?', [cost, pu.id]);
    const newBal = deps.dbGet('SELECT points_balance FROM users WHERE id=?', [pu.id])?.points_balance || 0;
    deps.dbInsert('INSERT INTO point_transactions (user_id,amount,balance_after,type,description,pipeline_id) VALUES (?,?,?,?,?,?)',
      [pu.id, -cost, newBal, 'deduct', `${stepType}: "${keyword}"`, pipelineId]);
    console.log(`[POINTS] -${cost} pts (${stepType}) user#${pu.id} → ${newBal} pts remaining`);
  } catch(e) {
    if (e.message?.includes('Không đủ points')) throw e;
    console.warn('[POINTS] Deduct error:', e.message);
  }
}

async function runSinglePipeline(pipelineId, signal) {
  const p = deps.dbGet('SELECT * FROM pipelines WHERE id=?', [pipelineId]);
  if (!p) return;
  const cfg = JSON.parse(p.config);
  
  const rawPrompts = deps.dbAll('SELECT key, content FROM prompt_templates');
  const prompts = {};
  for (const rp of rawPrompts) prompts[rp.key] = rp.content;

  logEvent(pipelineId, 'pipeline_start', 'start', `Single pipeline: "${cfg.keyword}"`, { keyword: cfg.keyword, step: p.current_step });

  try {
    // Points check — minimum balance to start
    const u = deps.dbGet('SELECT * FROM users WHERE id=?', [p.user_id]);
    let pu = u;
    if (pu && pu.role === 'member' && pu.owner_id) pu = deps.dbGet('SELECT * FROM users WHERE id=?', [pu.owner_id]) || pu;
    const minCost = deps.dbGet('SELECT cost FROM point_costs WHERE step_type = ?', ['intent'])?.cost || 5;
    if ((pu?.points_balance || 0) < minCost) throw new Error(`Không đủ points! Cần ít nhất ${minCost} pts, còn ${pu?.points_balance || 0} pts`);

    // Step 2: Intent
    if (p.current_step < 2) {
      const t0 = Date.now();
      updatePipelineStatus(pipelineId, { current_step: 2, step_label: 'Phân tích ý định (Step 2/7)' });
      const ip = buildPrompt(prompts.intent_prompt, {
        keywords: cfg.keyword,
        context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
      });
      const intentRaw = await internalChat(cfg.intentBot, ip, signal);
      pipelineDeductPoints(p.user_id, 'intent', cfg.keyword, pipelineId);
      const intentData = parseJSON(intentRaw);
      updatePipelineStatus(pipelineId, { intent_data: JSON.stringify(intentData) });
      p.intent_data = JSON.stringify(intentData);
      logEvent(pipelineId, 'intent', 'done', `Intent analyzed for "${cfg.keyword}"`, { bot: cfg.intentBot }, null, Date.now() - t0);
    }

    // Step 3: Outline
    if (p.current_step < 3) {
      const t0 = Date.now();
      updatePipelineStatus(pipelineId, { current_step: 3, step_label: 'Tạo dàn ý (Step 3/7)' });
      const op = buildPrompt(prompts.outline_prompt, {
        keywords: cfg.keyword,
        intent_json: p.intent_data || '{}',
        context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
      });
      const outline = await internalChat(cfg.outlineBot, op, signal);
      pipelineDeductPoints(p.user_id, 'outline', cfg.keyword, pipelineId);
      updatePipelineStatus(pipelineId, { outline });
      p.outline = outline;
      logEvent(pipelineId, 'outline', 'done', `Outline created (${outline.length} chars)`, { bot: cfg.outlineBot, chars: outline.length }, null, Date.now() - t0);
    }

    // Step 4: Eval / Review
    if (p.current_step < 4) {
      updatePipelineStatus(pipelineId, { current_step: 4, step_label: 'Bước 4/7 — Đang kiểm tra...' });
      
      if (cfg.reviewMode === 'manual') {
        // Manual mode: pause and wait for user approval
        logEvent(pipelineId, 'review', 'paused', 'Waiting for manual review');
        updatePipelineStatus(pipelineId, { status: 'paused', step_label: 'Chờ duyệt dàn ý — nhấn Duyệt để tiếp tục' });
        return;
      }

      // AUTO mode: AI tự review → sửa → tiếp tục không cần duyệt
      const t0 = Date.now();
      updatePipelineStatus(pipelineId, { step_label: 'Bước 4/7 — AI đang đánh giá dàn ý...' });
      const ePrompt = buildPrompt(prompts.eval_prompt, {
        keywords: cfg.keyword,
        intent_json: p.intent_data || '{}',
        outline: p.outline
      });
      const eRaw = await internalChat(cfg.evalBot, ePrompt, signal);
      pipelineDeductPoints(p.user_id, 'eval', cfg.keyword, pipelineId);
      const evalJson = parseJSON(eRaw);
      const score = evalJson.overall_score ?? evalJson.score ?? 70;
      const reason = evalJson.verdict || evalJson.reason || '';
      
      logEvent(pipelineId, 'eval', 'done', `AI Review: Score ${score}/100 — ${reason}`, { score, bot: cfg.evalBot }, null, Date.now() - t0);
      
      // Save eval data immediately so UI can show it
      updatePipelineStatus(pipelineId, { 
        eval_history: JSON.stringify(evalJson),
        review_feedback: `AI Score: ${score}/100 — ${reason}`
      });

      let finalOutline = p.outline;
      
      // Step 4.5: Auto-optimize if score < 80
      if (score < 80) {
        const t1 = Date.now();
        console.log(`[PIPE #${pipelineId}] Score ${score} < 80 → auto-optimizing outline...`);
        updatePipelineStatus(pipelineId, { step_label: `Bước 4/7 — Tối ưu dàn ý theo đánh giá (${score}/100)...` });
        const rp = buildPrompt(prompts.regenerate_prompt, {
          keywords: cfg.keyword,
          intent_json: p.intent_data || '{}',
          original_outline: p.outline,
          evaluation_json: JSON.stringify(evalJson, null, 2),
          context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
        });
        const rRaw = await internalChat(cfg.outlineBot, rp, signal);
        pipelineDeductPoints(p.user_id, 'regenerate', cfg.keyword, pipelineId);
        finalOutline = cleanRegenOutline(rRaw, cfg.keyword);
        updatePipelineStatus(pipelineId, { outline: finalOutline });
        logEvent(pipelineId, 'regenerate', 'done', `Outline tối ưu theo đánh giá (score gốc: ${score}/100)`, { original_score: score, bot: cfg.outlineBot }, null, Date.now() - t1);
      } else {
        console.log(`[PIPE #${pipelineId}] Score ${score} >= 80 → outline đạt chất lượng, không cần tối ưu`);
        logEvent(pipelineId, 'regenerate', 'skipped', `Score ${score}/100 >= 80 — không cần tối ưu`, { score });
      }
      
      // Commit approved_outline and review feedback — mark step 4 done
      updatePipelineStatus(pipelineId, { 
        current_step: 4,
        approved_outline: finalOutline, 
        review_feedback: `AI Score: ${score}/100 — ${reason}${score < 80 ? ' → Đã tối ưu' : ' → Đạt'}`,
        eval_history: JSON.stringify(evalJson),
        step_label: `Dàn ý đã được AI duyệt (${score}/100)${score < 80 ? ' — đã tối ưu' : ''} — chuẩn bị viết bài...`
      });
    }

    // Step 5-7: Write article (after auto-approval or manual approval)
    await continueAfterApproval(pipelineId, signal);

  } catch (err) {
    if (signal?.aborted) return;
    logEvent(pipelineId, 'pipeline_error', 'error', err.message || String(err), { step: p.current_step });
    updatePipelineStatus(pipelineId, { status: 'error', error_message: err.message || String(err), step_label: 'Lỗi' });
  }
}

async function continueAfterApproval(pipelineId, signal) {
  // Always re-fetch fresh pipeline state from DB
  let p = deps.dbGet('SELECT * FROM pipelines WHERE id=?', [pipelineId]);
  if (!p) return;
  const cfg = JSON.parse(p.config);
  
  const rawPrompts = deps.dbAll('SELECT key, content FROM prompt_templates');
  const prompts = {};
  for (const rp of rawPrompts) prompts[rp.key] = rp.content;

  try {
    // Step 5: Article
    if (p.current_step < 5) {
      const t0Article = Date.now();
      updatePipelineStatus(pipelineId, { current_step: 5, step_label: 'Đang viết bài (Step 5/7)' });
      const ap = buildPrompt(prompts.article_prompt, {
        keywords: cfg.keyword,
        intent_json: p.intent_data || '{}',
        outline: p.approved_outline || p.outline,
        review_feedback: p.review_feedback || '',
        internal_links: (cfg.enableLinks && cfg.internalLinks?.length > 0) ? formatInternalLinks(cfg.internalLinks) : '',
        context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
      });
      
      const article = await internalChat(cfg.articleBot, ap, signal);
      pipelineDeductPoints(p.user_id, 'article', cfg.keyword, pipelineId);
      
      // Post-processing: CODE tự chèn internal links (không phụ thuộc LLM)
      let finalArticle = article;
      if (cfg.enableLinks && cfg.internalLinks?.length > 0) {
        finalArticle = programmaticLinkInjection(article, cfg.internalLinks);
      }
      
      const wordCount = finalArticle.split(/\s+/).filter(w=>w).length;
      updatePipelineStatus(pipelineId, { article: finalArticle, article_with_images: finalArticle });
      logEvent(pipelineId, 'article_write', 'done', `Article written: ${wordCount} words`, { bot: cfg.articleBot, word_count: wordCount }, null, Date.now() - t0Article);
      
      // Refresh p from DB so subsequent steps have the article
      p = deps.dbGet('SELECT * FROM pipelines WHERE id=?', [pipelineId]);
      if (!p) return;
    }

    // Step 6: Images
    if (cfg.enableImages && p.current_step < 6) {
      const t0Img = Date.now();
      updatePipelineStatus(pipelineId, { current_step: 6, step_label: 'Đang tạo ảnh (Step 6/7)' });
      const secs = parseH2Sections(p.article);
      const isAR = ['Nano-Banana-Pro','Imagen-4-Ultra','Imagen-4-Fast'].includes(cfg.imageBot);
      const imagePromptBot = cfg.imagePromptBot || cfg.intentBot;
      const images = [];
      let imgDone = 0;

      await asyncPool(2, secs, async (s) => {
        if (signal?.aborted) throw new Error('Aborted');
        try {
          pipelineDeductPoints(p.user_id, 'image_context', cfg.keyword, pipelineId);
          const ctxPrompt = buildPrompt(prompts.image_context_prompt, {
            heading: s.heading,
            paragraph_content: s.content.slice(0, 800),
            field: cfg.field,
            keywords: cfg.keyword
          });
          let imgPromptText = await internalChat(imagePromptBot, ctxPrompt, signal);
          imgPromptText = imgPromptText.trim();
          if (imgPromptText && !imgPromptText.toLowerCase().includes('notext')) imgPromptText += ', notext';
          
          if (!imgPromptText) return;

          pipelineDeductPoints(p.user_id, 'image_gen', cfg.keyword, pipelineId);
          const params = isAR ? { aspect_ratio: '16:9' } : { aspect: '16:9' };
          let success = false;
          for (let retry = 0; retry < 3 && !success; retry++) {
            try {
              const imgR = await deps.callPoeAPI(cfg.imageBot, imgPromptText, false, params);
              const content = (await imgR.json()).choices?.[0]?.message?.content || '';
              let url = content.match(/https?:\/\/[^\s)]+/)?.[0];
              if (url) {
                // Xử lý và upload ảnh nếu có WP config (Full Pipeline)
                const processed = await processAndUploadImage(url, cfg.fullPipeline ? cfg.wpConfigId : null, s.heading);
                images.push({ heading: s.heading, url: processed.url, prompt: imgPromptText, mediaId: processed.id });
                success = true;
              }
            } catch (e) {}
            if (signal?.aborted) break;
          }
        } catch (e) {}
        imgDone++;
        updatePipelineStatus(pipelineId, { step_label: `Đang tạo ảnh ${imgDone}/${secs.length} (Step 6/7)` });
      });

      const finalImagesJSON = JSON.stringify(images);
      const articleWithImages = insertImagesIntoArticle(p.article, images);
      updatePipelineStatus(pipelineId, { images: finalImagesJSON, article_with_images: articleWithImages, current_step: 6 });
      
      // Refresh p to get updated images & article_with_images
      p = deps.dbGet('SELECT * FROM pipelines WHERE id=?', [pipelineId]);
      if (!p) return;
      logEvent(pipelineId, 'images', 'done', `Created ${images.length} images`, { count: images.length }, null, Date.now() - t0Img);
    }

    // Step 7: Save to articles
    if (p.current_step < 7) {
      updatePipelineStatus(pipelineId, { current_step: 7, step_label: 'Đang lưu...' });
      const marked = require('marked').marked; // using backend marked
      const fa = p.article_with_images || p.article;
      if (!fa) throw new Error('Article content is empty — cannot save');
      const wordCount = fa.split(/\s+/).filter(w=>w).length;
      
      let articleId = p.article_id;
      if (!articleId) {
        articleId = deps.dbInsert('INSERT INTO articles (keyword, field, company, style, intent_data, outline, outline_status, article, article_html, images, word_count, topic_id, review_mode, status, user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', 
          [cfg.keyword, cfg.field, cfg.company, cfg.style, p.intent_data, p.approved_outline || p.outline, 'used', fa, marked(fa), p.images, wordCount, cfg.topicId, cfg.reviewMode, 'draft', p.user_id]);
        updatePipelineStatus(pipelineId, { article_id: articleId });
      } else {
        deps.dbRun('UPDATE articles SET article=?, article_html=?, images=?, word_count=?, outline_status=? WHERE id=?', 
          [fa, marked(fa), p.images, wordCount, 'used', articleId]);
      }

      // Points already deducted per step above — no legacy quota deduction needed
    }

    updatePipelineStatus(pipelineId, { status: 'done', step_label: 'Hoàn thành!', completed_at: new Date().toISOString() });
    logEvent(pipelineId, 'pipeline_complete', 'done', 'Single pipeline completed');

  } catch (err) {
    if (signal?.aborted) return;
    logEvent(pipelineId, 'pipeline_error', 'error', err.message || String(err), { step: 'continueAfterApproval' });
    updatePipelineStatus(pipelineId, { status: 'error', error_message: err.message || String(err), step_label: 'Lỗi' });
  }
}
// ═══════ BATCH PIPELINE RUNNER ═══════

async function runBatchPipeline(pipelineId, signal) {
  const p = deps.dbGet('SELECT * FROM pipelines WHERE id=?', [pipelineId]);
  if (!p) return;
  const cfg = JSON.parse(p.config);

  const rawPrompts = deps.dbAll('SELECT key, content FROM prompt_templates');
  const prompts = {};
  for (const rp of rawPrompts) prompts[rp.key] = rp.content;

  let groups = p.groups_data ? JSON.parse(p.groups_data) : [];
  let items = p.batch_items ? JSON.parse(p.batch_items) : [];
  const keywords = p.raw_keywords ? JSON.parse(p.raw_keywords) : [];

  function saveItems() {
    updatePipelineStatus(pipelineId, { batch_items: JSON.stringify(items) });
  }

  logEvent(pipelineId, 'batch_start', 'start', `Batch: ${keywords.length} keywords`, { keyword_count: keywords.length, items_existing: items.length });

  try {
    // Phase 1: Keyword Grouping
    console.log(`[BATCH #${pipelineId}] Starting. current_step=${p.current_step}, items=${items.length}, groups=${groups.length}`);
    if (p.current_step < 1) {
      updatePipelineStatus(pipelineId, { current_step: 1, step_label: 'Phân nhóm keyword...' });
      pipelineDeductPoints(p.user_id, 'keyword_grouping', `Batch ${keywords.length} keywords`, pipelineId);

      if (cfg.skipGrouping) {
        groups = keywords.map(k => ({ group_name: k, main_keyword: k, related_keywords: [], insight: 'Không nhóm' }));
      } else {
        // ═══════ AI-FIRST CLUSTERING (2 BƯỚC) ═══════
        // Bước 1: Quick Insight Scan — phân tích intent/topic từng keyword (song song)
        updatePipelineStatus(pipelineId, { step_label: `Bước 1/2: Phân tích insight ${keywords.length} keywords...` });
        console.log(`[BATCH #${pipelineId}] Phase 1 Step 1: Quick insight scan for ${keywords.length} keywords (parallel)`);

        const insightMap = [];
        let insightDone = 0;
        await asyncPool(5, keywords, async (kw) => {
          if (signal?.aborted) return;
          try {
            const insightPrompt = `Phân tích nhanh keyword SEO sau. Trả lời CHỈ bằng JSON, không giải thích.\n\nKeyword: "${kw}"\nLĩnh vực: ${cfg.field || 'chung'}\n\nJSON OUTPUT:\n{"keyword":"${kw}","intent":"mua hàng|tìm hiểu|so sánh|hướng dẫn|khác","topic":"chủ đề cốt lõi (2-4 từ)","audience":"đối tượng chính","content_type":"loại bài viết phù hợp"}`;
            const raw = await internalChat(cfg.intentBot, insightPrompt, signal);
            const parsed = parseJSON(raw);
            insightMap.push({ keyword: kw, ...parsed });
          } catch {
            insightMap.push({ keyword: kw, intent: 'unknown', topic: kw, audience: '', content_type: '' });
          }
          insightDone++;
          updatePipelineStatus(pipelineId, { step_label: `Insight ${insightDone}/${keywords.length}...` });
        });

        console.log(`[BATCH #${pipelineId}] Phase 1 Step 1 done: ${insightMap.length} insights collected`);

        // Bước 2: Smart Grouping — gom nhóm dựa trên insight đã phân tích
        updatePipelineStatus(pipelineId, { step_label: 'Bước 2/2: Gom nhóm theo insight...' });
        console.log(`[BATCH #${pipelineId}] Phase 1 Step 2: Smart grouping based on insights`);

        const insightSummary = insightMap.map(i => `- "${i.keyword}" → intent: ${i.intent || '?'}, topic: ${i.topic || '?'}, audience: ${i.audience || '?'}, type: ${i.content_type || '?'}`).join('\n');

        const groupPrompt = `Dựa trên bản đồ insight dưới đây, hãy nhóm các keywords có CÙNG intent VÀ cùng topic chính thành 1 bài.\nLĩnh vực: ${cfg.field || 'chung'}\n\nBẢN ĐỒ INSIGHT:\n${insightSummary}\n\nQUY TẮC:\n- Keywords cùng intent + cùng topic cốt lõi → gộp 1 bài (keyword phổ biến nhất làm chính)\n- Keywords khác intent HOẶC khác topic → tách bài riêng\n- Mỗi nhóm = 1 bài viết\n- Giữ nguyên keyword gốc, không sửa đổi\n\nTrả lời HOÀN TOÀN bằng JSON:\n[{"group_name":"Tên nhóm","main_keyword":"keyword chính","related_keywords":["kw phụ"],"insight":"Lý do nhóm: cùng intent + topic gì"}]`;

        try {
          const raw = await internalChat(cfg.intentBot, groupPrompt, signal);
          const match = raw.match(/\[[\s\S]*\]/);
          groups = match ? JSON.parse(match[0]) : keywords.map(k => ({ group_name: k, main_keyword: k, related_keywords: [], insight: '' }));
        } catch {
          groups = keywords.map(k => ({ group_name: k, main_keyword: k, related_keywords: [], insight: 'Fallback' }));
        }
        console.log(`[BATCH #${pipelineId}] Phase 1 Step 2 done: ${groups.length} groups formed`);
      }

      updatePipelineStatus(pipelineId, { groups_data: JSON.stringify(groups), step_label: `Phân nhóm xong: ${groups.length} nhóm` });

      // If NOT fullPipeline AND NOT skipGrouping, pause for group review
      if (!cfg.fullPipeline && !cfg.skipGrouping) {
        updatePipelineStatus(pipelineId, { status: 'paused', step_label: `Chờ xác nhận ${groups.length} nhóm` });
        return;
      }
    }

    // Build items from groups if not yet built
    if (items.length === 0) {
      items = groups.map(g => ({
        id: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15), // Basic UUID
        keyword: g.main_keyword,
        related: (g.related_keywords || []).join(', '),
        intentData: null, intentStatus: 'pending',
        outline: '', outlineStatus: 'pending',
        reviewStatus: 'pending', reviewScore: null,
        article: '', wordCount: 0, articleStatus: 'pending',
        images: [], articleId: null, error: null, approved: false
      }));
      saveItems();
    }

    // Phase 2: Intent (SONG SONG — 3 keyword cùng lúc)
    const needsIntent = items.some(a => a.intentStatus !== 'done' && a.intentStatus !== 'error');
    if (p.current_step <= 2 || needsIntent) {
      updatePipelineStatus(pipelineId, { current_step: 2, step_label: 'Phân tích ý định...' });
      const intentPending = items.filter(a => a.intentStatus !== 'done' && a.intentStatus !== 'error');
      let intentDone = items.filter(a => a.intentStatus === 'done').length;
      console.log(`[BATCH #${pipelineId}] Phase 2: ${intentPending.length} items to process (parallel x3)`);

      await asyncPool(3, intentPending, async (a) => {
        if (signal?.aborted) return;
        let retries = 0;
        const maxRetries = 2;
        while (retries <= maxRetries) {
          try {
            const ip = buildPrompt(prompts.intent_prompt, {
              keywords: a.keyword,
              context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
            });
            const raw = await internalChat(cfg.intentBot, ip, signal);
            a.intentData = parseJSON(raw);
            a.intentStatus = 'done';
            // Trừ point SAU KHI thành công
            pipelineDeductPoints(p.user_id, 'intent', a.keyword, pipelineId);
            break;
          } catch (e) {
            retries++;
            if (retries > maxRetries) {
              a.intentStatus = 'error'; a.error = e.message;
              console.log(`[BATCH #${pipelineId}] Intent FAILED for "${a.keyword}" after ${maxRetries} retries: ${e.message}`);
            } else {
              console.log(`[BATCH #${pipelineId}] Intent retry ${retries}/${maxRetries} for "${a.keyword}": ${e.message}`);
              await new Promise(ok => setTimeout(ok, 3000));
            }
          }
        }
        intentDone++;
        updatePipelineStatus(pipelineId, { step_label: `Ý định ${intentDone}/${items.length}` });
        saveItems();
      });
    }

    // Phase 3: Outline (SONG SONG — 3 keyword cùng lúc)
    const needsOutline = items.some(a => a.outlineStatus !== 'done' && a.outlineStatus !== 'error' && a.intentStatus === 'done');
    if (p.current_step <= 3 || needsOutline) {
      updatePipelineStatus(pipelineId, { current_step: 3, step_label: 'Tạo dàn ý...' });
      // Mark error items first
      items.forEach(a => { if (a.intentStatus === 'error' && a.outlineStatus !== 'error') a.outlineStatus = 'error'; });
      const outlinePending = items.filter(a => a.outlineStatus !== 'done' && a.outlineStatus !== 'error' && a.intentStatus === 'done');
      let outlineDone = items.filter(a => a.outlineStatus === 'done').length;
      console.log(`[BATCH #${pipelineId}] Phase 3: ${outlinePending.length} items to process (parallel x3)`);

      await asyncPool(3, outlinePending, async (a) => {
        if (signal?.aborted) return;
        let retries = 0;
        const maxRetries = 2;
        while (retries <= maxRetries) {
          try {
            const op = buildPrompt(prompts.outline_prompt, {
              keywords: a.keyword,
              intent_json: a.intentData ? JSON.stringify(a.intentData, null, 2) : '{}',
              context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
            });
            a.outline = await internalChat(cfg.outlineBot, op, signal);
            a.outlineStatus = 'done';
            // Trừ point SAU KHI thành công
            pipelineDeductPoints(p.user_id, 'outline', a.keyword, pipelineId);
            break;
          } catch (e) {
            retries++;
            if (retries > maxRetries) {
              a.outlineStatus = 'error'; a.error = e.message;
              console.log(`[BATCH #${pipelineId}] Outline FAILED for "${a.keyword}" after ${maxRetries} retries: ${e.message}`);
            } else {
              console.log(`[BATCH #${pipelineId}] Outline retry ${retries}/${maxRetries} for "${a.keyword}": ${e.message}`);
              await new Promise(ok => setTimeout(ok, 3000));
            }
          }
        }
        outlineDone++;
        updatePipelineStatus(pipelineId, { step_label: `Dàn ý ${outlineDone}/${items.length}` });
        saveItems();
      });
    }

    // Phase 4: Review
    const needsReview = items.some(a => a.outlineStatus === 'done' && !a.approved && a.reviewStatus !== 'error');
    if (p.current_step <= 4 || needsReview) {
      updatePipelineStatus(pipelineId, { current_step: 4, step_label: 'Đánh giá dàn ý...' });

      if (cfg.reviewMode === 'auto') {
        // Auto-review (SONG SONG — 2 keyword cùng lúc)
        const reviewPending = items.filter(a => a.outlineStatus === 'done' && !a.approved && a.reviewStatus !== 'approved' && a.reviewStatus !== 'error');
        // Mark non-done items as error
        items.forEach(a => { if (a.outlineStatus !== 'done' && !a.approved && a.reviewStatus !== 'error') a.reviewStatus = 'error'; });
        let reviewDone = items.filter(a => a.approved || a.reviewStatus === 'approved').length;
        console.log(`[BATCH #${pipelineId}] Phase 4: ${reviewPending.length} items to review (parallel x2)`);

        let aiReviewHappened = reviewPending.length > 0;
        await asyncPool(2, reviewPending, async (a) => {
          if (signal?.aborted) return;
          try {
            // Save original outline BEFORE any regeneration for comparison
            const originalOutline = a.outline;
            let bestOutline = a.outline, bestScore = 0, lastVerdict = '';
            let lastEvalJson = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              const ep = buildPrompt(prompts.eval_prompt, {
                keywords: a.keyword,
                intent_json: a.intentData ? JSON.stringify(a.intentData, null, 2) : '{}',
                outline: a.outline
              });
              const eRaw = await internalChat(cfg.evalBot, ep, signal);
              // Trừ point SAU KHI thành công
              pipelineDeductPoints(p.user_id, 'eval', a.keyword, pipelineId);
              const evalJson = parseJSON(eRaw);
              const score = evalJson.overall_score ?? evalJson.score ?? 70;
              const verdict = evalJson.verdict || evalJson.reason || 'AI Evaluation';
              
              if (score > bestScore) { 
                bestScore = score; 
                bestOutline = a.outline;
                lastVerdict = verdict;
              }
              a.reviewScore = bestScore;
              lastEvalJson = evalJson;
              
              console.log(`[BATCH #${pipelineId}] Item "${a.keyword}" attempt ${attempt}: score=${score}`);

              if (score >= 80 || attempt === 3) { 
                a.outline = bestOutline; 
                a.original_outline = originalOutline;
                a.evalData = lastEvalJson;
                a.reviewStatus = 'approved'; 
                a.approved = true; 
                a.reviewFeedback = `AI Score: ${bestScore}/100 — ${lastVerdict}`;
                break; 
              }
              
              // Regenerate to improve
              const rp = buildPrompt(prompts.regenerate_prompt, {
                keywords: a.keyword,
                intent_json: a.intentData ? JSON.stringify(a.intentData, null, 2) : '{}',
                original_outline: a.outline,
                evaluation_json: JSON.stringify(evalJson, null, 2),
                context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
              });
              const rRaw = await internalChat(cfg.outlineBot, rp, signal);
              // Trừ point SAU KHI regenerate thành công
              pipelineDeductPoints(p.user_id, 'regenerate', a.keyword, pipelineId);
              a.outline = cleanRegenOutline(rRaw, a.keyword);
            }
          } catch (e) { a.reviewStatus = 'error'; a.error = e.message; }
          reviewDone++;
          updatePipelineStatus(pipelineId, { step_label: `Đánh giá ${reviewDone}/${items.length}` });
          saveItems();
        });

        // Nếu có AI Review sửa bài mà không chạy Full Pipeline -> Dừng lại chờ user duyệt
        if (aiReviewHappened && !cfg.fullPipeline) {
          updatePipelineStatus(pipelineId, { status: 'paused', step_label: 'Chờ duyệt dàn ý (AI đã sửa)' });
          return;
        }
      } else {
        if (cfg.fullPipeline) {
          // AI Review OFF, Full Pipeline ON -> Bỏ qua review, viết bài luôn
          let autoApproved = false;
          items.forEach(a => {
            if (a.outlineStatus === 'done' && !a.approved && a.reviewStatus !== 'error') {
              a.approved = true;
              a.reviewStatus = 'approved';
              a.reviewFeedback = 'Bỏ qua duyệt (Full Pipeline)';
              autoApproved = true;
            }
          });
          if (autoApproved) saveItems();
        } else {
          // AI Review OFF, Full Pipeline OFF -> Dừng chờ duyệt tay
          if (needsReview) {
            updatePipelineStatus(pipelineId, { status: 'paused', step_label: 'Chờ duyệt dàn ý' });
            return;
          }
        }
      }
    }

    // Phase 5: Write articles (2-3 parallel)
    {
      console.log(`[BATCH #${pipelineId}] Phase 5: items=${items.length}, approved=${items.filter(a=>a.approved).length}, outlineDone=${items.filter(a=>a.outlineStatus==='done').length}`);
      updatePipelineStatus(pipelineId, { current_step: 5, step_label: 'Viết bài...' });

      const pendingItems = items.filter(a => a.approved && a.outlineStatus === 'done' && a.articleStatus !== 'done');
      console.log(`[BATCH #${pipelineId}] Phase 5: pendingItems=${pendingItems.length}`);
      let artDone = 0;

      await asyncPool(3, pendingItems, async (a) => {
        if (signal?.aborted) return;
        const idx = items.indexOf(a);
        a.articleStatus = 'processing';
        updatePipelineStatus(pipelineId, { step_label: `Viết bài ${artDone+1}/${pendingItems.length}` });
        try {
          const linksText = (cfg.enableLinks && cfg.internalLinks?.length > 0) ? formatInternalLinks(cfg.internalLinks) : '';
          console.log(`[BATCH #${pipelineId}] SEO: Item "${a.keyword}" links_available=${cfg.internalLinks?.length || 0}`);
          
          const ap = buildPrompt(prompts.article_prompt, {
            keywords: a.keyword,
            intent_json: a.intentData ? JSON.stringify(a.intentData, null, 2) : '{}',
            outline: a.outline,
            review_feedback: '',
            internal_links: linksText,
            context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
          });
          a.article = await internalChat(cfg.articleBot, ap, signal);
          // Trừ point SAU KHI thành công
          pipelineDeductPoints(p.user_id, 'article', a.keyword, pipelineId);
          
          // Post-processing: CODE tự chèn internal links (không phụ thuộc LLM)
          if (cfg.enableLinks && cfg.internalLinks?.length > 0) {
            a.article = programmaticLinkInjection(a.article, cfg.internalLinks);
          }
          
          // SEO Injection Logging
          const linksInjected = (a.article.match(/\[.*?\]\(https?:\/\/.*?\)/g) || []).length;
          console.log(`[BATCH #${pipelineId}] SEO Result for "${a.keyword}": injected_links=${linksInjected}, total_available=${cfg.internalLinks?.length || 0}`);
          
          a.wordCount = a.article.split(/\s+/).filter(w => w).length;

          // Images
          if (cfg.enableImages) {
            const secs = parseH2Sections(a.article);
            const imagePromptBot = cfg.imagePromptBot || cfg.intentBot;
            const isAR = ['Nano-Banana-Pro','Imagen-4-Ultra','Imagen-4-Fast'].includes(cfg.imageBot);
            const images = [];

            await asyncPool(2, secs, async (s) => {
              if (signal?.aborted) return;
              try {
                pipelineDeductPoints(p.user_id, 'image_context', a.keyword, pipelineId);
                const ctxPrompt = buildPrompt(prompts.image_context_prompt, {
                  heading: s.heading, paragraph_content: s.content.slice(0, 800),
                  field: cfg.field, keywords: a.keyword
                });
                let imgPromptText = await internalChat(imagePromptBot, ctxPrompt, signal);
                imgPromptText = imgPromptText.trim();
                if (imgPromptText && !imgPromptText.toLowerCase().includes('notext')) imgPromptText += ', notext';
                if (!imgPromptText) return;
                pipelineDeductPoints(p.user_id, 'image_gen', a.keyword, pipelineId);
                const params = isAR ? { aspect_ratio: '16:9' } : { aspect: '16:9' };
                for (let retry = 0; retry < 3; retry++) {
                  try {
                    const imgR = await deps.callPoeAPI(cfg.imageBot, imgPromptText, false, params);
                    const content = (await imgR.json()).choices?.[0]?.message?.content || '';
                    let url = content.match(/https?:\/\/[^\s)]+/)?.[0];
                    if (url) { 
                      const processed = await processAndUploadImage(url, cfg.fullPipeline ? cfg.wpConfigId : null, s.heading);
                      images.push({ heading: s.heading, url: processed.url, prompt: imgPromptText, mediaId: processed.id }); 
                      break; 
                    }
                  } catch {}
                }
              } catch {}
            });
            a.images = images;
            if (images.length > 0) a.article = insertImagesIntoArticle(a.article, images);
          }

          // Save to DB
          const { marked } = require('marked');
          const articleHtml = marked(a.article);
          a.articleId = deps.dbInsert(
            'INSERT INTO articles (keyword, field, company, style, intent_data, outline, outline_status, article, article_html, images, word_count, topic_id, review_mode, status, user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [a.keyword, cfg.field || '', cfg.company || '', cfg.style || '', JSON.stringify(a.intentData || {}), a.outline || '', 'used', a.article, articleHtml, JSON.stringify(a.images || []), a.wordCount || 0, cfg.topicId || null, cfg.reviewMode || 'auto', 'draft', p.user_id]
          );

          a.articleStatus = 'done';
        } catch (e) { 
          console.error(`[BATCH #${pipelineId}] Article error for "${a.keyword}":`, e.message || e);
          a.articleStatus = 'error'; a.error = e.message; 
        }
        artDone++;
        saveItems();
        updatePipelineStatus(pipelineId, { step_label: `Viết bài ${artDone}/${pendingItems.length}` });
      });
    }

    // Phase 6: WP Publish (if configured)
    if (p.current_step < 6 && cfg.fullPipeline && cfg.wpConfigId) {
      updatePipelineStatus(pipelineId, { current_step: 6, step_label: 'Đang đăng WP...' });
      const wpPostStatus = cfg.wpPostStatus || 'publish'; // 'publish' hoặc 'draft'
      let wpDone = 0;
      for (const a of items) {
        if (signal?.aborted) return;
        if (a.articleStatus !== 'done' || !a.articleId) continue;
        try {
          const wpCfg = deps.dbGet('SELECT * FROM wp_configs WHERE id=?', [+cfg.wpConfigId]);
          if (wpCfg) {
            const article = deps.dbGet('SELECT * FROM articles WHERE id=?', [a.articleId]);
            if (article) {
              const cleanPass = (wpCfg.app_password || '').replace(/\s+/g, '');
              const intendedSlug = createSlug(article.keyword);
              let featuredMediaId = null;
              try {
                const imgs = JSON.parse(article.images || '[]');
                if (imgs.length > 0 && imgs[0].mediaId) featuredMediaId = imgs[0].mediaId;
              } catch(e) {}
              
              const wpPayload = { title: article.keyword, content: article.article_html, status: wpPostStatus, slug: intendedSlug };
              if (featuredMediaId) wpPayload.featured_media = featuredMediaId;

              const wpRes = await fetch(`${wpCfg.site_url}/wp-json/wp/v2/posts`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Basic ' + Buffer.from(`${wpCfg.username}:${cleanPass}`).toString('base64'),
                  'User-Agent': 'ContentForge/1.0'
                },
                body: JSON.stringify(wpPayload)
              });
              if (wpRes.ok) {
                const returnedWpData = await wpRes.json();
                a.wpPublished = true;
                a.wpPostStatus = wpPostStatus;
                const newStatus = wpPostStatus === 'publish' ? 'published' : 'draft';
                deps.dbRun('UPDATE articles SET status = ? WHERE id = ?', [newStatus, a.articleId]);
                wpDone++;
                
                if (returnedWpData.slug && returnedWpData.slug !== intendedSlug) {
                  console.log(`[WARNING] URL duplicated on WP. Intended: ${intendedSlug}, Actual: ${returnedWpData.slug}`);
                  a.warning = `Bị trùng URL: ${returnedWpData.slug}`;
                } else {
                  console.log(`[BATCH #${pipelineId}] WP published "${a.keyword}" as ${wpPostStatus}`);
                }
              } else {
                const errBody = await wpRes.text().catch(() => '');
                console.log(`[BATCH #${pipelineId}] WP publish FAILED for "${a.keyword}": ${wpRes.status} ${errBody.substring(0, 200)}`);
              }
            }
          }
        } catch (e) {
          console.log(`[BATCH #${pipelineId}] WP error for "${a.keyword}": ${e.message}`);
        }
        updatePipelineStatus(pipelineId, { step_label: `Đăng WP ${wpDone}/${items.filter(x => x.articleStatus === 'done').length}` });
      }
      saveItems();
    }

    // Done
    const doneCount = items.filter(a => a.articleStatus === 'done').length;
    const errorCount = items.filter(a => a.articleStatus === 'error').length;
    console.log(`[BATCH #${pipelineId}] DONE. done=${doneCount}, error=${errorCount}/${items.length}`);
    logEvent(pipelineId, 'batch_complete', 'done', `Batch done: ${doneCount}/${items.length}`, { done: doneCount, errors: errorCount, total: items.length });
    updatePipelineStatus(pipelineId, {
      current_step: 7,
      status: 'done',
      step_label: `Hoàn thành! ${doneCount}/${items.length} bài`,
      completed_at: new Date().toISOString()
    });

  } catch (err) {
    if (signal?.aborted) return;
    logEvent(pipelineId, 'batch_error', 'error', err.message || String(err));
    updatePipelineStatus(pipelineId, { status: 'error', error_message: err.message || String(err), step_label: 'Lỗi' });
  }
}


class PipelineQueue {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.maxPerUser = options.maxPerUser || 2;
    this.running = new Map(); // id -> AbortController
    this.pollMs = 2000;
    this._retryBackoffs = new Map(); // id -> next retry timestamp
  }

  start() {
    this._timer = setInterval(() => this.tick(), this.pollMs);
  }

  async tick() {
    // Auto-retry: check for error pipelines with retry_count < 2
    this._checkAutoRetry();
    
    if (this.running.size >= this.maxConcurrent) return;

    const next = deps.dbGet(`
      SELECT * FROM pipelines 
      WHERE status = 'queued' 
      ORDER BY priority ASC, created_at ASC 
      LIMIT 1
    `);
    
    if (!next) return;

    const userRunning = deps.dbGet(`SELECT COUNT(*) as c FROM pipelines WHERE user_id = ? AND status = 'running'`, [next.user_id])?.c || 0;
    
    const user = deps.dbGet('SELECT plan FROM users WHERE id=?', [next.user_id]);
    let limit = this.maxPerUser;
    if (user?.plan === 'free') limit = 1;
    else if (user?.plan === 'basic') limit = 2;
    else if (user?.plan === 'pro') limit = 3;
    else if (user?.plan === 'enterprise') limit = 5;

    if (userRunning >= limit) return;

    this.execute(next);
  }

  _checkAutoRetry() {
    // Find pipelines that errored with retry_count < 2
    const errored = deps.dbGet(
      "SELECT * FROM pipelines WHERE status = 'error' AND retry_count < 2 ORDER BY updated_at ASC LIMIT 1"
    );
    if (!errored) return;
    
    // Exponential backoff: 30s * 2^retry_count
    const backoffMs = 30000 * Math.pow(2, errored.retry_count || 0);
    const lastUpdate = new Date(errored.updated_at).getTime();
    const now = Date.now();
    
    if (now - lastUpdate < backoffMs) return; // Not yet time
    
    // Auto-retry
    deps.dbRun(
      "UPDATE pipelines SET status='queued', error_message=NULL, retry_count=retry_count+1, step_label='Auto-retry...' WHERE id=? AND status='error'",
      [errored.id]
    );
    logEvent(errored.id, 'auto_retry', 'start', `Auto-retry #${(errored.retry_count||0)+1} after ${backoffMs/1000}s`, { retry_count: (errored.retry_count||0)+1, backoff_ms: backoffMs });
    deps.saveDb();
    console.log(`[QUEUE] Auto-retry pipeline #${errored.id} (attempt ${(errored.retry_count||0)+1})`);
  }

  async execute(pipeline) {
    const ac = new AbortController();
    this.running.set(pipeline.id, ac);
    deps.dbRun(`UPDATE pipelines SET status='running', started_at=? WHERE id=?`, [new Date().toISOString(), pipeline.id]);
    
    try {
      if (pipeline.type === 'single') {
        await runSinglePipeline(pipeline.id, ac.signal);
      } else if (pipeline.type === 'batch') {
        await runBatchPipeline(pipeline.id, ac.signal);
      }
    } catch (e) {
      if (e.message !== 'Aborted') {
        logEvent(pipeline.id, 'queue_error', 'error', e.message);
        deps.dbRun(`UPDATE pipelines SET status='error', error_message=? WHERE id=?`, [e.message, pipeline.id]);
      }
    } finally {
      this.running.delete(pipeline.id);
    }
  }

  cancel(pipelineId) {
    const ac = this.running.get(pipelineId);
    if (ac) {
      ac.abort();
      this.running.delete(pipelineId);
    }
    deps.dbRun(`UPDATE pipelines SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [pipelineId]);
    logEvent(pipelineId, 'pipeline_cancel', 'done', 'Pipeline cancelled by user');
  }
}

module.exports = {
  initPipelineEngine,
  PipelineQueue,
  runSinglePipeline,
  runBatchPipeline,
  continueAfterApproval,
  poeApiSemaphore
};
