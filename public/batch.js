// ═══════ ContentForge Studio V2 — Batch Mode (Full Background Architecture) ═══════

// ──── Batch Queue: Multiple batches run in background, shown in sidebar ────
const batchQueue = [];
let batchNextId = 1;

// ──── Helpers ────
const batchDelay = ms => new Promise(r => setTimeout(r, ms));

async function batchApiCall(bot, prompt, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const wait = 3000 * attempt;
      console.log(`[Batch] Retry ${attempt}/${maxRetries}, waiting ${wait}ms...`);
      await batchDelay(wait);
    }
    try {
      const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ bot, prompt, stream: false }) });
      if (res.status === 429 || res.status === 503) {
        console.warn(`[Batch] Rate limited (${res.status}), retry ${attempt+1}/${maxRetries}`);
        if (attempt === maxRetries - 1) throw new Error(`API quá tải (${res.status}) sau ${maxRetries} lần thử`);
        continue;
      }
      if (!res.ok) throw new Error(`API lỗi ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === maxRetries - 1) throw e;
    }
  }
  throw new Error('API failed after retries');
}

function updateBatchKwCount() {
  const el = $('b-kw-count');
  if (!el) return;
  const count = $('b-keywords').value.split('\n').filter(k => k.trim()).length;
  el.textContent = count > 0 ? `(${count} keywords)` : '';
}

function getBatchConfig() {
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

// ═══════ MAIN ENTRY: Start Batch (Background from Phase 1) ═══════
async function batchStart() {
  const kws = $('b-keywords').value.split('\n').map(k => k.trim()).filter(k => k);
  const field = $('b-field').value.trim();
  if (!field) { showToast('Vui lòng nhập lĩnh vực', 'error'); return; }
  if (kws.length === 0) { showToast('Vui lòng nhập ít nhất 1 keyword', 'error'); return; }

  // Refetch prompt templates
  await loadPromptTemplates();

  const config = getBatchConfig();

  // Create batch instance immediately
  const b = {
    id: batchNextId++,
    type: 'batch',
    phase: 1,
    status: 'running',
    paused: false,
    cancelled: false,
    config: { ...config },
    rawKeywords: [...kws],
    groups: [],
    items: [],
    allWrittenKeywords: [],
    manualNotes: '',
    waitingManualReview: false,
    waitingGroupReview: false,
    createdAt: new Date(),
    stepLabel: 'Đang phân nhóm keyword...',
  };

  // Fetch internal links if enabled
  if (config.enableLinks) {
    try {
      const r = await api('/api/urls');
      const d = await r.json();
      b.config.internalLinks = d.urls || [];
    } catch { b.config.internalLinks = []; }
  }

  // Push to queue & update sidebar
  batchQueue.push(b);
  renderSidebar();

  // Show toast and let user continue
  showToast(`🚀 Batch #${b.id} (${kws.length} keywords) đang chạy ngầm! Xem sidebar →`, 'success');

  // Start full background pipeline (don't await)
  runBatchFullPipeline(b);
}

// ═══════ FULL BACKGROUND PIPELINE ═══════
async function runBatchFullPipeline(b) {
  try {
    // Phase 1: AI Keyword Grouping (or skip if skipGrouping is ON)
    b.phase = 1;
    if (b.config.skipGrouping) {
      // Skip AI grouping — each keyword = 1 article
      b.stepLabel = 'Bỏ qua phân nhóm — mỗi keyword = 1 bài';
      b.groups = b.rawKeywords.map(k => ({ group_name: k, main_keyword: k, related_keywords: [], insight: 'Không nhóm' }));
      renderSidebar();
    } else {
      b.stepLabel = 'Đang phân nhóm keyword...';
      renderSidebar();
      await batchRunGrouping(b);
      if (b.cancelled) return;
    }

    // If NOT full pipeline AND NOT skipGrouping, pause for group review
    if (!b.config.fullPipeline && !b.config.skipGrouping) {
      b.waitingGroupReview = true;
      b.stepLabel = `Chờ xác nhận ${b.groups.length} nhóm`;
      b.status = 'paused';
      renderSidebar();
      showToast(`📋 Batch #${b.id}: Phân nhóm xong (${b.groups.length} nhóm) — xác nhận trong sidebar`, 'info');

      // Wait for user confirmation
      while (b.waitingGroupReview && !b.cancelled) {
        await batchDelay(500);
      }
      if (b.cancelled) return;
      b.status = 'running';
    }

    // Create items from groups
    b.items = b.groups.map(g => ({
      keyword: g.main_keyword, related: (g.related_keywords || []).join(', '),
      intentData: null, intentStatus: 'pending',
      outline: '', outlineStatus: 'pending',
      reviewStatus: 'pending', reviewScore: null,
      article: '', articleHtml: '', wordCount: 0, articleStatus: 'pending', articleStep: '',
      images: [], articleId: null, suggestions: [], error: null, approved: false
    }));

    // Phase 2: Intent
    b.phase = 2; b.stepLabel = 'Phân tích ý định...'; renderSidebar();
    await batchRunPhase2(b);
    if (b.cancelled) return;

    // Phase 3: Outline
    b.phase = 3; b.stepLabel = 'Tạo dàn ý...'; renderSidebar();
    await batchRunPhase3(b);
    if (b.cancelled) return;

    // Phase 4: Review
    b.phase = 4; b.stepLabel = 'Đánh giá dàn ý...'; renderSidebar();
    await batchRunPhase4(b);
    if (b.cancelled) return;

    // Phase 5: Write articles
    b.phase = 5; b.stepLabel = 'Viết bài...'; renderSidebar();
    await batchRunPhase5(b);
    if (b.cancelled) return;

    // Phase 6: Done + WP Publish (if full pipeline)
    b.phase = 6;
    if (b.config.fullPipeline && b.config.wpConfigId) {
      b.stepLabel = 'Đang đăng WP...'; renderSidebar();
      await batchRunWpPublish(b);
    }

    b.status = 'done';
    b.stepLabel = 'Hoàn thành!';
    renderSidebar();
    const doneCount = b.items.filter(a => a.articleStatus === 'done').length;
    showToast(`🎉 Batch #${b.id} hoàn thành! ${doneCount}/${b.items.length} bài`, 'success');
    try { loadQuota(); } catch {}
  } catch (e) {
    b.status = 'error';
    b.stepLabel = 'Lỗi: ' + e.message;
    renderSidebar();
    showToast(`❌ Batch #${b.id} lỗi: ${e.message}`, 'error');
  }
}

// ── Phase 1: AI Keyword Grouping ──
async function batchRunGrouping(b) {
  const kws = b.rawKeywords;
  const field = b.config.field;
  try {
    const prompt = `Phân tích và nhóm các keywords SEO sau theo chủ đề/insight chung.\nLĩnh vực: ${field}\n\nKEYWORDS:\n${kws.join('\n')}\n\nQUY TẮC:\n- Mỗi nhóm có 1 chủ đề rõ ràng\n- Keywords quá giống nhau → gộp thành 1 bài\n- Keywords khác biệt rõ → tách bài riêng\n- Mỗi nhóm = 1 bài\n\nTrả lời HOÀN TOÀN bằng JSON:\n[{"group_name":"Tên nhóm","main_keyword":"keyword chính","related_keywords":["kw phụ"],"insight":"Lý do nhóm"}]`;
    const data = await batchApiCall(b.config.intentBot, prompt);
    const content = data.choices?.[0]?.message?.content || '[]';
    const match = content.match(/\[[\s\S]*\]/);
    b.groups = match ? JSON.parse(match[0]) : kws.map(k => ({ group_name: k, main_keyword: k, related_keywords: [], insight: '' }));
    if (!b.groups || b.groups.length === 0) {
      b.groups = kws.map(k => ({ group_name: k, main_keyword: k, related_keywords: [], insight: 'Tự động tạo' }));
    }
  } catch (e) {
    console.warn('[Batch] Grouping error:', e.message);
    b.groups = kws.map(k => ({ group_name: k, main_keyword: k, related_keywords: [], insight: 'Fallback (lỗi API)' }));
  }
  b.stepLabel = `Phân nhóm xong: ${b.groups.length} nhóm`;
  renderSidebar();
}

// ── Phase 2: Intent Analysis ──
async function batchRunPhase2(b) {
  const c = b.config;
  for (let i = 0; i < b.items.length; i++) {
    while (b.paused) await batchDelay(500);
    if (b.cancelled) return;
    if (i > 0) await batchDelay(1500);
    const a = b.items[i];
    a.intentStatus = 'processing';
    b.stepLabel = `Ý định ${i+1}/${b.items.length}`;
    renderSidebar();
    try {
      const prompt = buildPrompt(promptTemplates.intent_prompt, {
        keywords: a.keyword,
        context_info: buildContextInfo(c.field, c.company, c.style)
      });
      const data = await batchApiCall(c.intentBot, prompt);
      const content = data.choices?.[0]?.message?.content || '{}';
      try { a.intentData = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { a.intentData = { raw: content }; }
      a.intentStatus = 'done';
    } catch (e) { a.intentStatus = 'error'; a.error = e.message; }
    renderSidebar();
  }
}

// ── Phase 3: Outline Generation ──
async function batchRunPhase3(b) {
  const c = b.config;
  for (let i = 0; i < b.items.length; i++) {
    while (b.paused) await batchDelay(500);
    if (b.cancelled) return;
    const a = b.items[i];
    if (a.intentStatus === 'error') { a.outlineStatus = 'error'; renderSidebar(); continue; }
    if (i > 0) await batchDelay(1500);
    a.outlineStatus = 'processing';
    b.stepLabel = `Dàn ý ${i+1}/${b.items.length}`;
    renderSidebar();
    try {
      const prompt = buildPrompt(promptTemplates.outline_prompt, {
        keywords: a.keyword,
        intent_json: a.intentData ? JSON.stringify(a.intentData, null, 2) : '{}',
        context_info: buildContextInfo(c.field, c.company, c.style)
      });
      const data = await batchApiCall(c.outlineBot, prompt);
      a.outline = data.choices?.[0]?.message?.content || '';
      a.outlineStatus = 'done';
    } catch (e) { a.outlineStatus = 'error'; a.error = e.message; }
    renderSidebar();
  }
}

// ── Phase 4: Review ──
async function batchRunPhase4(b) {
  const c = b.config;
  // Full Pipeline → always auto review, never pause for user
  if (c.reviewMode === 'auto' || c.fullPipeline) {
    await batchRunAutoReview(b);
  } else {
    // Manual review: pause and wait for user action via sidebar
    b.waitingManualReview = true;
    b.stepLabel = 'Chờ duyệt dàn ý';
    b.status = 'paused';
    renderSidebar();
    showToast(`📋 Batch #${b.id}: Dàn ý sẵn sàng — duyệt trong sidebar`, 'info');
    while (b.waitingManualReview && !b.cancelled) {
      await batchDelay(500);
    }
    if (b.cancelled) return;
    b.status = 'running';
  }
}

async function batchRunAutoReview(b) {
  const c = b.config;
  for (let i = 0; i < b.items.length; i++) {
    if (b.cancelled) return;
    const a = b.items[i];
    if (a.outlineStatus !== 'done') { a.reviewStatus = 'error'; a.error = 'Outline lỗi'; renderSidebar(); continue; }
    if (i > 0) await batchDelay(2000);
    a.reviewStatus = 'processing';
    b.stepLabel = `Đánh giá ${i+1}/${b.items.length}`;
    renderSidebar();
    try {
      let bestOutline = a.outline, bestScore = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const evalPrompt = buildPrompt(promptTemplates.eval_prompt, {
          keywords: a.keyword,
          intent_json: a.intentData ? JSON.stringify(a.intentData, null, 2) : '{}',
          outline: a.outline
        });
        const data = await batchApiCall(c.evalBot, evalPrompt);
        let score = 70;
        try {
          const evalParsed = JSON.parse((data.choices?.[0]?.message?.content||'').match(/\{[\s\S]*\}/)[0]);
          score = evalParsed.overall_score ?? evalParsed.score ?? 70;
        } catch {}
        if (score > bestScore) { bestScore = score; bestOutline = a.outline; }
        a.reviewScore = bestScore;
        if (score >= 70 || attempt === 3) { a.outline = bestOutline; a.reviewStatus = 'approved'; a.approved = true; break; }
        await batchDelay(2000);
        let evalJson = null;
        try { evalJson = JSON.parse((data.choices?.[0]?.message?.content||'').match(/\{[\s\S]*\}/)[0]); } catch {}
        const rp = buildPrompt(promptTemplates.regenerate_prompt, {
          keywords: a.keyword,
          intent_json: a.intentData ? JSON.stringify(a.intentData, null, 2) : '{}',
          original_outline: a.outline,
          evaluation_json: evalJson ? JSON.stringify(evalJson, null, 2) : JSON.stringify({ key_issues: ['Cải thiện chất lượng tổng thể'], improvement_suggestions: [] }),
          context_info: buildContextInfo(c.field, c.company, c.style)
        });
        const regenData = await batchApiCall(c.outlineBot, rp);
        const rRaw = regenData.choices?.[0]?.message?.content || a.outline;
        a.outline = cleanRegenOutline(rRaw, a.keyword);
        a.reviewStatus = 'regenerating'; renderSidebar();
      }
    } catch (e) { a.reviewStatus = 'error'; a.error = e.message; }
    renderSidebar();
  }
}

// ── Phase 5: Write Article ──
async function batchRunPhase5(b) {
  const c = b.config;
  for (let i = 0; i < b.items.length; i++) {
    while (b.paused) await batchDelay(500);
    if (b.cancelled) return;
    const a = b.items[i];
    if (!a.approved || a.outlineStatus !== 'done') { a.articleStatus = 'skipped'; renderSidebar(); continue; }
    a.articleStatus = 'processing';
    b.stepLabel = `Viết bài ${i+1}/${b.items.length}`;
    try {
      a.articleStep = 'Đang viết bài'; renderSidebar();
      const articlePrompt = buildPrompt(promptTemplates.article_prompt, {
        keywords: a.keyword,
        intent_json: a.intentData ? JSON.stringify(a.intentData, null, 2) : '{}',
        outline: a.outline,
        review_feedback: b.manualNotes || '',
        internal_links: (c.enableLinks && c.internalLinks?.length > 0) ? formatInternalLinks(c.internalLinks) : '',
        context_info: buildContextInfo(c.field, c.company, c.style)
      });
      const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ bot: c.articleBot, prompt: articlePrompt, stream: false }) });
      if (!res.ok) throw new Error(`Article API ${res.status}`);
      a.article = (await res.json()).choices?.[0]?.message?.content || '';
      a.articleHtml = marked.parse(a.article);
      a.wordCount = a.article.split(/\s+/).filter(w => w).length;

      // Images
      if (c.enableImages) {
        a.articleStep = 'Đang tạo ảnh'; renderSidebar();
        const sections = parseH2Sections(a.article);
        const imgBot = c.imageBot;
        const imgPromptBot = c.imagePromptBot || c.intentBot;
        const isAR = ['Nano-Banana-Pro','Imagen-4-Ultra','Imagen-4-Fast'].includes(imgBot);
        const totalImgs = sections.length;
        let imgDone = 0;
        await asyncPool(2, sections, async (sec) => {
          try {
            const contextPrompt = buildPrompt(promptTemplates.image_context_prompt, {
              heading: sec.heading, paragraph_content: sec.content.slice(0, 800),
              field: c.field, keywords: a.keyword
            });
            const ctxRes = await api('/api/chat', { method: 'POST', body: JSON.stringify({ bot: imgPromptBot, prompt: contextPrompt, stream: false }) });
            let imgPromptText = (await ctxRes.json()).choices?.[0]?.message?.content?.trim() || '';
            if (imgPromptText && !imgPromptText.toLowerCase().includes('notext')) imgPromptText += ', notext';
            if (!imgPromptText) { imgDone++; return; }
            const params = isAR ? { aspect_ratio: '16:9' } : { aspect: '16:9' };
            for (let retry = 0; retry < 3; retry++) {
              try {
                const iRes = await api('/api/chat', { method: 'POST', body: JSON.stringify({ bot: imgBot, prompt: imgPromptText, stream: false, parameters: params }) });
                const url = ((await iRes.json()).choices?.[0]?.message?.content || '').match(/https?:\/\/[^\s)]+/)?.[0];
                if (url) { a.images.push({ heading: sec.heading, url, prompt: imgPromptText }); break; }
              } catch {}
            }
          } catch {}
          imgDone++;
          a.articleStep = `Ảnh ${imgDone}/${totalImgs}`; renderSidebar();
        });
        if (a.images.length > 0) {
          a.article = insertImagesIntoArticle(a.article, a.images);
          a.articleHtml = marked.parse(a.article);
        }
      }

      // Save DB
      a.articleStep = 'Lưu DB'; renderSidebar();
      const saveRes = await api('/api/articles', { method: 'POST', body: JSON.stringify({
        keyword: a.keyword, field: c.field, company: c.company, style: c.style,
        extra_keywords: a.related, reference_info: c.reference,
        intent_data: a.intentData, outline: a.outline, article: a.article,
        article_html: a.articleHtml, images: a.images, word_count: a.wordCount,
        topic_id: c.topic_id, review_mode: c.reviewMode, outline_status: 'used', status: 'draft'
      }) });
      a.articleId = (await saveRes.json()).id;
      b.allWrittenKeywords.push(a.keyword);
      if (a.related) b.allWrittenKeywords.push(...a.related.split(',').map(k => k.trim()).filter(k => k));

      a.articleStatus = 'done'; a.articleStep = '';
    } catch (e) { a.articleStatus = 'error'; a.articleStep = ''; a.error = e.message; }
    renderSidebar();
  }
}

// ── Phase 6: WP Publish ──
async function batchRunWpPublish(b) {
  let published = 0, failed = 0;
  for (const a of b.items) {
    if (a.articleStatus !== 'done' || !a.articleId) continue;
    try {
      b.stepLabel = `Đăng WP: ${a.keyword}`; renderSidebar();
      const r = await api('/api/wp/publish', {
        method: 'POST',
        body: JSON.stringify({ article_id: a.articleId, wp_config_id: +b.config.wpConfigId })
      });
      if (r.ok) { a.wpPublished = true; published++; }
      else { a.wpPublished = false; a.wpError = 'HTTP ' + r.status; failed++; }
    } catch (e) { a.wpPublished = false; a.wpError = e.message; failed++; }
    await batchDelay(2000);
  }
  if (published > 0) showToast(`📤 ${published} bài đã đăng WP` + (failed ? `, ${failed} lỗi` : ''), published ? 'success' : 'error');
}

// ═══════ SIDEBAR INTERACTION ═══════

function bqTogglePause(id) {
  const b = batchQueue.find(x => x.id === id);
  if (b) { b.paused = !b.paused; showToast(b.paused ? 'Batch tạm dừng' : 'Batch tiếp tục...', 'info'); renderSidebar(); }
}

function bqCancel(id) {
  const b = batchQueue.find(x => x.id === id);
  if (b) { b.cancelled = true; b.status = 'error'; b.stepLabel = 'Đã hủy'; showToast('Batch đã hủy', 'info'); renderSidebar(); }
}

function bqRemove(id) {
  const idx = batchQueue.findIndex(x => x.id === id);
  if (idx !== -1) { batchQueue.splice(idx, 1); renderSidebar(); }
}

// ═══════ VIEW DETAIL MODAL ═══════
function bqViewDetail(id) {
  const b = batchQueue.find(x => x.id === id);
  if (!b) return;

  const isDone = b.status === 'done';
  const totalItems = b.items.length;

  let detailRows = '';
  if (b.phase === 1 && b.groups.length > 0) {
    // Show groups
    detailRows = b.groups.map((g, i) => `<div style="display:flex;justify-content:space-between;padding:.5rem;font-size:.85rem;border-bottom:1px solid var(--border)">
      <div><strong>${i+1}. ${g.group_name}</strong><br><span style="color:var(--text2)">${g.main_keyword}</span>
      ${g.related_keywords?.length ? '<br><small style="color:var(--text3)">+ ' + g.related_keywords.join(', ') + '</small>' : ''}
      </div></div>`).join('');
  } else if (totalItems > 0) {
    detailRows = b.items.map((a, i) => {
      let status = '○ Chờ';
      if (a.intentStatus === 'processing') status = '⏳ Phân tích...';
      else if (a.outlineStatus === 'processing') status = '⏳ Dàn ý...';
      else if (a.reviewStatus === 'processing' || a.reviewStatus === 'regenerating') status = '⏳ Đánh giá...';
      else if (a.articleStatus === 'processing') status = `⏳ ${a.articleStep || 'Viết bài...'}`;
      else if (a.articleStatus === 'done') status = `✅ ${a.wordCount} từ` + (a.wpPublished ? ' 📤' : '');
      else if (a.articleStatus === 'error' || a.intentStatus === 'error' || a.outlineStatus === 'error') status = '❌ Lỗi';
      else if (a.articleStatus === 'skipped') status = '⏭ Bỏ qua';
      else if (a.reviewStatus === 'approved') status = '3✅ Đã duyệt';
      else if (a.outlineStatus === 'done') status = '2✅ Có dàn ý';
      else if (a.intentStatus === 'done') status = '1✅ Phân tích xong';

      return `<div style="display:flex;justify-content:space-between;padding:.375rem .5rem;font-size:.85rem;border-bottom:1px solid var(--border)">
        <span>${i+1}. ${a.keyword}</span><span>${status}</span>
      </div>`;
    }).join('');
  } else {
    detailRows = '<div style="padding:1rem;text-align:center;color:var(--text2)">Chưa có dữ liệu</div>';
  }

  let actions = '';
  if (isDone) {
    const completed = b.items.filter(a => a.articleStatus === 'done');
    actions = `<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.75rem">
      <button class="btn btn-sm btn-secondary" onclick="bqCopyAll(${b.id})"><i class="fas fa-copy"></i> Copy tất cả</button>
      <button class="btn btn-sm btn-secondary" onclick="bqDownloadAll(${b.id})"><i class="fas fa-download"></i> Tải tất cả</button>
      ${completed.length > 0 ? `<button class="btn btn-sm btn-primary" onclick="bqPublishAllWP(${b.id})"><i class="fab fa-wordpress"></i> Đăng WP</button>` : ''}
    </div>`;
  }

  showModal(`📦 Batch #${b.id} — ${b.stepLabel}`, `
    <div style="margin-bottom:.75rem">
      <span class="badge badge-info">${b.config.field}</span>
      <span class="badge ${b.status === 'done' ? 'badge-success' : b.status === 'error' ? 'badge-error' : 'badge-warning'}">${b.status === 'done' ? 'Hoàn thành' : b.status === 'error' ? 'Lỗi' : 'Đang chạy'}</span>
      ${b.config.fullPipeline ? '<span class="badge badge-info">Full Pipeline</span>' : ''}
    </div>
    <div style="max-height:50vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px">${detailRows}</div>
    ${actions}
  `, isDone ? [] : []);
}

// ═══════ VIEW ARTICLE (from results) ═══════
function bqViewArticle(batchId, itemIdx) {
  const b = batchQueue.find(x => x.id === batchId);
  if (!b) return;
  const a = b.items[itemIdx];
  const html = marked.parse(a.article || '');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = e => { if(e.target===overlay) overlay.remove(); };
  overlay.innerHTML = `<div class="modal-box" style="max-width:800px"><h3>${a.keyword} <span class="badge badge-info">${a.wordCount} từ</span></h3><div class="md-preview" style="max-height:60vh;overflow-y:auto">${html}</div><div class="modal-actions"><button class="btn btn-sm btn-secondary" onclick="navigator.clipboard.writeText(batchQueue.find(x=>x.id===${batchId}).items[${itemIdx}].article);showToast('Đã copy!','success')"><i class="fas fa-copy"></i> Copy</button><button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Đóng</button></div></div>`;
  document.body.appendChild(overlay);
}

function bqCopyAll(id) {
  const b = batchQueue.find(x => x.id === id);
  if (!b) return;
  const text = b.items.filter(a => a.articleStatus === 'done').map(a => a.article).join('\n\n---\n\n');
  navigator.clipboard.writeText(text).then(() => showToast('Đã copy tất cả!', 'success'));
}

function bqDownloadAll(id) {
  const b = batchQueue.find(x => x.id === id);
  if (!b) return;
  b.items.filter(a => a.articleStatus === 'done').forEach((a, i) => {
    setTimeout(() => {
      const blob = new Blob([a.article], { type: 'text/plain' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = (a.keyword || 'article') + '.md';
      link.click();
    }, i * 300);
  });
}

function bqPublishAllWP(id) {
  const b = batchQueue.find(x => x.id === id);
  if (!b) return;
  const completed = b.items.filter(a => a.articleStatus === 'done' && a.articleId);
  if (completed.length === 0) { showToast('Không có bài nào để đăng', 'error'); return; }

  showModal('🚀 Đăng tất cả lên WordPress', `
    <p>Sẽ đăng <strong>${completed.length}</strong> bài viết lên WordPress.</p>
    <p style="color:var(--text2)">Đảm bảo đã cấu hình WordPress site trong tab Quản trị.</p>
    <div class="form-group" style="margin-top:.75rem"><label>Chọn WP Site</label><select id="bq-wp-publish-site"></select></div>
  `, [{
    text: 'Đăng tất cả', cls: 'btn-primary',
    fn: `async function(){
      var sel=document.getElementById('bq-wp-publish-site');
      if(!sel.value){showToast('Chọn WP site','error');return}
      var ok=0,fail=0;
      for(var a of ${JSON.stringify(completed.map(a => ({ id: a.articleId, keyword: a.keyword })))}) {
        try{var r=await api('/api/wp/publish',{method:'POST',body:JSON.stringify({article_id:a.id,wp_config_id:+sel.value})});if(r.ok)ok++;else fail++;}catch{fail++;}
      }
      showToast(ok+' bài đăng thành công'+(fail?', '+fail+' lỗi':''),ok?'success':'error');
    }`
  }]);
  // Load WP sites into the modal selector
  setTimeout(async () => {
    const sel = document.getElementById('bq-wp-publish-site');
    if (!sel) return;
    try {
      const res = await api('/api/wp/configs');
      const d = await res.json();
      sel.innerHTML = '<option value="">— Chọn site —</option>' +
        (d.configs || []).map(c => `<option value="${c.id}" ${c.is_default ? 'selected' : ''}>${c.site_name}</option>`).join('');
    } catch { sel.innerHTML = '<option value="">Lỗi tải WP sites</option>'; }
  }, 100);
}

// ═══════ GROUP REVIEW MODAL ═══════
function bqShowGroupReview(id) {
  document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
  const b = batchQueue.find(x => x.id === id);
  if (!b || b.groups.length === 0) return;

  const cards = b.groups.map((g, i) => `
    <div class="card" style="background:var(--surface2);margin-bottom:.5rem;padding:.75rem">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1">
          <strong>📁 Nhóm ${i+1}: ${g.group_name}</strong>
          <div class="form-group" style="margin:.5rem 0 .25rem"><label style="font-size:.8rem">Keyword chính</label>
            <input value="${g.main_keyword}" onchange="batchQueue.find(x=>x.id===${id}).groups[${i}].main_keyword=this.value" style="padding:.375rem .5rem;font-size:.875rem"></div>
          ${g.related_keywords?.length ? `<div style="font-size:.8rem;color:var(--text2)">Liên quan: ${g.related_keywords.join(', ')}</div>` : ''}
          ${g.insight ? `<div style="font-size:.8rem;color:var(--text2);font-style:italic">${g.insight}</div>` : ''}
        </div>
        <button class="btn btn-sm btn-danger" onclick="batchQueue.find(x=>x.id===${id}).groups.splice(${i},1);bqShowGroupReview(${id})" style="margin-left:.5rem"><i class="fas fa-trash"></i></button>
      </div>
    </div>`).join('');

  showModal(`📋 Batch #${id} — ${b.groups.length} nhóm keyword`, `
    <div style="max-height:50vh;overflow-y:auto">${cards}</div>
    <div style="display:flex;gap:.5rem;margin-top:.75rem">
      <button class="btn btn-sm btn-secondary" onclick="bqAddManualGroupToModal(${id})"><i class="fas fa-plus"></i> Thêm nhóm</button>
    </div>
  `, [{
    text: '✅ Xác nhận & Tiếp tục', cls: 'btn-primary',
    fn: `function(){bqConfirmGroups(${id})}`
  }]);
}

function bqAddManualGroupToModal(id) {
  const b = batchQueue.find(x => x.id === id);
  if (!b) return;
  showModal('Thêm nhóm', `
    <div class="form-group"><label>Keywords (mỗi dòng = 1 nhóm)</label>
    <textarea id="bq-add-kws" rows="5" placeholder="keyword 1\nkeyword 2"></textarea></div>
  `, [{
    text: 'Thêm', cls: 'btn-primary',
    fn: `function(){
      var kws=document.getElementById('bq-add-kws').value.split(String.fromCharCode(10)).map(function(k){return k.trim()}).filter(function(k){return k});
      var b=batchQueue.find(function(x){return x.id===${id}});
      if(b&&kws.length>0){kws.forEach(function(k){b.groups.push({group_name:k,main_keyword:k,related_keywords:[],insight:'Thêm thủ công'})});}
      bqShowGroupReview(${id});
    }`
  }]);
}

function bqConfirmGroups(id) {
  const b = batchQueue.find(x => x.id === id);
  if (b) {
    b.waitingGroupReview = false;
    renderSidebar();
    showToast(`Batch #${id}: Đã xác nhận ${b.groups.length} nhóm, tiếp tục pipeline...`, 'success');
  }
}

// ═══════ MANUAL OUTLINE REVIEW MODAL ═══════
function bqOpenManualReview(id) {
  document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
  const b = batchQueue.find(x => x.id === id);
  if (!b) return;

  const cards = b.items.map((a, i) => {
    if (a.outlineStatus !== 'done') return `<div class="card" style="margin-bottom:.5rem;opacity:.5;padding:.75rem"><strong>${i+1}. ${a.keyword}</strong> — Lỗi outline</div>`;
    const bg = a.approved ? 'rgba(76,175,80,0.08)' : 'var(--surface2)';
    const badge = a.approved ? '<span class="badge badge-success">✅ Duyệt</span>' : '<span class="badge badge-warning">Chưa</span>';
    const editId = `bq-outline-edit-${id}-${i}`;
    const previewId = `bq-outline-preview-${id}-${i}`;
    const scoreHtml = a.reviewScore ? `<span class="badge badge-info">${a.reviewScore}/100</span>` : '';
    return `<div class="card" style="margin-bottom:.75rem;background:${bg};padding:.75rem" id="bq-card-${id}-${i}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <strong>${i+1}. ${a.keyword}</strong>
        <div style="display:flex;gap:.25rem;align-items:center">${scoreHtml} ${badge}</div>
      </div>
      <div id="${previewId}" class="md-preview" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);padding:.75rem;border-radius:6px;font-size:.85rem;margin-bottom:.5rem">${marked.parse(a.outline)}</div>
      <textarea id="${editId}" style="display:none;width:100%;min-height:200px;padding:.75rem;border:1px solid var(--border);border-radius:6px;font-size:.85rem;margin-bottom:.5rem;font-family:inherit;background:var(--surface);color:var(--text);resize:vertical">${a.outline}</textarea>
      <div style="display:flex;gap:.375rem;flex-wrap:wrap">
        <button class="btn btn-sm ${a.approved ? 'btn-secondary' : 'btn-primary'}" onclick="bqApproveItem(${id},${i})">${a.approved ? 'Đã duyệt' : '<i class="fas fa-check"></i> Duyệt'}</button>
        <button class="btn btn-sm btn-secondary" onclick="bqToggleEdit(${id},${i})" id="bq-edit-btn-${id}-${i}"><i class="fas fa-edit"></i> Sửa</button>
        <button class="btn btn-sm btn-secondary" onclick="bqAiEvalItem(${id},${i})"><i class="fas fa-star"></i> AI đánh giá</button>
        <button class="btn btn-sm btn-secondary" onclick="bqAiRegenItem(${id},${i})"><i class="fas fa-redo"></i> AI viết lại</button>
      </div>
      <div id="bq-eval-result-${id}-${i}" style="margin-top:.5rem"></div>
    </div>`;
  }).join('');

  showModal(`📋 Duyệt dàn ý — Batch #${id}`, `
    <div style="max-height:60vh;overflow-y:auto">${cards}</div>
    <div class="form-group" style="margin-top:.75rem"><label>Ghi chú chung cho AI (áp dụng khi viết bài)</label>
      <textarea id="bq-manual-notes-${id}" rows="2" placeholder="Ghi chú thêm..." style="font-size:.875rem">${b.manualNotes || ''}</textarea>
    </div>
    <div style="margin-top:.75rem;display:flex;gap:.5rem;flex-wrap:wrap">
      <button class="btn btn-secondary" onclick="bqApproveAllItems(${id})"><i class="fas fa-check-double"></i> Duyệt tất cả</button>
      <button class="btn btn-secondary" onclick="bqAiEvalAll(${id})"><i class="fas fa-star"></i> AI đánh giá tất cả</button>
    </div>
  `, [{ text: 'Xác nhận & Viết bài', cls: 'btn-primary', fn: `function(){bqConfirmManualReview(${id})}` }]);
}

function bqToggleEdit(batchId, idx) {
  const editEl = document.getElementById(`bq-outline-edit-${batchId}-${idx}`);
  const previewEl = document.getElementById(`bq-outline-preview-${batchId}-${idx}`);
  const btnEl = document.getElementById(`bq-edit-btn-${batchId}-${idx}`);
  if (!editEl || !previewEl) return;
  const isEditing = editEl.style.display !== 'none';
  if (isEditing) {
    // Save edit and switch to preview
    const b = batchQueue.find(x => x.id === batchId);
    if (b) b.items[idx].outline = editEl.value;
    previewEl.innerHTML = marked.parse(editEl.value);
    editEl.style.display = 'none';
    previewEl.style.display = '';
    if (btnEl) btnEl.innerHTML = '<i class="fas fa-edit"></i> Sửa';
  } else {
    // Switch to edit
    editEl.style.display = '';
    previewEl.style.display = 'none';
    if (btnEl) btnEl.innerHTML = '<i class="fas fa-save"></i> Lưu';
    editEl.focus();
  }
}

async function bqAiEvalItem(batchId, idx) {
  const b = batchQueue.find(x => x.id === batchId);
  if (!b) return;
  const a = b.items[idx];
  const resultEl = document.getElementById(`bq-eval-result-${batchId}-${idx}`);
  if (!resultEl) return;
  resultEl.innerHTML = '<div style="display:flex;align-items:center;gap:.5rem;color:var(--text2);font-size:.85rem"><div class="spinner"></div> AI đang đánh giá...</div>';
  try {
    const evalPrompt = buildPrompt(promptTemplates.eval_prompt, {
      keywords: a.keyword,
      intent_json: a.intentData ? JSON.stringify(a.intentData, null, 2) : '{}',
      outline: a.outline
    });
    const data = await batchApiCall(b.config.evalBot, evalPrompt);
    const content = data.choices?.[0]?.message?.content || '';
    let score = 0, verdict = '', issues = [];
    try {
      const j = JSON.parse(content.match(/\{[\s\S]*\}/)[0]);
      score = j.overall_score ?? j.score ?? 0;
      verdict = j.verdict || '';
      issues = [...(j.key_issues||[]), ...(j.improvement_suggestions||[])];
      a.reviewScore = score;
    } catch {}
    let html = `<div style="padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:.85rem">`;
    html += `<strong>${score}/100</strong> <span style="color:var(--text2)">${verdict}</span>`;
    if (issues.length > 0) html += '<ul style="margin:.25rem 0;padding-left:1.25rem">' + issues.map(i => `<li>${i}</li>`).join('') + '</ul>';
    html += '</div>';
    resultEl.innerHTML = html;
  } catch (e) {
    resultEl.innerHTML = `<div style="color:var(--error);font-size:.85rem">Lỗi: ${e.message}</div>`;
  }
}

async function bqAiRegenItem(batchId, idx) {
  const b = batchQueue.find(x => x.id === batchId);
  if (!b) return;
  const a = b.items[idx];
  const resultEl = document.getElementById(`bq-eval-result-${batchId}-${idx}`);
  if (resultEl) resultEl.innerHTML = '<div style="display:flex;align-items:center;gap:.5rem;color:var(--text2);font-size:.85rem"><div class="spinner"></div> AI đang viết lại outline...</div>';
  try {
    // First evaluate to get feedback
    const evalPrompt = buildPrompt(promptTemplates.eval_prompt, {
      keywords: a.keyword,
      intent_json: a.intentData ? JSON.stringify(a.intentData, null, 2) : '{}',
      outline: a.outline
    });
    const evalData = await batchApiCall(b.config.evalBot, evalPrompt);
    let evalJson = null;
    try { evalJson = JSON.parse((evalData.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/)[0]); } catch {}

    // Then regenerate
    const regenPrompt = buildPrompt(promptTemplates.regenerate_prompt, {
      keywords: a.keyword,
      intent_json: a.intentData ? JSON.stringify(a.intentData, null, 2) : '{}',
      original_outline: a.outline,
      evaluation_json: evalJson ? JSON.stringify(evalJson, null, 2) : JSON.stringify({ key_issues: ['Cải thiện chất lượng tổng thể'] }),
      context_info: buildContextInfo(b.config.field, b.config.company, b.config.style)
    });
    const regenData = await batchApiCall(b.config.outlineBot, regenPrompt);
    const rRaw = regenData.choices?.[0]?.message?.content || a.outline;

    // Clean regenerated outline (Markdown or JSON fallback)
    a.outline = cleanRegenOutline(rRaw, a.keyword);

    if (evalJson) a.reviewScore = evalJson.overall_score ?? evalJson.score ?? a.reviewScore;
    if (resultEl) resultEl.innerHTML = '<div style="color:var(--success);font-size:.85rem">✅ Đã viết lại outline</div>';

    // Refresh the modal to show updated outline
    bqOpenManualReview(batchId);
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<div style="color:var(--error);font-size:.85rem">Lỗi: ${e.message}</div>`;
  }
}

async function bqAiEvalAll(batchId) {
  const b = batchQueue.find(x => x.id === batchId);
  if (!b) return;
  showToast('Đang đánh giá tất cả outline...', 'info');
  for (let i = 0; i < b.items.length; i++) {
    if (b.items[i].outlineStatus === 'done') {
      await bqAiEvalItem(batchId, i);
      if (i < b.items.length - 1) await batchDelay(1500);
    }
  }
  showToast('Đánh giá xong!', 'success');
}

function bqApproveItem(batchId, idx) {
  const b = batchQueue.find(x => x.id === batchId);
  if (b) {
    // Save edited outline if editing
    const editEl = document.getElementById(`bq-outline-edit-${batchId}-${idx}`);
    if (editEl && editEl.style.display !== 'none') {
      b.items[idx].outline = editEl.value;
    }
    b.items[idx].approved = true;
    bqOpenManualReview(batchId);
  }
}

function bqApproveAllItems(batchId) {
  const b = batchQueue.find(x => x.id === batchId);
  if (b) { b.items.forEach(a => { if (a.outlineStatus === 'done') a.approved = true; }); bqOpenManualReview(batchId); }
}

function bqConfirmManualReview(batchId) {
  const b = batchQueue.find(x => x.id === batchId);
  if (b) {
    // Save notes
    const notesEl = document.getElementById(`bq-manual-notes-${batchId}`);
    if (notesEl) b.manualNotes = notesEl.value;
    b.waitingManualReview = false;
    b.status = 'running';
    renderSidebar();
  }
}

// ═══════ BATCH FROM OUTLINES (from history tab — skip Phase 1-4) ═══════
function batchFromOutlines(outlineDataArray) {
  const config = getBatchConfig();
  const first = outlineDataArray[0] || {};

  const b = {
    id: batchNextId++,
    type: 'batch',
    phase: 5,
    status: 'running',
    paused: false,
    cancelled: false,
    config: {
      ...config,
      field: first.field || config.field,
      company: first.company || config.company,
      style: first.style || config.style,
      reference: first.reference_info || config.reference,
    },
    rawKeywords: outlineDataArray.map(a => a.keyword || ''),
    groups: [],
    items: outlineDataArray.map(a => {
      let intentData = a.intent_data;
      if (typeof intentData === 'string') {
        try { intentData = JSON.parse(intentData || '{}'); } catch { intentData = {}; }
      }
      return {
        keyword: a.keyword || '', related: a.extra_keywords || '',
        intentData: intentData || {}, intentStatus: 'done',
        outline: a.outline || '', outlineStatus: 'done',
        reviewStatus: 'approved', reviewScore: null,
        article: '', articleHtml: '', wordCount: 0,
        articleStatus: 'pending', articleStep: '',
        images: [], articleId: a.id,
        suggestions: [], error: null, approved: true,
        _field: a.field, _company: a.company, _style: a.style, _reference: a.reference_info
      };
    }),
    allWrittenKeywords: [],
    manualNotes: '',
    waitingManualReview: false,
    waitingGroupReview: false,
    createdAt: new Date(),
    stepLabel: 'Viết bài từ outline...',
  };

  if (config.enableLinks) {
    api('/api/urls').then(r => r.json()).then(d => {
      b.config.internalLinks = d.urls || [];
    }).catch(() => { b.config.internalLinks = []; });
  }

  batchQueue.push(b);
  renderSidebar();
  showToast(`📦 Batch #${b.id}: viết ${b.items.length} bài từ outline...`, 'info');

  // Run Phase 5 directly
  (async () => {
    try {
      await batchRunPhase5(b);
      if (!b.cancelled) {
        b.phase = 6; b.status = 'done'; b.stepLabel = 'Hoàn thành!';
        renderSidebar();
        showToast(`🎉 Batch #${b.id} hoàn thành!`, 'success');
        try { loadQuota(); } catch {}
      }
    } catch (e) {
      b.status = 'error'; b.stepLabel = 'Lỗi: ' + e.message;
      renderSidebar();
      showToast(`❌ Batch #${b.id} lỗi: ${e.message}`, 'error');
    }
  })();
}

// ═══════ LEGACY HELPERS ═══════
function batchReset() {
  // Reset form to ready state — user can start new batch
  $('b-keywords').value = '';
  updateBatchKwCount();
}

// ═══════ RENDER BATCH CARDS FOR SIDEBAR ═══════
// Called by app.js renderSidebar() — returns HTML string of batch cards
function renderBatchSidebarCards() {
  if (!batchQueue || batchQueue.length === 0) return '';

  return batchQueue.map(b => {
    const totalItems = b.items.length || b.rawKeywords.length;
    const phaseLabels = { 1: 'Phân nhóm', 2: 'Ý định', 3: 'Dàn ý', 4: 'Đánh giá', 5: 'Viết bài', 6: 'Kết quả' };

    // Calculate progress
    let phaseDone = 0, phaseTotal = Math.max(totalItems, 1);
    if (b.phase === 1) { phaseDone = b.groups.length > 0 ? 1 : 0; phaseTotal = 1; }
    else if (b.phase === 2) phaseDone = b.items.filter(a => a.intentStatus === 'done').length;
    else if (b.phase === 3) phaseDone = b.items.filter(a => a.outlineStatus === 'done').length;
    else if (b.phase === 4) phaseDone = b.items.filter(a => a.reviewStatus === 'approved' || a.reviewStatus === 'error').length;
    else if (b.phase === 5) phaseDone = b.items.filter(a => a.articleStatus === 'done' || a.articleStatus === 'error').length;
    else if (b.phase === 6) { phaseDone = phaseTotal; }

    const pct = phaseTotal > 0 ? Math.round(phaseDone / phaseTotal * 100) : 0;
    const isDone = b.phase === 6 && b.status === 'done';
    const isError = b.status === 'error';
    const isPaused = b.paused || b.waitingGroupReview || b.waitingManualReview;

    let statusIcon, statusText, cardClass;
    if (isDone) { statusIcon = '✅'; statusText = 'Hoàn thành'; cardClass = 'pl-card-done'; }
    else if (isError) { statusIcon = '❌'; statusText = 'Lỗi'; cardClass = 'pl-card-error'; }
    else if (b.waitingGroupReview) { statusIcon = '📋'; statusText = 'Chờ xác nhận nhóm'; cardClass = 'pl-card-paused'; }
    else if (b.waitingManualReview) { statusIcon = '📋'; statusText = 'Chờ duyệt dàn ý'; cardClass = 'pl-card-paused'; }
    else if (isPaused) { statusIcon = '⏸'; statusText = 'Tạm dừng'; cardClass = 'pl-card-paused'; }
    else { statusIcon = '🔄'; statusText = 'Đang chạy'; cardClass = 'pl-card-running'; }

    const phaseText = phaseLabels[b.phase] || `Phase ${b.phase}`;
    const stepInfo = isDone
      ? `${b.items.filter(a => a.articleStatus === 'done').length}/${b.items.length} bài hoàn thành`
      : `Phase ${b.phase}/6 — ${b.stepLabel}`;

    // Actions
    let actions = '';
    if (b.waitingGroupReview) {
      actions = `<button class="btn btn-primary" onclick="bqShowGroupReview(${b.id})"><i class="fas fa-list"></i> Xem nhóm</button>`;
    } else if (b.waitingManualReview) {
      actions = `<button class="btn btn-primary" onclick="bqOpenManualReview(${b.id})"><i class="fas fa-clipboard-check"></i> Duyệt</button>`;
    } else if (isDone) {
      actions = `<button class="btn btn-secondary" onclick="bqViewDetail(${b.id})"><i class="fas fa-eye"></i> Xem</button>
        <button class="btn btn-secondary" onclick="bqRemove(${b.id})" style="opacity:.6"><i class="fas fa-trash"></i></button>`;
    } else if (isError) {
      actions = `<button class="btn btn-secondary" onclick="bqViewDetail(${b.id})"><i class="fas fa-eye"></i> Xem</button>
        <button class="btn btn-secondary" onclick="bqRemove(${b.id})" style="opacity:.6"><i class="fas fa-trash"></i></button>`;
    } else {
      actions = `<button class="btn btn-secondary" onclick="bqViewDetail(${b.id})"><i class="fas fa-eye"></i> Xem</button>
        <button class="btn btn-secondary" onclick="bqTogglePause(${b.id})">${b.paused ? '<i class="fas fa-play"></i>' : '<i class="fas fa-pause"></i>'}</button>
        <button class="btn btn-secondary" onclick="bqCancel(${b.id})" style="opacity:.6"><i class="fas fa-times"></i></button>`;
    }

    const progressBar = (!isDone && !isError) ? `<div class="pl-progress"><div class="pl-progress-fill" style="width:${pct}%"></div></div>` : '';
    const firstKw = b.rawKeywords && b.rawKeywords.length > 0 ? b.rawKeywords[0] : '';
    const batchName = firstKw ? `Batch #${b.id} - ${firstKw}` : `Batch #${b.id}`;

    return `<div class="pl-card ${cardClass}">
      <div class="pl-time">${statusIcon} ${formatTime(b.createdAt)}</div>
      <div class="pl-status ${isDone ? 'pl-status-done' : isError ? 'pl-status-error' : isPaused ? 'pl-status-paused' : 'pl-status-running'}">${statusText}</div>
      <div class="pl-keyword">📦 ${batchName} — ${totalItems} bài${b.config.fullPipeline ? ' 🔄' : ''}</div>
      <div class="pl-step">${stepInfo}</div>
      ${progressBar}
      <div class="pl-actions">${actions}</div>
    </div>`;
  }).join('');
}
