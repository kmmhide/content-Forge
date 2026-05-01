// ═══════ ContentForge Studio V2 — Batch Mode (Server-Driven) ═══════
// All pipeline execution happens on the server. This file only handles UI.

// ──── Helpers ────
function updateBatchKwCount() {
  const el = $('b-kw-count');
  if (!el) return;
  const count = $('b-keywords').value.split('\n').filter(k => k.trim()).length;
  el.textContent = count > 0 ? `(${count} keywords)` : '';
}

function getBatchConfig() {
  const wpStatusRadio = document.querySelector('input[name="b-wp-status"]:checked');
  return {
    field: $('b-field').value.trim(), company: $('b-company').value.trim(),
    style: $('b-style').value.trim(), reference: $('b-reference').value.trim(),
    topic_id: $('b-topic').value || null,
    reviewMode: $('b-review-toggle').classList.contains('on') ? 'auto' : 'manual',
    enableImages: $('b-image-toggle').classList.contains('on'),
    enableLinks: $('b-enable-links')?.checked || false,
    internalLinks: [],
    intentBot: $('b-intentBot').value, outlineBot: $('b-outlineBot').value,
    evalBot: $('b-evalBot').value, articleBot: $('b-articleBot').value,
    imagePromptBot: $('b-imagePromptBot')?.value || $('b-intentBot').value,
    imageBot: $('b-imageBot').value,
    skipGrouping: $('b-skip-grouping-toggle')?.classList.contains('on') || false,
    fullPipeline: $('b-fullpipeline-toggle')?.classList.contains('on') || false,
    wpConfigId: $('b-wp-site')?.value || null,
    wpPostStatus: wpStatusRadio?.value || 'publish',
  };
}

// ═══════ LOAD WP SITES FOR DROPDOWN ═══════
async function loadBatchWpSites() {
  const sel = $('b-wp-site');
  if (!sel) return;
  try {
    const res = await api('/api/wp/configs');
    const d = await res.json();
    const configs = d.configs || [];
    sel.innerHTML = '<option value="">— Không đăng WP —</option>' +
      configs.map(c => `<option value="${c.id}" ${c.is_default ? 'selected' : ''}>${c.site_name} (${c.site_url})</option>`).join('');
  } catch { sel.innerHTML = '<option value="">— Không có WP site —</option>'; }
}

// ═══════ MAIN ENTRY: Start Batch via Server API ═══════
async function batchStart() {
  const kws = $('b-keywords').value.split('\n').map(k => k.trim()).filter(k => k);
  const field = $('b-field').value.trim();
  if (!field) { showToast('Vui lòng nhập lĩnh vực', 'error'); return; }
  if (kws.length === 0) { showToast('Vui lòng nhập ít nhất 1 keyword', 'error'); return; }

  await loadPromptTemplates();
  const config = getBatchConfig();

  if (config.enableLinks) {
    try {
      const r = await api('/api/urls');
      const d = await r.json();
      config.internalLinks = d.urls || [];
    } catch { config.internalLinks = []; }
  }

  try {
    const res = await api('/api/pipeline/start', {
      method: 'POST',
      body: JSON.stringify({ type: 'batch', config, keywords: kws })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Lỗi', 'error');
    
    showToast(`🚀 Batch (${kws.length} keywords) đã bắt đầu chạy trên server!`, 'success');
    PipelineManager.pollNow();
    batchReset();
  } catch (e) {
    showToast('Lỗi: ' + e.message, 'error');
  }
}

// ═══════ SIDEBAR INTERACTION (via server API) ═══════

async function bqCancel(id) {
  try {
    await api(`/api/pipeline/${id}/cancel`, { method: 'POST' });
    showToast('Batch đã hủy', 'info');
    PipelineManager.pollNow();
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

async function bqRemove(id) {
  await bqCancel(id);
}

// ═══════ VIEW DETAIL MODAL ═══════
function bqViewDetail(id) {
  const p = PipelineManager.getById(id);
  if (!p) return;

  const items = p.batch_items || [];
  const groups = p.groups_data || [];
  const isDone = p.status === 'done';

  let detailRows = '';
  if (p.current_step <= 1 && groups.length > 0 && items.length === 0) {
    detailRows = groups.map((g, i) => `<div style="display:flex;justify-content:space-between;padding:.5rem;font-size:.85rem;border-bottom:1px solid var(--border)">
      <div><strong>${i+1}. ${g.group_name}</strong><br><span style="color:var(--text2)">${g.main_keyword}</span>
      ${g.related_keywords?.length ? '<br><small style="color:var(--text3)">+ ' + g.related_keywords.join(', ') + '</small>' : ''}
      </div></div>`).join('');
  } else if (items.length > 0) {
    detailRows = items.map((a, i) => {
      const itemId = a.id || `legacy-${i}`;
      let status = '○ Chờ';
      let statusColor = 'var(--text2)';
      if (a.intentStatus === 'processing') { status = '⏳ Phân tích...'; statusColor = 'var(--accent)'; }
      else if (a.outlineStatus === 'processing') { status = '⏳ Dàn ý...'; statusColor = 'var(--accent)'; }
      else if (a.reviewStatus === 'processing' || a.reviewStatus === 'regenerating') { status = '⏳ Đánh giá...'; statusColor = 'var(--accent)'; }
      else if (a.articleStatus === 'processing') { status = '⏳ Viết bài...'; statusColor = 'var(--accent)'; }
      else if (a.articleStatus === 'done') { status = `✅ ${a.wordCount || 0} từ`; statusColor = 'var(--success)'; }
      else if (a.articleStatus === 'error' || a.intentStatus === 'error') { status = '❌ Lỗi'; statusColor = 'var(--error)'; }
      else if (a.articleStatus === 'skipped') status = '⏭ Bỏ qua';
      else if (a.reviewStatus === 'approved') { status = '✅ Đã duyệt'; statusColor = 'var(--success)'; }
      else if (a.outlineStatus === 'done') { status = '📝 Có dàn ý'; statusColor = 'var(--info)'; }
      else if (a.intentStatus === 'done') { status = '🧠 Phân tích xong'; statusColor = 'var(--info)'; }
      
      const viewBtn = `<button class="btn btn-sm btn-secondary" onclick="this.closest('.modal-overlay').remove();viewBatchItem(${id}, '${itemId}')" style="padding:.15rem .4rem;font-size:.75rem" title="Xem chi tiết"><i class="fas fa-eye"></i></button>`;
      
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:.375rem .5rem;font-size:.85rem;border-bottom:1px solid var(--border)">
        <span>${i+1}. ${a.keyword}</span>
        <div style="display:flex;align-items:center;gap:.5rem">
          <span style="color:${statusColor};font-size:.8rem">${status}</span>
          ${viewBtn}
        </div>
      </div>`;
    }).join('');
  } else {
    detailRows = '<div style="padding:1rem;text-align:center;color:var(--text2)">Chưa có dữ liệu</div>';
  }

  showModal(`📦 Pipeline #${p.id} — ${p.step_label}`, `
    <div style="margin-bottom:.75rem">
      <span class="badge badge-info">${p.config?.field || ''}</span>
      <span class="badge ${isDone ? 'badge-success' : p.status === 'error' ? 'badge-error' : 'badge-warning'}">${isDone ? 'Hoàn thành' : p.status === 'error' ? 'Lỗi' : 'Đang chạy'}</span>
      ${p.config?.fullPipeline ? '<span class="badge badge-info">Full Pipeline</span>' : ''}
    </div>
    <p style="font-size:.8rem;color:var(--text2);margin-bottom:.5rem">💡 Click <i class="fas fa-eye"></i> để xem chi tiết từng bài</p>
    <div style="max-height:50vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px">${detailRows}</div>
  `, []);
}

// ═══════ GROUP REVIEW MODAL (server-driven) ═══════
function bqShowGroupReview(id) {
  // Save scroll position before removing old modal
  const existingScroll = document.getElementById('bq-groups-scroll');
  const savedScroll = existingScroll ? existingScroll.scrollTop : 0;
  document.querySelectorAll('.modal-overlay').forEach(el => el.remove());

  // Only fetch from server on first open, then use local edited copy
  if (!window._bqEditGroups || window._bqEditGroupsPipelineId !== id) {
    const p = PipelineManager.getById(id);
    if (!p) return;
    const groups = p.groups_data || [];
    if (groups.length === 0) return;
    window._bqEditGroups = JSON.parse(JSON.stringify(groups));
    window._bqEditGroupsPipelineId = id;
  }

  const groups = window._bqEditGroups;

  const cards = groups.map((g, i) => `
    <div class="card" style="background:var(--surface2);margin-bottom:.5rem;padding:.75rem">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1">
          <strong>📁 Nhóm ${i+1}: ${g.group_name}</strong>
          <div class="form-group" style="margin:.5rem 0 .25rem"><label style="font-size:.8rem">Keyword chính</label>
            <input value="${g.main_keyword}" onchange="window._bqEditGroups[${i}].main_keyword=this.value" style="padding:.375rem .5rem;font-size:.875rem"></div>
          ${g.related_keywords?.length ? `<div style="font-size:.8rem;color:var(--text2)">Liên quan: ${g.related_keywords.join(', ')}</div>` : ''}
          ${g.insight ? `<div style="font-size:.8rem;color:var(--text2);font-style:italic">${g.insight}</div>` : ''}
        </div>
        <button class="btn btn-sm btn-danger" onclick="bqDeleteGroup(${i},${id})" style="margin-left:.5rem"><i class="fas fa-trash"></i></button>
      </div>
    </div>`).join('');

  showModal(`📋 Pipeline #${id} — ${groups.length} nhóm keyword`, `
    <div id="bq-groups-scroll" style="max-height:50vh;overflow-y:auto">${cards}</div>
    <div style="display:flex;gap:.5rem;margin-top:.75rem">
      <button class="btn btn-sm btn-secondary" onclick="bqAddManualGroup(${id})"><i class="fas fa-plus"></i> Thêm nhóm</button>
    </div>
  `, [{
    text: '✅ Xác nhận & Tiếp tục', cls: 'btn-primary',
    fn: `function(){bqConfirmGroups(${id})}`
  }]);

  // Restore scroll position after modal renders
  requestAnimationFrame(() => {
    const scrollEl = document.getElementById('bq-groups-scroll');
    if (scrollEl && savedScroll > 0) scrollEl.scrollTop = savedScroll;
  });
}

function bqDeleteGroup(index, pipelineId) {
  window._bqEditGroups.splice(index, 1);
  bqShowGroupReview(pipelineId);
}

function bqAddManualGroup(id) {
  showModal('Thêm nhóm', `
    <div class="form-group"><label>Keywords (mỗi dòng = 1 nhóm)</label>
    <textarea id="bq-add-kws" rows="5" placeholder="keyword 1\nkeyword 2"></textarea></div>
  `, [{
    text: 'Thêm', cls: 'btn-primary',
    fn: `function(){
      var kws=document.getElementById('bq-add-kws').value.split(String.fromCharCode(10)).map(function(k){return k.trim()}).filter(function(k){return k});
      if(kws.length>0){kws.forEach(function(k){window._bqEditGroups.push({group_name:k,main_keyword:k,related_keywords:[],insight:'Thêm thủ công'})});}
      bqShowGroupReview(${id});
    }`
  }]);
}

async function bqConfirmGroups(id) {
  try {
    await api(`/api/pipeline/${id}/confirm-groups`, {
      method: 'POST',
      body: JSON.stringify({ groups: window._bqEditGroups })
    });
    // Reset local cache
    window._bqEditGroups = null;
    window._bqEditGroupsPipelineId = null;
    showToast(`Pipeline #${id}: Đã xác nhận nhóm, tiếp tục pipeline...`, 'success');
    PipelineManager.pollNow();
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

// ═══════ MANUAL OUTLINE REVIEW MODAL (server-driven) ═══════
function bqOpenManualReview(id) {
  document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
  const p = PipelineManager.getById(id);
  if (!p) return;
  const items = p.batch_items || [];

  // Store items locally for editing and ensure UUIDs exist
  window._bqEditItems = JSON.parse(JSON.stringify(items)).map((it, idx) => {
    if (!it.id) it._legacy_idx = `legacy-${idx}`;
    return it;
  });

  const cards = window._bqEditItems.map((a, i) => {
    if (a.outlineStatus !== 'done') return `<div class="card" style="margin-bottom:.5rem;opacity:.5;padding:.75rem"><strong>${i+1}. ${a.keyword}</strong> — Lỗi outline</div>`;
    const bg = a.approved ? 'rgba(76,175,80,0.08)' : 'var(--surface2)';
    const badge = a.approved ? '<span class="badge badge-success">✅ Duyệt</span>' : '<span class="badge badge-warning">Chưa</span>';
    const itemId = a.id || `legacy-${i}`;
    const editId = `bq-outline-edit-${id}-${itemId}`;
    const previewId = `bq-outline-preview-${id}-${itemId}`;
    const scoreHtml = a.reviewScore ? `<span class="badge badge-info">${a.reviewScore}/100</span>` : '';
    return `<div class="card" style="margin-bottom:.75rem;background:${bg};padding:.75rem" id="bq-card-${id}-${itemId}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <strong>${i+1}. ${a.keyword}</strong>
        <div style="display:flex;gap:.25rem;align-items:center">${scoreHtml} ${badge}</div>
      </div>
      <div id="${previewId}" class="md-preview" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);padding:.75rem;border-radius:6px;font-size:.85rem;margin-bottom:.5rem">${marked.parse(a.outline)}</div>
      <textarea id="${editId}" data-uuid="${itemId}" class="bq-outline-textarea" style="display:none;width:100%;min-height:200px;padding:.75rem;border:1px solid var(--border);border-radius:6px;font-size:.85rem;margin-bottom:.5rem;font-family:inherit;background:var(--surface);color:var(--text);resize:vertical">${a.outline}</textarea>
      <div style="display:flex;gap:.375rem;flex-wrap:wrap">
        <button class="btn btn-sm ${a.approved ? 'btn-secondary' : 'btn-primary'}" onclick="bqApproveItem(${id}, '${itemId}')">${a.approved ? 'Đã duyệt' : '<i class="fas fa-check"></i> Duyệt'}</button>
        <button class="btn btn-sm btn-secondary" onclick="bqToggleEdit(${id}, '${itemId}')" id="bq-edit-btn-${id}-${itemId}"><i class="fas fa-edit"></i> Sửa</button>
        <button class="btn btn-sm btn-secondary" id="bq-ai-review-btn-${id}-${itemId}" onclick="bqAIReviewItem(${id}, '${itemId}')" title="AI đánh giá & tối ưu dàn ý"><i class="fas fa-magic"></i> <span class="btn-text">AI Review</span></button>
      </div>
    </div>`;
  }).join('');

  showModal(`📋 Duyệt dàn ý — Pipeline #${id}`, `
    <div style="max-height:60vh;overflow-y:auto">${cards}</div>
    <div class="form-group" style="margin-top:.75rem"><label>Ghi chú chung cho AI (áp dụng khi viết bài)</label>
      <textarea id="bq-manual-notes-${id}" rows="2" placeholder="Ghi chú thêm..." style="font-size:.875rem"></textarea>
    </div>
    <div style="margin-top:.75rem;display:flex;gap:.5rem;flex-wrap:wrap">
      <button class="btn btn-secondary" onclick="bqApproveAllItems(${id})"><i class="fas fa-check-double"></i> Duyệt tất cả</button>
    </div>
  `, [{ text: 'Xác nhận & Viết bài', cls: 'btn-primary', fn: `function(){bqConfirmManualReview(${id})}` }]);
}

function bqToggleEdit(batchId, itemUuid) {
  const editEl = document.getElementById(`bq-outline-edit-${batchId}-${itemUuid}`);
  const previewEl = document.getElementById(`bq-outline-preview-${batchId}-${itemUuid}`);
  const btnEl = document.getElementById(`bq-edit-btn-${batchId}-${itemUuid}`);
  if (!editEl || !previewEl) return;
  const isEditing = editEl.style.display !== 'none';
  if (isEditing) {
    const item = window._bqEditItems.find(it => (it.id || it._legacy_idx) === itemUuid);
    if (item) item.outline = editEl.value;
    previewEl.innerHTML = marked.parse(editEl.value);
    editEl.style.display = 'none';
    previewEl.style.display = '';
    if (btnEl) btnEl.innerHTML = '<i class="fas fa-edit"></i> Sửa';
  } else {
    editEl.style.display = '';
    previewEl.style.display = 'none';
    if (btnEl) btnEl.innerHTML = '<i class="fas fa-save"></i> Lưu';
    editEl.focus();
  }
}

function bqApproveItem(batchId, itemUuid) {
  const editEl = document.getElementById(`bq-outline-edit-${batchId}-${itemUuid}`);
  const item = window._bqEditItems.find(it => (it.id || it._legacy_idx) === itemUuid);
  if (!item) return;
  
  if (editEl && editEl.style.display !== 'none') {
    item.outline = editEl.value;
  }
  item.approved = true;
  item.reviewStatus = 'approved';
  bqOpenManualReview(batchId);
}

function bqApproveAllItems(batchId) {
  if (!window._bqEditItems) return;
  window._bqEditItems.forEach(a => { if (a.outlineStatus === 'done') { a.approved = true; a.reviewStatus = 'approved'; } });
  bqOpenManualReview(batchId);
}

async function bqConfirmManualReview(batchId) {
  const notesEl = document.getElementById(`bq-manual-notes-${batchId}`);
  const notes = notesEl ? notesEl.value : '';
  
  // Robust collection: Sync all textareas back to state
  document.querySelectorAll('.bq-outline-textarea').forEach(ta => {
    const uuid = ta.dataset.uuid;
    const item = window._bqEditItems.find(it => (it.id || it._legacy_idx) === uuid);
    if (item) item.outline = ta.value;
  });

  try {
    await api(`/api/pipeline/${batchId}/confirm-review`, {
      method: 'POST',
      body: JSON.stringify({ items: window._bqEditItems, notes })
    });
    showToast(`Pipeline #${batchId}: Đã xác nhận, tiếp tục viết bài...`, 'success');
    PipelineManager.pollNow();
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

async function bqAIReviewItem(batchId, itemUuid) {
  const item = window._bqEditItems.find(it => (it.id || it._legacy_idx) === itemUuid);
  if (!item) return;
  const p = PipelineManager.getById(batchId);
  if (!p) return;
  const cfg = p.config;
  
  const btn = document.getElementById(`bq-ai-review-btn-${batchId}-${itemUuid}`);
  if (!btn) return;
  btn.classList.add('btn-loading');
  btn.disabled = true;

  try {
    const kw = item.keyword;
    const field = cfg.field;
    
    // 1. Evaluate
    const evalPrompt = buildPrompt(promptTemplates.eval_prompt, {
      keywords: kw,
      intent_json: item.intentData ? JSON.stringify(item.intentData, null, 2) : '{}',
      outline: item.outline
    });
    
    const evalRes = await api('/api/chat', { method: 'POST', body: JSON.stringify({ bot: cfg.evalBot, prompt: evalPrompt, stream: false }) });
    const evalData = await evalRes.json();
    const evalContent = evalData.choices?.[0]?.message?.content || '';
    
    let evalJson = null;
    try {
      const match = evalContent.match(/\{[\s\S]*\}/);
      if (match) evalJson = JSON.parse(match[0]);
    } catch {}
    
    if (!evalJson) throw new Error('Không thể phân tích đánh giá từ AI');

    const score = evalJson.overall_score ?? evalJson.score ?? 0;
    
    // 2. Regenerate to improve
    const regenPrompt = buildPrompt(promptTemplates.regenerate_prompt, {
      keywords: kw,
      intent_json: item.intentData ? JSON.stringify(item.intentData, null, 2) : '{}',
      original_outline: item.outline,
      evaluation_json: JSON.stringify(evalJson, null, 2),
      context_info: buildContextInfo(field, cfg.company, cfg.style)
    });
    
    const regenRes = await api('/api/chat', { method: 'POST', body: JSON.stringify({ bot: cfg.outlineBot, prompt: regenPrompt, stream: false }) });
    const regenData = await regenRes.json();
    const regenRaw = regenData.choices?.[0]?.message?.content || '';
    
    item.outline = cleanRegenOutline(regenRaw, kw);
    item.reviewScore = score;
    item.reviewStatus = 'approved';
    item.approved = true;

    showToast(`✅ Đã tối ưu outline cho "${kw}" (Score: ${score}/100)`, 'success');
    
    // Refresh modal
    bqOpenManualReview(batchId);
  } catch (e) {
    console.error('[bqAIReviewItem] Error:', e);
    showToast('Lỗi AI Review: ' + e.message, 'error');
  } finally {
    btn.classList.remove('btn-loading');
    btn.disabled = false;
  }
}

// ═══════ BATCH FROM OUTLINES (from history tab) ═══════
async function batchFromOutlines(outlineDataArray) {
  const config = getBatchConfig();
  const first = outlineDataArray[0] || {};
  config.field = first.field || config.field;
  config.company = first.company || config.company;
  config.style = first.style || config.style;

  const kws = outlineDataArray.map(a => a.keyword || '').filter(k => k);
  // For now, create a batch pipeline on the server
  // The server will need to handle "from outlines" differently later
  try {
    const res = await api('/api/pipeline/start', {
      method: 'POST',
      body: JSON.stringify({ type: 'batch', config, keywords: kws })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Lỗi', 'error');
    showToast(`📦 Batch viết ${kws.length} bài từ outline...`, 'info');
    PipelineManager.pollNow();
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

// ═══════ LEGACY HELPERS ═══════
function batchReset() {
  $('b-keywords').value = '';
  updateBatchKwCount();
}

// ═══════ RENDER BATCH CARDS FOR SIDEBAR ═══════
// Called by app.js renderSidebar() — returns HTML string of batch pipeline cards
// Each batch item is rendered as its own individual card (like single mode)
function renderBatchSidebarCards() {
  const batches = PipelineManager.pipelines.filter(p => p.type === 'batch');
  if (batches.length === 0) return '';

  let html = '';

  for (const p of batches) {
    const items = p.batch_items || [];
    const groups = p.groups_data || [];
    const totalItems = items.length || (p.raw_keywords || []).length;
    const isDone = p.status === 'done';
    const isError = p.status === 'error';
    const isPaused = p.status === 'paused';
    const isGroupReview = isPaused && p.current_step <= 1 && groups.length > 0;
    const isOutlineReview = isPaused && p.current_step === 4;

    // Batch group header card
    let headerStatus, headerIcon, headerClass;
    if (isDone) { headerIcon = '✅'; headerStatus = 'Hoàn thành'; headerClass = 'pl-card-done'; }
    else if (isError) { headerIcon = '❌'; headerStatus = 'Lỗi'; headerClass = 'pl-card-error'; }
    else if (isGroupReview) { headerIcon = '📋'; headerStatus = 'Chờ xác nhận nhóm'; headerClass = 'pl-card-paused'; }
    else if (isOutlineReview) { headerIcon = '📋'; headerStatus = 'Chờ duyệt dàn ý'; headerClass = 'pl-card-paused'; }
    else if (isPaused) { headerIcon = '⏸'; headerStatus = 'Tạm dừng'; headerClass = 'pl-card-paused'; }
    else { headerIcon = '🔄'; headerStatus = 'Đang chạy'; headerClass = 'pl-card-running'; }

    const doneCount = items.filter(a => a.articleStatus === 'done').length;

    // Group header actions
    let headerActions = '';
    if (isGroupReview) {
      headerActions = `<button class="btn btn-primary btn-sm" onclick="bqShowGroupReview(${p.id})"><i class="fas fa-list"></i> Xem nhóm</button>`;
    } else if (isOutlineReview) {
      headerActions = `<button class="btn btn-primary btn-sm" onclick="bqOpenManualReview(${p.id})"><i class="fas fa-clipboard-check"></i> Duyệt</button>`;
    }
    headerActions += ` <button class="btn btn-secondary btn-sm" onclick="bqViewLogs(${p.id})" title="Xem log"><i class="fas fa-clipboard-list"></i></button>`;
    if (!isDone && !isError) {
      headerActions += ` <button class="btn btn-secondary btn-sm" onclick="bqCancel(${p.id})" style="opacity:.6" title="Hủy"><i class="fas fa-times"></i></button>`;
    } else {
      headerActions += ` <button class="btn btn-secondary btn-sm" onclick="bqRemove(${p.id})" style="opacity:.6" title="Xóa"><i class="fas fa-trash"></i></button>`;
    }

    html += `<div class="pl-card ${headerClass}" style="border-left:3px solid var(--accent)">
      <div class="pl-time">${headerIcon} ${formatTime(p.created_at)}</div>
      <div class="pl-status ${isDone ? 'pl-status-done' : isError ? 'pl-status-error' : isPaused ? 'pl-status-paused' : 'pl-status-running'}">${headerStatus}</div>
      <div class="pl-keyword">📦 Batch #${p.id} — ${totalItems} bài${p.config?.fullPipeline ? ' 🔄' : ''}</div>
      <div class="pl-step">${isDone ? `${doneCount}/${items.length} bài hoàn thành` : `Step ${p.current_step}/7 — ${p.step_label}`}</div>
      <div class="pl-actions">${headerActions}</div>
    </div>`;

    // Individual item cards (only when items exist)
    if (items.length > 0) {
      items.forEach((a, i) => {
        const itemId = a.id || `legacy-${i}`;
        const itemStep = getBatchItemStep(a);
        const itemStepLabel = getBatchItemStepLabel(a);
        const itemPct = Math.round((itemStep / 7) * 100);

        let itemStatusIcon, itemStatusText, itemCardClass;
        if (a.articleStatus === 'done') { itemStatusIcon = '✅'; itemStatusText = `${a.wordCount || 0} từ`; itemCardClass = 'pl-card-done'; }
        else if (a.articleStatus === 'error' || a.intentStatus === 'error' || a.outlineStatus === 'error') { itemStatusIcon = '❌'; itemStatusText = 'Lỗi'; itemCardClass = 'pl-card-error'; }
        else if (a.articleStatus === 'processing' || a.outlineStatus === 'processing' || a.intentStatus === 'processing' || a.reviewStatus === 'processing') { itemStatusIcon = '⏳'; itemStatusText = 'Đang xử lý'; itemCardClass = 'pl-card-running'; }
        else if (a.reviewStatus === 'approved' && a.articleStatus !== 'done') { itemStatusIcon = '🟢'; itemStatusText = 'Đã duyệt'; itemCardClass = 'pl-card-running'; }
        else { itemStatusIcon = '○'; itemStatusText = 'Chờ'; itemCardClass = ''; }

        const isItemViewing = PipelineManager.viewingItemId === itemId && PipelineManager.viewingId === p.id;
        const viewingBorder = isItemViewing ? 'outline:2px solid var(--accent);outline-offset:2px;' : '';
        const progressBar = (a.articleStatus !== 'done' && a.articleStatus !== 'error') ? `<div class="pl-progress"><div class="pl-progress-fill" style="width:${itemPct}%"></div></div>` : '';

        let itemActions = `<button class="btn btn-secondary btn-sm" onclick="viewBatchItem(${p.id}, '${itemId}')"><i class="fas fa-eye"></i> Xem</button>`;
        if (a.articleStatus === 'error') {
          itemActions += ` <button class="btn btn-warning btn-sm" onclick="bqRetryItem(${p.id}, '${itemId}')" title="Retry"><i class="fas fa-redo"></i></button>`;
        }

        html += `<div class="pl-card ${itemCardClass}" style="margin-left:1rem;border-left:2px solid var(--border);${viewingBorder}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="pl-keyword" style="font-size:.8rem">${itemStatusIcon} "${a.keyword}"</div>
          </div>
          <div class="pl-step" style="font-size:.75rem">${itemStepLabel}</div>
          ${progressBar}
          <div class="pl-actions">${itemActions}</div>
        </div>`;
      });
    }
  }

  return html;
}

// Helper: Map batch item status → step number (1-7)
function getBatchItemStep(item) {
  if (item.articleStatus === 'done') return 7;
  if (item.articleStatus === 'processing') return 5;
  if (item.reviewStatus === 'approved' && item.articleStatus !== 'done') return 5;
  if (item.reviewStatus === 'processing' || item.reviewStatus === 'regenerating') return 4;
  if (item.outlineStatus === 'done' && item.reviewStatus !== 'approved') return 4;
  if (item.outlineStatus === 'processing') return 3;
  if (item.intentStatus === 'done' && item.outlineStatus !== 'done') return 3;
  if (item.intentStatus === 'processing') return 2;
  return 1;
}

// Helper: Get human-readable step label for batch item
function getBatchItemStepLabel(item) {
  if (item.articleStatus === 'done') return `Hoàn thành — ${item.wordCount || 0} từ`;
  if (item.articleStatus === 'error') return `Lỗi: ${(item.error || '').substring(0, 50)}`;
  if (item.articleStatus === 'processing') return 'Step 5/7 — Đang viết bài...';
  if (item.reviewStatus === 'approved' && item.articleStatus !== 'done') return 'Step 4 ✓ — Chờ viết bài';
  if (item.reviewStatus === 'processing' || item.reviewStatus === 'regenerating') return 'Step 4/7 — AI đang đánh giá...';
  if (item.outlineStatus === 'done' && !item.approved) return 'Step 4/7 — Chờ đánh giá';
  if (item.outlineStatus === 'processing') return 'Step 3/7 — Đang tạo dàn ý...';
  if (item.intentStatus === 'done') return 'Step 2 ✓ — Phân tích xong';
  if (item.intentStatus === 'processing') return 'Step 2/7 — Đang phân tích...';
  if (item.intentStatus === 'error') return 'Lỗi phân tích ý định';
  return 'Step 1/7 — Chờ xử lý';
}

// ═══════ RETRY & LOGS ═══════
async function bqRetryPipeline(id) {
  try {
    const res = await api(`/api/pipeline/${id}/retry`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Lỗi', 'error');
    showToast(`Pipeline #${id}: Retry lần ${data.retry_count}...`, 'info');
    PipelineManager.pollNow();
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

async function bqRetryItem(pipelineId, itemId) {
  try {
    const res = await api(`/api/pipeline/${pipelineId}/retry-item`, {
      method: 'POST',
      body: JSON.stringify({ item_id: itemId })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Lỗi', 'error');
    showToast(`Retry item thành công`, 'success');
    PipelineManager.pollNow();
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

async function bqViewLogs(id) {
  try {
    const res = await api(`/api/pipeline/${id}/logs`);
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Lỗi', 'error');
    const logs = data.logs || [];
    if (logs.length === 0) {
      return showModal(`📋 Pipeline #${id} — Logs`, '<div style="padding:1rem;text-align:center;color:var(--text2)">Chưa có log</div>', []);
    }
    const rows = logs.map(l => {
      const statusIcon = l.status === 'done' ? '✅' : l.status === 'error' ? '❌' : l.status === 'start' ? '▶️' : l.status === 'paused' ? '⏸' : '•';
      const dur = l.duration_ms ? `<span style="color:var(--text3);font-size:.75rem">${l.duration_ms}ms</span>` : '';
      const meta = l.metadata ? `<div style="font-size:.7rem;color:var(--text3);margin-top:.125rem">${typeof l.metadata === 'object' ? JSON.stringify(l.metadata) : l.metadata}</div>` : '';
      const time = l.created_at ? new Date(l.created_at).toLocaleTimeString('vi-VN') : '';
      return `<div style="display:flex;gap:.5rem;padding:.375rem .5rem;border-bottom:1px solid var(--border);font-size:.8rem;align-items:flex-start">
        <span style="flex-shrink:0;width:1.25rem;text-align:center">${statusIcon}</span>
        <div style="flex:1;min-width:0">
          <div><strong>${l.step}</strong> ${l.message || ''}${l.item_id ? ` <span style="color:var(--text3)">[${l.item_id.substring(0,8)}]</span>` : ''}</div>
          ${meta}
        </div>
        <div style="flex-shrink:0;text-align:right">${dur}<br><span style="font-size:.7rem;color:var(--text3)">${time}</span></div>
      </div>`;
    }).join('');
    showModal(`📋 Pipeline #${id} — ${logs.length} events`, `
      <div style="max-height:60vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px">${rows}</div>
    `, []);
  } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}
