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
function afterLoginSetup() {
  $('app-login').classList.add('hidden');
  $('app-main').classList.remove('hidden');
  $('user-display').textContent = currentUser.display_name + ' (' + (currentUser.role === 'admin' ? '★ Admin' : currentUser.role === 'owner' ? '👥 Owner' : 'Member') + ')';
  $('admin-tab').classList.toggle('hidden', currentUser.role !== 'admin');
  $('owner-tab').classList.toggle('hidden', currentUser.role !== 'owner');
  loadTopics(); loadQuota(); loadBotDropdowns(); loadInternalLinks(); loadPromptTemplates();
  PipelineManager.pollNow();
  PipelineManager.startPolling();
  if (typeof loadBatchWpSites === 'function') loadBatchWpSites();
  if (currentUser.role === 'admin') { pollAdminQuotaBadge(); setInterval(pollAdminQuotaBadge, 60000); }
}

async function doLogin() {
  const u = $('login-user').value, p = $('login-pass').value;
  if (!u || !p) { $('login-error').textContent = 'Vui lòng nhập đầy đủ'; $('login-error').style.display = 'block'; return; }
  try {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    const data = await res.json();
    if (!res.ok) { $('login-error').textContent = data.error; $('login-error').style.display = 'block'; return; }
    token = data.token; currentUser = data.user;
    // Persist session across F5
    sessionStorage.setItem('cf_token', token);
    sessionStorage.setItem('cf_user', JSON.stringify(currentUser));
    afterLoginSetup();
  } catch (e) { $('login-error').textContent = 'Lỗi kết nối'; $('login-error').style.display = 'block'; }
}

function doLogout() {
  token = null; currentUser = null;
  sessionStorage.removeItem('cf_token');
  sessionStorage.removeItem('cf_user');
  PipelineManager.stopPolling();
  $('app-main').classList.add('hidden');
  $('app-login').classList.remove('hidden');
  $('login-pass').value = '';
}

// Auto-restore session on page load (F5)
(function initSession() {
  const savedToken = sessionStorage.getItem('cf_token');
  const savedUser = sessionStorage.getItem('cf_user');
  if (savedToken && savedUser) {
    token = savedToken;
    currentUser = JSON.parse(savedUser);
    // Verify token is still valid
    fetch('/api/articles?limit=1', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(r => { if (r.ok) { afterLoginSetup(); } else { doLogout(); } })
      .catch(() => { doLogout(); });
  }
})();

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
  if (tab === 'owner') switchOwnerTab('stats');
  // Stop queue monitor refresh when leaving its tab
  if (tab !== 'admin' && window._queueRefreshTimer) { clearInterval(window._queueRefreshTimer); window._queueRefreshTimer = null; }
  if (tab !== 'owner' && window._ownerQueueTimer) { clearInterval(window._ownerQueueTimer); window._ownerQueueTimer = null; }
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

// ═══════ POINTS ═══════
async function loadQuota() { return loadPoints(); } // backward compat
async function loadPoints() {
  try {
    const res = await api('/api/points');
    const data = await res.json();
    const bal = data.balance || 0;
    const el = document.getElementById('points-text');
    if (el) el.textContent = `💰 ${bal.toLocaleString()} pts`;
    const poolInfo = document.getElementById('points-pool-info');
    if (poolInfo) {
      poolInfo.textContent = data.is_shared_pool ? `👥 Pool: ${data.pool_owner}` : '';
    }
  } catch {}
}

// ═══════ POINTS MODAL ═══════
async function showPointsModal() {
  const modal = $('upgrade-modal');
  modal.classList.remove('hidden');
  const body = $('upgrade-modal-body');
  body.innerHTML = '<div style="text-align:center;padding:2rem"><i class="fas fa-spinner fa-spin" style="font-size:2rem;color:var(--accent)"></i></div>';
  try {
    const [pointsRes, pkgsRes, histRes, myReqRes] = await Promise.all([
      api('/api/points'),
      fetch('/api/points/packages'),
      api('/api/points/history?limit=10'),
      api('/api/points/my-requests')
    ]);
    const pointsData = await pointsRes.json();
    const { packages } = await pkgsRes.json();
    const { transactions } = await histRes.json();
    const { requests: myRequests } = await myReqRes.json();
    const costs = pointsData.costs || [];
    const balance = pointsData.balance || 0;

    // Cost table
    const costRows = costs.map(c => `<tr>
      <td style="padding:.4rem .75rem;font-size:.85rem">${c.display_name}</td>
      <td style="padding:.4rem .75rem;font-size:.85rem;text-align:right;font-weight:700;color:var(--accent)">${c.cost} pts</td>
    </tr>`).join('');

    // Package cards
    const pkgCards = packages.map(p => `<button class="btn" onclick="purchasePoints(${p.id}, ${p.points})" style="display:flex;justify-content:space-between;align-items:center;padding:.75rem 1rem;border-radius:.75rem;border:1px solid var(--border);background:var(--surface2);width:100%;text-align:left;cursor:pointer;transition:all .2s" onmouseover="this.style.borderColor='var(--accent)';this.style.transform='translateY(-1px)'" onmouseout="this.style.borderColor='var(--border)';this.style.transform=''">
      <div>
        <div style="font-weight:700;font-size:1rem;color:var(--text1)">${p.points.toLocaleString()} pts</div>
        ${p.bonus_label ? `<div style="font-size:.7rem;color:var(--success);font-weight:600">${p.bonus_label}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:.5rem">
        <span style="font-weight:700;font-size:.95rem;color:var(--accent)">${p.price_label}</span>
        <span style="background:var(--accent);color:#fff;padding:.2rem .6rem;border-radius:999px;font-size:.75rem;font-weight:600">Mua</span>
      </div>
    </button>`).join('');

    // Transaction history
    const txRows = transactions.length > 0 ? transactions.map(t => {
      const isPositive = t.amount > 0;
      const amtColor = isPositive ? 'var(--success)' : 'var(--error)';
      const amtSign = isPositive ? '+' : '';
      const icon = t.type === 'purchase' ? '🛒' : t.type === 'admin_add' ? '👑' : t.type === 'bonus' ? '🎁' : '⚡';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:.35rem 0;border-bottom:1px solid var(--border);font-size:.8rem">
        <div style="display:flex;align-items:center;gap:.35rem">
          <span>${icon}</span>
          <span style="color:var(--text2)">${t.description || t.type}</span>
        </div>
        <div style="display:flex;align-items:center;gap:.75rem">
          <span style="color:${amtColor};font-weight:600">${amtSign}${t.amount} pts</span>
          <span style="color:var(--text3);font-size:.7rem">${t.created_at?.slice(0,16).replace('T',' ')}</span>
        </div>
      </div>`;
    }).join('') : '<div style="padding:.5rem;text-align:center;color:var(--text2);font-size:.85rem">Chưa có giao dịch</div>';

    body.innerHTML = `
      <div style="text-align:center;margin-bottom:1.5rem">
        <div style="font-size:2.5rem;font-weight:800;color:var(--accent)">${balance.toLocaleString()} pts</div>
        <div style="color:var(--text2);font-size:.85rem">Số dư hiện tại của bạn</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-bottom:1.5rem">
        <div>
          <h3 style="font-size:.9rem;margin-bottom:.75rem;display:flex;align-items:center;gap:.35rem"><i class="fas fa-list"></i> Bảng giá Points</h3>
          <table style="width:100%;border-collapse:collapse;background:var(--surface2);border-radius:.75rem;overflow:hidden">
            <thead><tr style="background:var(--surface)"><th style="padding:.5rem .75rem;text-align:left;font-size:.8rem;color:var(--text2)">Bước</th><th style="padding:.5rem .75rem;text-align:right;font-size:.8rem;color:var(--text2)">Points</th></tr></thead>
            <tbody>${costRows}</tbody>
          </table>
        </div>
        <div>
          <h3 style="font-size:.9rem;margin-bottom:.75rem;display:flex;align-items:center;gap:.35rem"><i class="fas fa-shopping-cart"></i> Mua thêm Points</h3>
          <div style="display:flex;flex-direction:column;gap:.5rem">${pkgCards}</div>
        </div>
      </div>
      <details style="margin-top:.5rem">
        <summary style="cursor:pointer;font-size:.85rem;font-weight:600;color:var(--text2)">📋 Lịch sử giao dịch gần nhất</summary>
        <div style="margin-top:.5rem">${txRows}</div>
      </details>
      ${myRequests && myRequests.length > 0 ? `
      <details open style="margin-top:.75rem">
        <summary style="cursor:pointer;font-size:.85rem;font-weight:600;color:var(--accent)">📨 Yêu cầu mua Points (${myRequests.filter(r=>r.status==='pending').length} đang chờ)</summary>
        <div style="margin-top:.5rem">${myRequests.map(r => {
          const statusIcon = r.status === 'pending' ? '⏳' : r.status === 'approved' ? '✅' : '❌';
          const statusColor = r.status === 'pending' ? 'var(--warn)' : r.status === 'approved' ? 'var(--success)' : 'var(--error)';
          const statusText = r.status === 'pending' ? 'Chờ duyệt' : r.status === 'approved' ? 'Đã duyệt' : 'Từ chối';
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:.35rem 0;border-bottom:1px solid var(--border);font-size:.8rem">
            <div style="display:flex;align-items:center;gap:.35rem">
              <span>${statusIcon}</span>
              <span>${r.points.toLocaleString()} pts (${r.price_label || ''})</span>
            </div>
            <div style="display:flex;align-items:center;gap:.5rem">
              <span style="color:${statusColor};font-weight:600;font-size:.75rem">${statusText}</span>
              <span style="color:var(--text3);font-size:.7rem">${r.created_at?.slice(0,16).replace('T',' ')}</span>
            </div>
          </div>`;
        }).join('')}</div>
      </details>` : ''}
    `;
  } catch(e) { body.innerHTML = '<p style="color:var(--error)">Lỗi tải thông tin. Thử lại sau.</p>'; }
}
// Alias for backward compat
function showUpgradeModal() { showPointsModal(); }

async function purchasePoints(pkgId, pts) {
  if (!confirm(`Xác nhận mua ${pts.toLocaleString()} points? Yêu cầu sẽ được gửi cho Admin duyệt.`)) return;
  try {
    const res = await api('/api/points/purchase', { method: 'POST', body: JSON.stringify({ package_id: pkgId }) });
    const d = await res.json();
    if (!res.ok) return showToast(d.error || 'Lỗi mua points', 'error');
    showToast(`📨 Yêu cầu mua ${pts.toLocaleString()} pts đã gửi! Chờ Admin xác nhận thanh toán.`, 'success', 6000);
    showPointsModal(); // Refresh modal to show pending
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); }
}

function selectPlanForRequest() {} // Legacy no-op
async function submitUpgradeRequest() {} // Legacy no-op

function closeUpgradeModal() { $('upgrade-modal').classList.add('hidden'); }

// Close modal on backdrop click
document.addEventListener('DOMContentLoaded', () => {
  const m = $('upgrade-modal');
  if (m) m.addEventListener('click', e => { if (e.target === m) closeUpgradeModal(); });
});

// Poll admin pending quota count (admin only)
async function pollAdminQuotaBadge() {
  if (currentUser?.role !== 'admin') return;
  try {
    const res = await api('/api/admin/quota-requests?status=pending');
    const d = await res.json();
    const badge = $('admin-qr-badge');
    if (!badge) return;
    if (d.pending_count > 0) { badge.textContent = d.pending_count; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
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

  // Fetch internal links if enabled
  if (config.enableLinks) {
    try {
      const urlRes = await api('/api/urls');
      const urlData = await urlRes.json();
      config.internalLinks = urlData.urls || [];
    } catch { config.internalLinks = []; }
  }

  try {
    const res = await api('/api/pipeline/start', {
      method: 'POST',
      body: JSON.stringify({ type: 'single', config, keywords: [keyword] })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Lỗi', 'error');
    
    showToast(`🚀 Pipeline "${keyword}" đã bắt đầu chạy trên server!`, 'success');
    PipelineManager.pollNow();
    
    // Reset form immediately — user gets fresh form back
    resetPipeline();
    loadQuota();
  } catch (e) {
    showToast('Lỗi: ' + e.message, 'error');
  }
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

    if (score >= 80 || attempt === 3) {
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
    state._lastEvalJson = j;
    renderEvalPanel(j);
    // Save eval result to server pipeline
    saveEvalToServer(j);
    
    // If AI auto-review is ON → automatically optimize outline based on evaluation
    const isAutoReview = $('s-review-toggle')?.classList.contains('on');
    const score = j.overall_score ?? j.score ?? 70;
    if (isAutoReview && score < 80) {
      showToast(`AI đánh giá ${score}/100 — đang tự động tối ưu outline...`, 'info');
      await optimizeFromEval();
    } else if (isAutoReview && score >= 80) {
      showToast(`AI đánh giá ${score}/100 — Outline đạt chất lượng tốt!`, 'success');
    }
  } catch {
    // If not valid JSON, show raw content
    renderEvalPanelRaw(content);
  }
}

function renderEvalPanel(j) {
  const panel = $('ai-eval-panel');
  const contentEl = $('ai-eval-content');
  const actionsEl = $('ai-eval-actions');
  if (!panel || !contentEl) return;

  const score = j.overall_score ?? j.score ?? 0;
  const verdict = j.verdict || '';
  const issues = [...(j.key_issues||[]), ...(j.improvement_suggestions||[]), ...(j.improvements||[])];
  const scoreColor = score >= 70 ? 'var(--success)' : score >= 50 ? '#f59e0b' : 'var(--error)';
  const scoreLabel = score >= 70 ? 'pass' : 'fail';

  contentEl.innerHTML = `
    <div style="font-size:2rem;text-align:center;margin:.5rem 0">
      <span style="color:${scoreColor};font-weight:700">${score}/100</span>
      <small style="font-size:1rem;color:var(--text2);margin-left:.5rem">${scoreLabel}</small>
    </div>
    ${j.insight_alignment_score !== undefined ? `<p style="text-align:center;color:var(--text2);margin:.25rem 0">Insight: ${j.insight_alignment_score} | Depth: ${j.depth_score} | Flow: ${j.flow_score} | SEO: ${j.seo_score}</p>` : ''}
    ${verdict ? `<p style="text-align:center;font-style:italic;color:var(--text2);margin:.25rem 0">${verdict}</p>` : ''}
    ${issues.length ? '<ul style="margin:.5rem 0;padding-left:1.5rem">' + issues.map(i => '<li style="margin:.25rem 0;font-size:.875rem">' + i + '</li>').join('') + '</ul>' : ''}
  `;

  actionsEl.innerHTML = `<button class="btn btn-primary btn-sm" onclick="btnWithLoading(this, optimizeFromEval)"><i class="fas fa-magic"></i> Tối ưu theo đánh giá</button>
    <button class="btn btn-secondary btn-sm" onclick="btnWithLoading(this, aiEvaluate)"><i class="fas fa-redo"></i> Đánh giá lại</button>`;

  panel.classList.remove('hidden');
}

function renderEvalPanelRaw(content) {
  const panel = $('ai-eval-panel');
  const contentEl = $('ai-eval-content');
  const actionsEl = $('ai-eval-actions');
  if (!panel || !contentEl) return;
  contentEl.innerHTML = `<div class="md-preview">${marked.parse(content)}</div>`;
  actionsEl.innerHTML = '';
  panel.classList.remove('hidden');
}

async function saveEvalToServer(evalJson) {
  const viewId = PipelineManager.viewingId;
  if (!viewId) return;
  try {
    await api(`/api/pipeline/${viewId}/eval`, {
      method: 'POST',
      body: JSON.stringify({ eval_data: evalJson })
    });
  } catch {}
}

async function savePipelineOutline(newOutline, originalOutline) {
  const viewId = PipelineManager.viewingId;
  if (!viewId) { console.warn('[savePipelineOutline] No viewingId'); return false; }
  try {
    const body = { outline: newOutline };
    if (originalOutline) body.original_outline = originalOutline;
    const res = await api(`/api/pipeline/${viewId}/update-outline`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { console.error('[savePipelineOutline] Server error:', data.error); showToast('Lỗi lưu outline: ' + data.error, 'error'); return false; }
    console.log('[savePipelineOutline] Saved OK, length:', data.saved_length);
    return true;
  } catch (e) { console.error('[savePipelineOutline] Error:', e); return false; }
}

async function optimizeFromEval() {
  const evalJson = state._lastEvalJson;
  if (!evalJson) { showToast('Không có dữ liệu đánh giá', 'error'); return; }
  const kw = $('s-keyword').value, field = $('s-field').value;
  const style = $('s-style').value || 'tu nhien', company = $('s-company').value;
  
  // Keep original outline for comparison
  const originalOutline = state.outline;
  state.originalOutline = originalOutline;
  
  const regenPrompt = buildPrompt(promptTemplates.regenerate_prompt, {
    keywords: kw,
    intent_json: state.intentData ? JSON.stringify(state.intentData, null, 2) : '{}',
    original_outline: originalOutline,
    evaluation_json: JSON.stringify(evalJson, null, 2),
    context_info: buildContextInfo(field, company, style)
  });
  
  // Set up beforeunload guard to save outline if user refreshes during streaming
  let pendingOutline = null;
  const beforeUnloadHandler = () => {
    if (pendingOutline && PipelineManager.viewingId && token) {
      try {
        fetch(`/api/pipeline/${PipelineManager.viewingId}/update-outline`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ outline: pendingOutline, original_outline: originalOutline }),
          keepalive: true
        });
      } catch {}
    }
  };
  window.addEventListener('beforeunload', beforeUnloadHandler);
  
  goToStep(3);
  $('outline-result').innerHTML = '<div class="loading-overlay"><div class="spinner"></div>Đang tối ưu outline theo đánh giá...</div>';
  try {
    const regenRaw = await streamChat($('s-outlineBot').value, regenPrompt, 'outline-result');
    console.log('[optimizeFromEval] streamChat returned, length:', regenRaw?.length);
    state.outline = cleanRegenOutline(regenRaw, kw);
    console.log('[optimizeFromEval] cleaned outline length:', state.outline?.length);
    pendingOutline = state.outline;
    
    // SAVE IMMEDIATELY - before any UI updates that could be interrupted
    console.log('[optimizeFromEval] Saving to server, viewingId:', PipelineManager.viewingId);
    const saved = await savePipelineOutline(state.outline, originalOutline);
    console.log('[optimizeFromEval] Save result:', saved);
    pendingOutline = null;
    
    $('outline-result').innerHTML = marked.parse(state.outline);
    goToStep(4);
    populateOutlineEditor(state.outline);
    switchOutlineTab('edit');
    
    if (saved) {
      showToast('✅ Outline đã tối ưu & lưu thành công!', 'success');
    } else {
      showToast('⚠️ Outline tối ưu xong nhưng chưa lưu được lên server', 'warning');
    }
    
    // Show comparison panel
    showOutlineComparison(originalOutline, state.outline);
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); goToStep(4); populateOutlineEditor(state.outline); }
  finally { window.removeEventListener('beforeunload', beforeUnloadHandler); }
}

async function regenerateOutline() {
  const notes = $('s-review-notes').value;
  const kw = $('s-keyword').value, field = $('s-field').value;
  const style = $('s-style').value || 'tu nhien';
  const company = $('s-company').value;
  
  // Keep original outline for comparison
  const originalOutline = state.outline;
  
  let regenPrompt;
  if (notes || state.outline) {
    let evalJson = null;
    if (notes) {
      evalJson = { key_issues: [notes], improvement_suggestions: [] };
    }
    regenPrompt = buildPrompt(promptTemplates.regenerate_prompt, {
      keywords: kw,
      intent_json: state.intentData ? JSON.stringify(state.intentData, null, 2) : '{}',
      original_outline: originalOutline,
      evaluation_json: evalJson ? JSON.stringify(evalJson) : JSON.stringify({ key_issues: ['Cai thien chat luong tong the'], improvement_suggestions: [] }),
      context_info: buildContextInfo(field, company, style)
    });
  } else {
    regenPrompt = buildOutlinePrompt();
  }
  goToStep(3);
  const regenRaw = await streamChat($('s-outlineBot').value, regenPrompt, 'outline-result');
  state.outline = cleanRegenOutline(regenRaw, kw);
  state.originalOutline = originalOutline;
  $('outline-result').innerHTML = marked.parse(state.outline);
  goToStep(4);
  populateOutlineEditor(state.outline);
  switchOutlineTab('edit');
  await savePipelineOutline(state.outline, originalOutline);
  
  // Show comparison if there was an original
  if (originalOutline) {
    showOutlineComparison(originalOutline, state.outline);
  }
}

// ═══════ OUTLINE COMPARISON ═══════
function showOutlineComparison(original, optimized) {
  const panel = $('outline-compare-panel');
  const origEl = $('outline-compare-original');
  const optEl = $('outline-compare-optimized');
  if (!panel || !origEl || !optEl) return;
  origEl.innerHTML = marked.parse(original || '');
  optEl.innerHTML = marked.parse(optimized || '');
  panel.classList.remove('hidden');
}

function useOriginalOutline() {
  if (!state.originalOutline) { showToast('Không có outline gốc', 'error'); return; }
  state.outline = state.originalOutline;
  populateOutlineEditor(state.outline);
  switchOutlineTab('edit');
  $('outline-compare-panel').classList.add('hidden');
  savePipelineOutline(state.outline);
  showToast('Đã khôi phục outline gốc', 'success');
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

async function showWpPublishModal() {
  if (!state.articleId) {
    showToast('Vui lòng "Lưu vào DB" bài viết trước khi đăng lên WordPress!', 'warning');
    return;
  }
  
  try {
    const res = await api('/api/wp/configs');
    const d = await res.json();
    if (!d.configs || d.configs.length === 0) {
      showModal('Đăng lên WordPress', '<p>Bạn chưa cấu hình Website WordPress nào. Vui lòng liên hệ Admin để thêm WP Site.</p>', []);
      return;
    }

    const siteOptions = d.configs.map(c => `<option value="${c.id}">${c.site_name} (${c.site_url})</option>`).join('');

    showModal('Đăng lên WordPress', `
      <div class="form-group">
        <label>Chọn Website</label>
        <select id="wp-pub-site" class="input-field" onchange="fetchWpCategories(this.value, 'wp-pub-cat')">
          <option value="">-- Chọn Website --</option>
          ${siteOptions}
        </select>
      </div>
      <div class="form-group">
        <label>Danh mục (Category)</label>
        <select id="wp-pub-cat" class="input-field">
          <option value="">-- Mặc định --</option>
        </select>
        <div id="wp-cat-loading" style="display:none; font-size:12px; color:var(--text2); margin-top:5px;"><i class="fas fa-spinner fa-spin"></i> Đang tải danh mục...</div>
      </div>
      <div class="form-group">
        <label>Trạng thái</label>
        <select id="wp-pub-status" class="input-field">
          <option value="publish">Publish (Đăng ngay)</option>
          <option value="draft">Draft (Bản nháp)</option>
          <option value="pending">Pending Review (Chờ duyệt)</option>
        </select>
      </div>
    `, [
      { text: 'Hủy', cls: 'btn-secondary', fn: 'closeModal()' },
      { text: '<i class="fab fa-wordpress"></i> Đăng bài', cls: 'btn-primary', fn: 'publishToWpNow()' }
    ]);

  } catch (e) {
    showToast('Lỗi khi lấy danh sách WP Site: ' + e.message, 'error');
  }
}

// fetchWpCategories is now defined in BULK PUBLISH section with targetSelectId support

async function publishToWpNow() {
  const wpConfigId = $('wp-pub-site').value;
  if (!wpConfigId) {
    showToast('Vui lòng chọn Website WordPress!', 'warning');
    return;
  }
  
  const btn = event.currentTarget;
  const oldText = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang đăng...';
  btn.disabled = true;

  try {
    const res = await api('/api/wp/publish', {
      method: 'POST',
      body: JSON.stringify({
        article_id: state.articleId,
        wp_config_id: wpConfigId,
        category_id: $('wp-pub-cat').value,
        status: $('wp-pub-status').value
      })
    });
    
    const data = await res.json();
    if (data.success) {
      showToast('Đăng thành công!', 'success');
      closeModal();
      window.open(data.url, '_blank'); // Mở bài viết trong tab mới
    } else {
      showToast('Lỗi: ' + (data.error || 'Unknown WP error'), 'error');
      console.error('WP error details:', data.details);
    }
  } catch (e) {
    showToast('Lỗi mạng: ' + e.message, 'error');
  } finally {
    btn.innerHTML = oldText;
    btn.disabled = false;
  }
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

// ═══════ BULK PUBLISH TO WORDPRESS ═══════
async function showBulkPublishModal() {
  const ids = [...selectedArticleIds];
  if (ids.length === 0) { showToast('Vui lòng chọn ít nhất 1 bài!', 'warning'); return; }

  try {
    const res = await api('/api/wp/configs');
    const d = await res.json();
    if (!d.configs?.length) { showToast('Chưa cấu hình WP Site nào!', 'error'); return; }

    const siteOptions = d.configs.map(c => `<option value="${c.id}">${c.site_name} (${c.site_url})</option>`).join('');

    showModal('Đăng WP hàng loạt — ' + ids.length + ' bài', `
      <div class="form-group">
        <label>Website WordPress</label>
        <select id="bp-site" class="input-field" onchange="fetchWpCategories(this.value, 'bp-cat')">
          <option value="">-- Chọn --</option>${siteOptions}
        </select>
      </div>
      <div class="form-group">
        <label>Danh mục</label>
        <select id="bp-cat" class="input-field"><option value="">-- Mặc định --</option></select>
      </div>
      <div class="form-group">
        <label>Trạng thái WP</label>
        <select id="bp-status" class="input-field">
          <option value="publish">Publish (Đăng ngay)</option>
          <option value="draft">Draft (Bản nháp)</option>
        </select>
      </div>
      <div id="bp-progress" style="display:none">
        <div style="margin:.75rem 0;background:var(--surface2);border-radius:8px;overflow:hidden;height:24px">
          <div id="bp-progress-bar" style="height:100%;background:var(--accent);transition:width .3s;width:0%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:.75rem;font-weight:600"></div>
        </div>
        <div id="bp-log" style="max-height:200px;overflow:auto;font-size:.8rem;background:var(--surface2);padding:.5rem;border-radius:6px"></div>
      </div>
    `, [
      { text: 'Hủy', cls: 'btn-secondary', fn: 'closeModal()' },
      { text: '<i class="fab fa-wordpress"></i> Bắt đầu đăng', cls: 'btn-primary', fn: 'executeBulkPublish()' }
    ]);
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

async function fetchWpCategories(wpConfigId, targetSelectId) {
  const catSelect = document.getElementById(targetSelectId || 'wp-pub-cat');
  if (!catSelect || !wpConfigId) return;
  catSelect.innerHTML = '<option value="">-- Mặc định --</option>';
  try {
    const res = await api('/api/wp/configs/' + wpConfigId + '/categories');
    const cats = await res.json();
    if (Array.isArray(cats)) {
      cats.forEach(c => { catSelect.innerHTML += `<option value="${c.id}">${c.name}</option>`; });
    }
  } catch (e) { console.error('Lỗi tải danh mục WP:', e); }
}

async function executeBulkPublish() {
  const wpConfigId = $('bp-site').value;
  if (!wpConfigId) { showToast('Chọn Website!', 'warning'); return; }

  const ids = [...selectedArticleIds];
  const progressDiv = $('bp-progress');
  const progressBar = $('bp-progress-bar');
  const logDiv = $('bp-log');
  progressDiv.style.display = 'block';
  logDiv.innerHTML = '';

  let doneCount = 0;
  for (const id of ids) {
    logDiv.innerHTML += `<div>⏳ Đang đăng bài #${id}...</div>`;
    logDiv.scrollTop = logDiv.scrollHeight;
    try {
      const res = await api('/api/wp/publish', {
        method: 'POST',
        body: JSON.stringify({
          article_id: id,
          wp_config_id: wpConfigId,
          category_id: $('bp-cat').value,
          status: $('bp-status').value
        })
      });
      const data = await res.json();
      if (data.success) {
        let msg = `✅ Bài #${id} → <a href="${data.url}" target="_blank" style="color:inherit">${data.url}</a>`;
        if (data.warning) {
          msg += ` <span style="color:var(--warning); margin-left: 10px;">⚠️ ${data.warning}</span>`;
          showToast(`Bài #${id}: ${data.warning}`, 'warning');
        }
        logDiv.innerHTML += `<div style="color:var(--success)">${msg}</div>`;
      } else {
        logDiv.innerHTML += `<div style="color:var(--error)">❌ Bài #${id}: ${data.error}</div>`;
      }
    } catch (e) {
      logDiv.innerHTML += `<div style="color:var(--error)">❌ Bài #${id}: ${e.message}</div>`;
    }
    doneCount++;
    const pct = Math.round((doneCount / ids.length) * 100);
    progressBar.style.width = pct + '%';
    progressBar.textContent = `${doneCount}/${ids.length}`;
    logDiv.scrollTop = logDiv.scrollHeight;
    // Delay between posts
    if (doneCount < ids.length) await new Promise(ok => setTimeout(ok, 2000));
  }
  logDiv.innerHTML += `<div style="margin-top:.5rem;font-weight:700">🎉 Hoàn thành! ${doneCount}/${ids.length} bài đã xử lý.</div>`;
  logDiv.scrollTop = logDiv.scrollHeight;
  selectedArticleIds.clear();
  loadHistory();
}

// ═══════ BULK SCHEDULE TO WORDPRESS ═══════
async function showBulkScheduleModal() {
  const ids = [...selectedArticleIds];
  if (ids.length === 0) { showToast('Chọn ít nhất 1 bài!', 'warning'); return; }

  try {
    const res = await api('/api/wp/configs');
    const d = await res.json();
    if (!d.configs?.length) { showToast('Chưa cấu hình WP Site!', 'error'); return; }

    const siteOptions = d.configs.map(c => `<option value="${c.id}">${c.site_name}</option>`).join('');
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const defaultDate = tomorrow.toISOString().split('T')[0];

    const timezones = [
      'Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo',
      'Asia/Seoul', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Dubai',
      'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
      'America/New_York', 'America/Chicago', 'America/Los_Angeles',
      'Australia/Sydney', 'Pacific/Auckland'
    ];
    const tzOptions = timezones.map(tz => `<option value="${tz}" ${tz === 'Asia/Ho_Chi_Minh' ? 'selected' : ''}>${tz}</option>`).join('');

    showModal('Lên lịch đăng — ' + ids.length + ' bài', `
      <div class="form-group">
        <label>Website WordPress</label>
        <select id="bs-site" class="input-field" onchange="fetchWpCategories(this.value, 'bs-cat')">
          <option value="">-- Chọn --</option>${siteOptions}
        </select>
      </div>
      <div class="form-group">
        <label>Danh mục</label>
        <select id="bs-cat" class="input-field"><option value="">-- Mặc định --</option></select>
      </div>
      <div class="form-group">
        <label>Múi giờ</label>
        <select id="bs-tz" class="input-field">${tzOptions}</select>
      </div>
      <hr style="border-color:var(--border)">
      <div class="form-group">
        <label>Chế độ lên lịch</label>
        <select id="bs-mode" class="input-field" onchange="toggleScheduleMode()">
          <option value="per_day">N bài / ngày</option>
          <option value="spread">Chia đều trong X ngày</option>
        </select>
      </div>
      <div class="form-group" id="bs-perday-group">
        <label>Số bài mỗi ngày</label>
        <input id="bs-perday" type="number" value="2" min="1" max="50" class="input-field" onchange="previewSchedule()">
      </div>
      <div class="form-group hidden" id="bs-spread-group">
        <label>Tổng số ngày</label>
        <input id="bs-days" type="number" value="7" min="1" max="365" class="input-field" onchange="previewSchedule()">
      </div>
      <div class="form-group">
        <label>Ngày bắt đầu</label>
        <input id="bs-start" type="date" value="${defaultDate}" class="input-field" onchange="previewSchedule()">
      </div>
      <div class="form-group">
        <label>Giờ đăng cố định</label>
        <input id="bs-time" type="time" value="08:00" class="input-field" onchange="previewSchedule()">
      </div>
      <div class="form-group">
        <label>Trạng thái WP</label>
        <select id="bs-status" class="input-field">
          <option value="publish">Publish</option>
          <option value="draft">Draft</option>
        </select>
      </div>
      <hr style="border-color:var(--border)">
      <div id="bs-preview" style="max-height:250px;overflow:auto;font-size:.8rem"></div>
    `, [
      { text: 'Hủy', cls: 'btn-secondary', fn: 'closeModal()' },
      { text: '<i class="fas fa-calendar-check"></i> Xác nhận lịch', cls: 'btn-primary', fn: 'executeBulkSchedule()' }
    ]);

    // Auto preview
    setTimeout(() => previewSchedule(), 100);
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

function toggleScheduleMode() {
  const mode = $('bs-mode').value;
  $('bs-perday-group').classList.toggle('hidden', mode !== 'per_day');
  $('bs-spread-group').classList.toggle('hidden', mode !== 'spread');
  previewSchedule();
}

function previewSchedule() {
  const ids = [...selectedArticleIds];
  const mode = $('bs-mode')?.value;
  const startDate = $('bs-start')?.value;
  const postTime = $('bs-time')?.value || '08:00';
  if (!startDate || !ids.length) return;

  let schedule = [];
  const startD = new Date(startDate + 'T' + postTime + ':00');

  if (mode === 'per_day') {
    const perDay = Math.max(1, +($('bs-perday')?.value || 1));
    let dayOffset = 0, countInDay = 0;
    for (let i = 0; i < ids.length; i++) {
      const d = new Date(startD);
      d.setDate(d.getDate() + dayOffset);
      d.setHours(d.getHours() + countInDay);
      schedule.push({ idx: i + 1, date: d });
      countInDay++;
      if (countInDay >= perDay) { countInDay = 0; dayOffset++; }
    }
  } else {
    const days = Math.max(1, +($('bs-days')?.value || 7));
    const perDay = Math.ceil(ids.length / days);
    let dayOffset = 0, countInDay = 0;
    for (let i = 0; i < ids.length; i++) {
      const d = new Date(startD);
      d.setDate(d.getDate() + dayOffset);
      d.setHours(d.getHours() + countInDay);
      schedule.push({ idx: i + 1, date: d });
      countInDay++;
      if (countInDay >= perDay) { countInDay = 0; dayOffset++; }
    }
  }

  const totalDays = schedule.length > 0 ? Math.ceil((schedule[schedule.length - 1].date - schedule[0].date) / 86400000) + 1 : 0;

  const preview = $('bs-preview');
  if (!preview) return;
  preview.innerHTML = `
    <div style="font-weight:600;margin-bottom:.5rem">📅 Preview lịch đăng (${ids.length} bài, ${totalDays} ngày)</div>
    <table class="data-table" style="font-size:.8rem">
      <thead><tr><th>#</th><th>Ngày</th><th>Giờ</th></tr></thead>
      <tbody>
        ${schedule.map(s => `<tr>
          <td>${s.idx}</td>
          <td>${s.date.toLocaleDateString('vi')}</td>
          <td>${s.date.toLocaleTimeString('vi', { hour: '2-digit', minute: '2-digit' })}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

async function executeBulkSchedule() {
  const wpConfigId = $('bs-site').value;
  if (!wpConfigId) { showToast('Chọn Website!', 'warning'); return; }
  const ids = [...selectedArticleIds];
  if (!ids.length) { showToast('Chưa chọn bài!', 'warning'); return; }

  try {
    const res = await api('/api/wp/bulk-schedule', {
      method: 'POST',
      body: JSON.stringify({
        article_ids: ids,
        wp_config_id: wpConfigId,
        category_id: $('bs-cat').value || null,
        wp_status: $('bs-status').value,
        mode: $('bs-mode').value,
        start_date: $('bs-start').value,
        post_time: $('bs-time').value,
        articles_per_day: $('bs-perday').value,
        total_days: $('bs-days').value,
        timezone: $('bs-tz').value
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Đã lên lịch ${data.count} bài thành công!`, 'success');
      closeModal();
      selectedArticleIds.clear();
      loadHistory();
    } else {
      showToast('Lỗi: ' + (data.error || 'Unknown'), 'error');
    }
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
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
let selectedArticleIds = new Set();
// Keep backward compat alias
const selectedOutlineIds = selectedArticleIds;
let historyWriteQueue = []; // Queue for sequential single writing
let _historyTopicsLoaded = false;

async function loadHistory(page = 1) {
  try {
    // Load topic filter options (once)
    if (!_historyTopicsLoaded) {
      try {
        const tr = await api('/api/topics');
        const td = await tr.json();
        const sel = $('h-topic-filter');
        if (sel && td.topics) {
          sel.innerHTML = '<option value="">Tất cả chủ đề</option>' +
            td.topics.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
        }
        _historyTopicsLoaded = true;
      } catch {}
    }

    const search = $('h-search')?.value || '';
    const statusFilter = $('h-status-filter')?.value || '';
    const topicFilter = $('h-topic-filter')?.value || '';
    let qs = `page=${page}&limit=15&search=${encodeURIComponent(search)}`;
    if (statusFilter) qs += `&status=${statusFilter}`;
    if (topicFilter) qs += `&topic_id=${topicFilter}`;
    const res = await api(`/api/articles?${qs}`);
    const data = await res.json();
    const articles = data.articles || [];

    // Select-all checkbox state
    const allIds = articles.map(a => a.id);
    const allSelected = allIds.length > 0 && allIds.every(id => selectedArticleIds.has(id));
    const selectAllCb = $('h-select-all');
    if (selectAllCb) selectAllCb.checked = allSelected;

    // Build topic name cache
    const topicNames = {};
    try {
      const topicSel = $('h-topic-filter');
      if (topicSel) [...topicSel.options].forEach(o => { if (o.value) topicNames[o.value] = o.textContent; });
    } catch {}

    const offset = ((data.page || 1) - 1) * 15;
    $('history-table').innerHTML = articles.map((a, idx) => {
      const rowNum = offset + idx + 1;
      let statusBadge;
      if (a.status === 'outline_only') statusBadge = '<span class="badge badge-warning">📝 Outline</span>';
      else if (a.status === 'published') statusBadge = '<span class="badge badge-success">✅ Đã xuất bản</span>';
      else statusBadge = '<span class="badge badge-info">📄 Bản nháp</span>';

      // Schedule badge
      // (will be populated if article has pending schedule)

      // Checkbox for ALL articles
      const checked = selectedArticleIds.has(a.id) ? 'checked' : '';
      const checkboxCell = `<td><input type="checkbox" class="h-article-cb" data-id="${a.id}" data-status="${a.status}" ${checked} onchange="historyToggleOne(${a.id}, this.checked)"></td>`;

      const topicName = a.topic_id ? (topicNames[a.topic_id] || `#${a.topic_id}`) : '—';

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
        <td style="font-size:.8rem;color:var(--text2)">${topicName}</td>
        <td>${statusBadge}</td>
        <td>${new Date(a.created_at).toLocaleDateString('vi')}</td>
        <td>${actions}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text2)">Chưa có bài viết</td></tr>';
    let pgHtml = '';
    for (let i = 1; i <= data.totalPages; i++) pgHtml += `<button class="btn btn-sm ${i === data.page ? 'btn-primary' : 'btn-secondary'}" onclick="loadHistory(${i})">${i}</button>`;
    $('history-pagination').innerHTML = pgHtml;

    historyUpdateActionBar();
  } catch (e) { console.error('loadHistory error:', e); }
}

function historyToggleOne(id, checked) {
  if (checked) selectedArticleIds.add(id);
  else selectedArticleIds.delete(id);

  // Update select-all checkbox
  const allCbs = document.querySelectorAll('.h-article-cb');
  const allChecked = allCbs.length > 0 && [...allCbs].every(cb => cb.checked);
  const selectAllCb = $('h-select-all');
  if (selectAllCb) selectAllCb.checked = allChecked;

  historyUpdateActionBar();
}

function historyToggleSelectAll(checked) {
  const cbs = document.querySelectorAll('.h-article-cb');
  cbs.forEach(cb => {
    cb.checked = checked;
    const id = +cb.dataset.id;
    if (checked) selectedArticleIds.add(id);
    else selectedArticleIds.delete(id);
  });
  historyUpdateActionBar();
}

function historyUpdateActionBar() {
  const count = selectedArticleIds.size;
  const actionBar = $('history-action-bar');
  if (count > 0) {
    actionBar.classList.remove('hidden');
    $('history-selected-count').textContent = `Đã chọn: ${count} bài`;

    // Determine what types are selected
    const cbs = document.querySelectorAll('.h-article-cb:checked');
    let hasOutline = false, hasDraft = false;
    cbs.forEach(cb => {
      if (cb.dataset.status === 'outline_only') hasOutline = true;
      if (cb.dataset.status === 'draft') hasDraft = true;
    });

    // Show/hide buttons based on selection type
    const btnWrite = $('h-btn-write-single');
    const btnBatch = $('h-btn-write-batch');
    const btnBulkPub = $('h-btn-bulk-publish');
    const btnSchedule = $('h-btn-schedule');

    if (btnWrite) btnWrite.style.display = hasOutline ? '' : 'none';
    if (btnBatch) btnBatch.style.display = hasOutline ? '' : 'none';
    if (btnBulkPub) btnBulkPub.style.display = hasDraft ? '' : 'none';
    if (btnSchedule) btnSchedule.style.display = hasDraft ? '' : 'none';
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
  
  // CLEAR TIMERS when switching tabs to prevent background UI overwrites
  if (window._queueRefreshTimer) {
    clearInterval(window._queueRefreshTimer);
    window._queueRefreshTimer = null;
  }

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
    pollAdminPRBadge();

  } else if (tab === 'purchase-requests') {
    loadAdminPurchaseRequests();

  } else if (tab === 'app-settings') {
    loadAdminSettings();

  } else if (tab === 'queue') {
    // Queue Monitor tab — auto-refresh every 10s
    if (window._queueRefreshTimer) clearInterval(window._queueRefreshTimer);
    async function loadQueueMonitor() {
      try {
        const res = await api('/api/admin/queue');
        if (!res.ok) return;
        const d = await res.json();
        const s = d.stats;
        const statColors = { running: 'var(--accent)', queued: 'var(--info)', paused: '#f59e0b', error: 'var(--error)', done_today: 'var(--success)' };
        const statLabels = { running: '▶ Đang chạy', queued: '⏳ Xếp hàng', paused: '⏸ Chờ duyệt', error: '❌ Lỗi', done_today: '✅ Hoàn thành hôm nay' };
        const statsHtml = Object.entries({ running: s.running, queued: s.queued, paused: s.paused, error: s.error, done_today: s.done_today }).map(([k, v]) =>
          `<div class="card" style="text-align:center;padding:.75rem">
            <div style="font-size:1.75rem;font-weight:700;color:${statColors[k]}">${v}</div>
            <div style="color:var(--text2);font-size:.8rem">${statLabels[k]}</div>
          </div>`).join('');
        
        const pipelineRows = (d.pipelines || []).map(p => {
          const kws = p.raw_keywords?.slice(0,2).join(', ') || p.config?.keyword || '—';
          const statusBadge = p.status === 'running' ? '<span class="badge badge-info">▶ Chạy</span>'
            : p.status === 'queued' ? '<span class="badge" style="background:var(--surface2)">⏳ Đợi</span>'
            : p.status === 'paused' ? '<span class="badge badge-warning">⏸ Dừng</span>'
            : '<span class="badge badge-error">❌ Lỗi</span>';
          const progress = p.type === 'batch' && p.batch_count > 0
            ? `<div style="font-size:.7rem;color:var(--text3)">${p.batch_done}/${p.batch_count} bài</div>` : '';
          return `<tr>
            <td>${p.id}</td>
            <td><strong>${p.username || '—'}</strong><br><small style="color:var(--text2)">${p.plan || ''}</small></td>
            <td><span class="badge badge-info">${p.type}</span></td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${kws}">${kws}</td>
            <td>${statusBadge}${progress}</td>
            <td style="font-size:.75rem;color:var(--text2)">${p.step_label || '—'}</td>
            <td><button class="btn btn-sm btn-danger" onclick="adminCancelPipeline(${p.id})"><i class="fas fa-times"></i></button></td>
          </tr>`;
        }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text2)">Không có pipeline nào đang hoạt động</td></tr>';

        const keyRows = (d.api_keys || []).map(k => {
          const status = k.is_active ? '🟢' : '🔴';
          const isRR = s.rr_index % Math.max(d.api_keys.length, 1) === d.api_keys.indexOf(k) ? ' ← next' : '';
          return `<tr style="${!k.is_active ? 'opacity:.5' : ''}">
            <td>${status} <strong>${k.key_name}</strong>${isRR ? `<span style="color:var(--accent);font-size:.75rem">${isRR}</span>` : ''}</td>
            <td>${k.usage_count || 0}</td>
            <td>${k.last_used_at ? new Date(k.last_used_at).toLocaleString('vi') : '—'}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--error);font-size:.75rem" title="${k.last_error||''}">${k.last_error ? k.last_error.substring(0,60) + '...' : '—'}</td>
          </tr>`;
        }).join('');

        el.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3 style="margin:0">🔄 Queue Monitor</h3>
            <div style="font-size:.75rem;color:var(--text2);text-align:right">
              Tự động cập nhật 10s · RR Index: ${s.rr_index} · Keys active: ${s.total_keys}<br>
              <span style="color:${s.worker_ready ? 'var(--success)' : 'var(--error)'}">
                ${s.worker_ready ? '🟢' : '🔴'} Worker ${s.worker_mode || ''}
                ${s.worker_pid ? `· PID ${s.worker_pid}` : ''}
                ${s.worker_restarts > 0 ? `· ⚠ ${s.worker_restarts} restart(s)` : ''}
              </span>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:.75rem;margin-bottom:1.5rem">${statsHtml}</div>
          <div class="card" style="margin-bottom:1rem">
            <div class="card-header"><i class="fas fa-tasks"></i> Pipeline đang hoạt động (${d.pipelines?.length || 0})</div>
            <table class="data-table"><thead><tr><th>#</th><th>User</th><th>Loại</th><th>Keyword</th><th>Trạng thái</th><th>Bước</th><th></th></tr></thead>
            <tbody>${pipelineRows}</tbody></table>
          </div>
          <div class="card">
            <div class="card-header"><i class="fas fa-key"></i> API Keys Health</div>
            <table class="data-table"><thead><tr><th>Key</th><th>Tổng calls</th><th>Dùng lần cuối</th><th>Lỗi gần nhất</th></tr></thead>
            <tbody>${keyRows}</tbody></table>
          </div>`;
      } catch(e) { console.error('Queue monitor error:', e); }
    }
    await loadQueueMonitor();
    window._queueRefreshTimer = setInterval(loadQueueMonitor, 10000);
    return;

  } else if (tab === 'users') {
    try {
      const res = await api('/api/admin/users');
      const d = await res.json();
      const roleColors = { admin: 'badge-error', owner: 'badge-warning', member: 'badge-info' };
      const roleIcons = { admin: '⭐', owner: '👥', member: '👤' };
      const rows = (d.users||[]).map(u => {
        const roleBadge = `<span class="badge ${roleColors[u.role]||'badge-info'}">${roleIcons[u.role]||''} ${u.role}</span>`;
        const ownerInfo = u.owner_name ? `<br><small style="color:var(--text2)">↳ ${u.owner_name}</small>` : '';
        const indent = u.role === 'member' ? 'padding-left:1.5rem;border-left:2px solid var(--surface2)' : '';
        return `<tr style="${indent}">
          <td><strong>${u.username}</strong><br><small>${u.display_name}</small>${ownerInfo}</td>
          <td>${roleBadge}</td>
          <td>${u.plan}</td>
          <td>${u.quota_used_today}/${u.quota_daily}<br><small style="color:var(--text2)">${u.quota_used_month}/${u.quota_monthly} tháng</small></td>
          <td>${u.last_login ? new Date(u.last_login).toLocaleDateString('vi') : 'Chưa đăng nhập'}</td>
          <td><button class="btn btn-sm btn-secondary" onclick="editUser(${u.id})">Sửa</button> <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id},'${u.username}')"><i class="fas fa-trash"></i></button></td>
        </tr>`;
      }).join('');
      el.innerHTML = `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
          <div>
            <span class="badge badge-error" style="margin-right:.25rem">⭐ Admin: ${(d.users||[]).filter(u=>u.role==='admin').length}</span>
            <span class="badge badge-warning" style="margin-right:.25rem">👥 Owner: ${(d.users||[]).filter(u=>u.role==='owner').length}</span>
            <span class="badge badge-info">👤 Member: ${(d.users||[]).filter(u=>u.role==='member').length}</span>
          </div>
          <button class="btn btn-sm btn-primary" onclick="showAddUserModal()"><i class="fas fa-plus"></i> Thêm user</button>
        </div>
        <table class="data-table"><thead><tr><th>Tài khoản</th><th>Role</th><th>Plan</th><th>Quota hôm nay/tháng</th><th>Đăng nhập</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>`;
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
        ${(d.configs||[]).map(c=>`<tr><td>${c.site_name}</td><td>${c.site_url}</td><td>${c.is_default?'✓':'—'}</td><td style="text-align:right"><button class="btn btn-sm btn-secondary" onclick="testWp(${c.id})">Test</button> <button class="btn btn-sm btn-danger" onclick="deleteWp(${c.id})"><i class="fas fa-trash"></i></button></td></tr>`).join('')}
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

  } else if (tab === 'point-costs') {
    try {
      const res = await api('/api/admin/point-costs'); const d = await res.json();
      const rows = (d.costs||[]).map(c => `<tr>
        <td><strong>${c.step_type}</strong></td>
        <td><input id="pc-name-${c.step_type}" value="${c.display_name}" class="input-field" style="width:200px"></td>
        <td><input id="pc-cost-${c.step_type}" type="number" value="${c.cost}" class="input-field" style="width:80px"></td>
        <td><button class="btn btn-sm btn-primary" onclick="savePointCost('${c.step_type}')">Lưu</button></td>
      </tr>`).join('');
      el.innerHTML = `<div class="card">
        <div class="card-header"><i class="fas fa-coins"></i> Bảng giá Points theo bước</div>
        <p style="color:var(--text2);font-size:.8rem;padding:.5rem .75rem 0">Cấu hình số points trừ cho mỗi tác vụ. Thay đổi áp dụng ngay lập tức.</p>
        <table class="data-table"><thead><tr><th>Step Type</th><th>Tên hiển thị</th><th>Cost (pts)</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>`;
    } catch(e) { el.innerHTML = '<p>Lỗi: '+e.message+'</p>'; }

  } else if (tab === 'point-packages') {
    try {
      const res = await api('/api/admin/point-packages'); const d = await res.json();
      const rows = (d.packages||[]).map(p => `<tr>
        <td><input id="pp-pts-${p.id}" type="number" value="${p.points}" class="input-field" style="width:90px"></td>
        <td><input id="pp-price-${p.id}" type="number" value="${p.price}" class="input-field" style="width:110px"></td>
        <td><input id="pp-label-${p.id}" value="${p.price_label}" class="input-field" style="width:110px"></td>
        <td><input id="pp-bonus-${p.id}" value="${p.bonus_label||''}" class="input-field" style="width:120px"></td>
        <td><label><input type="checkbox" id="pp-active-${p.id}" ${p.is_active?'checked':''}> On</label></td>
        <td>
          <button class="btn btn-sm btn-primary" onclick="savePointPkg(${p.id})">Lưu</button>
          <button class="btn btn-sm btn-danger" onclick="deletePointPkg(${p.id})" style="margin-left:.25rem">Xóa</button>
        </td>
      </tr>`).join('');
      el.innerHTML = `<div class="card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <span><i class="fas fa-shopping-bag"></i> Gói mua Points</span>
          <button class="btn btn-sm btn-primary" onclick="addPointPkg()"><i class="fas fa-plus"></i> Thêm gói</button>
        </div>
        <table class="data-table"><thead><tr><th>Points</th><th>Giá (VNĐ)</th><th>Nhãn giá</th><th>Bonus text</th><th>Hiện</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>`;
    } catch(e) { el.innerHTML = '<p>Lỗi: '+e.message+'</p>'; }
  }
}

// ═══════ ADMIN: POINT COST/PACKAGE ACTIONS ═══════
async function savePointCost(stepType) {
  const body = {
    display_name: document.getElementById('pc-name-'+stepType)?.value,
    cost: +document.getElementById('pc-cost-'+stepType)?.value,
  };
  const res = await api('/api/admin/point-costs/'+stepType, { method: 'PUT', body: JSON.stringify(body) });
  if (res.ok) showToast('Đã lưu '+stepType, 'success');
  else showToast('Lỗi lưu', 'error');
}

async function savePointPkg(id) {
  const body = {
    points: +document.getElementById('pp-pts-'+id)?.value,
    price: +document.getElementById('pp-price-'+id)?.value,
    price_label: document.getElementById('pp-label-'+id)?.value,
    bonus_label: document.getElementById('pp-bonus-'+id)?.value || null,
    is_active: document.getElementById('pp-active-'+id)?.checked ? 1 : 0,
  };
  const res = await api('/api/admin/point-packages/'+id, { method: 'PUT', body: JSON.stringify(body) });
  if (res.ok) { showToast('Đã lưu gói', 'success'); switchAdminTab('point-packages'); }
  else showToast('Lỗi lưu', 'error');
}

async function deletePointPkg(id) {
  if (!confirm('Xóa gói này?')) return;
  const res = await api('/api/admin/point-packages/'+id, { method: 'DELETE' });
  if (res.ok) { showToast('Đã xóa', 'info'); switchAdminTab('point-packages'); }
  else showToast('Lỗi xóa', 'error');
}

async function addPointPkg() {
  const body = { points: 1000, price: 100000, price_label: '100,000đ', bonus_label: '', is_active: 1, sort_order: 99 };
  const res = await api('/api/admin/point-packages', { method: 'POST', body: JSON.stringify(body) });
  if (res.ok) { showToast('Đã thêm gói mới', 'success'); switchAdminTab('point-packages'); }
  else showToast('Lỗi thêm', 'error');
}

// Legacy quota actions (no-op)
async function adminApproveQuota() {}
async function adminRejectQuota() {}
async function savePlan(planKey) {
  const body = {
    display_name: document.getElementById('pln-name-'+planKey)?.value,
    price_label: document.getElementById('pln-price-'+planKey)?.value,
    quota_daily: +document.getElementById('pln-qd-'+planKey)?.value,
    quota_monthly: +document.getElementById('pln-qm-'+planKey)?.value,
    max_batch_size: +document.getElementById('pln-mb-'+planKey)?.value,
    description: document.getElementById('pln-desc-'+planKey)?.value,
    is_active: document.getElementById('pln-active-'+planKey)?.checked ? 1 : 0,
  };
  const res = await api('/api/admin/plans/'+planKey, { method: 'PUT', body: JSON.stringify(body) });
  if (res.ok) showToast('Đã lưu plan '+planKey, 'success');
  else showToast('Lỗi lưu plan', 'error');
}

// Admin actions
async function showAddUserModal() {
  // Fetch owners list for member assignment
  let ownerOpts = '<option value="">— Không có (Admin/Owner) —</option>';
  try {
    const ores = await api('/api/admin/users');
    const od = await ores.json();
    const owners = (od.users||[]).filter(u => u.role === 'owner' || u.role === 'admin');
    ownerOpts += owners.map(o => `<option value="${o.id}">${o.display_name} (${o.role})</option>`).join('');
  } catch {}

  showModal('Thêm user', `
    <div class="form-group"><label>Username</label><input id="mu-user"></div>
    <div class="form-group"><label>Password</label><input id="mu-pass" type="password"></div>
    <div class="form-group"><label>Tên hiển thị</label><input id="mu-name"></div>
    <div class="form-group"><label>Role</label>
      <select id="mu-role" onchange="document.getElementById('mu-owner-row').style.display=this.value==='member'?'block':'none'">
        <option value="member">👤 Member (người dùng phụ)</option>
        <option value="owner">👥 Owner (người dùng chính)</option>
        <option value="admin">⭐ Admin</option>
      </select>
    </div>
    <div class="form-group" id="mu-owner-row"><label>Thuộc Owner</label><select id="mu-owner">${ownerOpts}</select></div>
    <div class="form-group"><label>Plan</label><select id="mu-plan"><option>free</option><option>basic</option><option>pro</option><option>enterprise</option></select></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem">
      <div class="form-group"><label>Quota/ngày</label><input id="mu-qd" type="number" value="10"></div>
      <div class="form-group"><label>Quota/tháng</label><input id="mu-qm" type="number" value="200"></div>
    </div>
  `, [{ text: 'Tạo', cls: 'btn-primary', fn: `async function(){
    const role=document.getElementById('mu-role').value;
    const owner_id=role==='member'?document.getElementById('mu-owner').value||null:null;
    const res=await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({username:document.getElementById('mu-user').value,password:document.getElementById('mu-pass').value,display_name:document.getElementById('mu-name').value,role,plan:document.getElementById('mu-plan').value,quota_daily:+document.getElementById('mu-qd').value,quota_monthly:+document.getElementById('mu-qm').value,owner_id})});
    const d=await res.json();
    if(!res.ok){showToast(d.error||'Lỗi','error');return;}
    showToast('Đã tạo user!','success');switchAdminTab('users')}` }]);
}

async function deleteUser(id, username) {
  if (!confirm(`Xóa user "${username}"? Dữ liệu của họ sẽ bị xóa vĩnh viễn.`)) return;
  try {
    const res = await api('/api/admin/users/'+id, { method: 'DELETE' });
    if (res.ok) { showToast('Đã xóa user', 'success'); switchAdminTab('users'); }
    else { const d = await res.json(); showToast(d.error||'Lỗi xóa user', 'error'); }
  } catch(e) { showToast('Lỗi: '+e.message, 'error'); }
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

async function deleteWp(id) {
  if (!confirm('Bạn có chắc chắn muốn xóa WP Site này?')) return;
  const res = await api('/api/wp/configs/' + id, { method: 'DELETE' });
  if (res.ok) {
    showToast('Đã xóa WP Site', 'success');
    switchAdminTab('wp');
  }
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

// Sync server pipeline data → legacy frontend state
function syncPipelineToState(p) {
  if (!p) return;
  state.intentData = p.intent_data;
  if (typeof state.intentData === 'string') { try { state.intentData = JSON.parse(state.intentData); } catch {} }
  state.outline = p.outline;
  state.approvedOutline = p.approved_outline;
  state.article = p.article;
  state.articleWithImages = p.article_with_images;
  state.images = p.images || [];
  if (typeof state.images === 'string') { try { state.images = JSON.parse(state.images); } catch { state.images = []; } }
  state.articleId = p.article_id;
  state.reviewFeedback = p.review_feedback;
  // Restore AI evaluation from server
  if (p.eval_history && typeof p.eval_history === 'object') {
    state._lastEvalJson = p.eval_history;
  } else if (p.eval_history && typeof p.eval_history === 'string') {
    try { state._lastEvalJson = JSON.parse(p.eval_history); } catch {}
  }
  // Restore original outline for comparison (saved in approved_outline during optimization)
  if (p.approved_outline && p.outline && p.approved_outline !== p.outline && p.status === 'paused') {
    state.originalOutline = p.approved_outline;
  }
}

const PipelineManager = {
  pipelines: [],
  viewingId: null,
  pollTimer: null,
  _pollInProgress: false, // Lock chống poll chồng chéo

  startPolling() {
    if (!this.pollTimer) this.pollTimer = setInterval(() => this.pollNow(), 3000);
  },
  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },
  async pollNow() {
    if (!token) return;
    if (this._pollInProgress) return; // Bỏ qua nếu poll trước chưa xong
    this._pollInProgress = true;
    try {
      const res = await api('/api/pipeline/active');
      if (!res.ok) return;
      const data = await res.json();
      this.pipelines = data.pipelines || [];
      renderSidebar();

      // Snapshot viewingId TRƯỚC khi fetch — tránh race condition khi user chuyển pipeline
      const snapshotViewingId = this.viewingId;
      if (snapshotViewingId) {
        const sRes = await api('/api/pipeline/' + snapshotViewingId + '/status');
        if (sRes.ok) {
          const sData = await sRes.json();
          // Kiểm tra lại: user có còn xem pipeline này không?
          if (this.viewingId === snapshotViewingId) {
            const idx = this.pipelines.findIndex(p => p.id === snapshotViewingId);
            if (idx !== -1) this.pipelines[idx] = sData;
            else this.pipelines.push(sData);
            refreshPipelineView(snapshotViewingId);
          }
          // Nếu viewingId đã thay đổi → bỏ qua data cũ, không refresh
        }
      }
    } catch (e) {} finally {
      this._pollInProgress = false;
    }
  },
  getById(id) { return this.pipelines.find(p => p.id === id); },
  async remove(id) {
    if (!confirm('Hủy/Xóa pipeline này?')) return;
    try {
      await api(`/api/pipeline/${id}/cancel`, { method: 'POST' });
      showToast('Đã hủy/xóa', 'success');
      if (this.viewingId === id) backToForm();
      this.pollNow();
    } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
  }
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
  const order = { paused: 0, running: 1, queued: 1, error: 2, done: 3, cancelled: 4 };
  return [...PipelineManager.pipelines].filter(p => p.type !== 'batch').sort((a, b) => {
    const oa = order[a.status] ?? 5, ob = order[b.status] ?? 5;
    if (oa !== ob) return oa - ob;
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });
}

function renderSidebar() {
  const container = $('sidebar-cards');
  const empty = $('sidebar-empty');
  const badge = $('sidebar-badge');
  if (!container) return;
  const all = getSortedPipelines();
  const singleActiveCount = all.filter(p => p.status === 'running' || p.status === 'paused' || p.status === 'queued').length;
  const batchActiveCount = PipelineManager.pipelines.filter(p => p.type === 'batch' && (p.status === 'running' || p.status === 'paused' || p.status === 'queued')).length;
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
    const pct = Math.round((p.current_step / 7) * 100);
    const timeStr = formatTime(p.created_at);
    const isViewing = PipelineManager.viewingId === p.id;

    let statusIcon, statusText, statusClass, cardClass;
    switch (p.status) {
      case 'running': case 'queued': statusIcon = '🟢'; statusText = 'Đang chạy'; statusClass = 'pl-status-running'; cardClass = 'pl-card-running'; break;
      case 'paused': {
        const isAutoReview = p.config?.reviewMode === 'auto';
        statusIcon = isAutoReview ? '🤖' : '🟡';
        statusText = isAutoReview ? 'AI đang tự review' : 'Chờ duyệt';
        statusClass = isAutoReview ? 'pl-status-running' : 'pl-status-paused';
        cardClass = isAutoReview ? 'pl-card-running' : 'pl-card-paused';
        break;
      }
      case 'done': statusIcon = '✅'; statusText = 'Hoàn thành'; statusClass = 'pl-status-done'; cardClass = 'pl-card-done'; break;
      case 'error': statusIcon = '❌'; statusText = 'Lỗi'; statusClass = 'pl-status-error'; cardClass = 'pl-card-error'; break;
      default: statusIcon = '⏹'; statusText = 'Đã hủy'; statusClass = ''; cardClass = ''; break;
    }

    const label = `"${p.config?.keyword || 'Pipeline'}"`;
    const wordCount = p.article_with_images ? p.article_with_images.split(/\s+/).filter(w=>w).length : 0;

    let stepInfo = `Step ${p.current_step}/7 — ${p.step_label}`;
    if (p.status === 'done' && wordCount) stepInfo = `${wordCount.toLocaleString()} từ`;
    if (p.status === 'error') stepInfo = `Step ${p.current_step} — ${p.error_message || p.step_label}`;

    let actions = '';
    if (p.status === 'running' || p.status === 'queued') {
      actions = `<button class="btn btn-secondary" onclick="viewPipeline(${p.id})"><i class="fas fa-eye"></i> Xem chi tiết</button>`;
    } else if (p.status === 'paused') {
      const isAutoReview = p.config?.reviewMode === 'auto';
      if (isAutoReview) {
        // Auto review shouldn't need approval — but show cancel option
        actions = `<button class="btn btn-secondary" onclick="viewPipeline(${p.id})"><i class="fas fa-eye"></i> Xem</button>`;
      } else {
        actions = `<button class="btn btn-primary" onclick="viewPipeline(${p.id})"><i class="fas fa-check"></i> Duyệt outline</button>
          <button class="btn btn-secondary" onclick="viewPipeline(${p.id})"><i class="fas fa-eye"></i> Xem</button>`;
      }
    } else if (p.status === 'done') {
      actions = `<button class="btn btn-secondary" onclick="viewPipeline(${p.id})"><i class="fas fa-eye"></i> Xem kết quả</button>
        <button class="btn btn-secondary" onclick="bqViewLogs(${p.id})" title="Xem log"><i class="fas fa-clipboard-list"></i></button>
        <button class="btn btn-secondary" onclick="PipelineManager.remove(${p.id})" style="opacity:.6"><i class="fas fa-trash"></i></button>`;
    } else if (p.status === 'error') {
      const _rc = p.retry_count || 0;
      actions = `${_rc < 3 ? `<button class="btn btn-warning" onclick="bqRetryPipeline(${p.id})" title="Retry (${_rc}/3)"><i class="fas fa-redo"></i> Retry</button>` : ''}
        <button class="btn btn-secondary" onclick="bqViewLogs(${p.id})" title="Xem log"><i class="fas fa-clipboard-list"></i></button>
        <button class="btn btn-secondary" onclick="PipelineManager.remove(${p.id})" style="opacity:.6"><i class="fas fa-trash"></i></button>`;
    }

    const progressBar = (p.status === 'running' || p.status === 'queued') ? `<div class="pl-progress"><div class="pl-progress-fill" style="width:${pct}%"></div></div>` : '';
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
  
  // Guard: don't auto-switch UI if user is NOT on the single tab
  const singleTab = document.getElementById('tab-single');
  if (!singleTab || singleTab.classList.contains('hidden')) return;
  
  // If viewing a batch item, delegate to batch item refresh
  if (PipelineManager.viewingItemId) {
    refreshBatchItemView(id, PipelineManager.viewingItemId);
    return;
  }
  
  const p = PipelineManager.getById(id);
  if (!p) return;
  $('pipeline-view-title').textContent = `Đang xem: "${p.config?.keyword}" — ${p.step_label}`;
  syncPipelineToState(p);
  
  // Only update UI sections if data is available — do NOT re-call populateOutlineEditor
  // to avoid resetting user's current tab/edit state every 3s
  if (p.intent_data && p.current_step >= 2) {
    try { $('intent-result').innerHTML = '<pre style="white-space:pre-wrap;font-size:.85rem">' + JSON.stringify(p.intent_data, null, 2) + '</pre>'; } catch {}
  }
  if (p.outline && p.current_step >= 3) {
    try { $('outline-result').innerHTML = marked.parse(p.outline); } catch {}
  }
  // DON'T call populateOutlineEditor here — it resets the editor and tab state
  // The editor is already populated by viewPipeline() or goToStep()
  if (p.article && p.current_step >= 5) {
    try { $('article-result').innerHTML = marked.parse(p.article); } catch {}
  }
  if (p.current_step >= 7 && p.status === 'done') {
    const fa = p.article_with_images || p.article;
    if (fa) {
      const words = fa.split(/\s+/).filter(w => w).length;
      try {
        $('word-count-badge').textContent = words + ' từ';
        $('img-count-badge').textContent = (p.images?.length || 0) + ' ảnh';
        $('final-article').innerHTML = marked.parse(fa);
        $('article-edit-textarea').value = fa;
        renderImageManager();
      } catch {}
    }
  }
  // Only switch step if it actually changed (prevent auto-tab-switch every 3s)
  if (!PipelineManager._lastStep || PipelineManager._lastStep !== p.current_step) {
    PipelineManager._lastStep = p.current_step;
    goToStep(p.current_step);
    // Populate outline editor only when step changes to manual-review (paused)
    if (p.current_step >= 4 && p.status === 'paused' && p.outline) {
      populateOutlineEditor(p.approved_outline || p.outline);
      switchOutlineTab('edit');
    }
  }
}

// ═══════ BATCH ITEM STEP-BY-STEP VIEW ═══════
function refreshBatchItemView(batchId, itemId) {
  const p = PipelineManager.getById(batchId);
  if (!p || p.type !== 'batch') return;
  const items = p.batch_items || [];
  const item = items.find(a => (a.id || `legacy-${items.indexOf(a)}`) === itemId);
  if (!item) return;

  const itemStep = typeof getBatchItemStep === 'function' ? getBatchItemStep(item) : 1;
  const itemStepLabel = typeof getBatchItemStepLabel === 'function' ? getBatchItemStepLabel(item) : '';
  $('pipeline-view-title').textContent = `📦 Batch #${batchId} — "${item.keyword}" — ${itemStepLabel}`;

  // Update UI sections from item data
  if (item.intentData && itemStep >= 2) {
    try { $('intent-result').innerHTML = '<pre style="white-space:pre-wrap;font-size:.85rem">' + JSON.stringify(item.intentData, null, 2) + '</pre>'; } catch {}
  }
  if (item.outline && itemStep >= 3) {
    try { $('outline-result').innerHTML = marked.parse(item.outline); } catch {}
  }
  if (item.article && itemStep >= 5) {
    try { $('article-result').innerHTML = marked.parse(item.article); } catch {}
  }
  if (item.articleStatus === 'done') {
    const fa = item.articleWithImages || item.article;
    if (fa) {
      const words = fa.split(/\s+/).filter(w => w).length;
      try {
        $('word-count-badge').textContent = words + ' từ';
        $('img-count-badge').textContent = (item.images?.length || 0) + ' ảnh';
        $('final-article').innerHTML = marked.parse(fa);
        $('article-edit-textarea').value = fa;
        state.images = item.images || [];
        renderImageManager();
      } catch {}
    }
  }

  // Only switch step if it changed
  if (!PipelineManager._lastItemStep || PipelineManager._lastItemStep !== itemStep) {
    PipelineManager._lastItemStep = itemStep;
    goToStep(itemStep);
    if (itemStep >= 4 && item.outline) {
      populateOutlineEditor(item.outline);
      switchOutlineTab('edit');
    }
  }
}

// ═══════ VIEW BATCH ITEM (Step-by-step, like Single Mode) ═══════
async function viewBatchItem(batchId, itemId) {
  PipelineManager.viewingId = batchId;
  PipelineManager.viewingItemId = itemId;
  PipelineManager._lastStep = null;
  PipelineManager._lastItemStep = null;

  // Fetch full pipeline details from server
  try {
    const sRes = await api('/api/pipeline/' + batchId + '/status');
    if (sRes.ok) {
      const fullData = await sRes.json();
      const idx = PipelineManager.pipelines.findIndex(pp => pp.id === batchId);
      if (idx !== -1) PipelineManager.pipelines[idx] = fullData;
      else PipelineManager.pipelines.push(fullData);
    }
  } catch {}

  const p = PipelineManager.getById(batchId);
  if (!p || p.type !== 'batch') return;

  const items = p.batch_items || [];
  const item = items.find(a => (a.id || `legacy-${items.indexOf(a)}`) === itemId);
  if (!item) {
    showToast('Không tìm thấy bài viết trong batch', 'error');
    return;
  }

  const itemStep = typeof getBatchItemStep === 'function' ? getBatchItemStep(item) : 1;
  const itemStepLabel = typeof getBatchItemStepLabel === 'function' ? getBatchItemStepLabel(item) : '';

  // Show pipeline view banner
  $('pipeline-view-banner').classList.remove('hidden');
  $('pipeline-view-title').textContent = `📦 Batch #${batchId} — "${item.keyword}" — ${itemStepLabel}`;

  // Switch to single tab to reuse step UI
  switchTab('single');

  // Populate form with batch config + item keyword
  if (p.config) {
    $('s-keyword').value = item.keyword || '';
    $('s-field').value = p.config.field || '';
    $('s-company').value = p.config.company || '';
    $('s-style').value = p.config.style || '';
    $('s-extra').value = p.config.extra || '';
    $('s-reference').value = p.config.reference || '';
  }

  // Map item data → state
  state.intentData = item.intentData || null;
  state.outline = item.outline || '';
  state.approvedOutline = item.outline || '';
  state.originalOutline = item.original_outline || null;
  state.article = item.article || '';
  state.articleWithImages = item.articleWithImages || item.article || '';
  state.images = item.images || [];
  state.reviewFeedback = item.reviewFeedback || '';
  state.reviewMode = p.config?.reviewMode || 'auto';
  state._lastEvalJson = item.evalData || null;

  // Populate UI sections based on item progress
  if (item.intentData) {
    try { $('intent-result').innerHTML = '<pre style="white-space:pre-wrap;font-size:.85rem">' + JSON.stringify(item.intentData, null, 2) + '</pre>'; } catch {}
  }
  if (item.outline) {
    try { $('outline-result').innerHTML = marked.parse(item.outline); } catch {}
  }
  if (item.article) {
    try { $('article-result').innerHTML = marked.parse(item.article); } catch {}
  }

  // Navigate to appropriate step
  goToStep(itemStep);

  // Step 4: Show outline editor + review panels
  if (itemStep >= 4 && item.outline) {
    populateOutlineEditor(item.outline);
    switchOutlineTab('edit');
    
    // Show manual review panel (read-only for batch viewing)
    $('review-manual').classList.remove('hidden');
    $('review-auto').classList.add('hidden');

    // Show outline comparison if original_outline exists and differs
    if (item.original_outline && item.original_outline !== item.outline) {
      showOutlineComparison(item.original_outline, item.outline);
    } else {
      $('outline-compare-panel')?.classList.add('hidden');
    }

    // Show AI evaluation panel if evalData exists
    if (item.evalData) {
      renderEvalPanel(item.evalData);
    } else {
      $('ai-eval-panel')?.classList.add('hidden');
    }
  }

  // Step 7: Show result
  if (item.articleStatus === 'done') {
    const fa = item.articleWithImages || item.article;
    if (fa) {
      const words = fa.split(/\s+/).filter(w => w).length;
      try {
        $('word-count-badge').textContent = words + ' từ';
        $('img-count-badge').textContent = (item.images?.length || 0) + ' ảnh';
        $('final-article').innerHTML = marked.parse(fa);
        $('article-edit-textarea').value = fa;
        renderImageManager();
      } catch {}
    }
  }

  // Disable start button while viewing
  $('btn-start').disabled = true;

  // Render sidebar to highlight current item
  renderSidebar();
}

async function viewPipeline(id) {
  // Set viewingId ngay lập tức để poll biết user đang xem pipeline nào
  PipelineManager.viewingId = id;
  PipelineManager.viewingItemId = null; // Clear batch item viewing
  PipelineManager._lastStep = null; // Reset so goToStep fires on first view
  PipelineManager._lastItemStep = null;
  
  // Xóa sạch UI cũ trước khi hiện pipeline mới — tránh hiển thị nhầm dữ liệu cache
  try {
    $('intent-result').innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text2)"><i class="fas fa-spinner fa-spin"></i> Đang tải...</div>';
    $('outline-result').innerHTML = '';
    $('article-result').innerHTML = '';
    $('final-article').innerHTML = '';
  } catch {}
  
  // Fetch full pipeline details từ server
  try {
    const sRes = await api('/api/pipeline/' + id + '/status');
    if (sRes.ok) {
      const fullData = await sRes.json();
      // Kiểm tra: user có còn xem pipeline này không? (có thể đã click pipeline khác)
      if (PipelineManager.viewingId !== id) return; // User đã chuyển → bỏ qua
      const idx = PipelineManager.pipelines.findIndex(pp => pp.id === id);
      if (idx !== -1) PipelineManager.pipelines[idx] = fullData;
      else PipelineManager.pipelines.push(fullData);
    }
  } catch {}
  
  // Kiểm tra lần nữa sau async fetch
  if (PipelineManager.viewingId !== id) return;

  const p = PipelineManager.getById(id);
  if (!p) return;
  
  $('pipeline-view-banner').classList.remove('hidden');
  $('pipeline-view-title').textContent = `Đang xem: "${p.config?.keyword}" — ${p.step_label}`;
  switchTab('single');
  
  // Populate UI state mapping for legacy handlers
  syncPipelineToState(p);

  if (p.config) {
    $('s-keyword').value = p.config.keyword || '';
    $('s-field').value = p.config.field || '';
    $('s-company').value = p.config.company || '';
    $('s-style').value = p.config.style || '';
    $('s-extra').value = p.config.extra || '';
    $('s-reference').value = p.config.reference || '';
  }
  
  if (p.status === 'paused' && p.current_step === 4) {
    populateOutlineEditor(p.outline);
    switchOutlineTab('edit');
    $('review-manual').classList.remove('hidden');
    $('review-auto').classList.add('hidden');
    $('btn-start').disabled = true;
    // Restore AI evaluation panel if exists
    if (state._lastEvalJson) {
      renderEvalPanel(state._lastEvalJson);
    }
    // Restore outline comparison if original differs from current
    if (state.originalOutline && state.originalOutline !== state.outline) {
      showOutlineComparison(state.originalOutline, state.outline);
    }
  }
  
  if (p.status === 'done') {
    const fa = p.article_with_images || p.article;
    if (fa) {
      const words = fa.split(/\s+/).filter(w => w).length;
      try {
        $('word-count-badge').textContent = words + ' từ';
        $('img-count-badge').textContent = (p.images?.length || 0) + ' ảnh';
        $('final-article').innerHTML = marked.parse(fa);
        $('article-edit-textarea').value = fa;
        renderImageManager();
      } catch {}
      loadSuggestions(p.config?.keyword, p.config?.field);
    }
  }
  refreshPipelineView(id);
}

function backToForm() {
  PipelineManager.viewingId = null;
  PipelineManager.viewingItemId = null;
  PipelineManager._lastItemStep = null;
  $('pipeline-view-banner').classList.add('hidden');
  // Hide comparison panels that may be open from batch item view
  const comparePanel = $('outline-compare-panel');
  if (comparePanel) comparePanel.classList.add('hidden');
  const evalPanel = $('ai-eval-panel');
  if (evalPanel) evalPanel.classList.add('hidden');
  // Reset to form mode
  resetPipeline();
}

// Override approveOutline to handle pipeline review via API
const _origApproveOutline = approveOutline;
approveOutline = async function() {
  const viewId = PipelineManager.viewingId;
  if (viewId) {
    const p = PipelineManager.getById(viewId);
    if (p && p.status === 'paused') {
      const outlineEdited = $('outline-edit-textarea')?.value || p.outline;
      const notes = $('s-review-notes')?.value;
      try {
        await api(`/api/pipeline/${viewId}/approve`, {
          method: 'POST',
          body: JSON.stringify({ outline_edited: outlineEdited, notes })
        });
        showToast('Đã duyệt! Pipeline tiếp tục chạy trên server...', 'success');
        backToForm();
        PipelineManager.pollNow();
      } catch (e) { showToast('Lỗi duyệt outline: ' + e.message, 'error'); }
      return;
    }
  }
  return _origApproveOutline();
};

// The large runPipelineBackground and resumePipelineFromReview functions 
// have been removed, as execution now happens fully server-side.

// ═══════ ADMIN: QUEUE MONITOR ACTIONS ═══════
async function adminCancelPipeline(id) {
  if (!confirm(`Hủy pipeline #${id}?`)) return;
  try {
    const res = await api(`/api/pipeline/${id}/cancel`, { method: 'POST' });
    if (res.ok) { showToast(`Đã hủy pipeline #${id}`, 'success'); switchAdminTab('queue'); }
    else showToast('Lỗi hủy pipeline', 'error');
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); }
}

// ═══════════════════════════════════════════════
// OWNER WORKSPACE
// ═══════════════════════════════════════════════

async function switchOwnerTab(tab) {
  document.querySelectorAll('#tab-owner .sub-tab').forEach(t => t.classList.remove('active'));
  event?.target?.classList?.add('active');
  const el = $('owner-content');
  if (!el) return;
  // Stop queue refresh if leaving queue tab
  if (tab !== 'queue' && window._ownerQueueTimer) { clearInterval(window._ownerQueueTimer); window._ownerQueueTimer = null; }

  if (tab === 'stats') {
    try {
      const res = await api('/api/owner/stats');
      const d = await res.json();
      const q = d.quota;
      const pct = q.daily > 0 ? Math.round(q.used_today / q.daily * 100) : 0;
      el.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem">
          <div class="card" style="text-align:center"><div style="font-size:2rem;font-weight:700;color:var(--accent)">${d.total_articles}</div><div style="color:var(--text2)">Tổng bài viết nhóm</div></div>
          <div class="card" style="text-align:center"><div style="font-size:2rem;font-weight:700;color:var(--success)">${d.articles_today}</div><div style="color:var(--text2)">Bài hôm nay</div></div>
          <div class="card" style="text-align:center"><div style="font-size:2rem;font-weight:700;color:var(--info)">${d.member_count}</div><div style="color:var(--text2)">Members</div></div>
        </div>
        <div class="card">
          <div class="card-header">💳 Quota nhóm (dùng chung pool)</div>
          <div style="padding:1rem">
            <div style="display:flex;justify-content:space-between;margin-bottom:.5rem">
              <span>Hôm nay: <strong>${q.used_today}/${q.daily}</strong></span>
              <span style="color:${pct>=90?'var(--error)':pct>=70?'var(--warn)':'var(--success)'}">${pct}%</span>
            </div>
            <div class="quota-bar"><div class="quota-fill" style="width:${Math.min(pct,100)}%;background:${pct>=90?'var(--error)':pct>=70?'var(--warn)':'var(--accent)'}"></div></div>
            <div style="margin-top:.75rem;color:var(--text2);font-size:.85rem">Tháng này: ${q.used_month}/${q.monthly}</div>
          </div>
        </div>`;
    } catch(e) { el.innerHTML = '<p>Lỗi tải thống kê</p>'; }

  } else if (tab === 'members') {
    await loadOwnerMembers();

  } else if (tab === 'history') {
    await loadOwnerHistory();

  } else if (tab === 'queue') {
    if (window._ownerQueueTimer) clearInterval(window._ownerQueueTimer);
    async function loadOwnerQueue() {
      try {
        const res = await api('/api/owner/queue');
        const d = await res.json(); const s = d.stats;
        const statColors = { running: 'var(--accent)', queued: 'var(--info)', paused: '#f59e0b', error: 'var(--error)', done_today: 'var(--success)' };
        const statLabels = { running: '▶ Đang chạy', queued: '⏳ Xếp hàng', paused: '⏸ Chờ', error: '❌ Lỗi', done_today: '✅ Hôm nay' };
        const statsHtml = Object.entries({ running: s.running, queued: s.queued, paused: s.paused, error: s.error, done_today: s.done_today })
          .map(([k,v]) => `<div class="card" style="text-align:center;padding:.75rem"><div style="font-size:1.75rem;font-weight:700;color:${statColors[k]}">${v}</div><div style="color:var(--text2);font-size:.8rem">${statLabels[k]}</div></div>`).join('');
        const rows = (d.pipelines||[]).map(p => {
          const kw = p.raw_keywords?.slice(0,2).join(', ') || p.config?.keyword || '—';
          const badge = p.status==='running'?'<span class="badge badge-info">▶ Chạy</span>':p.status==='queued'?'<span class="badge">⏳ Đợi</span>':p.status==='paused'?'<span class="badge badge-warning">⏸</span>':'<span class="badge badge-error">❌</span>';
          return `<tr><td>${p.id}</td><td><strong>${p.username||'—'}</strong><br><small>${p.display_name||''}</small></td><td><span class="badge badge-info">${p.type}</span></td><td title="${kw}" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${kw}</td><td>${badge}</td><td style="font-size:.75rem;color:var(--text2)">${p.step_label||'—'}</td></tr>`;
        }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text2)">Không có pipeline đang hoạt động</td></tr>';
        el.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
            <h3 style="margin:0">📋 Queue nhóm</h3>
            <span style="font-size:.75rem;color:var(--text2)">Tự động cập nhật 10s</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:.75rem;margin-bottom:1.5rem">${statsHtml}</div>
          <div class="card">
            <table class="data-table"><thead><tr><th>#</th><th>User</th><th>Loại</th><th>Keyword</th><th>Trạng thái</th><th>Bước</th></tr></thead>
            <tbody>${rows}</tbody></table>
          </div>`;
      } catch(e) { console.error(e); }
    }
    await loadOwnerQueue();
    window._ownerQueueTimer = setInterval(loadOwnerQueue, 10000);
    return;

  } else if (tab === 'wp') {
    try {
      const res = await api('/api/wp/configs'); const d = await res.json();
      const rows = (d.configs||[]).map(c => `<tr><td><strong>${c.site_name}</strong></td><td>${c.site_url}</td><td>${c.username}</td><td><span class="badge ${c.status==='active'?'badge-success':'badge-error'}">${c.status||'—'}</span></td><td><button class="btn btn-sm btn-secondary" onclick="ownerTestWp(${c.id})">Test</button> <button class="btn btn-sm btn-danger" onclick="ownerDeleteWp(${c.id})"><i class="fas fa-trash"></i></button></td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text2)">Chưa có WP site</td></tr>';
      el.innerHTML = `<div class="card">
        <div class="card-header"><i class="fab fa-wordpress"></i> WordPress Sites</div>
        <div style="padding:.75rem">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.75rem">
            <input id="ow-wp-name" placeholder="Tên site" class="input-field">
            <input id="ow-wp-url" placeholder="URL (https://...)" class="input-field">
            <input id="ow-wp-user" placeholder="Username WP" class="input-field">
            <input id="ow-wp-pass" placeholder="App Password" class="input-field" type="password">
          </div>
          <button class="btn btn-primary btn-sm" onclick="ownerAddWp()"><i class="fas fa-plus"></i> Thêm site</button>
        </div>
        <table class="data-table"><thead><tr><th>Tên</th><th>URL</th><th>User</th><th>Trạng thái</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    } catch { el.innerHTML = '<p>Lỗi</p>'; }

  } else if (tab === 'topics') {
    try {
      const res = await api('/api/topics'); const d = await res.json();
      const rows = (d.topics||[]).map(t => `<tr><td><strong>${t.name}</strong></td><td><code>${t.slug}</code></td><td>${t.description||'—'}</td><td><button class="btn btn-sm btn-danger" onclick="ownerDeleteTopic(${t.id})"><i class="fas fa-trash"></i></button></td></tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--text2)">Chưa có topic</td></tr>';
      el.innerHTML = `<div class="card">
        <div class="card-header"><i class="fas fa-tags"></i> Topics</div>
        <div style="display:flex;gap:.5rem;padding:.75rem">
          <input id="ow-topic-name" placeholder="Tên topic" class="input-field" style="flex:1">
          <input id="ow-topic-desc" placeholder="Mô tả" class="input-field" style="flex:1">
          <button class="btn btn-primary btn-sm" onclick="ownerAddTopic()"><i class="fas fa-plus"></i> Thêm</button>
        </div>
        <table class="data-table"><thead><tr><th>Tên</th><th>Slug</th><th>Mô tả</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    } catch { el.innerHTML = '<p>Lỗi</p>'; }
  }
}

// --- Owner: Members ---
async function loadOwnerMembers() {
  const el = $('owner-content');
  try {
    const res = await api('/api/owner/members'); const d = await res.json();
    const rows = (d.members||[]).map(m => `
      <tr>
        <td><strong>${m.username}</strong><br><small style="color:var(--text2)">${m.display_name}</small></td>
        <td>${m.plan}</td>
        <td>${m.quota_used_today}</td>
        <td>${m.quota_used_month}</td>
        <td>${m.last_login ? new Date(m.last_login).toLocaleDateString('vi') : 'Chưa đăng nhập'}</td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="ownerEditMember(${m.id},'${m.username}','${m.display_name}','${m.plan}')">Sửa</button>
          <button class="btn btn-sm btn-danger" onclick="ownerDeleteMember(${m.id},'${m.username}')"><i class="fas fa-times"></i></button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text2)">Chưa có members. Thêm thành viên đầu tiên!</td></tr>';
    el.innerHTML = `<div class="card">
      <div class="card-header"><i class="fas fa-user-plus"></i> Thêm Member mới</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:.5rem;padding:.75rem;align-items:end">
        <div><label style="font-size:.8rem;color:var(--text2)">Username *</label><input id="ow-m-user" placeholder="username" class="input-field"></div>
        <div><label style="font-size:.8rem;color:var(--text2)">Mật khẩu *</label><input id="ow-m-pass" placeholder="password" type="password" class="input-field"></div>
        <div><label style="font-size:.8rem;color:var(--text2)">Tên hiển thị</label><input id="ow-m-name" placeholder="Tên đầy đủ" class="input-field"></div>
        <div><label style="font-size:.8rem;color:var(--text2)">Plan</label>
          <select id="ow-m-plan" class="input-field"><option value="free">Free</option><option value="basic">Basic</option><option value="pro">Pro</option></select>
        </div>
        <button class="btn btn-primary" onclick="ownerAddMember()" style="white-space:nowrap"><i class="fas fa-plus"></i> Thêm</button>
      </div>
      <table class="data-table">
        <thead><tr><th>Tài khoản</th><th>Plan</th><th>Quota hôm nay</th><th>Quota tháng</th><th>Đăng nhập lần cuối</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  } catch(e) { el.innerHTML = '<p>Lỗi: '+e.message+'</p>'; }
}

async function ownerAddMember() {
  const username = $('ow-m-user').value.trim();
  const password = $('ow-m-pass').value;
  const display_name = $('ow-m-name').value.trim() || username;
  const plan = $('ow-m-plan').value;
  if (!username || !password) return showToast('Cần nhập username và mật khẩu', 'error');
  try {
    const res = await api('/api/owner/members', { method: 'POST', body: JSON.stringify({ username, password, display_name, plan }) });
    const d = await res.json();
    if (!res.ok) return showToast(d.error || 'Lỗi thêm member', 'error');
    showToast('Đã thêm member: ' + username, 'success');
    await loadOwnerMembers();
  } catch(e) { showToast('Lỗi: '+e.message, 'error'); }
}

async function ownerDeleteMember(id, username) {
  if (!confirm(`Xóa member "${username}"? Tất cả dữ liệu của họ vẫn được giữ lại.`)) return;
  try {
    const res = await api('/api/owner/members/'+id, { method: 'DELETE' });
    if (res.ok) { showToast('Đã xóa member', 'success'); await loadOwnerMembers(); }
    else showToast('Lỗi xóa member', 'error');
  } catch(e) { showToast('Lỗi: '+e.message, 'error'); }
}

function ownerEditMember(id, username, display_name, plan) {
  const newName = prompt(`Tên hiển thị cho "${username}":`, display_name);
  if (newName === null) return;
  const newPass = prompt(`Mật khẩu mới (để trống = giữ nguyên):`, '');
  const body = { display_name: newName || display_name };
  if (newPass) body.password = newPass;
  api('/api/owner/members/'+id, { method: 'PUT', body: JSON.stringify(body) })
    .then(r => r.ok ? (showToast('Đã cập nhật', 'success'), loadOwnerMembers()) : showToast('Lỗi', 'error'));
}

// --- Owner: Group History ---
async function loadOwnerHistory(page = 1) {
  const el = $('owner-content');
  try {
    const res = await api(`/api/owner/articles?page=${page}&limit=20`);
    const d = await res.json();
    const rows = (d.articles||[]).map(a => {
      const status = a.status === 'published' ? '<span class="badge badge-success">Published</span>'
        : a.status === 'draft' ? '<span class="badge">Draft</span>'
        : '<span class="badge badge-warning">'+a.status+'</span>';
      return `<tr>
        <td><strong>${a.keyword}</strong></td>
        <td><span class="badge badge-info">${a.username||'—'}</span></td>
        <td>${status}</td>
        <td>${a.word_count||0} từ</td>
        <td style="font-size:.75rem">${a.created_at?.slice(0,16).replace('T',' ')}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text2)">Nhóm chưa có bài viết nào</td></tr>';
    const pagination = d.totalPages > 1 ? `<div style="text-align:center;padding:.75rem">
      ${page > 1 ? `<button class="btn btn-sm btn-secondary" onclick="loadOwnerHistory(${page-1})">← Trước</button>` : ''}
      <span style="margin:0 .75rem;color:var(--text2)">Trang ${page}/${d.totalPages}</span>
      ${page < d.totalPages ? `<button class="btn btn-sm btn-secondary" onclick="loadOwnerHistory(${page+1})">Sau →</button>` : ''}
    </div>` : '';
    el.innerHTML = `<div class="card">
      <div class="card-header"><i class="fas fa-clock-rotate-left"></i> Lịch sử nhóm (${d.total} bài)</div>
      <table class="data-table"><thead><tr><th>Keyword</th><th>Người viết</th><th>Trạng thái</th><th>Số từ</th><th>Thời gian</th></tr></thead>
      <tbody>${rows}</tbody></table>
      ${pagination}
    </div>`;
  } catch(e) { el.innerHTML = '<p>Lỗi: '+e.message+'</p>'; }
}

// --- Owner: WP Sites ---
async function ownerAddWp() {
  const body = { site_name: $('ow-wp-name').value, site_url: $('ow-wp-url').value, username: $('ow-wp-user').value, app_password: $('ow-wp-pass').value };
  if (!body.site_name || !body.site_url) return showToast('Cần nhập tên và URL', 'error');
  const res = await api('/api/wp/configs', { method: 'POST', body: JSON.stringify(body) });
  if (res.ok) { showToast('Đã thêm WP site', 'success'); switchOwnerTab('wp'); }
  else { const e = await res.json(); showToast(e.error || 'Lỗi', 'error'); }
}
async function ownerTestWp(id) {
  const res = await api('/api/wp/configs/'+id+'/test', { method: 'POST' });
  const d = await res.json();
  showToast(d.success ? '✅ Kết nối thành công!' : '❌ Lỗi: '+d.error, d.success ? 'success' : 'error');
}
async function ownerDeleteWp(id) {
  if (!confirm('Xóa WP site này?')) return;
  const res = await api('/api/wp/configs/'+id, { method: 'DELETE' });
  if (res.ok) { showToast('Đã xóa', 'success'); switchOwnerTab('wp'); }
}

// --- Owner: Topics ---
async function ownerAddTopic() {
  const name = $('ow-topic-name').value.trim();
  const description = $('ow-topic-desc').value.trim();
  if (!name) return showToast('Cần nhập tên topic', 'error');
  const res = await api('/api/owner/topics', { method: 'POST', body: JSON.stringify({ name, description }) });
  if (res.ok) { showToast('Đã thêm topic', 'success'); loadTopics(); switchOwnerTab('topics'); }
  else { const e = await res.json(); showToast(e.error || 'Lỗi', 'error'); }
}
async function ownerDeleteTopic(id) {
  if (!confirm('Xóa topic này?')) return;
  await api('/api/topics/'+id, { method: 'DELETE' });
  showToast('Đã xóa', 'success'); loadTopics(); switchOwnerTab('topics');
}

// ═══════ AUTH: REGISTER ═══════
function toggleAuthForm(mode) {
  if (mode === 'register') {
    $('login-form').classList.add('hidden');
    $('register-form').classList.remove('hidden');
    $('register-error').style.display = 'none';
  } else {
    $('register-form').classList.add('hidden');
    $('login-form').classList.remove('hidden');
    $('login-error').style.display = 'none';
  }
}

async function doRegister() {
  const email = $('reg-email').value.trim();
  const password = $('reg-pass').value;
  const display_name = $('reg-name').value.trim();
  const errEl = $('register-error');
  errEl.style.display = 'none';

  if (!email || !password) { errEl.textContent = 'Email và mật khẩu là bắt buộc'; errEl.style.display = 'block'; return; }
  if (password.length < 6) { errEl.textContent = 'Mật khẩu tối thiểu 6 ký tự'; errEl.style.display = 'block'; return; }

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, display_name })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; errEl.style.display = 'block'; return; }

    // Auto-login
    token = data.token; currentUser = data.user;
    $('app-login').classList.add('hidden');
    $('app-main').classList.remove('hidden');
    $('user-display').textContent = currentUser.display_name + ' (Member)';
    $('admin-tab').classList.add('hidden');
    $('owner-tab').classList.add('hidden');
    loadTopics(); loadQuota(); loadBotDropdowns(); loadInternalLinks(); loadPromptTemplates();
    PipelineManager.pollNow(); PipelineManager.startPolling();
    showToast('🎉 Đăng ký thành công! Chào mừng bạn.', 'success');
  } catch (e) { errEl.textContent = 'Lỗi kết nối'; errEl.style.display = 'block'; }
}

// Kiểm tra registration có bật không — ẩn link "Đăng ký" nếu tắt
async function checkRegistrationEnabled() {
  try {
    const res = await fetch('/api/settings/public');
    const d = await res.json();
    const regLink = $('register-link');
    if (regLink) regLink.style.display = d.allow_registration ? '' : 'none';
  } catch {}
}
document.addEventListener('DOMContentLoaded', checkRegistrationEnabled);

// ═══════ ADMIN: PURCHASE REQUESTS TAB ═══════
async function loadAdminPurchaseRequests() {
  const el = $('admin-content');
  try {
    const res = await api('/api/admin/purchase-requests');
    const { requests, pending_count } = await res.json();
    // Update badge
    const badge = $('admin-pr-badge');
    if (badge) {
      if (pending_count > 0) { badge.textContent = pending_count; badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }
    const rows = requests.map(r => {
      const statusBadge = r.status === 'pending' ? '<span class="badge badge-warning">⏳ Chờ duyệt</span>'
        : r.status === 'approved' ? '<span class="badge badge-success">✅ Đã duyệt</span>'
        : '<span class="badge badge-error" style="background:var(--error);color:#fff">❌ Từ chối</span>';
      const actions = r.status === 'pending' ? `
        <button class="btn btn-sm btn-primary" onclick="adminApprovePurchase(${r.id})"><i class="fas fa-check"></i> Duyệt</button>
        <button class="btn btn-sm btn-danger" onclick="adminRejectPurchase(${r.id})"><i class="fas fa-times"></i> Từ chối</button>` : '';
      return `<tr>
        <td>${r.id}</td>
        <td><strong>${r.display_name || r.username}</strong></td>
        <td>${r.points.toLocaleString()} pts</td>
        <td>${r.price_label || ''}</td>
        <td>${statusBadge}</td>
        <td>${r.created_at?.slice(0,16).replace('T',' ')}</td>
        <td>${actions}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<div class="card">
      <div class="card-header"><i class="fas fa-shopping-cart"></i> Yêu cầu mua Points (${pending_count} đang chờ)</div>
      <table class="data-table"><thead><tr>
        <th>#</th><th>User</th><th>Points</th><th>Gói</th><th>Trạng thái</th><th>Thời gian</th><th></th>
      </tr></thead><tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:var(--text2)">Chưa có yêu cầu</td></tr>'}</tbody></table>
    </div>`;
  } catch (e) { el.innerHTML = '<p style="color:var(--error)">Lỗi tải dữ liệu</p>'; }
}

async function adminApprovePurchase(id) {
  const note = prompt('Ghi chú (tùy chọn):') || '';
  try {
    const res = await api(`/api/admin/purchase-requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ note }) });
    if (res.ok) { showToast('✅ Đã duyệt — Points đã được cộng cho user', 'success'); loadAdminPurchaseRequests(); }
    else { const d = await res.json(); showToast(d.error, 'error'); }
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

async function adminRejectPurchase(id) {
  const note = prompt('Lý do từ chối (tùy chọn):') || '';
  try {
    const res = await api(`/api/admin/purchase-requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) });
    if (res.ok) { showToast('❌ Đã từ chối yêu cầu', 'info'); loadAdminPurchaseRequests(); }
    else { const d = await res.json(); showToast(d.error, 'error'); }
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

// ═══════ ADMIN: APP SETTINGS TAB ═══════
async function loadAdminSettings() {
  const el = $('admin-content');
  try {
    const res = await api('/api/admin/settings');
    const { settings } = await res.json();
    const allowReg = settings.allow_registration === '1';
    const adminEmail = settings.admin_email || '';
    el.innerHTML = `<div class="card">
      <div class="card-header"><i class="fas fa-cog"></i> Cài đặt hệ thống</div>
      <div style="display:flex;flex-direction:column;gap:1.5rem">
        <div style="padding:1rem;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">
          <h4 style="margin:0 0 .75rem"><i class="fas fa-user-plus" style="color:var(--accent)"></i> Đăng ký tài khoản</h4>
          <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;font-size:.9rem">
            <input type="checkbox" id="setting-allow-reg" ${allowReg ? 'checked' : ''} onchange="saveAppSetting('allow_registration', this.checked ? '1' : '0')">
            Cho phép người dùng tự đăng ký tài khoản
          </label>
          <p style="font-size:.8rem;color:var(--text2);margin-top:.5rem">Khi bật, form đăng nhập sẽ hiện link "Đăng ký". User mới sẽ có 0 pts và cần mua thêm.</p>
        </div>
        <div style="padding:1rem;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">
          <h4 style="margin:0 0 .75rem"><i class="fas fa-envelope" style="color:var(--accent)"></i> Email Admin (nhận thông báo)</h4>
          <div class="form-group" style="margin:0">
            <input type="email" id="setting-admin-email" value="${adminEmail}" placeholder="admin@example.com" style="width:100%">
          </div>
          <button class="btn btn-sm btn-primary" onclick="saveAppSetting('admin_email', $('setting-admin-email').value)" style="margin-top:.5rem"><i class="fas fa-save"></i> Lưu</button>
          <p style="font-size:.8rem;color:var(--text2);margin-top:.5rem">Nhận email khi có yêu cầu mua points hoặc user mới đăng ký. Cần cấu hình SMTP trong .env</p>
        </div>
      </div>
    </div>`;
  } catch (e) { el.innerHTML = '<p style="color:var(--error)">Lỗi tải cài đặt</p>'; }
}

async function saveAppSetting(key, value) {
  try {
    const res = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ key, value }) });
    if (res.ok) {
      showToast('✅ Đã lưu cài đặt', 'success');
      if (key === 'allow_registration') checkRegistrationEnabled();
    }
    else showToast('Lỗi lưu cài đặt', 'error');
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

// Poll purchase request badge cho admin
async function pollAdminPRBadge() {
  if (currentUser?.role !== 'admin') return;
  try {
    const res = await api('/api/admin/purchase-requests?status=pending');
    const d = await res.json();
    const badge = $('admin-pr-badge');
    if (!badge) return;
    if (d.pending_count > 0) { badge.textContent = d.pending_count; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
  } catch {}
}
