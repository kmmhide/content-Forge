// ═══════ ContentForge Studio V2 — App Logic ═══════
let token = null, currentUser = null, pipelineActive = false;
let state = { step: 1, intentData: null, outline: '', approvedOutline: '', reviewFeedback: '', article: '', articleWithImages: '', images: [], reviewMode: 'manual', articleId: null, evalHistory: [] };
let currentBatchId = null, batchPollTimer = null;
let dupTimeout = null;
let promptTemplates = {}; // Loaded from API on login

// ═══════ HELPERS ═══════
const $ = id => document.getElementById(id);
const api = async (url, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) { doLogout(); throw new Error('Session expired'); }
  return res;
};

function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.textContent = msg;
  $('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

function showModal(title, body, buttons = []) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  let btns = buttons.map(b => `<button class="btn ${b.cls || 'btn-secondary'}" onclick="(${b.fn})();this.closest('.modal-overlay').remove()">${b.text}</button>`).join('');
  overlay.innerHTML = `<div class="modal-box"><h3>${title}</h3><div>${body}</div><div class="modal-actions">${btns}<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Đóng</button></div></div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function toggleSwitch(id) {
  const el = $(id);
  el.classList.toggle('on');
  if (id === 'review-toggle') {
    state.reviewMode = el.classList.contains('on') ? 'auto' : 'manual';
    $('review-label').textContent = state.reviewMode === 'auto' ? 'AI tự động duyệt' : 'Duyệt thủ công';
  }
  if (id === 's-review-toggle') {
    const label = $('s-review-label');
    if (label) label.textContent = el.classList.contains('on') ? 'AI tự động duyệt — pipeline chạy hoàn toàn tự động' : 'Duyệt thủ công — pipeline sẽ dừng để bạn xem outline';
  }
  if (id === 'b-review-toggle') {
    const label = $('b-review-label');
    if (label) label.textContent = el.classList.contains('on') ? 'AI tự động duyệt' : 'Duyệt thủ công từng bài';
  }
  if (id === 'b-skip-grouping-toggle') {
    const label = $('b-skip-grouping-label');
    if (label) label.textContent = el.classList.contains('on') ? 'Bật — Mỗi keyword sẽ tạo 1 bài riêng, không nhóm' : 'Tắt — AI sẽ phân nhóm keyword tương tự thành 1 bài';
  }
  if (id === 'b-fullpipeline-toggle') {
    const label = $('b-fullpipeline-label');
    const wpGroup = $('b-wp-site-group');
    if (label) label.textContent = el.classList.contains('on') ? 'Bật — Chạy toàn bộ pipeline tự động (phân nhóm → viết → đăng WP)' : 'Tắt — Dừng sau khi phân nhóm để xác nhận';
    if (wpGroup) wpGroup.style.display = el.classList.contains('on') ? '' : 'none';
  }
}

function toggleCollapsible(id) {
  const el = $(id);
  el.classList.toggle('open');
  const icon = el.previousElementSibling.querySelector('i');
  if (icon) icon.style.transform = el.classList.contains('open') ? 'rotate(90deg)' : '';
}

// ═══════ BUTTON LOADING STATE ═══════
async function btnWithLoading(btn, fn) {
  if (btn.classList.contains('btn-loading')) return; // Prevent double-click
  btn.classList.add('btn-loading');
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    console.error('Button action error:', e);
    showToast('Lỗi: ' + e.message, 'error');
  } finally {
    btn.classList.remove('btn-loading');
    btn.disabled = false;
  }
}

// ═══════ OUTLINE EDITOR (Step 4) ═══════
let outlineEdited = false;
function switchOutlineTab(tab) {
  const editTab = $('outline-tab-edit'), previewTab = $('outline-tab-preview');
  const editArea = $('outline-edit-textarea'), previewArea = $('outline-preview-area');
  if (tab === 'edit') {
    editTab.classList.add('active'); previewTab.classList.remove('active');
    editArea.classList.remove('hidden'); previewArea.classList.add('hidden');
  } else {
    previewTab.classList.add('active'); editTab.classList.remove('active');
    previewArea.classList.remove('hidden'); editArea.classList.add('hidden');
    // Sync textarea → preview
    const md = editArea.value;
    previewArea.innerHTML = marked.parse(md);
    // Also update state
    state.outline = md;
  }
}
function onOutlineEdited() {
  outlineEdited = true;
  const indicator = $('outline-edit-indicator');
  if (indicator) indicator.classList.remove('hidden');
  // Live sync to state
  state.outline = $('outline-edit-textarea').value;
}
function populateOutlineEditor(md) {
  const textarea = $('outline-edit-textarea');
  if (textarea) textarea.value = md;
  const previewArea = $('outline-preview-area');
  if (previewArea) previewArea.innerHTML = marked.parse(md);
  outlineEdited = false;
  const indicator = $('outline-edit-indicator');
  if (indicator) indicator.classList.add('hidden');
  // Default to edit tab
  switchOutlineTab('edit');
}

// ═══════ ARTICLE EDITOR (Step 7) ═══════
let articleEdited = false;
function switchArticleTab(tab) {
  const editTab = $('article-tab-edit'), previewTab = $('article-tab-preview');
  const editArea = $('article-edit-textarea'), previewArea = $('final-article');
  if (tab === 'edit') {
    editTab.classList.add('active'); previewTab.classList.remove('active');
    editArea.classList.remove('hidden'); previewArea.classList.add('hidden');
    // Set current markdown into textarea
    editArea.value = state.articleWithImages || state.article;
  } else {
    previewTab.classList.add('active'); editTab.classList.remove('active');
    previewArea.classList.remove('hidden'); editArea.classList.add('hidden');
    // Sync textarea → preview if user edited
    if (articleEdited) {
      const md = editArea.value;
      state.articleWithImages = md;
      state.article = md;
      previewArea.innerHTML = marked.parse(md);
      updateWordCount();
    }
  }
}
function onArticleEdited() {
  articleEdited = true;
  const indicator = $('article-edit-indicator');
  if (indicator) indicator.classList.remove('hidden');
}
function updateWordCount() {
  const fa = state.articleWithImages || state.article;
  const words = fa.split(/\s+/).filter(w => w).length;
  $('word-count-badge').textContent = words + ' từ';
}

// ═══════ IMAGE MANAGER ═══════
function renderImageManager() {
  const panel = $('img-manager-panel');
  const list = $('img-manager-list');
  const count = $('img-manager-count');
  if (!panel || !list) return;
  if (state.images.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  count.textContent = state.images.length;
  list.innerHTML = state.images.map((img, i) => `
    <div class="img-item">
      <img src="${img.url}" alt="${img.heading}" onerror="this.src='data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'80\' height=\'50\'><rect fill=\'%23ccc\' width=\'80\' height=\'50\'/><text x=\'40\' y=\'28\' text-anchor=\'middle\' fill=\'%23666\' font-size=\'10\'>No img</text></svg>'">
      <div class="img-item-info">
        <div class="img-heading">${img.heading}</div>
        <div style="color:var(--text2);font-size:.75rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${img.prompt || ''}</div>
      </div>
      <div class="img-item-actions">
        <button class="btn btn-sm btn-danger" onclick="removeImage(${i})" title="Xóa ảnh này"><i class="fas fa-trash"></i></button>
      </div>
    </div>
  `).join('');
}
function removeImage(idx) {
  if (idx < 0 || idx >= state.images.length) return;
  const removed = state.images.splice(idx, 1)[0];
  // Remove image markdown from article
  if (state.articleWithImages) {
    const lines = state.articleWithImages.split('\n');
    const filtered = lines.filter(line => {
      if (line.includes(removed.url)) return false;
      if (line.trim() === `*${removed.heading}*`) return false;
      return true;
    });
    state.articleWithImages = filtered.join('\n');
    state.article = state.articleWithImages;
  }
  $('final-article').innerHTML = marked.parse(state.articleWithImages || state.article);
  $('img-count-badge').textContent = state.images.length + ' ảnh';
  updateWordCount();
  renderImageManager();
  showToast(`Đã xóa ảnh: ${removed.heading}`, 'info');
}

// ═══════ PROMPT TEMPLATE ENGINE ═══════
function buildPrompt(template, variables) {
  if (!template) return '';
  let result = template;

  // Pass 1: For each variable with a value, replace {key} AND resolve conditional blocks
  for (const [key, value] of Object.entries(variables)) {
    const strVal = (value === null || value === undefined) ? '' : String(value);
    if (strVal.trim() !== '') {
      // First resolve conditional blocks containing this key: extract content inside quotes
      // Pattern: {Nếu có key: "...content with {key}..."}
      const condRegex = new RegExp(
        '\\{Nếu có ' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ': "([^"]*)"\\}',
        'g'
      );
      result = result.replace(condRegex, (match, inner) => {
        // Replace {key} inside the extracted content
        return inner.replaceAll('{' + key + '}', strVal);
      });
      // Then replace remaining bare {key} occurrences
      result = result.replaceAll('{' + key + '}', strVal);
    }
  }

  // Pass 2: Remove conditional blocks for variables that are EMPTY
  for (const [key, value] of Object.entries(variables)) {
    const strVal = (value === null || value === undefined) ? '' : String(value);
    if (strVal.trim() === '') {
      // Remove the entire conditional line
      const condRegex = new RegExp(
        '\\{Nếu có ' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ': "[^"]*"\\}',
        'g'
      );
      result = result.replace(condRegex, '');
      // Remove bare {key} occurrences
      result = result.replaceAll('{' + key + '}', '');
    }
  }

  // Clean up remaining conditional blocks for any unmatched variables
  result = result.replace(/\{Nếu có [^}]*\}/g, '');
  // Remove excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

// Clean regenerated outline: strip code blocks, change_log, handle JSON fallback
function cleanRegenOutline(raw, fallbackKeyword) {
  if (!raw || !raw.trim()) return raw;
  let text = raw;
  // Strip code block wrappers (```markdown ... ``` or ``` ... ```)
  text = text.replace(/^```[\w]*\n?/gm, '').replace(/```\s*$/gm, '');
  // Strip change_log section (after --- separator)
  const sepIdx = text.lastIndexOf('\n---');
  if (sepIdx > 0 && sepIdx > text.length * 0.5) {
    text = text.substring(0, sepIdx);
  }
  // If it looks like Markdown (has # or ##), use it directly
  if (/^\s*#/m.test(text)) {
    return text.trim();
  }
  // Legacy fallback: try to parse JSON improved_outline
  try {
    const rj = JSON.parse((text.match(/\{[\s\S]*\}/) || [])[0] || '{}');
    if (rj.improved_outline?.structure) {
      const s = rj.improved_outline.structure;
      let md = `# ${rj.improved_outline.title || fallbackKeyword || ''}\n\n`;
      md += `**Meta:** ${rj.improved_outline.meta || ''}\n\n`;
      md += `**H1:** ${s.H1 || ''}\n\n**Intro:** ${s.intro || ''}\n\n`;
      (s.H2 || []).forEach(h => {
        md += `## ${h.heading}\n`;
        (h.notes || []).forEach(n => (md += `- ${n}\n`));
        // Also handle sub_sections / h3 if AI returns them
        (h.sub_sections || h.h3 || []).forEach(sub => {
          md += `### ${sub.heading || sub}\n`;
          (sub.notes || []).forEach(n => (md += `- ${n}\n`));
        });
        md += '\n';
      });
      md += `**Kết:** ${s.conclusion || ''}\n`;
      return md.trim();
    }
  } catch {}
  return text.trim();
}

function formatInternalLinks(links) {
  if (!links || links.length === 0) return '';
  let s = '';
  const priority = links.filter(l => l.is_priority);
  const normal = links.filter(l => !l.is_priority);
  if (priority.length > 0) {
    s += 'URL ưu tiên (BẮT BUỘC phải chèn):\n';
    priority.forEach(l => { s += `- [${l.title}](${l.url})${l.keyword ? ' (keyword: '+l.keyword+')' : ''}\n`; });
  }
  if (normal.length > 0) {
    s += 'URL liên quan (chèn nếu phù hợp):\n';
    normal.forEach(l => { s += `- [${l.title}](${l.url})${l.keyword ? ' (keyword: '+l.keyword+')' : ''}\n`; });
  }
  s += 'QUY TẮC: Chèn 2-5 link tự nhiên trong bài, ưu tiên URL ưu tiên. LINK NẰM TRONG CÂU VĂN, KHÔNG liệt kê riêng.\n';
  return s;
}

async function loadPromptTemplates() {
  try {
    const res = await api('/api/prompts');
    promptTemplates = await res.json();
    console.log('[Prompts] Loaded', Object.keys(promptTemplates).length, 'templates:', Object.keys(promptTemplates).join(', '));
  } catch (e) { console.error('Failed to load prompt templates:', e); }
}

// ═══════ AUTH ═══════
async function doLogin() {
  const u = $('login-user').value, p = $('login-pass').value;
  if (!u || !p) { $('login-error').textContent = 'Vui lòng nhập đầy đủ'; $('login-error').style.display = 'block'; return; }
  try {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    const data = await res.json();
    if (!res.ok) { $('login-error').textContent = data.error; $('login-error').style.display = 'block'; return; }
    token = data.token; currentUser = data.user;
    $('app-login').classList.add('hidden');
    $('app-main').classList.remove('hidden');
    $('user-display').textContent = currentUser.display_name;
    if (currentUser.role !== 'admin') $('admin-tab').classList.add('hidden');
    else $('admin-tab').classList.remove('hidden');
    loadTopics(); loadQuota(); loadBotDropdowns(); loadInternalLinks(); loadPromptTemplates();
    if (typeof loadBatchWpSites === 'function') loadBatchWpSites();
  } catch (e) { $('login-error').textContent = 'Lỗi kết nối'; $('login-error').style.display = 'block'; }
}

function doLogout() {
  token = null; currentUser = null;
  $('app-main').classList.add('hidden');
  $('app-login').classList.remove('hidden');
  $('login-pass').value = '';
}

$('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

// ═══════ NAVIGATION ═══════
function switchTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.nav-tab[data-tab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  $('tab-' + tab).classList.add('active');
  $('progress-bar').style.display = tab === 'single' ? 'flex' : 'none';
  if (tab === 'history') loadHistory();
  if (tab === 'admin') switchAdminTab('stats');
}

// ═══════ STEP MANAGEMENT ═══════
function goToStep(n) {
  state.step = n;
  document.querySelectorAll('.step-panel').forEach(p => p.classList.add('hidden'));
  $('step-' + n).classList.remove('hidden');
  document.querySelectorAll('.step-dot').forEach((d, i) => {
    d.classList.remove('active');
    if (i + 1 === n) d.classList.add('active');
    else if (i + 1 < n) { d.classList.add('completed'); d.onclick = () => goToStep(i + 1); }
  });
  document.querySelectorAll('.step-line').forEach((l, i) => {
    l.classList.toggle('completed', i + 1 < n);
  });
}

// ═══════ TOPICS ═══════
async function loadTopics() {
  try {
    const res = await api('/api/topics');
    const data = await res.json();
    const opts = '<option value="">— Không chọn —</option>' + (data.topics || []).map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    $('s-topic').innerHTML = opts;
    $('b-topic').innerHTML = opts;
  } catch {}
}

// ═══════ QUOTA ═══════
async function loadQuota() {
  try {
    const res = await api('/api/quota');
    const data = await res.json();
    const pct = data.daily.limit > 0 ? (data.daily.used / data.daily.limit * 100) : 0;
    $('quota-text').textContent = `${data.daily.used}/${data.daily.limit} hôm nay | ${data.monthly.used}/${data.monthly.limit} tháng`;
    $('quota-fill').style.width = Math.min(pct, 100) + '%';
    if (pct >= 90) $('quota-fill').style.background = 'var(--error)';
    else if (pct >= 70) $('quota-fill').style.background = 'var(--warn)';
  } catch {}
}

// ═══════ KEYWORD DEDUP ═══════
function checkDuplicate() {
  clearTimeout(dupTimeout);
  $('kw-dup-status').textContent = '';
  $('kw-dup-warning').classList.add('hidden');
  const kw = $('s-keyword').value.trim();
  if (!kw || kw.length < 2) return;
  dupTimeout = setTimeout(async () => {
    try {
      const res = await api('/api/keywords/check-duplicate?keyword=' + encodeURIComponent(kw));
      const data = await res.json();
      if (data.isDuplicate) {
        $('kw-dup-status').innerHTML = '<span style="color:var(--warn)">⚠</span>';
        $('kw-dup-warning').innerHTML = `<strong>⚠ Từ khóa này đã được viết trước đó.</strong><br>Bạn vẫn có thể tiếp tục viết với góc tiếp cận mới.`;
        $('kw-dup-warning').classList.remove('hidden');
      } else {
        $('kw-dup-status').innerHTML = '<span style="color:var(--success)">✓</span>';
      }
    } catch {}
  }, 500);
}

// ═══════ PIPELINE ═══════
async function startPipeline() {
  const keyword = $('s-keyword').value.trim(), field = $('s-field').value.trim();
  if (!keyword || !field) return showToast('Cần nhập từ khóa và lĩnh vực!', 'error');

  // Refetch prompt templates to get latest admin changes
  await loadPromptTemplates();

  // Check quota
  try {
    const qr = await api('/api/auth/me');
    const qu = await qr.json();
    if (qu.quota_used_today >= qu.quota_limit_day) return showToast('Hết quota ngày!', 'error');
  } catch {}

  // Check duplicate
  try {
    const dr = await api(`/api/keywords/check?keyword=${encodeURIComponent(keyword)}`);
    const dd = await dr.json();
    if (dd.exists) {
      if (!confirm(`Keyword "${keyword}" đã viết rồi. Tiếp tục?`)) return;
    }
  } catch {}

  // Capture ALL form values into config
  const config = {
    keyword, field,
    company: $('s-company').value.trim(),
    style: $('s-style').value.trim(),
    extra: $('s-extra').value.trim(),
    reference: $('s-reference').value.trim(),
    reviewMode: $('s-review-toggle')?.classList.contains('on') ? 'auto' : 'manual',
    enableImages: $('image-toggle')?.classList.contains('on') || false,
    enableLinks: $('s-enable-links')?.checked || false,
    intentBot: $('s-intentBot').value,
    outlineBot: $('s-outlineBot').value,
    evalBot: $('s-evalBot').value,
    articleBot: $('s-articleBot').value,
    imageBot: $('s-imageBot').value,
    imagePromptBot: $('s-imagePromptBot')?.value || $('s-intentBot').value,
    topicId: $('s-topic')?.value || null,
    internalLinks: []
  };

  // Create pipeline & launch in background (do NOT await)
  const p = PipelineManager.create(keyword, 'single');
  if (!p) return;
  p.config = config;

  // Fetch internal links if enabled
  if (config.enableLinks) {
    try {
      const urlRes = await api('/api/urls');
      const urlData = await urlRes.json();
      p.config.internalLinks = urlData.urls || [];
    } catch { p.config.internalLinks = []; }
  }

  showToast(`🚀 Pipeline "${keyword}" đã bắt đầu chạy ngầm!`, 'success');

  // Launch async — pipeline runs independently
  runPipelineBackground(p.id);

  // Reset form immediately — user gets fresh form back
  resetPipeline();
  loadQuota();
}

function buildIntentSection(id) {
  if (!id) return '';
  let s = '\n════════════════════════════════\nKẾT QUẢ PHÂN TÍCH Ý ĐỊNH TÌM KIẾM:\n════════════════════════════════\n';
  s += `- Ý định chính: ${id.primary_intent || 'N/A'}\n`;
  s += `- Ý định phụ: ${Array.isArray(id.secondary_intents) ? id.secondary_intents.join(', ') : 'N/A'}\n`;
  s += `- Đối tượng mục tiêu: ${id.target_audience || 'N/A'}\n`;
  s += `- Góc tiếp cận: ${id.content_angle || 'N/A'}\n`;
  s += `- Điểm đau: ${Array.isArray(id.pain_points) ? id.pain_points.join(', ') : 'N/A'}\n`;
  s += `- Keywords liên quan: ${Array.isArray(id.related_keywords) ? id.related_keywords.join(', ') : 'N/A'}\n`;
  s += '════════════════════════════════\n';
  return s;
}

function buildContextInfo(field, company, style) {
  const parts = [];
  if (field) parts.push('Linh vuc: ' + field);
  if (company) parts.push('Cong ty/Thuong hieu: ' + company);
  if (style) parts.push('Van phong: ' + style);
  return parts.length > 0 ? parts.join(' | ') : '';
}

function buildLinksSection(links) {
  if (!links || links.length === 0) return '';
  let s = '\nINTERNAL LINKS (chèn tự nhiên vào bài viết, dùng anchor text phù hợp):\n';
  const priority = links.filter(l => l.is_priority);
  const normal = links.filter(l => !l.is_priority);
  if (priority.length > 0) {
    s += 'URL ưu tiên (BẮT BUỘC phải chèn):\n';
    priority.forEach(l => { s += `- [${l.title}](${l.url})${l.keyword ? ' (keyword: '+l.keyword+')' : ''}\n`; });
  }
  if (normal.length > 0) {
    s += 'URL liên quan (chèn nếu phù hợp):\n';
    normal.forEach(l => { s += `- [${l.title}](${l.url})${l.keyword ? ' (keyword: '+l.keyword+')' : ''}\n`; });
  }
  s += 'QUY TẮC: Chèn 2-5 link tự nhiên trong bài, ưu tiên URL ưu tiên. LINK NẰM TRONG CÂU VĂN, KHÔNG liệt kê riêng.\n';
  return s;
}

function buildOutlinePrompt() {
  const kw = $('s-keyword').value, field = $('s-field').value, style = $('s-style').value || 'tu nhien, ro rang, co chieu sau';
  const company = $('s-company').value;
  return buildPrompt(promptTemplates.outline_prompt, {
    keywords: kw,
    intent_json: state.intentData ? JSON.stringify(state.intentData, null, 2) : '{}',
    context_info: buildContextInfo(field, company, style)
  });
}

function buildArticlePrompt() {
  const kw = $('s-keyword').value, field = $('s-field').value, company = $('s-company').value;
  const style = $('s-style').value || 'tu nhien';
  const notes = $('s-review-notes').value;
  const outline = state.approvedOutline || state.outline;
  // Build internal links — check pipeline config first, then DOM
  let linksText = '';
  const viewId = PipelineManager.viewingId;
  const pipe = viewId ? PipelineManager.getById(viewId) : null;
  const enableLinks = pipe?.config?.enableLinks ?? ($('s-enable-links')?.checked || false);
  if (enableLinks) {
    const links = pipe?.config?.internalLinks || state._internalLinks || [];
    if (links.length > 0) linksText = formatInternalLinks(links);
  }
  return buildPrompt(promptTemplates.article_prompt, {
    keywords: kw,
    intent_json: state.intentData ? JSON.stringify(state.intentData, null, 2) : '{}',
    outline,
    review_feedback: state.reviewFeedback || '',
    internal_links: linksText,
    context_info: buildContextInfo(field, company, style)
  });
}

async function streamChat(bot, prompt, targetId) {
  const el = $(targetId);
  el.innerHTML = '';
  let content = '';
  const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ bot, prompt, stream: true }) });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const d = JSON.parse(line.slice(6));
        const delta = d.choices?.[0]?.delta?.content || '';
        content += delta;
      } catch {}
    }
    el.innerHTML = marked.parse(content);
    el.scrollTop = el.scrollHeight;
  }
  if (targetId === 'outline-result') state.outline = content;
  if (targetId === 'article-result') state.article = content;
  return content;
}

// ═══════ AUTO REVIEW ═══════
async function autoReview() {
  const timeline = $('auto-review-timeline');
  let bestOutline = state.outline, bestScore = 0;
  const kw = $('s-keyword').value, field = $('s-field').value;
  const style = $('s-style').value || 'tu nhien';
  const company = $('s-company').value;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const evalPrompt = buildPrompt(promptTemplates.eval_prompt, {
      keywords: kw,
      intent_json: state.intentData ? JSON.stringify(state.intentData, null, 2) : '{}',
      outline: state.outline
    });
    const evalRes = await api('/api/chat', { method: 'POST', body: JSON.stringify({ bot: $('s-evalBot').value, prompt: evalPrompt, stream: false }) });
    const evalData = await evalRes.json();
    const evalContent = evalData.choices?.[0]?.message?.content || '';
    let score = 70, reason = '', improvements = [], evalJson = null;
    try {
      const m = evalContent.match(/\{[\s\S]*\}/);
      evalJson = JSON.parse(m[0]);
      score = evalJson.overall_score ?? evalJson.score ?? 70;
      reason = evalJson.verdict || evalJson.reason || '';
      improvements = evalJson.key_issues || evalJson.improvements || [];
    } catch {}

    if (score > bestScore) { bestScore = score; bestOutline = state.outline; }
    state.evalHistory.push({ score, reason, improvements, attempt });
    const icon = score >= 70 ? '\u2713' : '\u21bb';
    timeline.innerHTML += `<div class="timeline-item"><span>${icon}</span> \u0110\u00e1nh gi\u00e1 l\u1ea7n ${attempt}: <strong>${score}/100</strong> \u2014 ${score >= 70 ? 'Duy\u1ec7t' : 'T\u1ea1o l\u1ea1i'}</div>`;

    if (score >= 70 || attempt === 3) {
      $('auto-review-loading').classList.add('hidden');
      state.outline = bestOutline;
      state.approvedOutline = bestOutline;
      if (reason) state.reviewFeedback = `AI Score: ${bestScore}/100 \u2014 ${reason}`;
      $('auto-review-outline-preview').innerHTML = marked.parse(bestOutline);
      $('auto-review-actions').classList.remove('hidden');
      $('btn-switch-manual').classList.add('hidden');
      pipelineActive = false;
      return;
    }
    // Regenerate with evaluation JSON
    const regenPrompt = buildPrompt(promptTemplates.regenerate_prompt, {
      keywords: kw,
      intent_json: state.intentData ? JSON.stringify(state.intentData, null, 2) : '{}',
      original_outline: state.outline,
      evaluation_json: evalJson ? JSON.stringify(evalJson, null, 2) : JSON.stringify({ key_issues: improvements }),
      context_info: buildContextInfo(field, company, style)
    });
    const regenRaw = await streamChat($('s-outlineBot').value, regenPrompt, 'outline-result');
    // Clean regenerated outline (Markdown or JSON fallback)
    state.outline = cleanRegenOutline(regenRaw, kw);
  }
}

function switchToManual() {
  state.reviewMode = 'manual';
  $('review-auto').classList.add('hidden');
  $('review-manual').classList.remove('hidden');
  populateOutlineEditor(state.outline);
  pipelineActive = false;
}

async function approveOutline() {
  if (pipelineActive) return;
  pipelineActive = true;
  // Sync from editor textarea if user edited
  const textarea = $('outline-edit-textarea');
  if (textarea && textarea.value) state.outline = textarea.value;
  state.approvedOutline = state.outline;
  const notes = $('s-review-notes').value;
  if (notes) state.reviewFeedback = notes;
  await continueAfterReview();
}

async function continueAfterReview() {
  try {
    // Auto-save outline to DB immediately
    if (!state.articleId) {
      try {
        const saveRes = await api('/api/articles', { method: 'POST', body: JSON.stringify({
          keyword: $('s-keyword').value, field: $('s-field').value, company: $('s-company').value,
          style: $('s-style').value, extra_keywords: $('s-extra').value, reference_info: $('s-reference').value,
          intent_data: state.intentData, outline: state.approvedOutline || state.outline,
          outline_status: 'approved', status: 'outline_only',
          topic_id: $('s-topic').value || null, review_mode: state.reviewMode
        })});
        const sr = await saveRes.json();
        if (sr.id) state.articleId = sr.id;
      } catch {}
    }

    // Step 5: Article
    goToStep(5);
    // Ensure internal links are loaded before building article prompt
    if ($('s-enable-links')?.checked && !state._internalLinks?.length) {
      try {
        const urlRes = await api('/api/urls');
        const urlData = await urlRes.json();
        state._internalLinks = urlData.urls || [];
        // Also update pipeline config if viewing
        if (PipelineManager.viewingId) {
          const p = PipelineManager.getById(PipelineManager.viewingId);
          if (p) p.config.internalLinks = state._internalLinks;
        }
      } catch { state._internalLinks = []; }
    }
    await streamChat($('s-articleBot').value, buildArticlePrompt(), 'article-result');

    // Step 6: Images (if enabled)
    if ($('image-toggle').classList.contains('on')) {
      goToStep(6);
      await generateImages();
    }

    // Step 7: Result
    goToStep(7);
    showResult();
  } catch (e) {
    showToast('Lỗi: ' + e.message, 'error');
  }
  pipelineActive = false;
  $('btn-start').disabled = false;
  loadQuota();
}

async function aiEvaluate() {
  const kw = $('s-keyword').value, field = $('s-field').value;
  const evalPrompt = buildPrompt(promptTemplates.eval_prompt, {
    keywords: kw,
    intent_json: state.intentData ? JSON.stringify(state.intentData, null, 2) : '{}',
    outline: state.outline
  });
  const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ bot: $('s-evalBot').value, prompt: evalPrompt, stream: false }) });
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  try {
    const j = JSON.parse(content.match(/\{[\s\S]*\}/)[0]);
    const score = j.overall_score ?? j.score;
    const verdict = j.verdict || '';
    const issues = [...(j.key_issues||[]), ...(j.improvement_suggestions||[]), ...(j.improvements||[])];
    state._lastEvalJson = j;
    showModal('\u0110\u00e1nh gi\u00e1 AI', `<div style="font-size:2rem;text-align:center;margin:.5rem">${score}/100 <small style="font-size:1rem;color:var(--text2)">${verdict}</small></div><p>${j.insight_alignment_score!==undefined?'Insight: '+j.insight_alignment_score+' | Depth: '+j.depth_score+' | Flow: '+j.flow_score+' | SEO: '+j.seo_score:''}</p>${issues.length?'<ul>'+issues.map(i=>'<li>'+i+'</li>').join('')+'</ul>':''}`, [{text:'🔄 Tối ưu theo đánh giá',cls:'btn-primary',fn:'function(){optimizeFromEval()}'}]);
  } catch { showModal('\u0110\u00e1nh gi\u00e1 AI', `<div class="md-preview">${marked.parse(content)}</div>`); }
}

async function optimizeFromEval() {
  const evalJson = state._lastEvalJson;
  if (!evalJson) { showToast('Không có dữ liệu đánh giá', 'error'); return; }
  const kw = $('s-keyword').value, field = $('s-field').value;
  const style = $('s-style').value || 'tu nhien', company = $('s-company').value;
  const regenPrompt = buildPrompt(promptTemplates.regenerate_prompt, {
    keywords: kw,
    intent_json: state.intentData ? JSON.stringify(state.intentData, null, 2) : '{}',
    original_outline: state.outline,
    evaluation_json: JSON.stringify(evalJson, null, 2),
    context_info: buildContextInfo(field, company, style)
  });
  goToStep(3);
  $('outline-result').innerHTML = '<div class="loading-overlay"><div class="spinner"></div>Đang tối ưu outline theo đánh giá...</div>';
  try {
    const regenRaw = await streamChat($('s-outlineBot').value, regenPrompt, 'outline-result');
    state.outline = cleanRegenOutline(regenRaw, kw);
    $('outline-result').innerHTML = marked.parse(state.outline);
    goToStep(4);
    populateOutlineEditor(state.outline);
    if (PipelineManager.viewingId) { const p = PipelineManager.getById(PipelineManager.viewingId); if (p) p.state.outline = state.outline; }
    showToast('✅ Outline đã tối ưu xong!', 'success');
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); goToStep(4); populateOutlineEditor(state.outline); }
}

async function regenerateOutline() {
  const notes = $('s-review-notes').value;
  const kw = $('s-keyword').value, field = $('s-field').value;
  const style = $('s-style').value || 'tu nhien';
  const company = $('s-company').value;
  let regenPrompt;
  if (notes || state.outline) {
    // Get a quick eval first if we have notes
    let evalJson = null;
    if (notes) {
      evalJson = { key_issues: [notes], improvement_suggestions: [] };
    }
    regenPrompt = buildPrompt(promptTemplates.regenerate_prompt, {
      keywords: kw,
      intent_json: state.intentData ? JSON.stringify(state.intentData, null, 2) : '{}',
      original_outline: state.outline,
      evaluation_json: evalJson ? JSON.stringify(evalJson) : JSON.stringify({ key_issues: ['Cai thien chat luong tong the'], improvement_suggestions: [] }),
      context_info: buildContextInfo(field, company, style)
    });
  } else {
    regenPrompt = buildOutlinePrompt();
  }
  goToStep(3);
  const regenRaw = await streamChat($('s-outlineBot').value, regenPrompt, 'outline-result');
  // Clean regenerated outline (Markdown or JSON fallback)
  state.outline = cleanRegenOutline(regenRaw, kw);
  $('outline-result').innerHTML = marked.parse(state.outline);
  goToStep(4);
  populateOutlineEditor(state.outline);
  if (PipelineManager.viewingId) {
    const p = PipelineManager.getById(PipelineManager.viewingId);
    if (p) { p.state.outline = state.outline; }
  }
}

// ═══════ IMAGE UTILITIES ═══════
function removeDiacritics(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}
function findBestMatch(headingText, imageMap) {
  if (imageMap[headingText]) return imageMap[headingText];
  for (const [key, img] of Object.entries(imageMap)) {
    const nk = removeDiacritics(key), nh = removeDiacritics(headingText);
    if (nk === nh) return img;
    const kw = nk.split(/\s+/), hw = nh.split(/\s+/);
    if (kw.filter(w => hw.includes(w)).length / kw.length > 0.7) return img;
  }
  return null;
}
function insertImagesIntoArticle(articleMd, images) {
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

// ═══════ IMAGES ═══════
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

async function generateImages() {
  const imageBot = $('s-imageBot').value;
  const imagePromptBot = $('s-imagePromptBot')?.value || $('s-intentBot').value; // fallback to intent bot
  const kw = $('s-keyword').value, field = $('s-field').value;
  const sections = parseH2Sections(state.article);
  if (sections.length === 0) { $('image-result').innerHTML = '<p>Không tìm thấy heading để tạo ảnh</p>'; return; }
  state.images = [];
  const el = $('image-result');
  const totalImages = sections.length;
  let completed = 0, failed = 0;
  const isAspectRatio = ['Nano-Banana-Pro', 'Imagen-4-Ultra', 'Imagen-4-Fast'].includes(imageBot);

  // Build progress table
  const stepStatus = sections.map(s => ({ heading: s.heading, step: '', status: '○ Chờ' }));
  function renderImageProgress() {
    const pct = Math.round(completed / totalImages * 100);
    let html = `<div style="margin-bottom:1rem"><p style="color:var(--text2);font-weight:600">🖼 Tạo hình ảnh — ${completed}/${totalImages} heading</p>`;
    html += `<div class="quota-bar" style="height:8px;margin:.5rem 0"><div class="quota-fill" style="width:${pct}%"></div></div></div>`;
    html += '<table class="data-table" style="font-size:.85rem"><thead><tr><th>#</th><th>Heading</th><th>Bước</th><th>Trạng thái</th></tr></thead><tbody>';
    stepStatus.forEach((s, i) => {
      html += `<tr><td>${i+1}</td><td>${s.heading}</td><td>${s.step || '—'}</td><td>${s.status}</td></tr>`;
    });
    html += '</tbody></table>';
    // Show completed images
    if (state.images.length > 0) {
      html += state.images.map(img => `<div style="margin:.5rem 0"><img src="${img.url}" style="max-width:100%;border-radius:8px"><p style="font-size:.8rem;color:var(--text2)">${img.heading}</p></div>`).join('');
    }
    el.innerHTML = html;
  }
  renderImageProgress();

  await asyncPool(2, sections, async (sec, idx) => {
    try {
      // Step 6a: Text bot reads context → writes image prompt
      stepStatus[idx].step = 'Đọc ngữ cảnh';
      stepStatus[idx].status = '⏳ 6a...';
      renderImageProgress();

      const contextPrompt = buildPrompt(promptTemplates.image_context_prompt, {
        heading: sec.heading,
        paragraph_content: sec.content.slice(0, 800),
        field: field,
        keywords: kw
      });

      const contextRes = await api('/api/chat', { method: 'POST', body: JSON.stringify({ bot: imagePromptBot, prompt: contextPrompt, stream: false }) });
      let imagePromptText = (await contextRes.json()).choices?.[0]?.message?.content?.trim() || '';
      // Ensure notext is appended
      if (imagePromptText && !imagePromptText.toLowerCase().includes('notext')) {
        imagePromptText += ', notext';
      }

      if (!imagePromptText) {
        stepStatus[idx].status = '❌ Lỗi (no prompt)';
        failed++;
        completed++;
        renderImageProgress();
        return;
      }

      // Step 6b: Image bot creates image from prompt
      stepStatus[idx].step = 'Tạo ảnh';
      stepStatus[idx].status = '⏳ 6b...';
      renderImageProgress();

      const params = isAspectRatio ? { aspect_ratio: '16:9' } : { aspect: '16:9' };
      let success = false;
      for (let retry = 0; retry < 3 && !success; retry++) {
        try {
          const imgRes = await api('/api/chat', { method: 'POST', body: JSON.stringify({ bot: imageBot, prompt: imagePromptText, stream: false, parameters: params }) });
          const imgData = await imgRes.json();
          const content = imgData.choices?.[0]?.message?.content || '';
          const urlMatch = content.match(/https?:\/\/[^\s)]+/);
          if (urlMatch) {
            state.images.push({ heading: sec.heading, url: urlMatch[0], prompt: imagePromptText });
            success = true;
          } else if (retry === 2) { failed++; }
        } catch (e) {
          if (retry === 2) failed++;
        }
      }
      stepStatus[idx].step = '—';
      stepStatus[idx].status = success ? '✅ Xong' : '❌ Lỗi';
    } catch (e) {
      stepStatus[idx].status = '❌ Lỗi';
      failed++;
    }
    completed++;
    renderImageProgress();
  });

  if (state.images.length === 0) el.innerHTML = '<p>Không tạo được ảnh nào</p>';
  else {
    let msg = `<p style="color:var(--success);font-weight:600">✅ Tạo thành công ${state.images.length}/${totalImages} ảnh.`;
    if (failed > 0) msg += ` <span style="color:var(--error)">${failed} ảnh bị lỗi.</span>`;
    msg += '</p>';
    el.innerHTML = msg + state.images.map(img => `<div style="margin:.5rem 0"><img src="${img.url}" style="max-width:100%;border-radius:8px"><p style="font-size:.8rem;color:var(--text2)">${img.heading}</p></div>`).join('');
  }
}

// ═══════ RESULT ═══════
function showResult() {
  // Insert images into article markdown
  if (state.images.length > 0) {
    state.articleWithImages = insertImagesIntoArticle(state.article, state.images);
  } else {
    state.articleWithImages = state.article;
  }
  const finalArticle = state.articleWithImages;
  const words = finalArticle.split(/\s+/).filter(w => w).length;
  $('word-count-badge').textContent = words + ' từ';
  $('img-count-badge').textContent = state.images.length + ' ảnh';
  $('final-article').innerHTML = marked.parse(finalArticle);
  $('article-edit-textarea').value = finalArticle;
  articleEdited = false;
  const indicator = $('article-edit-indicator');
  if (indicator) indicator.classList.add('hidden');
  // Reset to preview tab
  switchArticleTab('preview');
  // Render image manager
  renderImageManager();
  loadSuggestions($('s-keyword').value, $('s-field').value);
  // Auto-save to DB
  saveToDb();
}

async function loadSuggestions(keyword, field) {
  try {
    const res = await api('/api/keywords/suggest', { method: 'POST', body: JSON.stringify({ keyword: keyword || '', field: field || '', count: 5 }) });
    const data = await res.json();
    if (data.suggestions?.length) {
      $('keyword-suggestions').innerHTML = data.suggestions.map(s =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:.5rem;margin:.25rem 0;background:var(--surface);border-radius:6px;border:1px solid var(--border)"><div><strong>${s.keyword}</strong><br><small style="color:var(--text2)">${s.reason || ''}</small></div><button class="btn btn-sm btn-primary" onclick="useSuggestion('${s.keyword.replace(/'/g, "\\'")}')">Viết bài</button></div>`
      ).join('');
    } else { $('keyword-suggestions').textContent = 'Không có gợi ý'; }
  } catch { $('keyword-suggestions').textContent = 'Không có gợi ý'; }
}

function useSuggestion(kw) { resetPipeline(); $('s-keyword').value = kw; showToast('Đã chọn: ' + kw, 'success'); }

function syncArticleFromEditor() {
  const ta = $('article-edit-textarea');
  if (ta && articleEdited) {
    state.articleWithImages = ta.value;
    state.article = ta.value;
  }
}

function copyResult(fmt) {
  syncArticleFromEditor();
  const text = fmt === 'md' ? (state.articleWithImages || state.article) : marked.parse(state.articleWithImages || state.article);
  navigator.clipboard.writeText(text).then(() => showToast('Đã copy!', 'success')).catch(() => {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    showToast('Đã copy!', 'success');
  });
}

function downloadResult(fmt) {
  syncArticleFromEditor();
  const content = fmt === 'md' ? (state.articleWithImages || state.article) : marked.parse(state.articleWithImages || state.article);
  const blob = new Blob([content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = ($('s-keyword').value || 'article') + '.' + fmt;
  a.click();
}

async function saveToDb() {
  syncArticleFromEditor();
  try {
    const finalArticle = state.articleWithImages || state.article;
    const method = state.articleId ? 'PUT' : 'POST';
    const url = state.articleId ? '/api/articles/' + state.articleId : '/api/articles';
    const res = await api(url, { method, body: JSON.stringify({
      keyword: $('s-keyword').value, field: $('s-field').value, company: $('s-company').value,
      style: $('s-style').value, extra_keywords: $('s-extra').value, reference_info: $('s-reference').value,
      intent_data: state.intentData, outline: state.approvedOutline || state.outline,
      outline_status: 'used',
      article: finalArticle, article_html: marked.parse(finalArticle), images: state.images,
      word_count: finalArticle.split(/\s+/).filter(w => w).length,
      topic_id: $('s-topic').value || null, review_mode: state.reviewMode, status: 'draft'
    })});
    const data = await res.json();
    if (data.success) {
      state.articleId = data.id || state.articleId;
      showToast('Đã lưu thành công! (ID: ' + state.articleId + ')', 'success');
    } else showToast('Lỗi: ' + (data.error || 'Unknown'), 'error');
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

function showWpPublishModal() {
  showModal('Đăng lên WordPress', '<p>Tính năng đăng WordPress cần cấu hình WP Site trong Admin > WP Sites trước.</p>', []);
}

function resetPipeline() {
  state = { step: 1, intentData: null, outline: '', approvedOutline: '', reviewFeedback: '', article: '', articleWithImages: '', images: [], reviewMode: state.reviewMode, articleId: null, evalHistory: [] };
  goToStep(1);
  $('btn-start').disabled = false;
  pipelineActive = false;
  // Reset auto-review UI
  const arActions = $('auto-review-actions');
  if (arActions) arActions.classList.add('hidden');
  const btnSwitchManual = $('btn-switch-manual');
  if (btnSwitchManual) btnSwitchManual.classList.remove('hidden');
}

// ═══════ SAVE OUTLINE ONLY (Flow B) ═══════
async function saveOutlineOnly() {
  // Get data from pipeline config if viewing a sidebar pipeline, otherwise from form
  const viewId = PipelineManager.viewingId;
  const p = viewId ? PipelineManager.getById(viewId) : null;
  const cfg = p?.config || {};

  // Pull outline from pipeline state first (most reliable), then from global state
  let outlineToSave = '';
  if (p) {
    outlineToSave = p.state.approvedOutline || p.state.outline || '';
  }
  if (!outlineToSave) {
    outlineToSave = state.approvedOutline || state.outline || '';
  }
  state.approvedOutline = outlineToSave;

  const notes = $('s-review-notes')?.value;
  if (notes) state.reviewFeedback = notes;

  const keyword = cfg.keyword || $('s-keyword').value;
  const field = cfg.field || $('s-field').value;
  const company = cfg.company || $('s-company').value;
  const style = cfg.style || $('s-style').value;
  const extra = cfg.extra || $('s-extra').value;
  const reference = cfg.reference || $('s-reference').value;
  const topicId = cfg.topicId || $('s-topic').value || null;
  const reviewMode = cfg.reviewMode || state.reviewMode;

  // Pull intent data from pipeline too
  const intentData = p ? (p.state.intentData || state.intentData) : state.intentData;

  if (!keyword) { showToast('Không có từ khóa để lưu', 'error'); return; }
  if (!outlineToSave) { showToast('Không có outline để lưu', 'error'); return; }

  console.log('[saveOutlineOnly] keyword:', keyword, 'outline_length:', outlineToSave.length, 'from_pipeline:', !!p);

  try {
    const saveRes = await api('/api/articles', { method: 'POST', body: JSON.stringify({
      keyword, field, company, style,
      extra_keywords: extra, reference_info: reference,
      intent_data: intentData,
      outline: outlineToSave,
      outline_status: 'approved', article: null,
      status: 'outline_only',
      topic_id: topicId, review_mode: reviewMode
    })});
    const sr = await saveRes.json();
    if (saveRes.ok && sr.success) {
      showToast(`✅ Đã lưu outline '${keyword}' vào kho`, 'success');
      // If viewing a pipeline, remove it from sidebar since outline is saved
      if (viewId) {
        PipelineManager.pipelines = PipelineManager.pipelines.filter(pp => pp.id !== viewId);
        PipelineManager.viewingId = null;
        $('pipeline-view-banner').classList.add('hidden');
        renderSidebar();
      }
      resetPipeline();
    } else {
      showToast('Lỗi lưu: ' + (sr.error || `HTTP ${saveRes.status}`), 'error');
    }
  } catch (e) { showToast('Lỗi lưu: ' + e.message, 'error'); }
}

// ═══════ BATCH MODE ═══════
// (Moved to batch.js — 4-phase system)
function updateBatchKwCount() {
  const kws = $('b-keywords').value.split('\n').filter(k => k.trim());
  $('b-kw-count').textContent = kws.length > 0 ? kws.length + ' keywords' : '';
}

// ═══════ HISTORY ═══════
let selectedOutlineIds = new Set();
let historyWriteQueue = []; // Queue for sequential single writing

async function loadHistory(page = 1) {
  try {
    const search = $('h-search')?.value || '';
    const statusFilter = $('h-status-filter')?.value || '';
    let qs = `page=${page}&limit=15&search=${encodeURIComponent(search)}`;
    if (statusFilter) qs += `&status=${statusFilter}`;
    const res = await api(`/api/articles?${qs}`);
    const data = await res.json();
    const articles = data.articles || [];
    const hasOutlines = articles.some(a => a.status === 'outline_only');
    
    // Show/hide "select all" checkbox — use ONLY classList, remove conflicting inline style
    const selectAllWrap = $('h-select-all-wrap');
    selectAllWrap.removeAttribute('style'); // Clear inline display:none from HTML
    if (hasOutlines) {
      selectAllWrap.classList.remove('hidden');
      selectAllWrap.style.cssText = 'display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;cursor:pointer;font-size:.875rem;padding:.5rem .75rem;background:var(--surface2);border-radius:8px;border:1px solid var(--border)';
    } else {
      selectAllWrap.classList.add('hidden');
    }
    
    // Update select-all checkbox state
    const outlineIds = articles.filter(a => a.status === 'outline_only').map(a => a.id);
    const allSelected = outlineIds.length > 0 && outlineIds.every(id => selectedOutlineIds.has(id));
    const selectAllCb = $('h-select-all');
    if (selectAllCb) selectAllCb.checked = allSelected;
    
    const offset = ((data.page || 1) - 1) * 15;
    $('history-table').innerHTML = articles.map((a, idx) => {
      const rowNum = offset + idx + 1;
      const statusBadge = a.status === 'outline_only' ? '<span class="badge badge-warning">📝 Outline</span>'
        : a.status === 'published' ? '<span class="badge badge-success">✅ Đã xuất bản</span>'
        : '<span class="badge badge-info">📄 Bản nháp</span>';
      
      // Checkbox only for outline_only status
      let checkboxCell = '<td></td>';
      if (a.status === 'outline_only') {
        const checked = selectedOutlineIds.has(a.id) ? 'checked' : '';
        checkboxCell = `<td><input type="checkbox" class="h-outline-cb" data-id="${a.id}" ${checked} onchange="historyToggleOne(${a.id}, this.checked)"></td>`;
      }
      
      let actions = '';
      if (a.status === 'outline_only') {
        actions = `<button class="btn btn-sm btn-secondary" onclick="viewOutline(${a.id})">👁 Outline</button>
          <button class="btn btn-sm btn-primary" onclick="writeFromOutline(${a.id})">✍ Viết bài</button>
          <button class="btn btn-sm btn-secondary" onclick="copyOutline(${a.id})"><i class="fas fa-copy"></i></button>`;
      } else {
        actions = `<button class="btn btn-sm btn-secondary" onclick="viewArticle(${a.id})">Xem</button>`;
        if (a.outline) actions += ` <button class="btn btn-sm btn-secondary" onclick="viewOutline(${a.id})" title="Xem outline">📝</button>`;
      }
      actions += ` <button class="btn btn-sm btn-danger" onclick="deleteArticle(${a.id})"><i class="fas fa-trash"></i></button>`;
      return `<tr>
        ${checkboxCell}
        <td>${rowNum}</td>
        <td><strong>${a.keyword || '—'}</strong></td>
        <td>${statusBadge}</td>
        <td>${new Date(a.created_at).toLocaleDateString('vi')}</td>
        <td>${actions}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text2)">Chưa có bài viết</td></tr>';
    let pgHtml = '';
    for (let i = 1; i <= data.totalPages; i++) pgHtml += `<button class="btn btn-sm ${i === data.page ? 'btn-primary' : 'btn-secondary'}" onclick="loadHistory(${i})">${i}</button>`;
    $('history-pagination').innerHTML = pgHtml;
    
    historyUpdateActionBar();
  } catch (e) { console.error('loadHistory error:', e); }
}

function historyToggleOne(id, checked) {
  if (checked) selectedOutlineIds.add(id);
  else selectedOutlineIds.delete(id);
  
  // Update select-all checkbox
  const allCbs = document.querySelectorAll('.h-outline-cb');
  const allChecked = allCbs.length > 0 && [...allCbs].every(cb => cb.checked);
  const selectAllCb = $('h-select-all');
  if (selectAllCb) selectAllCb.checked = allChecked;
  
  historyUpdateActionBar();
}

function historyToggleSelectAll(checked) {
  const cbs = document.querySelectorAll('.h-outline-cb');
  cbs.forEach(cb => {
    cb.checked = checked;
    const id = +cb.dataset.id;
    if (checked) selectedOutlineIds.add(id);
    else selectedOutlineIds.delete(id);
  });
  historyUpdateActionBar();
}

function historyUpdateActionBar() {
  const count = selectedOutlineIds.size;
  const actionBar = $('history-action-bar');
  if (count > 0) {
    actionBar.classList.remove('hidden');
    $('history-selected-count').textContent = `Đã chọn: ${count} outline`;
  } else {
    actionBar.classList.add('hidden');
  }
}

// ═══════ WRITE FROM OUTLINE — BACKGROUND PIPELINE (Option A: all simultaneous) ═══════
async function historyWriteSingleSequential() {
  const ids = [...selectedOutlineIds];
  if (ids.length === 0) return showToast('Chưa chọn outline nào', 'error');
  
  selectedOutlineIds.clear();
  historyUpdateActionBar();
  
  // Create ALL pipelines simultaneously (Option A)
  let created = 0;
  for (const id of ids) {
    try {
      const res = await api('/api/articles/' + id);
      const a = await res.json();
      const launched = launchOutlinePipeline(a);
      if (launched) created++;
    } catch (e) {
      showToast(`Lỗi tải outline #${id}: ${e.message}`, 'error');
    }
  }
  
  if (created > 0) {
    showToast(`🚀 Đã tạo ${created} pipeline chạy ngầm! Xem sidebar →`, 'success');
    loadHistory(); // Refresh history
  }
}

// Launch a single outline as a background pipeline in the sidebar
function launchOutlinePipeline(articleData) {
  const a = articleData;
  const keyword = a.keyword || 'Không có keyword';
  
  // Create pipeline via PipelineManager
  const p = PipelineManager.create(keyword, 'single');
  if (!p) return false; // Max pipeline limit reached
  
  // Parse intent data
  let intentData = a.intent_data;
  if (typeof intentData === 'string') {
    try { intentData = JSON.parse(intentData || '{}'); } catch { intentData = {}; }
  }
  
  // Set pipeline state — outline is already approved, skip Steps 1-4
  p.state.intentData = intentData || {};
  p.state.outline = a.outline || '';
  p.state.approvedOutline = a.outline || '';
  p.state.articleId = a.id;
  
  // Set pipeline config from saved article data
  p.config = {
    keyword: a.keyword || '',
    field: a.field || '',
    company: a.company || '',
    style: a.style || '',
    extra: a.extra_keywords || '',
    reference: a.reference_info || '',
    reviewMode: 'auto', // Skip review — outline already approved
    enableImages: false, // No images by default for outline→article
    enableLinks: false,
    intentBot: $('s-intentBot')?.value || '',
    outlineBot: $('s-outlineBot')?.value || '',
    evalBot: $('s-evalBot')?.value || '',
    articleBot: $('s-articleBot')?.value || '',
    imageBot: $('s-imageBot')?.value || '',
    topicId: a.topic_id || null,
    internalLinks: []
  };
  
  // Start from Step 5 directly (article writing)
  p.currentStep = 5;
  p.stepLabel = 'Đang viết bài (Step 5/7)';
  PipelineManager.update(p.id);
  
  // Launch async — pipeline runs independently in background
  resumePipelineFromReview(p.id);
  
  return true;
}

// ═══════ WRITE BATCH (from selected outlines — background pipelines) ═══════
async function historyWriteBatch() {
  const ids = [...selectedOutlineIds];
  if (ids.length === 0) return showToast('Chưa chọn outline nào', 'error');
  
  selectedOutlineIds.clear();
  historyUpdateActionBar();
  
  // Fetch all outline data and launch as background pipelines
  showToast(`📦 Đang tải ${ids.length} outline...`, 'info');
  let created = 0;
  for (const id of ids) {
    try {
      const res = await api('/api/articles/' + id);
      const a = await res.json();
      const launched = launchOutlinePipeline(a);
      if (launched) created++;
    } catch (e) {
      showToast(`Lỗi tải outline #${id}: ${e.message}`, 'error');
    }
  }
  
  if (created > 0) {
    showToast(`🚀 Đã tạo ${created} pipeline chạy ngầm! Xem sidebar →`, 'success');
    loadHistory(); // Refresh history
  } else {
    showToast('Không tạo được pipeline nào (tối đa 5 đồng thời)', 'error');
  }
}

// ═══════ DELETE SELECTED OUTLINES ═══════
async function historyDeleteSelected() {
  const ids = [...selectedOutlineIds];
  if (ids.length === 0) return showToast('Chưa chọn outline nào', 'error');
  
  showModal('Xác nhận xóa', 
    `<p>Bạn có chắc muốn xóa <strong>${ids.length}</strong> outline đã chọn?</p><p style="color:var(--error);font-size:.875rem">⚠ Hành động này không thể hoàn tác.</p>`,
    [{ text: `🗑 Xóa ${ids.length} outline`, cls: 'btn-danger', fn: `async function(){
      const ids = [${ids.join(',')}];
      for (const id of ids) {
        try { await fetch('/api/articles/'+id, {method:'DELETE', headers:{Authorization:'Bearer '+token}}); } catch {}
      }
      selectedOutlineIds.clear();
      historyUpdateActionBar();
      loadHistory();
      showToast('Đã xóa '+ids.length+' outline', 'success');
    }` }]
  );
}

async function viewArticle(id) {
  try {
    const res = await api('/api/articles/' + id);
    const a = await res.json();
    const content = a.article || a.outline || 'Không có nội dung';
    showModal(a.keyword || 'Bài viết', `<div class="md-preview" style="max-height:60vh;overflow-y:auto">${marked.parse(content)}</div>`);
  } catch (e) { showToast('Lỗi mở bài viết: ' + e.message, 'error'); }
}

async function viewOutline(id) {
  try {
    const res = await api('/api/articles/' + id);
    if (!res.ok) { showToast('Lỗi tải outline: HTTP ' + res.status, 'error'); return; }
    const a = await res.json();
    const outlineContent = a.outline || '';
    if (!outlineContent) {
      showModal('Dàn ý: ' + (a.keyword || ''), '<div style="padding:2rem;text-align:center;color:var(--text2)"><i class="fas fa-exclamation-circle" style="font-size:2rem;margin-bottom:.5rem;display:block"></i>Outline chưa được lưu hoặc đã bị xóa.</div>');
      return;
    }
    showModal('Dàn ý: ' + (a.keyword || ''), `<div class="md-preview" style="max-height:60vh;overflow-y:auto">${marked.parse(outlineContent)}</div>`);
  } catch (e) { showToast('Lỗi mở outline: ' + e.message, 'error'); }
}

async function copyOutline(id) {
  try {
    const res = await api('/api/articles/' + id);
    const a = await res.json();
    navigator.clipboard.writeText(a.outline || '').then(() => showToast('Đã copy outline!', 'success'));
  } catch {}
}

async function writeFromOutline(id) {
  try {
    const res = await api('/api/articles/' + id);
    const a = await res.json();
    // Launch as background pipeline — user can keep working
    const launched = launchOutlinePipeline(a);
    if (launched) {
      showToast(`🚀 Pipeline "${a.keyword}" đang chạy ngầm! Xem sidebar →`, 'success');
      loadHistory(); // Refresh history
    }
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

async function deleteArticle(id) {
  showModal('Xác nhận', 'Bạn có chắc muốn xóa bài viết này?', [
    { text: 'Xóa', cls: 'btn-danger', fn: `async function(){await fetch('/api/articles/${id}',{method:'DELETE',headers:{Authorization:'Bearer '+token}});loadHistory()}` }
  ]);
}

// ═══════ ADMIN ═══════
async function switchAdminTab(tab) {
  document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
  event?.target?.classList?.add('active');
  const el = $('admin-content');

  if (tab === 'stats') {
    try {
      const res = await api('/api/admin/stats');
      const d = await res.json();
      el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem">
        <div class="card" style="text-align:center"><div style="font-size:2rem;font-weight:700;color:var(--accent)">${d.total_articles}</div><div style="color:var(--text2)">Tổng bài viết</div></div>
        <div class="card" style="text-align:center"><div style="font-size:2rem;font-weight:700;color:var(--success)">${d.articles_today}</div><div style="color:var(--text2)">Bài hôm nay</div></div>
        <div class="card" style="text-align:center"><div style="font-size:2rem;font-weight:700;color:var(--info)">${d.total_users}</div><div style="color:var(--text2)">Users</div></div>
        <div class="card" style="text-align:center"><div style="font-size:2rem;font-weight:700">${d.api_keys?.length || 0}</div><div style="color:var(--text2)">API Keys</div></div>
      </div>`;
    } catch { el.innerHTML = '<p>Lỗi tải thống kê</p>'; }
  } else if (tab === 'users') {
    try {
      const res = await api('/api/admin/users');
      const d = await res.json();
      el.innerHTML = `<div class="card"><button class="btn btn-sm btn-primary" onclick="showAddUserModal()" style="margin-bottom:1rem"><i class="fas fa-plus"></i> Thêm user</button>
        <table class="data-table"><thead><tr><th>Username</th><th>Role</th><th>Plan</th><th>Quota</th><th></th></tr></thead><tbody>
        ${(d.users||[]).map(u=>`<tr><td><strong>${u.username}</strong><br><small>${u.display_name}</small></td><td><span class="badge ${u.role==='admin'?'badge-error':'badge-info'}">${u.role}</span></td><td>${u.plan}</td><td>${u.quota_used_today}/${u.quota_daily}</td><td><button class="btn btn-sm btn-secondary" onclick="editUser(${u.id})">Sửa</button></td></tr>`).join('')}
        </tbody></table></div>`;
    } catch { el.innerHTML = '<p>Lỗi</p>'; }
  } else if (tab === 'apikeys') {
    try {
      const res = await api('/api/admin/api-keys');
      const d = await res.json();
      el.innerHTML = `<div class="card"><h3 style="margin-bottom:1rem">🔑 Quản lý API Keys</h3>
        <p style="color:var(--text2);font-size:.85rem;margin-bottom:1rem">API sẽ tự động xoay vòng: nếu key đang dùng hết tín dụng (402/403), app sẽ tự chuyển sang key tiếp theo theo thứ tự Priority.</p>
        <button class="btn btn-sm btn-primary" onclick="showAddKeyModal()" style="margin-bottom:1rem"><i class="fas fa-plus"></i> Thêm key</button>
        <table class="data-table"><thead><tr><th>Tên</th><th>Key</th><th>Priority</th><th>Trạng thái</th><th>Calls</th><th>Lỗi gần nhất</th><th>Hành động</th></tr></thead><tbody>
        ${(d.keys||[]).map(k=>{
          const statusBadge = k.is_active 
            ? '<span class="badge badge-success">✅ Active</span>' 
            : '<span class="badge badge-error">❌ Tắt</span>';
          const toggleBtn = k.is_active
            ? `<button class="btn btn-sm btn-secondary" onclick="toggleApiKey(${k.id},0)" title="Tắt key này">⏸ Tắt</button>`
            : `<button class="btn btn-sm btn-primary" onclick="toggleApiKey(${k.id},1)" title="Bật lại key này">▶ Bật</button>`;
          return `<tr style="${!k.is_active?'opacity:.6':''}">
            <td><strong>${k.key_name}</strong></td>
            <td><code style="font-size:.75rem">${k.masked_key}</code></td>
            <td>${k.priority}</td>
            <td>${statusBadge}</td>
            <td>${k.usage_count}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.75rem;color:var(--error)" title="${(k.last_error||'').replace(/"/g,'&quot;')}">${k.last_error||'—'}</td>
            <td style="white-space:nowrap">${toggleBtn} <button class="btn btn-sm btn-danger" onclick="deleteApiKey(${k.id},'${k.key_name.replace(/'/g,"\\'")}')"><i class="fas fa-trash"></i></button></td>
          </tr>`;
        }).join('')}
        </tbody></table></div>`;
    } catch { el.innerHTML = '<p>Lỗi</p>'; }
  } else if (tab === 'prompts') {
    try {
      const res = await api('/api/admin/prompts');
      const d = await res.json();
      // Helper to escape HTML in textarea default values
      const esc = (s) => (s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      el.innerHTML = `<div class="card"><h3 style="margin-bottom:1rem">Prompt Templates</h3>
        <p style="color:var(--text2);font-size:.85rem;margin-bottom:1rem">💡 Dùng <code>{keywords}</code>, <code>{field}</code>, <code>{company}</code>, <code>{style}</code>, <code>{intent_data}</code>, <code>{outline}</code>, <code>{review_feedback}</code>, <code>{extra_keywords}</code>, <code>{reference_info}</code>, <code>{file_content}</code>, <code>{internal_links}</code>, <code>{user_notes}</code>, <code>{heading}</code>, <code>{paragraph_content}</code> làm biến.<br>Điều kiện: <code>{Nếu có company: "Công ty: {company}"}</code> — sẽ bị xóa nếu biến trống.</p>
        <div class="form-group"><label>Prompt phân tích ý định (Step 2 — intent)</label><textarea id="p-intent_prompt" rows="8">${esc(d.intent_prompt)}</textarea></div>
        <div class="form-group"><label>Prompt dàn ý (Step 3 — outline)</label><textarea id="p-outline_prompt" rows="10">${esc(d.outline_prompt)}</textarea></div>
        <div class="form-group"><label>Prompt đánh giá (Step 4 — eval)</label><textarea id="p-eval_prompt" rows="8">${esc(d.eval_prompt)}</textarea></div>
        <div class="form-group"><label>Prompt tạo lại outline (Step 4 — regenerate)</label><textarea id="p-regenerate_prompt" rows="10">${esc(d.regenerate_prompt)}</textarea></div>
        <div class="form-group"><label>Prompt viết bài (Step 5 — article)</label><textarea id="p-article_prompt" rows="10">${esc(d.article_prompt)}</textarea></div>
        <div class="form-group"><label>Prompt ngữ cảnh ảnh (Step 6 — image_context)</label><textarea id="p-image_context_prompt" rows="8">${esc(d.image_context_prompt)}</textarea></div>
        <button class="btn btn-primary" onclick="savePrompts()"><i class="fas fa-save"></i> Lưu tất cả</button></div>`;
    } catch { el.innerHTML = '<p>Lỗi</p>'; }
  } else if (tab === 'topics') {
    try {
      const res = await api('/api/topics');
      const d = await res.json();
      el.innerHTML = `<div class="card"><div style="display:flex;gap:.5rem;margin-bottom:1rem"><input id="new-topic" placeholder="Tên topic mới" style="flex:1;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--surface)"><button class="btn btn-sm btn-primary" onclick="addTopic()"><i class="fas fa-plus"></i></button></div>
        <table class="data-table"><thead><tr><th>Tên</th><th>Slug</th><th></th></tr></thead><tbody>
        ${(d.topics||[]).map(t=>`<tr><td>${t.name}</td><td><code>${t.slug}</code></td><td><button class="btn btn-sm btn-danger" onclick="deleteTopic(${t.id})"><i class="fas fa-trash"></i></button></td></tr>`).join('')}
        </tbody></table></div>`;
    } catch { el.innerHTML = '<p>Lỗi</p>'; }
  } else if (tab === 'urls') {
    try {
      const res = await api('/api/urls');
      const d = await res.json();
      el.innerHTML = `<div class="card"><button class="btn btn-sm btn-primary" onclick="showAddUrlModal()" style="margin-bottom:1rem"><i class="fas fa-plus"></i> Thêm URL</button>
        <table class="data-table"><thead><tr><th>URL</th><th>Title</th><th>Priority</th></tr></thead><tbody>
        ${(d.urls||[]).map(u=>`<tr><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis"><a href="${u.url}" target="_blank">${u.url}</a></td><td>${u.title||'—'}</td><td>${u.is_priority?'⭐':'—'}</td></tr>`).join('')}
        </tbody></table></div>`;
    } catch { el.innerHTML = '<p>Lỗi</p>'; }
  } else if (tab === 'wp') {
    try {
      const res = await api('/api/wp/configs');
      const d = await res.json();
      el.innerHTML = `<div class="card"><button class="btn btn-sm btn-primary" onclick="showAddWpModal()" style="margin-bottom:1rem"><i class="fas fa-plus"></i> Thêm WP Site</button>
        <table class="data-table"><thead><tr><th>Tên</th><th>URL</th><th>Mặc định</th><th></th></tr></thead><tbody>
        ${(d.configs||[]).map(c=>`<tr><td>${c.site_name}</td><td>${c.site_url}</td><td>${c.is_default?'✓':'—'}</td><td><button class="btn btn-sm btn-secondary" onclick="testWp(${c.id})">Test</button></td></tr>`).join('')}
        </tbody></table></div>`;
    } catch { el.innerHTML = '<p>Lỗi</p>'; }
  } else if (tab === 'bots') {
    try {
      const res = await api('/api/bot-configs/all');
      const d = await res.json();
      const stepLabels = { intent: 'Phân tích', outline: 'Dàn ý', eval: 'Đánh giá', article: 'Viết bài', image_prompt: 'Prompt ảnh', image: 'Ảnh' };
      const steps = ['intent', 'outline', 'eval', 'article', 'image_prompt', 'image'];

      function renderBotsAdmin(step) {
        const bots = (d.bots || []).filter(b => b.step_type === step);
        const tabBtns = steps.map(s => `<button class="btn btn-sm ${s === step ? 'btn-primary' : 'btn-secondary'}" onclick="window._renderBotsStep_('${s}')">${stepLabels[s]}</button>`).join(' ');
        const rows = bots.map((b, i) => `<tr>
          <td>${i + 1}</td>
          <td>${b.display_name || b.bot_name}</td>
          <td><code>${b.bot_name}</code></td>
          <td>${b.is_default ? '⭐' : '—'}</td>
          <td>${b.sort_order}</td>
          <td><span class="badge ${b.is_active ? 'badge-success' : 'badge-error'}">${b.is_active ? '✅ Active' : '❌ Ẩn'}</span></td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="editBotConfig(${b.id},'${b.step_type}','${b.bot_name.replace(/'/g,"\\'")}','${(b.display_name||'').replace(/'/g,"\\'")}',${b.sort_order},${b.is_default},${b.is_active})">Sửa</button>
            ${!b.is_default ? `<button class="btn btn-sm btn-secondary" onclick="setDefaultBot(${b.id},'${b.step_type}')">⭐</button>` : ''}
            <button class="btn btn-sm btn-secondary" onclick="toggleBotActive(${b.id},${b.is_active?0:1},'${b.step_type}')">${b.is_active ? 'Ẩn' : 'Hiện'}</button>
            <button class="btn btn-sm btn-danger" onclick="deleteBotConfig(${b.id},'${b.step_type}')"><i class="fas fa-trash"></i></button>
          </td>
        </tr>`).join('');
        el.innerHTML = `<div class="card"><h3 style="margin-bottom:1rem">Quản lý Model AI</h3>
          <div style="display:flex;gap:.5rem;margin-bottom:1rem;flex-wrap:wrap">${tabBtns}</div>
          <table class="data-table"><thead><tr><th>#</th><th>Tên hiển thị</th><th>Tên API</th><th>Mặc định</th><th>Thứ tự</th><th>Trạng thái</th><th></th></tr></thead><tbody>${rows}</tbody></table>
          <button class="btn btn-sm btn-primary" onclick="showAddBotModal('${step}')" style="margin-top:1rem"><i class="fas fa-plus"></i> Thêm model mới</button>
        </div>`;
      }
      window._renderBotsStep_ = function(step) {
        api('/api/bot-configs/all').then(r => r.json()).then(d2 => { d.bots = d2.bots; renderBotsAdmin(step); });
      };
      renderBotsAdmin('intent');
    } catch { el.innerHTML = '<p>Lỗi tải bot configs</p>'; }
  }
}

// Admin actions
function showAddUserModal() {
  showModal('Thêm user', `
    <div class="form-group"><label>Username</label><input id="mu-user"></div>
    <div class="form-group"><label>Password</label><input id="mu-pass" type="password"></div>
    <div class="form-group"><label>Tên hiển thị</label><input id="mu-name"></div>
    <div class="form-group"><label>Role</label><select id="mu-role"><option>user</option><option>admin</option></select></div>
    <div class="form-group"><label>Plan</label><select id="mu-plan"><option>free</option><option>basic</option><option>pro</option><option>enterprise</option></select></div>
  `, [{ text: 'Tạo', cls: 'btn-primary', fn: `async function(){
    await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({username:document.getElementById('mu-user').value,password:document.getElementById('mu-pass').value,display_name:document.getElementById('mu-name').value,role:document.getElementById('mu-role').value,plan:document.getElementById('mu-plan').value})});
    switchAdminTab('users')}` }]);
}

function showAddKeyModal() {
  showModal('Thêm API Key', `
    <div class="form-group"><label>Tên</label><input id="mk-name"></div>
    <div class="form-group"><label>API Key</label><input id="mk-key"></div>
    <div class="form-group"><label>Priority</label><input id="mk-pri" type="number" value="1"></div>
  `, [{ text: 'Thêm', cls: 'btn-primary', fn: `async function(){
    await fetch('/api/admin/api-keys',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({key_name:document.getElementById('mk-name').value,api_key:document.getElementById('mk-key').value,priority:+document.getElementById('mk-pri').value})});
    switchAdminTab('apikeys')}` }]);
}

async function toggleApiKey(id, newState) {
  try {
    await api('/api/admin/api-keys/' + id, { method: 'PUT', body: JSON.stringify({ is_active: !!newState }) });
    showToast(newState ? 'Đã bật API key!' : 'Đã tắt API key!', 'success');
    switchAdminTab('apikeys');
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

function deleteApiKey(id, name) {
  showModal('Xóa API Key', `<p>Bạn có chắc muốn xóa key "<strong>${name}</strong>"?</p><p style="color:var(--error);font-size:.85rem">⚠ Không thể hoàn tác</p>`, [
    { text: '🗑 Xóa', cls: 'btn-danger', fn: `async function(){
      await fetch('/api/admin/api-keys/${id}',{method:'DELETE',headers:{Authorization:'Bearer '+token}});
      showToast('Đã xóa API key!','success');
      switchAdminTab('apikeys');
    }` }
  ]);
}

async function savePrompts() {
  const keys = ['intent_prompt', 'outline_prompt', 'eval_prompt', 'regenerate_prompt', 'article_prompt', 'image_context_prompt'];
  const body = {};
  for (const key of keys) {
    const el = $('p-' + key);
    if (el) body[key] = el.value;
  }
  await api('/api/admin/prompts', { method: 'PUT', body: JSON.stringify(body) });
  // Refetch templates so frontend uses updated prompts immediately
  await loadPromptTemplates();
  showToast('Đã lưu prompts!', 'success');
}

async function addTopic() {
  const name = $('new-topic').value.trim();
  if (!name) return;
  await api('/api/topics', { method: 'POST', body: JSON.stringify({ name }) });
  switchAdminTab('topics');
  loadTopics();
}

async function deleteTopic(id) {
  await api('/api/topics/' + id, { method: 'DELETE' });
  switchAdminTab('topics');
  loadTopics();
}

async function testWp(id) {
  const res = await api('/api/wp/configs/' + id + '/test', { method: 'POST' });
  const d = await res.json();
  showToast(d.success ? 'Kết nối thành công!' : 'Lỗi: ' + d.error, d.success ? 'success' : 'error');
}

function showAddWpModal() {
  showModal('Thêm WordPress Site', `
    <div class="form-group"><label>Tên site</label><input id="mw-name"></div>
    <div class="form-group"><label>URL (https://...)</label><input id="mw-url"></div>
    <div class="form-group"><label>Username</label><input id="mw-user"></div>
    <div class="form-group"><label>Application Password</label><input id="mw-pass"></div>
  `, [{ text: 'Thêm', cls: 'btn-primary', fn: `async function(){
    await fetch('/api/wp/configs',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({site_name:document.getElementById('mw-name').value,site_url:document.getElementById('mw-url').value,username:document.getElementById('mw-user').value,app_password:document.getElementById('mw-pass').value})});
    switchAdminTab('wp')}` }]);
}

function showAddUrlModal() {
  showModal('Thêm URL', `
    <div class="form-group"><label>URL</label><input id="mx-url"></div>
    <div class="form-group"><label>Title</label><input id="mx-title"></div>
    <div class="form-group"><label>Keyword</label><input id="mx-kw"></div>
  `, [{ text: 'Thêm', cls: 'btn-primary', fn: `async function(){
    await fetch('/api/urls',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({url:document.getElementById('mx-url').value,title:document.getElementById('mx-title').value,keyword:document.getElementById('mx-kw').value})});
    switchAdminTab('urls')}` }]);
}

// ═══════ BOT CONFIG ADMIN ACTIONS ═══════
function showAddBotModal(stepType) {
  const stepLabels = { intent: 'Phân tích', outline: 'Dàn ý', eval: 'Đánh giá', article: 'Viết bài', image: 'Ảnh' };
  showModal('Thêm Model AI', `
    <div class="form-group"><label>Bước</label><select id="mb-step">${Object.entries(stepLabels).map(([k,v]) => `<option value="${k}" ${k===stepType?'selected':''}>${v}</option>`).join('')}</select></div>
    <div class="form-group"><label>Tên API * (chính xác, case-sensitive)</label><input id="mb-name" placeholder="VD: Gemini-3.1-Pro"></div>
    <div class="form-group"><label>Tên hiển thị</label><input id="mb-display" placeholder="VD: Gemini 3.1 Pro (nhanh)"></div>
    <div class="form-group"><label>Thứ tự</label><input id="mb-order" type="number" value="1"></div>
    <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer"><input type="checkbox" id="mb-default"> Đặt làm mặc định</label>
  `, [{ text: 'Lưu', cls: 'btn-primary', fn: `async function(){
    await fetch('/api/admin/bot-configs',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({step_type:document.getElementById('mb-step').value,bot_name:document.getElementById('mb-name').value,display_name:document.getElementById('mb-display').value,sort_order:+document.getElementById('mb-order').value,is_default:document.getElementById('mb-default').checked})});
    switchAdminTab('bots')}` }]);
}

function editBotConfig(id, stepType, botName, displayName, sortOrder, isDefault, isActive) {
  const stepLabels = { intent: 'Phân tích', outline: 'Dàn ý', eval: 'Đánh giá', article: 'Viết bài', image: 'Ảnh' };
  showModal('Sửa Model AI', `
    <div class="form-group"><label>Bước</label><select id="mb-step">${Object.entries(stepLabels).map(([k,v]) => `<option value="${k}" ${k===stepType?'selected':''}>${v}</option>`).join('')}</select></div>
    <div class="form-group"><label>Tên API *</label><input id="mb-name" value="${botName}"></div>
    <div class="form-group"><label>Tên hiển thị</label><input id="mb-display" value="${displayName}"></div>
    <div class="form-group"><label>Thứ tự</label><input id="mb-order" type="number" value="${sortOrder}"></div>
    <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer"><input type="checkbox" id="mb-default" ${isDefault?'checked':''}> Đặt làm mặc định</label>
  `, [{ text: 'Lưu', cls: 'btn-primary', fn: `async function(){
    await fetch('/api/admin/bot-configs/${id}',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({step_type:document.getElementById('mb-step').value,bot_name:document.getElementById('mb-name').value,display_name:document.getElementById('mb-display').value,sort_order:+document.getElementById('mb-order').value,is_default:document.getElementById('mb-default').checked})});
    switchAdminTab('bots')}` }]);
}

async function setDefaultBot(id, stepType) {
  await api('/api/admin/bot-configs/' + id, { method: 'PUT', body: JSON.stringify({ is_default: true }) });
  showToast('Đã đặt mặc định!', 'success');
  switchAdminTab('bots');
}

async function toggleBotActive(id, newState, stepType) {
  await api('/api/admin/bot-configs/' + id, { method: 'PUT', body: JSON.stringify({ is_active: !!newState }) });
  switchAdminTab('bots');
}

async function deleteBotConfig(id, stepType) {
  if (!confirm('Xóa model này?')) return;
  await api('/api/admin/bot-configs/' + id, { method: 'DELETE' });
  showToast('Đã xóa!', 'success');
  switchAdminTab('bots');
}

// ═══════ BOT DROPDOWN LOADER ═══════
async function loadBotDropdowns() {
  try {
    const res = await api('/api/bot-configs');
    const data = await res.json();
    const bots = data.bots || [];
    const stepMap = { intent: 'intentBot', outline: 'outlineBot', eval: 'evalBot', article: 'articleBot', image_prompt: 'imagePromptBot', image: 'imageBot' };
    for (const [step, suffix] of Object.entries(stepMap)) {
      const stepBots = bots.filter(b => b.step_type === step);
      const opts = stepBots.map(b => `<option value="${b.bot_name}" ${b.is_default ? 'selected' : ''}>${b.display_name || b.bot_name}</option>`).join('');
      const sEl = $('s-' + suffix); if (sEl) sEl.innerHTML = opts;
      const bEl = $('b-' + suffix); if (bEl) bEl.innerHTML = opts;
    }
  } catch (e) { console.error('Failed to load bot configs:', e); }
}

// ═══════ INTERNAL LINKS MANAGEMENT ═══════
async function loadInternalLinks() {
  try {
    const res = await api('/api/urls');
    const data = await res.json();
    const urls = data.urls || [];
    const renderList = (containerId) => {
      const el = $(containerId);
      if (!el) return;
      if (urls.length === 0) { el.innerHTML = '<p style="color:var(--text2);font-size:.85rem;text-align:center;padding:.5rem">Chưa có URL nào</p>'; return; }
      el.innerHTML = urls.map(u => `<div style="display:flex;align-items:center;gap:.5rem;padding:.375rem .25rem;border-bottom:1px solid var(--border);font-size:.85rem">
        <span style="flex-shrink:0">${u.is_priority ? '⭐' : '  '}</span>
        <a href="${u.url}" target="_blank" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--accent)" title="${u.url}">${u.url}</a>
        <span style="color:var(--text2);flex-shrink:0;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u.title || ''}</span>
        <button class="btn btn-sm btn-danger" onclick="removeUrl(${u.id})" style="flex-shrink:0;padding:.125rem .375rem;font-size:.7rem" title="Xóa">✕</button>
      </div>`).join('');
    };
    renderList('s-urls-list');
    renderList('b-urls-list');
  } catch (e) { console.error('Failed to load URLs:', e); }
}

async function addSingleUrl(prefix) {
  const url = $(prefix + '-new-url').value.trim();
  const title = $(prefix + '-new-url-title').value.trim();
  if (!url || !title) { showToast('Cần nhập URL và Tiêu đề', 'error'); return; }
  const kw = $(prefix + '-new-url-kw').value.trim();
  const priority = $(prefix + '-new-url-priority').checked;
  try {
    await api('/api/urls', { method: 'POST', body: JSON.stringify({ url, title, keyword: kw, is_priority: priority }) });
    $(prefix + '-new-url').value = ''; $(prefix + '-new-url-title').value = ''; $(prefix + '-new-url-kw').value = '';
    $(prefix + '-new-url-priority').checked = false;
    showToast('Đã thêm URL!', 'success');
    loadInternalLinks();
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

async function addBulkUrls(prefix) {
  const text = $(prefix + '-bulk-urls').value.trim();
  if (!text) return;
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const urls = lines.map(l => {
    const parts = l.split('|').map(p => p.trim());
    return { url: parts[0], title: parts[1] || parts[0] };
  }).filter(u => u.url);
  if (urls.length === 0) { showToast('Không tìm thấy URL hợp lệ', 'error'); return; }
  try {
    await api('/api/urls/bulk', { method: 'POST', body: JSON.stringify({ urls }) });
    $(prefix + '-bulk-urls').value = '';
    showToast(`Đã thêm ${urls.length} URL!`, 'success');
    loadInternalLinks();
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

async function removeUrl(id) {
  try {
    await api('/api/urls/' + id, { method: 'DELETE' });
    showToast('Đã xóa URL', 'success');
    loadInternalLinks();
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

// ═══════ PHASE 3: PIPELINE MANAGER (SIDEBAR) ═══════
const PipelineManager = {
  pipelines: [], nextId: 1, MAX: 5, MAX_CARDS: 20,
  viewingId: null,

  create(keyword, type) {
    const active = this.pipelines.filter(p => p.status === 'running' || p.status === 'paused').length;
    if (active >= this.MAX) { showToast('Tối đa ' + this.MAX + ' pipeline đồng thời', 'error'); return null; }
    const p = { id: this.nextId++, keyword, type: type || 'single', status: 'running', currentStep: 1, totalSteps: 7,
      state: { intentData:null, outline:'', approvedOutline:'', reviewFeedback:'', article:'', articleWithImages:'', images:[], articleId:null, evalHistory:[] },
      config: {}, createdAt: new Date(), error: null, stepLabel: 'Khởi tạo...' };
    this.pipelines.unshift(p);
    // Trim old completed
    const done = this.pipelines.filter(p2 => p2.status === 'done');
    if (done.length > this.MAX_CARDS) { const excess = done.slice(this.MAX_CARDS); excess.forEach(e => { this.pipelines = this.pipelines.filter(p2 => p2.id !== e.id); }); }
    renderSidebar(); return p;
  },
  getById(id) { return this.pipelines.find(p => p.id === id); },
  remove(id) {
    if (!confirm('Xóa pipeline này?')) return;
    const p = this.getById(id);
    if (p && p.status === 'running') p.status = 'cancelled';
    this.pipelines = this.pipelines.filter(p2 => p2.id !== id);
    if (this.viewingId === id) backToForm();
    renderSidebar();
  },
  update(id, label) { const p = this.getById(id); if (p && label) p.stepLabel = label; renderSidebar(); refreshPipelineView(id); }
};

function toggleSidebar() {
  const sb = $('pipeline-sidebar');
  sb.classList.toggle('open');
}

function formatTime(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  const hh = String(dt.getHours()).padStart(2,'0'), mm = String(dt.getMinutes()).padStart(2,'0'), ss = String(dt.getSeconds()).padStart(2,'0');
  const dd2 = String(dt.getDate()).padStart(2,'0'), mo = String(dt.getMonth()+1).padStart(2,'0');
  return `${hh}:${mm}:${ss} ${dd2}-${mo}-${dt.getFullYear()}`;
}

function getSortedPipelines() {
  const order = { paused: 0, running: 1, error: 2, done: 3, cancelled: 4 };
  return [...PipelineManager.pipelines].sort((a, b) => {
    const oa = order[a.status] ?? 5, ob = order[b.status] ?? 5;
    if (oa !== ob) return oa - ob;
    return (b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0);
  });
}

function renderSidebar() {
  const container = $('sidebar-cards');
  const empty = $('sidebar-empty');
  const badge = $('sidebar-badge');
  if (!container) return;
  const all = getSortedPipelines();
  const singleActiveCount = all.filter(p => p.status === 'running' || p.status === 'paused').length;

  // Count batch active too
  const batchActiveCount = (typeof batchQueue !== 'undefined') ? batchQueue.filter(b => b.status === 'running' || b.paused || b.waitingGroupReview || b.waitingManualReview).length : 0;
  const totalActive = singleActiveCount + batchActiveCount;

  // Mobile badge
  if (badge) {
    if (totalActive > 0) { badge.textContent = totalActive; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
  }

  // Get batch cards HTML
  const batchCardsHtml = (typeof renderBatchSidebarCards === 'function') ? renderBatchSidebarCards() : '';
  const hasBatch = batchCardsHtml.length > 0;

  if (all.length === 0 && !hasBatch) {
    container.innerHTML = '';
    if (empty) { empty.style.display = ''; container.appendChild(empty); }
    return;
  }
  if (empty) empty.style.display = 'none';

  // Render single pipeline cards
  const singleCardsHtml = all.map(p => {
    const pct = Math.round((p.currentStep / p.totalSteps) * 100);
    const timeStr = formatTime(p.createdAt);
    const isViewing = PipelineManager.viewingId === p.id;

    let statusIcon, statusText, statusClass, cardClass;
    switch (p.status) {
      case 'running': statusIcon = '🟢'; statusText = 'Đang chạy'; statusClass = 'pl-status-running'; cardClass = 'pl-card-running'; break;
      case 'paused': statusIcon = '🟡'; statusText = 'Chờ duyệt'; statusClass = 'pl-status-paused'; cardClass = 'pl-card-paused'; break;
      case 'done': statusIcon = '✅'; statusText = 'Hoàn thành'; statusClass = 'pl-status-done'; cardClass = 'pl-card-done'; break;
      case 'error': statusIcon = '❌'; statusText = 'Lỗi'; statusClass = 'pl-status-error'; cardClass = 'pl-card-error'; break;
      default: statusIcon = '⏹'; statusText = 'Đã hủy'; statusClass = ''; cardClass = ''; break;
    }

    const label = `"${p.keyword}"`;
    const wordCount = p.state.articleWithImages ? p.state.articleWithImages.split(/\s+/).filter(w=>w).length : 0;

    let stepInfo = `Step ${p.currentStep}/${p.totalSteps} — ${p.stepLabel}`;
    if (p.status === 'done' && wordCount) stepInfo = `${wordCount.toLocaleString()} từ`;
    if (p.status === 'error') stepInfo = `Step ${p.currentStep} — ${p.error || p.stepLabel}`;

    let actions = '';
    if (p.status === 'running') {
      actions = `<button class="btn btn-secondary" onclick="viewPipeline(${p.id})"><i class="fas fa-eye"></i> Xem chi tiết</button>`;
    } else if (p.status === 'paused') {
      actions = `<button class="btn btn-primary" onclick="viewPipeline(${p.id})"><i class="fas fa-check"></i> Duyệt outline</button>
        <button class="btn btn-secondary" onclick="viewPipeline(${p.id})"><i class="fas fa-eye"></i> Xem</button>`;
    } else if (p.status === 'done') {
      actions = `<button class="btn btn-secondary" onclick="viewPipeline(${p.id})"><i class="fas fa-eye"></i> Xem kết quả</button>
        <button class="btn btn-secondary" onclick="PipelineManager.remove(${p.id})" style="opacity:.6"><i class="fas fa-trash"></i></button>`;
    } else if (p.status === 'error') {
      actions = `<button class="btn btn-secondary" onclick="retryPipeline(${p.id})"><i class="fas fa-redo"></i> Thử lại</button>
        <button class="btn btn-secondary" onclick="PipelineManager.remove(${p.id})" style="opacity:.6"><i class="fas fa-trash"></i></button>`;
    }

    const progressBar = (p.status === 'running') ? `<div class="pl-progress"><div class="pl-progress-fill" style="width:${pct}%"></div></div>` : '';
    const viewingBorder = isViewing ? 'outline:2px solid var(--accent);outline-offset:2px;' : '';

    return `<div class="pl-card ${cardClass}" style="${viewingBorder}">
      <div class="pl-time">${statusIcon} ${timeStr}</div>
      <div class="pl-status ${statusClass}">${statusText}</div>
      <div class="pl-keyword">${label}</div>
      <div class="pl-step">${stepInfo}</div>
      ${progressBar}
      <div class="pl-actions">${actions}</div>
    </div>`;
  }).join('');

  // Combine: batch cards first, then single cards
  container.innerHTML = batchCardsHtml + singleCardsHtml;
}

function refreshPipelineView(id) {
  if (PipelineManager.viewingId !== id) return;
  const p = PipelineManager.getById(id);
  if (!p) return;
  $('pipeline-view-title').textContent = `Đang xem: "${p.keyword}" — ${p.stepLabel}`;
  // Update step content based on pipeline state
  if (p.state.intentData && p.currentStep >= 2) {
    try { $('intent-result').innerHTML = '<pre style="white-space:pre-wrap;font-size:.85rem">' + JSON.stringify(p.state.intentData, null, 2) + '</pre>'; } catch {}
  }
  if (p.state.outline && p.currentStep >= 3) {
    try { $('outline-result').innerHTML = marked.parse(p.state.outline); } catch {}
  }
  if (p.state.outline && p.currentStep >= 4) {
    try { populateOutlineEditor(p.state.approvedOutline || p.state.outline); } catch {}
  }
  if (p.state.article && p.currentStep >= 5) {
    try { $('article-result').innerHTML = marked.parse(p.state.article); } catch {}
  }
  if (p.currentStep >= 7 && p.status === 'done') {
    const fa = p.state.articleWithImages || p.state.article;
    const words = fa.split(/\s+/).filter(w => w).length;
    try {
      $('word-count-badge').textContent = words + ' từ';
      $('img-count-badge').textContent = (p.state.images?.length || 0) + ' ảnh';
      $('final-article').innerHTML = marked.parse(fa);
      $('article-edit-textarea').value = fa;
      renderImageManager();
    } catch {}
  }
  goToStep(p.currentStep);
}

function viewPipeline(id) {
  const p = PipelineManager.getById(id);
  if (!p) return;
  PipelineManager.viewingId = id;
  // Show banner
  $('pipeline-view-banner').classList.remove('hidden');
  $('pipeline-view-title').textContent = `Đang xem: "${p.keyword}" — ${p.stepLabel}`;
  // Switch to single tab view
  switchTab('single');
  // Populate state for interaction (approve, etc)
  state.intentData = p.state.intentData;
  state.outline = p.state.outline;
  state.approvedOutline = p.state.approvedOutline;
  state.article = p.state.article;
  state.articleWithImages = p.state.articleWithImages;
  state.images = p.state.images;
  state.articleId = p.state.articleId;
  state.reviewFeedback = p.state.reviewFeedback;
  // Fill form fields from pipeline config so saveOutlineOnly/approve can read them
  if (p.config) {
    $('s-keyword').value = p.config.keyword || '';
    $('s-field').value = p.config.field || '';
    $('s-company').value = p.config.company || '';
    $('s-style').value = p.config.style || '';
    $('s-extra').value = p.config.extra || '';
    $('s-reference').value = p.config.reference || '';
  }
  // If pipeline needs review, set up the review UI  
  if (p.status === 'paused' && p.currentStep === 4) {
    populateOutlineEditor(p.state.outline);
    // Show manual review controls, hide auto review
    $('review-manual').classList.remove('hidden');
    $('review-auto').classList.add('hidden');
    $('btn-start').disabled = true;
  }
  // If pipeline is done, show result + suggestions
  if (p.status === 'done') {
    const fa = p.state.articleWithImages || p.state.article;
    if (fa) {
      const words = fa.split(/\s+/).filter(w => w).length;
      try {
        $('word-count-badge').textContent = words + ' t\u1eeb';
        $('img-count-badge').textContent = (p.state.images?.length || 0) + ' \u1ea3nh';
        $('final-article').innerHTML = marked.parse(fa);
        $('article-edit-textarea').value = fa;
        renderImageManager();
      } catch {}
      // Load suggestions using pipeline's keyword/field
      loadSuggestions(p.keyword, p.config.field);
    }
  }
  refreshPipelineView(id);
}

function backToForm() {
  PipelineManager.viewingId = null;
  $('pipeline-view-banner').classList.add('hidden');
  // Reset to form mode
  resetPipeline();
}

// Override approveOutline to handle pipeline review
const _origApproveOutline = approveOutline;
approveOutline = async function() {
  const viewId = PipelineManager.viewingId;
  if (viewId) {
    const p = PipelineManager.getById(viewId);
    if (p && p.status === 'paused') {
      p.state.approvedOutline = p.state.outline;
      const notes = $('s-review-notes')?.value;
      if (notes) p.state.reviewFeedback = notes;
      p.status = 'running';
      p.stepLabel = 'Tiếp tục viết bài...';
      PipelineManager.update(viewId);
      backToForm();
      // Resume pipeline
      resumePipelineFromReview(viewId);
      return;
    }
  }
  return _origApproveOutline();
};

async function resumePipelineFromReview(id) {
  const p = PipelineManager.getById(id);
  if (!p) return;
  const cfg = p.config;
  try {
    // Save outline
    if (!p.state.articleId) {
      try {
        const sr = await api('/api/articles', { method:'POST', body:JSON.stringify({ keyword:cfg.keyword, field:cfg.field, company:cfg.company, style:cfg.style, intent_data:p.state.intentData, outline:p.state.approvedOutline, outline_status:'approved', status:'outline_only' })});
        const d = await sr.json(); if (d.id) p.state.articleId = d.id;
      } catch {}
    }
    // Step 5: Article — use template
    p.currentStep = 5; p.stepLabel = 'Đang viết bài (Step 5/7)'; PipelineManager.update(id);
    const ap = buildPrompt(promptTemplates.article_prompt, {
      keywords: cfg.keyword,
      intent_json: p.state.intentData ? JSON.stringify(p.state.intentData, null, 2) : '{}',
      outline: p.state.approvedOutline,
      review_feedback: p.state.reviewFeedback || '',
      internal_links: (cfg.enableLinks && cfg.internalLinks?.length > 0) ? formatInternalLinks(cfg.internalLinks) : '',
      context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
    });
    const ar = await api('/api/chat', { method:'POST', body:JSON.stringify({ bot:cfg.articleBot, prompt:ap, stream:false })});
    p.state.article = (await ar.json()).choices?.[0]?.message?.content || '';
    p.state.articleWithImages = p.state.article;

    // Step 6: Images — 2-step (text bot → image bot)
    if (cfg.enableImages) {
      p.currentStep = 6; p.stepLabel = 'Đang tạo ảnh (Step 6/7)'; PipelineManager.update(id);
      const secs = parseH2Sections(p.state.article);
      const isAR = ['Nano-Banana-Pro','Imagen-4-Ultra','Imagen-4-Fast'].includes(cfg.imageBot);
      const imagePromptBot = cfg.imagePromptBot || cfg.intentBot;
      const totalImgs = secs.length;
      let imgDone = 0, imgFailed = 0;
      await asyncPool(2, secs, async (s) => {
        try {
          // Step 6a: Text bot reads context → writes image prompt
          const contextPrompt = buildPrompt(promptTemplates.image_context_prompt, {
            heading: s.heading,
            paragraph_content: s.content.slice(0, 800),
            field: cfg.field,
            keywords: cfg.keyword
          });
          const ctxRes = await api('/api/chat', { method:'POST', body:JSON.stringify({ bot: imagePromptBot, prompt: contextPrompt, stream:false }) });
          let imgPromptText = (await ctxRes.json()).choices?.[0]?.message?.content?.trim() || '';
          if (imgPromptText && !imgPromptText.toLowerCase().includes('notext')) imgPromptText += ', notext';

          if (!imgPromptText) { imgFailed++; imgDone++; return; }

          // Step 6b: Image bot creates image from prompt
          const params = isAR ? { aspect_ratio:'16:9' } : { aspect:'16:9' };
          let success = false;
          for (let retry = 0; retry < 3 && !success; retry++) {
            try {
              const imgR = await api('/api/chat', { method:'POST', body:JSON.stringify({ bot:cfg.imageBot, prompt:imgPromptText, stream:false, parameters:params }) });
              const url = ((await imgR.json()).choices?.[0]?.message?.content||'').match(/https?:\/\/[^\s)]+/)?.[0];
              if (url) { p.state.images.push({ heading:s.heading, url, prompt:imgPromptText }); success = true; }
              else if (retry === 2) imgFailed++;
            } catch { if (retry === 2) imgFailed++; }
          }
        } catch { imgFailed++; }
        imgDone++;
        p.stepLabel = `Đang tạo ảnh ${imgDone}/${totalImgs} (Step 6/7)`;
        PipelineManager.update(id);
      });
      if (p.state.images.length>0) p.state.articleWithImages = insertImagesIntoArticle(p.state.article, p.state.images);
    }

    // Step 7: Save
    p.currentStep = 7; p.stepLabel = 'Đang lưu...'; PipelineManager.update(id);
    const fa = p.state.articleWithImages || p.state.article;
    const method = p.state.articleId?'PUT':'POST';
    const url = p.state.articleId?'/api/articles/'+p.state.articleId:'/api/articles';
    try { await api(url,{method,body:JSON.stringify({keyword:cfg.keyword,field:cfg.field,company:cfg.company,style:cfg.style,intent_data:p.state.intentData,outline:p.state.approvedOutline,article:fa,article_html:marked.parse(fa),images:p.state.images,word_count:fa.split(/\s+/).filter(w=>w).length,outline_status:'used',status:'draft'})}); } catch {}

    p.status = 'done'; p.stepLabel = 'Hoàn thành!';
    showToast(`✅ Bài "${cfg.keyword}" đã hoàn thành!`, 'success');
  } catch (e) {
    p.status = 'error'; p.stepLabel = 'Lỗi: ' + e.message;
    showToast(`❌ "${cfg.keyword}": ${e.message}`, 'error');
  }
  PipelineManager.update(id);
  loadQuota();
}

async function runPipelineBackground(id) {
  const p = PipelineManager.getById(id);
  if (!p) return;
  const cfg = p.config;
  try {
    // CRITICAL: Auto-save immediately to DB so it appears in History tab
    if (!p.state.articleId) {
      try {
        const sr = await api('/api/articles', { method:'POST', body:JSON.stringify({ 
          keyword:cfg.keyword, field:cfg.field, company:cfg.company, style:cfg.style, 
          intent_data:p.state.intentData, outline:'', outline_status:null, status:'outline_only',
          topic_id:cfg.topicId || null, review_mode:cfg.reviewMode
        })});
        const d = await sr.json(); if (d.id) p.state.articleId = d.id;
      } catch (e) { console.warn('Failed to pre-save article to DB', e); }
    }

    // Step 2: Intent — use template
    p.currentStep = 2; p.stepLabel = 'Ph\u00e2n t\u00edch \u00fd \u0111\u1ecbnh (Step 2/7)'; PipelineManager.update(id);
    const ip = buildPrompt(promptTemplates.intent_prompt, {
      keywords: cfg.keyword,
      context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
    });
    const ir = await api('/api/chat',{method:'POST',body:JSON.stringify({bot:cfg.intentBot,prompt:ip,stream:false})});
    try { p.state.intentData = JSON.parse(((await ir.json()).choices?.[0]?.message?.content||'{}').match(/\{[\s\S]*\}/)?.[0]||'{}'); } catch { p.state.intentData = {}; }

    // Step 3: Outline — use template
    p.currentStep = 3; p.stepLabel = 'T\u1ea1o d\u00e0n \u00fd (Step 3/7)'; PipelineManager.update(id);
    const op = buildPrompt(promptTemplates.outline_prompt, {
      keywords: cfg.keyword,
      intent_json: p.state.intentData ? JSON.stringify(p.state.intentData, null, 2) : '{}',
      context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
    });
    const or2 = await api('/api/chat',{method:'POST',body:JSON.stringify({bot:cfg.outlineBot,prompt:op,stream:false})});
    p.state.outline = (await or2.json()).choices?.[0]?.message?.content || '';

    // Step 4: Review
    p.currentStep = 4; PipelineManager.update(id);
    if (cfg.reviewMode === 'manual') {
      // PAUSE — wait for user to review
      p.status = 'paused'; p.stepLabel = 'Chờ duyệt dàn ý';
      PipelineManager.update(id);
      showToast(`⏸ Dàn ý "${cfg.keyword}" chờ duyệt`, 'info');
      return; // Pipeline pauses here. resumePipelineFromReview() will continue.
    }
    // Auto review — use template
    p.stepLabel = 'AI \u0111ang \u0111\u00e1nh gi\u00e1 (Step 4/7)'; PipelineManager.update(id);
    const ePrompt = buildPrompt(promptTemplates.eval_prompt, {
      keywords: cfg.keyword,
      intent_json: p.state.intentData ? JSON.stringify(p.state.intentData, null, 2) : '{}',
      outline: p.state.outline
    });
    const eRes = await api('/api/chat',{method:'POST',body:JSON.stringify({bot:cfg.evalBot,prompt:ePrompt,stream:false})});
    const eContent = (await eRes.json()).choices?.[0]?.message?.content || '';
    let score = 70, reason = '', evalJson = null;
    try { const j = JSON.parse(eContent.match(/\{[\s\S]*\}/)[0]); evalJson = j; score = j.overall_score ?? j.score ?? 70; reason = j.verdict || j.reason || ''; } catch {}
    if (score < 70) {
      const rp = buildPrompt(promptTemplates.regenerate_prompt, {
        keywords: cfg.keyword,
        intent_json: p.state.intentData ? JSON.stringify(p.state.intentData, null, 2) : '{}',
        original_outline: p.state.outline,
        evaluation_json: evalJson ? JSON.stringify(evalJson, null, 2) : '{}',
        context_info: buildContextInfo(cfg.field, cfg.company, cfg.style)
      });
      const rRes = await api('/api/chat',{method:'POST',body:JSON.stringify({bot:cfg.outlineBot,prompt:rp,stream:false})});
      const rRaw = (await rRes.json()).choices?.[0]?.message?.content || p.state.outline;
      // Try to extract improved_outline from JSON, fallback to raw text
      try {
        const rj = JSON.parse((rRaw.match(/\{[\s\S]*\}/) || [])[0] || '{}');
        if (rj.improved_outline?.structure) {
          const s = rj.improved_outline.structure;
          let outlineMd = `# ${rj.improved_outline.title || cfg.keyword}\n\n**Meta:** ${rj.improved_outline.meta || ''}\n\n**H1:** ${s.H1 || ''}\n\n**Intro:** ${s.intro || ''}\n\n`;
          (s.H2 || []).forEach(h => { outlineMd += `## ${h.heading}\n`; (h.notes||[]).forEach(n => (outlineMd += `- ${n}\n`)); outlineMd += '\n'; });
          outlineMd += `**Ket:** ${s.conclusion || ''}\n`;
          p.state.outline = outlineMd;
        } else { p.state.outline = rRaw; }
      } catch { p.state.outline = rRaw; }
    }
    p.state.approvedOutline = p.state.outline;
    if (reason) p.state.reviewFeedback = `AI Score: ${score}/100 \u2014 ${reason}`;

    // Continue to article writing
    await resumePipelineFromReview(id);
  } catch (e) {
    p.status = 'error'; p.stepLabel = 'Lỗi: ' + e.message;
    showToast(`❌ "${cfg.keyword}": ${e.message}`, 'error');
    PipelineManager.update(id);
  }
}

function retryPipeline(id) {
  const p = PipelineManager.getById(id);
  if (!p) return;
  p.status = 'running';
  p.currentStep = 1;
  p.stepLabel = 'Đang thử lại...';
  p.error = null;
  p.state = { intentData:null, outline:'', approvedOutline:'', reviewFeedback:'', article:'', articleWithImages:'', images:[], articleId:null, evalHistory:[] };
  renderSidebar();
  runPipelineBackground(p.id);
}

