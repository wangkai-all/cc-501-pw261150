// Single-file frontend: vanilla JS, no build step. Talks JSON to the API.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents || 0) / 100);
const num = (cents) =>
  `<span class="num ${cents < 0 ? 'neg' : cents > 0 ? 'pos' : 'muted'}">${money(cents)}</span>`;
const dateLabel = (iso) => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—');

const state = {
  subscriptions: [],
  selectedSub: null,
  plans: [],
  analysis: null,
  invoices: [],
  corrections: [],
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, ok = true) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${ok ? 'ok' : 'err'}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3800);
}

// ---------------------------------------------------------------- boot
async function boot() {
  state.plans = await api('/api/plans');
  await refreshSubList();
  await refreshAll();
  bindStatic();
}

async function refreshSubList() {
  state.subscriptions = await api('/api/subscriptions');
  if (!state.selectedSub && state.subscriptions[0]) {
    state.selectedSub = state.subscriptions[0].id;
  }
  if (state.selectedSub && !state.subscriptions.find((s) => s.id === state.selectedSub)) {
    state.selectedSub = state.subscriptions[0]?.id || null;
  }
  $('#sub-list').innerHTML = state.subscriptions.length
    ? state.subscriptions.map((s) => `
      <li data-id="${s.id}" class="${s.id === state.selectedSub ? 'active' : ''}">
        <div class="name">${esc(s.customer_name)} <span class="badge ${s.status}">${s.status}</span></div>
        <div class="meta">${esc(s.timezone)} · anchor ${esc(s.anchor_date)} · v${s.version}</div>
      </li>`).join('')
    : '<li class="empty">暂无订阅</li>';
  $$('#sub-list li[data-id]').forEach((li) =>
    li.addEventListener('click', () => {
      state.selectedSub = li.dataset.id;
      refreshAll();
    }));

  const ov = await api('/api/overview');
  $('#overview').innerHTML = [
    ['subscriptions', '订阅总数', ov.subscriptions, ''],
    ['active', '活跃 / 暂停 / 取消', `${ov.active}/${ov.paused}/${ov.canceled}`, 'good'],
    ['invoices', '账单行数', ov.invoices, ''],
    ['superseded', '已被取代版本', ov.superseded, 'warn'],
    ['corrections', '更正次数', ov.corrections, ''],
    ['pendingCorrections', '待恢复更正', ov.pendingCorrections, ov.pendingCorrections ? 'bad' : 'good'],
    ['billed', '当前应收', money(ov.billedCents), 'good'],
    ['refunded', '已退款', money(ov.refundedCents), 'warn'],
    ['webhooks', '回调事件', ov.webhooks, ''],
    ['pendingNtf', '待发通知', ov.pendingNotifications, ov.pendingNotifications ? 'warn' : 'good'],
  ].map(([, k, v, cls]) => `<div class="stat ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
}

async function refreshAll() {
  await refreshSubList();
  const id = state.selectedSub;
  const [timeline, analysis, invoices, corrections, webhooks, notifications, audit] =
    await Promise.all([
      id ? api(`/api/subscriptions/${id}/timeline`) : Promise.resolve(null),
      id ? api(`/api/subscriptions/${id}/analysis`) : Promise.resolve(null),
      id ? api(`/api/subscriptions/${id}/invoices`) : Promise.resolve([]),
      api('/api/corrections'),
      api('/api/webhooks'),
      api('/api/notifications'),
      api('/api/audit?limit=120'),
    ]);
  state.analysis = analysis;
  state.invoices = invoices;
  state.corrections = corrections;
  renderTimeline(timeline);
  renderAnalysis(analysis);
  renderInvoices(invoices);
  renderCorrections(corrections);
  renderWebhooks(webhooks);
  renderNotifications(notifications);
  renderAudit(audit);
}

// ---------------------------------------------------------------- tabs
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.tab-panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $(`#tab-${t.dataset.tab}`).classList.add('active');
}));

// ---------------------------------------------------------------- timeline
function renderTimeline(tl) {
  const root = $('#timeline');
  if (!tl) return (root.innerHTML = '<div class="empty">请选择或新建一个订阅</div>');
  const s = tl.subscription;
  const typeName = {
    created: '创建订阅', plan_changed: '套餐变更', paused: '暂停',
    resumed: '恢复', canceled: '取消',
  };
  root.innerHTML = `
    <div class="card">
      <h2>${esc(s.customer_name)} <span class="badge ${s.status}">${s.status}</span></h2>
      <div class="kv">
        <div class="k">订阅 ID</div><div class="mono">${esc(s.id)}</div>
        <div class="k">时区</div><div>${esc(s.timezone)}</div>
        <div class="k">账单锚点 (本地)</div><div>${esc(s.anchor_date)}</div>
        <div class="k">开始 (UTC)</div><div class="mono">${dateLabel(s.startedAtIso)}</div>
        <div class="k">当前套餐</div><div class="mono">${esc(s.plan_id)}</div>
        <div class="k">乐观锁版本</div><div>v${s.version}</div>
      </div>
    </div>
    <div class="card">
      <h2>合并时间线 (事件 / 账单 / 更正 / 退款)</h2>
      <div class="timeline">
        ${tl.items.map((it) => renderTimelineItem(it)).join('')}
      </div>
    </div>`;
}

function renderTimelineItem(it) {
  const time = it.effectiveAtIso || it.createdAt || it.periodStart || it.recalcFrom || '';
  if (it.kind === 'event') {
    return `<div class="tl-item event">
      <div class="tl-head"><span class="tl-title">${typeName[it.type] || it.type}</span>
        <span class="badge">${esc(it.source)}</span>
        <span class="tl-time">本地 ${esc(it.effectiveDate)} · ${dateLabel(it.effectiveAtIso)}</span></div>
      <div class="tl-body">${esc(it.reason || '')} ${it.planId ? `<code>${esc(it.planId)}</code>` : ''}
        ${it.idempotencyKey ? `<div class="muted" style="margin-top:4px">幂等键 <span class="pill">${esc(it.idempotencyKey)}</span></div>` : ''}
      </div></div>`;
  }
  if (it.kind === 'invoice') {
    const sup = it.supersededBy ? '<span class="badge superseded">已被新版本取代</span>' : `<span class="badge ${it.status}">${it.status}</span>`;
    return `<div class="tl-item invoice">
      <div class="tl-head"><span class="tl-title">账单 #${it.sequence} · 版本 v${it.version}</span>
        ${sup}<span class="tl-time">${dateLabel(time)}</span></div>
      <div class="tl-body">账期 <code>${esc(it.periodStart)}</code> → <code>${esc(it.periodEnd)}</code>
        <div style="margin-top:6px">金额 ${num(it.totalCents)}</div>
        <div class="muted mono" style="margin-top:4px">${esc(it.id)}${it.correctionId ? ` · 更正 ${esc(it.correctionId)}` : ''}</div>
      </div></div>`;
  }
  if (it.kind === 'correction') {
    return `<div class="tl-item correction">
      <div class="tl-head"><span class="tl-title">更正请求</span>
        <span class="badge ${it.status}">${it.status}</span>
        <span class="tl-time">${dateLabel(time)}</span></div>
      <div class="tl-body">${esc(it.reason)}
        <div style="margin-top:6px">重算范围 <code>${esc(it.recalcFrom)}</code> → <code>${esc(it.recalcTo)}</code></div>
        <div class="muted" style="margin-top:4px">${it.diffs.length} 个账期产生新版本，净差异 ${num(it.diffs.reduce((a, d) => a + d.delta_cents, 0))}</div>
      </div></div>`;
  }
  return `<div class="tl-item refund">
    <div class="tl-head"><span class="tl-title">退款</span>
      <span class="badge ${it.status}">${it.status}</span>
      <span class="tl-time">${dateLabel(time)}</span></div>
    <div class="tl-body">${esc(it.reason || '')}<br>账单 <code>${esc(it.invoiceId)}</code> · ${num(it.amountCents)}</div></div>`;
}

// ---------------------------------------------------------------- analysis
function renderAnalysis(a) {
  const root = $('#analysis');
  if (!a) return (root.innerHTML = '<div class="empty">请选择订阅</div>');
  root.innerHTML = `
    <div class="totals-strip">
      <div class="stat"><div class="v">${num(a.totals.computedCents)}</div><div class="k">引擎按事件重算总额</div></div>
      <div class="stat"><div class="v">${num(a.totals.invoicedCents)}</div><div class="k">当前账单总额</div></div>
      <div class="stat warn"><div class="v">${num(a.totals.refundsCents)}</div><div class="k">已退款</div></div>
      <div class="stat"><div class="v">${a.daySummary.activeDays} / ${a.daySummary.pausedDays}</div><div class="k">计费日 / 暂停日 (共 ${a.daySummary.totalDays} 天)</div></div>
    </div>
    <div class="card">
      <h2>重算明细 — 每个账期的确定性结果 (时区 ${esc(a.timezone)})</h2>
      <table><thead><tr><th>#</th><th>账期 (本地日)</th><th>名义/实际天数</th><th>行项目</th><th class="num">重算金额</th><th>已出账</th><th>状态</th></tr></thead>
      <tbody>${a.periods.map((p) => `
        <tr>
          <td class="mono">${p.sequence}</td>
          <td class="mono">${esc(p.startDate)} → ${esc(p.endDate)}</td>
          <td>${p.nominalDays} / ${p.activeDays}${p.endedByCancel ? ' <span class="badge canceled">取消截止</span>' : p.complete ? '' : ' <span class="badge pending">开放中</span>'}</td>
          <td>${p.lines.map((l) => `<div class="mono" style="margin-bottom:3px">
              <span class="badge ${l.kind === 'paused' ? 'paused' : 'issued'}">${l.kind}</span>
              ${l.days}d × ${esc(l.detail.split(',')[0])} <b>${num(l.amountCents)}</b></div>`).join('')}</td>
          <td class="num">${money(p.computedTotalCents)}</td>
          <td>${p.invoice ? `v${p.invoice.version} ${num(p.invoice.totalCents)}` : '<span class="muted">未出账</span>'}</td>
          <td>${p.invoice ? (p.invoice.matchesComputed
            ? '<span class="badge applied">一致</span>'
            : '<span class="badge failed">有偏差，需更正</span>')
            : '<span class="badge draft">等待出账</span>'}</td>
        </tr>`).join('')}</tbody></table>
      <div class="muted" style="margin-top:10px;font-size:12px">
        暂停日按 0 计费并顺延账期；日费率 = 月费 / 当月名义天数；分段半入正取整，金额以整数分存储。
      </div>
    </div>`;
}

// ---------------------------------------------------------------- invoices + diff
function renderInvoices(invoices) {
  const root = $('#invoices');
  if (!invoices.length) return (root.innerHTML = '<div class="empty">该订阅暂无账单</div>');
  const bySeq = {};
  for (const inv of invoices) (bySeq[inv.period_sequence] ||= []).push(inv);
  root.innerHTML = Object.entries(bySeq)
    .sort((a, b) => a[0] - b[0])
    .map(([seq, versions]) => {
      const current = versions.find((v) => !v.superseded_by) || versions[0];
      return `<div class="inv-card">
        <div class="inv-head">
          <div class="inv-title">账期 #${seq}
            <span class="muted mono" style="font-weight:400">${new Date(current.period_start).toISOString().slice(0,10)} → ${new Date(current.period_end).toISOString().slice(0,10)}</span>
          </div>
          <div class="versions">
            ${versions.map((v) => `<span class="badge ${v.superseded_by ? 'superseded' : v.status}">v${v.version} ${v.superseded_by ? '已取代' : v.status}</span>`).join('<span class="arrow">→</span>')}
            <span style="margin-left:10px">当前 ${num(current.total_cents)}</span>
          </div>
        </div>
        <table><thead><tr><th>类型</th><th>套餐</th><th>区间 (UTC ms → 本地日)</th><th class="num">天数</th><th class="num">金额</th><th>说明</th></tr></thead>
        <tbody>${current.lines.map((l) => `
          <tr><td><span class="badge ${l.kind === 'paused' ? 'paused' : 'issued'}">${l.kind}</span></td>
          <td class="mono">${esc(l.plan_id || '—')}</td>
          <td class="mono">${new Date(l.range_start).toISOString().slice(0, 10)} → ${new Date(l.range_end).toISOString().slice(0, 10)}</td>
          <td class="num">${l.days}</td>
          <td class="num">${money(l.amount_cents)}</td>
          <td class="muted">${esc(l.detail)}</td></tr>`).join('')}</tbody></table>
        ${versions.length > 1 ? renderVersionDiffs(versions) : ''}
      </div>`;
    }).join('');

  $$('button[data-diff]').forEach((b) => b.addEventListener('click', async () => {
    const [oldId, newId] = b.dataset.diff.split('|');
    const rows = await api(`/api/invoices/${oldId}/diff/${newId}`);
    const target = $(`#diffbox-${b.dataset.box}`);
    target.innerHTML = `<table><thead><tr><th>行键</th><th>类型</th><th class="num">旧</th><th class="num">新</th><th class="num">差异</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="mono">${esc(r.planId || '—')} ${new Date(r.rangeStart).toISOString().slice(0,10)}→${new Date(r.rangeEnd).toISOString().slice(0,10)}</td>
        <td><span class="badge ${r.kind === 'paused' ? 'paused' : 'issued'}">${r.kind}</span></td>
        <td class="num">${money(r.oldAmount)}</td><td class="num">${money(r.newAmount)}</td>
        <td class="num">${r.delta === 0 ? '0' : (r.delta > 0 ? '+' : '') + money(r.delta).replace('$','$')}</td>
        <td><span class="badge ${r.presentIn === 'both' ? 'applied' : 'duplicate'}">${r.presentIn}</span></td></tr>`).join('')}</tbody></table>`;
  }));
}

function renderVersionDiffs(versions) {
  return versions.filter((v) => v.superseded_by).map((oldV, i) => {
    const newV = versions.find((v) => v.id === oldV.superseded_by);
    const boxId = `${oldV.period_sequence}_${i}`;
    return `<div style="margin-top:10px">
      <button class="btn tiny" data-box="${boxId}" data-diff="${oldV.id}|${newV.id}">查看 v${oldV.version} → v${newV.version} 行级差异</button>
      <div id="diffbox-${boxId}" style="margin-top:8px"></div></div>`;
  }).join('');
}

// ---------------------------------------------------------------- corrections
function renderCorrections(corrections) {
  const root = $('#corrections');
  const mine = corrections.filter((c) => !state.selectedSub || c.subscription_id === state.selectedSub);
  if (!mine.length) return (root.innerHTML = '<div class="empty">暂无更正记录。对已出账订阅做一次回溯生效的变更/回调即可触发。</div>');
  root.innerHTML = mine.map((c) => `
    <div class="diff-card">
      <div class="inv-head">
        <div class="inv-title">更正 <span class="mono">${esc(c.id)}</span>
          <span class="badge ${c.status}" style="margin-left:8px">${c.status}</span></div>
        <div class="muted mono">${dateLabel(new Date(c.created_at).toISOString())}</div>
      </div>
      <div class="recalc-banner">
        <b>重算范围：</b> 触发事件 <code>${esc(c.trigger_event_id)}</code> 生效时刻
        <code>${new Date(c.recalc_from).toISOString()}</code> 起，至
        <code>${new Date(c.recalc_to).toISOString()}</code>；仅重建账期结束晚于该时刻的已出账账单。
        ${c.error_message ? `<div class="neg" style="margin-top:6px">上次错误：${esc(c.error_message)}</div>` : ''}
      </div>
      <div>${esc(c.reason)}</div>
      <table style="margin-top:10px"><thead><tr><th>账期</th><th>旧账单 (冻结)</th><th>新账单版本</th><th class="num">旧总额</th><th class="num">新总额</th><th class="num">差异</th></tr></thead>
      <tbody>${c.diffs.map((d) => `<tr>
        <td class="mono">#${d.period_sequence}</td>
        <td class="mono">${esc(d.old_invoice_id)}</td>
        <td class="mono">${esc(d.new_invoice_id)}</td>
        <td class="num">${money(d.old_total_cents)}</td>
        <td class="num">${money(d.new_total_cents)}</td>
        <td class="num">${d.delta_cents > 0 ? '+' : ''}${money(d.delta_cents)}</td></tr>`).join('') ||
        '<tr><td colspan="6" class="muted">重算结果与原账单一致，无新版本（幂等空更正）</td></tr>'}</tbody></table>
    </div>`).join('');
}

// ---------------------------------------------------------------- webhooks
const PRESETS = {
  created: () => ({
    eventId: `evt_${Math.random().toString(36).slice(2, 10)}`,
    eventType: 'subscription.created',
    payload: {
      customerName: '回调创建客户', planId: state.plans[0]?.id,
      timezone: 'America/New_York', anchorDate: '2026-01-15', reason: 'provider signup',
    },
  }),
  change: () => ({
    eventId: `evt_${Math.random().toString(36).slice(2, 10)}`,
    eventType: 'subscription.plan_changed',
    payload: {
      subscriptionId: state.selectedSub, planId: state.plans[1]?.id || state.plans[0]?.id,
      effectiveDate: '2026-02-10', reason: 'provider plan change (backdated)',
    },
  }),
  pause: () => ({
    eventId: `evt_${Math.random().toString(36).slice(2, 10)}`,
    eventType: 'subscription.paused',
    payload: { subscriptionId: state.selectedSub, effectiveDate: '2026-03-05', reason: 'customer paused' },
  }),
  resume: () => ({
    eventId: `evt_${Math.random().toString(36).slice(2, 10)}`,
    eventType: 'subscription.resumed',
    payload: { subscriptionId: state.selectedSub, effectiveDate: '2026-03-12', reason: 'customer resumed' },
  }),
  cancel: () => ({
    eventId: `evt_${Math.random().toString(36).slice(2, 10)}`,
    eventType: 'subscription.canceled',
    payload: { subscriptionId: state.selectedSub, effectiveDate: '2026-04-20', reason: 'churn' },
  }),
};

function renderWebhooks(events) {
  const root = $('#webhooks');
  root.innerHTML = `
    <div class="webhook-builder">
      <h2 style="margin-top:0">回调模拟器 — 修改后重复点 “发送” 验证幂等</h2>
      <div class="preset-row">
        ${Object.entries({ created: '创建', change: '套餐变更', pause: '暂停', resume: '恢复', cancel: '取消' })
          .map(([k, label]) => `<button class="btn tiny" data-preset="${k}">${label}</button>`).join('')}
      </div>
      <textarea id="webhook-json" class="mono"></textarea>
      <div class="row-actions" style="margin-top:10px">
        <button id="btn-send-webhook" class="btn primary">发送回调</button>
        <button id="btn-replay-webhook" class="btn">原样重发 (重复回调)</button>
      </div>
    </div>
    <div class="card"><h2>已接收回调 (${events.length})</h2>
      <table><thead><tr><th>event_id</th><th>类型</th><th>状态</th><th>结果订阅</th><th>接收时间</th><th>错误</th></tr></thead>
      <tbody>${events.map((e) => `<tr>
        <td class="mono">${esc(e.event_id)}</td><td>${esc(e.event_type)}</td>
        <td><span class="badge ${e.status}">${e.status}</span></td>
        <td class="mono">${esc(e.result_subscription_id || '—')}</td>
        <td class="mono">${dateLabel(new Date(e.received_at).toISOString())}</td>
        <td class="neg">${esc(e.error_message || '')}</td></tr>`).join('') ||
        '<tr><td colspan="6" class="empty">尚无回调</td></tr>'}</tbody></table></div>`;

  $$('button[data-preset]').forEach((b) => b.addEventListener('click', () => {
    $('#webhook-json').value = JSON.stringify(PRESETS[b.dataset.preset](), null, 2);
  }));
  $('#webhook-json').value = JSON.stringify(PRESETS.change(), null, 2);
  $('#btn-send-webhook').onclick = () => sendWebhook(false);
  $('#btn-replay-webhook').onclick = () => sendWebhook(true);
}

async function sendWebhook(replay) {
  try {
    const body = JSON.parse($('#webhook-json').value);
    const result = await api('/api/webhooks', { method: 'POST', body });
    toast(replay || result.duplicate
      ? `重复回调已幂等忽略 → status=${result.status}`
      : `回调处理成功 ${result.correctionId ? '，并触发更正 ' + result.correctionId : ''}`);
    await refreshAll();
  } catch (err) {
    toast(err.message, false);
  }
}

// ---------------------------------------------------------------- notifications
function renderNotifications(rows) {
  $('#notifications').innerHTML = rows.length ? `
    <div class="card"><table><thead><tr><th>类型</th><th>订阅</th><th>状态</th><th class="num">尝试</th><th>负载</th><th>错误</th><th>时间</th></tr></thead>
    <tbody>${rows.map((n) => `<tr>
      <td><span class="badge ${n.status}">${esc(n.type)}</span></td>
      <td class="mono">${esc(n.subscription_id)}</td>
      <td><span class="badge ${n.status}">${n.status}</span></td>
      <td class="num">${n.attempts}/${n.max_attempts}</td>
      <td class="mono muted" style="max-width:340px;word-break:break-all">${esc(JSON.stringify(n.payload))}</td>
      <td class="neg">${esc(n.last_error || '')}</td>
      <td class="mono">${dateLabel(new Date(n.created_at).toISOString())}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">暂无通知</div>';
}

// ---------------------------------------------------------------- audit
function renderAudit(rows) {
  $('#audit').innerHTML = rows.length ? `
    <div class="card"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>实体</th><th>before → after</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td class="mono">${dateLabel(new Date(r.created_at).toISOString())}</td>
      <td><span class="badge">${esc(r.actor)}</span></td>
      <td class="mono">${esc(r.action)}</td>
      <td class="mono muted">${esc(r.entity_type)}:${esc(r.entity_id)}</td>
      <td class="mono muted" style="max-width:480px;word-break:break-all">
        ${r.before ? `<span class="neg">${esc(JSON.stringify(r.before))}</span>` : ''}
        ${r.before && r.after ? ' → ' : ''}
        ${r.after ? `<span class="pos">${esc(JSON.stringify(r.after))}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">暂无审计</div>';
}

// ---------------------------------------------------------------- action forms
function bindStatic() {
  $('#btn-run-billing').onclick = async () => {
    try { toast(JSON.stringify(await api('/api/billing/run', { method: 'POST', body: {} }))); await refreshAll(); }
    catch (e) { toast(e.message, false); }
  };
  $('#btn-deliver').onclick = async () => {
    try { toast(`通知投递完成: ${JSON.stringify(await api('/api/notifications/deliver', { method: 'POST' }))}`); await refreshAll(); }
    catch (e) { toast(e.message, false); }
  };
  $('#btn-recover').onclick = async () => {
    try { toast(`恢复结果: ${JSON.stringify(await api('/api/corrections/recover', { method: 'POST' }))}`); await refreshAll(); }
    catch (e) { toast(e.message, false); }
  };
  $('#btn-new-sub').onclick = () => openActionForm('new-sub');
  $$('.action-grid .btn[data-act]').forEach((b) =>
    b.addEventListener('click', () => openActionForm(b.dataset.act)));
}

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

function openActionForm(act) {
  const box = $('#action-form');
  box.classList.remove('hidden');
  const sub = state.subscriptions.find((s) => s.id === state.selectedSub);
  const planOptions = state.plans.map((p) =>
    `<option value="${esc(p.id)}" ${sub && p.id === sub.plan_id ? 'selected' : ''}>${esc(p.name)} (${money(p.monthly_price_cents)})</option>`).join('');

  const foot = `<div class="row-actions"><button class="btn primary" id="af-submit">提交</button>
    <button class="btn ghost" id="af-cancel">取消</button></div>`;
  const eff = `<label>生效日期 (本地 YYYY-MM-DD，可回溯)</label><input id="af-date" value="${todayLocal()}">`;

  const forms = {
    'new-sub': `<label>客户名</label><input id="af-name" value="新客户 ${Math.random().toString(36).slice(2, 7)}">
      <label>套餐</label><select id="af-plan">${planOptions}</select>
      <label>时区</label><select id="af-tz">
        <option>America/New_York</option><option>Europe/London</option>
        <option>Asia/Shanghai</option><option selected>Pacific/Auckland</option></select>
      <label>锚点日</label><input id="af-anchor" value="2026-01-31">${foot}`,
    plan_changed: `${eff}<label>新套餐</label><select id="af-plan">${planOptions}</select>
      <label>原因</label><input id="af-reason" value="admin plan change">
      <label>期望乐观锁版本 (留空跳过)</label><input id="af-ver" placeholder="${sub ? sub.version : ''}">${foot}`,
    paused: `${eff}<label>原因</label><input id="af-reason" value="admin pause">${foot}`,
    resumed: `${eff}<label>原因</label><input id="af-reason" value="admin resume">${foot}`,
    canceled: `${eff}<label>原因</label><input id="af-reason" value="admin cancel">${foot}`,
    refund: `<label>账单 ID</label><input id="af-invoice" placeholder="${state.invoices[0]?.id || ''}" value="${state.invoices.find((i) => !i.superseded_by)?.id || ''}">
      <label>退款金额 (分，整数)</label><input id="af-amount" type="number" value="500">
      <label>原因 / 幂等键</label><input id="af-reason" value="goodwill refund">
      <input id="af-key" value="ref-${Math.random().toString(36).slice(2, 10)}">${foot}`,
    fault: `<p>下次更正应用阶段将注入异常：阶段一的 pending 标记保留、阶段二整体回滚。<br>
      请随后发送一个会触发更正的回调，再点顶部 “恢复未完成更正”。</p>${foot}`,
  };
  box.innerHTML = forms[act] || '';
  $('#af-cancel') && ($('#af-cancel').onclick = () => box.classList.add('hidden'));
  $('#af-submit').onclick = () => submitAction(act);
}

async function submitAction(act) {
  const val = (id) => $(id)?.value.trim();
  try {
    if (act === 'new-sub') {
      const body = {
        customerName: val('#af-name'), planId: val('#af-plan'),
        timezone: val('#af-tz'), anchorDate: val('#af-anchor'),
        idempotencyKey: `api-create-${Math.random().toString(36).slice(2, 10)}`,
      };
      const s = await api('/api/subscriptions', { method: 'POST', body });
      state.selectedSub = s.id;
      toast('订阅已创建');
    } else if (act === 'refund') {
      const r = await api(`/api/subscriptions/${state.selectedSub}/refunds`, {
        method: 'POST',
        body: { invoiceId: val('#af-invoice'), amountCents: Number(val('#af-amount')),
          reason: val('#af-reason'), idempotencyKey: val('#af-key') },
      });
      toast(r.duplicate ? '重复退款请求，幂等返回原记录' : '退款已完成');
    } else if (act === 'fault') {
      await api('/api/test/inject-fault', { method: 'POST' });
      toast('故障已注入：下一次更正 apply 将失败');
    } else {
      const body = {
        type: act, effectiveDate: val('#af-date'), reason: val('#af-reason') || '',
      };
      if (act === 'plan_changed') {
        body.planId = val('#af-plan');
        const v = val('#af-ver');
        if (v) body.expectedVersion = Number(v);
      }
      const r = await api(`/api/subscriptions/${state.selectedSub}/events`, { method: 'POST', body });
      toast(`事件已记录 (v${r.subscription.version})`);
    }
    $('#action-form').classList.add('hidden');
    await refreshAll();
  } catch (err) {
    toast(err.message, false);
  }
}

boot().catch((e) => toast(e.message, false));
