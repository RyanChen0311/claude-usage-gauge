// ==UserScript==
// @name         Claude 用量儀表
// @namespace    https://github.com/RyanChen0311
// @version      1.0.0
// @description  在 claude.ai 顯示 5 小時用量、重置倒數、消耗速度與暫停建議
// @match        https://claude.ai/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (document.getElementById('cug-host')) return;

  // ================= 設定 =================
  const CFG = {
    windowMin: 300,        // 5 小時週期（分鐘）
    pollMs: 60_000,        // 自動更新間隔
    rateWindowMin: 15,     // 即時速度：取最近 15 分鐘樣本
    minSpanMin: 3,         // 樣本跨度不足 3 分鐘時改用週期平均
    warnPauseMin: 10,      // 建議暫停 < 10 分鐘 → 琥珀色「稍微放慢」
    resetJitterMs: 5 * 60_000,
    storeKey: 'cug.samples',
    uiKey: 'cug.ui',
  };

  // ================= 資料層 =================
  const getCookie = (name) => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };

  let orgId = null;
  async function resolveOrgId() {
    if (orgId) return orgId;
    orgId = getCookie('lastActiveOrg');
    if (orgId) return orgId;
    const res = await fetch('/api/organizations', { credentials: 'include' });
    if (!res.ok) throw new Error(`取得組織失敗（HTTP ${res.status}）`);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length || !list[0].uuid) throw new Error('找不到組織資料');
    orgId = list[0].uuid;
    return orgId;
  }

  async function fetchUsage() {
    const id = await resolveOrgId();
    const res = await fetch(`/api/organizations/${id}/usage`, { credentials: 'include' });
    if (!res.ok) {
      orgId = null; // 下次重新解析組織
      throw new Error(`用量端點回應 HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data || !('five_hour' in data)) throw new Error('回傳格式改變，找不到 five_hour');
    const fh = data.five_hour || {};
    return {
      u: Number(fh.utilization ?? 0),
      resetsAt: fh.resets_at ? Date.parse(fh.resets_at) : null,
    };
  }

  const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 */ } };

  let samples = loadJSON(CFG.storeKey, []);

  function addSample(snap) {
    const last = samples[samples.length - 1];
    const newWindow = last && (
      Math.abs((last.r ?? 0) - (snap.resetsAt ?? 0)) > CFG.resetJitterMs || snap.u < last.u
    );
    if (newWindow) samples = [];
    samples.push({ t: Date.now(), u: snap.u, r: snap.resetsAt });
    const cutoff = Date.now() - CFG.windowMin * 60_000;
    samples = samples.filter((p) => p.t >= cutoff).slice(-400);
    saveJSON(CFG.storeKey, samples);
  }

  // ================= 計算層 =================
  // 最小平方法斜率，單位：% / 分鐘
  function slope(points) {
    const n = points.length;
    if (n < 2) return null;
    const t0 = points[0].t;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of points) {
      const x = (p.t - t0) / 60_000, y = p.u;
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const d = n * sxx - sx * sx;
    return d === 0 ? null : (n * sxy - sx * sy) / d;
  }

  function analyze(now) {
    const cur = samples[samples.length - 1];
    const u = cur.u;
    if (!cur.r) return { u, state: 'idle' };
    if (cur.r <= now) return { u, state: 'rolled' };

    const r = (cur.r - now) / 60_000;                         // 距離重置（分鐘）
    const elapsed = Math.min(CFG.windowMin, Math.max(0, CFG.windowMin - r));
    const vAvg = elapsed > 0.5 ? u / elapsed : null;          // 週期平均速度

    const recent = samples.filter((p) => p.t >= now - CFG.rateWindowMin * 60_000);
    const span = recent.length > 1 ? (recent[recent.length - 1].t - recent[0].t) / 60_000 : 0;
    let vNow = span >= CFG.minSpanMin ? slope(recent) : null;  // 即時速度
    if (vNow !== null) vNow = Math.max(0, vNow);

    const v = vNow ?? vAvg ?? 0;
    const remain = Math.max(0, 100 - u);
    const vTarget = remain / r;                                // 剛好用完所需速度
    const projected = u + v * r;                               // 照目前速度，重置時用到

    let pause = 0, state;
    if (u >= 100) state = 'out';
    else if (v <= 0) state = 'safe';
    else {
      pause = r - remain / v;                                  // P = r − (100 − u) / v
      state = pause <= 0 ? 'safe' : pause < CFG.warnPauseMin ? 'warn' : 'danger';
    }
    return { u, r, vAvg, vNow, v, vTarget, remain, projected, pause: Math.max(0, pause), state };
  }

  // ================= 格式化 =================
  const pct = (x) => `${Math.round(Math.min(999, Math.max(0, x)))}%`;
  const perHour = (v) => `${(v * 60).toFixed(1)}%/時`;
  const pad = (n) => String(n).padStart(2, '0');
  const fmtHMS = (min) => {
    const s = Math.max(0, Math.floor(min * 60));
    return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  };
  const fmtDur = (min) => {
    const m = Math.ceil(min);
    if (m < 60) return `${m} 分鐘`;
    return `${Math.floor(m / 60)} 小時 ${m % 60} 分`;
  };
  const clock = (t) => new Date(t).toLocaleTimeString('zh-TW', { hour12: false });

  function advice(a) {
    const note = a.vNow == null && a.r != null ? '即時速度需累積 3 分鐘樣本，目前以週期平均估算。' : '';
    switch (a.state) {
      case 'idle':
        return ['週期尚未開始', '送出下一則訊息後，5 小時計時才會開始。', ''];
      case 'rolled':
        return ['上個週期已結束', '按「重新整理」取得新週期的資料。', ''];
      case 'out':
        return ['額度已用完', `再等 ${fmtDur(a.r)} 就會重置。`, ''];
      case 'safe':
        return ['節奏剛好，照常使用',
          `照目前速度，重置時約用到 ${pct(a.projected)}。`, note];
      case 'warn':
        return ['稍微放慢',
          `暫停約 ${fmtDur(a.pause)}，或把速度降到 ${perHour(a.vTarget)} 以下。`, note];
      default:
        return [`建議暫停 ${fmtDur(a.pause)}`,
          `照目前速度約 ${fmtDur(a.remain / a.v)} 後用完，比重置早 ${fmtDur(a.pause)}。` +
          `暫停後可恢復原速，或全程降到 ${perHour(a.vTarget)}。`, note];
    }
  }

  // ================= 呈現層 =================
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    el.append(...kids.flat().filter((c) => c != null));
    return el;
  }

  const CSS = `
    :host { all: initial;
      --ink:#EAF1F7; --dim:#8FA3B5; --line:#2C4154; --panel:#1B2B3A; --track:#0F1A24;
      --safe:#34C58A; --warn:#F0B23A; --danger:#EF5B5B; --idle:#8FA3B5; --on-state:#0E1A24; }
    * { box-sizing:border-box; }
    .wrap { font-family:"Bahnschrift","DIN Alternate","Segoe UI","Microsoft JhengHei","PingFang TC",sans-serif; }
    .panel { --state:var(--idle); width:400px; max-width:calc(100vw - 24px); background:var(--panel);
      color:var(--ink); border:1px solid var(--line); border-radius:14px; overflow:hidden;
      box-shadow:0 12px 32px rgba(8,16,24,.45); }
    [data-state="safe"]   { --state:var(--safe); }
    [data-state="warn"]   { --state:var(--warn); }
    [data-state="danger"],[data-state="out"] { --state:var(--danger); }
    header { display:flex; align-items:center; gap:8px; padding:10px 12px 10px 16px;
      border-bottom:1px solid var(--line); cursor:grab; user-select:none; touch-action:none; }
    header:active { cursor:grabbing; }
    .title { flex:1; font-size:14px; color:var(--dim); }
    button { font:inherit; font-size:14px; color:var(--ink); background:transparent;
      border:1px solid #3A536A; border-radius:8px; padding:6px 12px; cursor:pointer; }
    button.primary { background:var(--ink); color:#14202B; border-color:var(--ink); font-weight:600; }
    button:disabled { opacity:.6; cursor:progress; }
    button:focus-visible { outline:2px solid #7FC4FF; outline-offset:2px; }
    .stats { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding:18px 16px 8px; }
    .label { font-size:13px; color:var(--dim); margin-bottom:6px; }
    .big { font-size:60px; font-weight:600; line-height:1; font-variant-numeric:tabular-nums; }
    .remain { color:var(--state); }
    .count { font-size:44px; line-height:60px; }
    .bar { padding:8px 16px 4px; }
    .track { height:12px; background:var(--track); border-radius:6px; overflow:hidden; }
    .fill { height:100%; width:0; background:var(--state); transition:width .4s ease; }
    .used { margin-top:6px; font-size:14px; color:var(--dim); font-variant-numeric:tabular-nums; }
    .rates { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; padding:12px 16px; }
    .rates .v { font-size:20px; font-weight:600; font-variant-numeric:tabular-nums; }
    .advice { margin:4px 12px 12px; padding:14px 16px; border-radius:10px;
      background:var(--state); color:var(--on-state); }
    .advice .head { font-size:24px; font-weight:700; }
    .advice .detail { font-size:15px; line-height:1.5; margin-top:4px; }
    .advice .note { font-size:12px; opacity:.75; margin-top:6px; }
    .advice .note:empty { display:none; }
    .foot { padding:0 16px 12px; font-size:12px; color:var(--dim); }
    .foot.err { color:#FF8A8A; }
    .pill { display:none; --state:var(--idle); background:var(--state); color:var(--on-state);
      border:0; border-radius:999px; padding:10px 18px; font-size:20px; font-weight:700;
      font-variant-numeric:tabular-nums; box-shadow:0 8px 24px rgba(8,16,24,.45); }
    .collapsed .panel { display:none; }
    .collapsed .pill { display:inline-block; }
    @media (prefers-reduced-motion: reduce) { .fill { transition:none; } }
  `;

  const $ = {};
  $.refresh  = h('button', { class: 'primary', type: 'button', onclick: () => refresh() }, '重新整理');
  $.collapse = h('button', { type: 'button', onclick: () => setCollapsed(true) }, '收合');
  $.header   = h('header', {}, h('div', { class: 'title' }, 'Claude 5 小時用量'), $.refresh, $.collapse);
  $.remain   = h('div', { class: 'big remain' }, '—');
  $.count    = h('div', { class: 'big count' }, '—');
  $.fill     = h('div', { class: 'fill' });
  $.used     = h('div', { class: 'used' }, '已用 —');
  $.vNow     = h('div', { class: 'v' }, '—');
  $.vAvg     = h('div', { class: 'v' }, '—');
  $.proj     = h('div', { class: 'v' }, '—');
  $.head     = h('div', { class: 'head' }, '讀取中');
  $.detail   = h('div', { class: 'detail' }, '正在取得用量資料。');
  $.note     = h('div', { class: 'note' });
  $.foot     = h('div', { class: 'foot' }, '');
  $.panel = h('div', { class: 'panel', 'data-state': 'idle' },
    $.header,
    h('div', { class: 'stats' },
      h('div', {}, h('div', { class: 'label' }, '剩餘用量'), $.remain),
      h('div', {}, h('div', { class: 'label' }, '距離重置'), $.count)),
    h('div', { class: 'bar' }, h('div', { class: 'track' }, $.fill), $.used),
    h('div', { class: 'rates' },
      h('div', {}, h('div', { class: 'label' }, '目前速度'), $.vNow),
      h('div', {}, h('div', { class: 'label' }, '週期平均'), $.vAvg),
      h('div', {}, h('div', { class: 'label' }, '重置時預估'), $.proj)),
    h('div', { class: 'advice' }, $.head, $.detail, $.note),
    $.foot);
  $.pill = h('button', { class: 'pill', type: 'button', 'data-state': 'idle',
    onclick: () => setCollapsed(false), 'aria-label': '展開用量面板' }, '—');
  $.wrap = h('div', { class: 'wrap' }, $.panel, $.pill);

  const host = h('div', { id: 'cug-host' });
  host.style.cssText = 'position:fixed;z-index:2147483000;top:72px;right:16px;';
  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  shadow.append(styleEl, $.wrap);
  document.body.append(host);

  // ---- 位置與收合狀態 ----
  const ui = loadJSON(CFG.uiKey, { x: null, y: null, collapsed: false });
  function place(x, y) {
    x = Math.min(Math.max(0, x), Math.max(0, innerWidth - host.offsetWidth));
    y = Math.min(Math.max(0, y), Math.max(0, innerHeight - host.offsetHeight));
    host.style.left = `${x}px`; host.style.top = `${y}px`; host.style.right = 'auto';
    ui.x = x; ui.y = y;
  }
  function setCollapsed(c) {
    ui.collapsed = c;
    $.wrap.classList.toggle('collapsed', c);
    saveJSON(CFG.uiKey, ui);
  }
  setCollapsed(!!ui.collapsed);
  if (ui.x != null) place(ui.x, ui.y);
  addEventListener('resize', () => { if (ui.x != null) place(ui.x, ui.y); });

  (function enableDrag(handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = host.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top; dragging = true;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (dragging) place(ox + e.clientX - sx, oy + e.clientY - sy);
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      saveJSON(CFG.uiKey, ui);
    });
  })($.header);

  // ---- 每秒重繪 ----
  let lastOk = null, lastErr = null;

  function render() {
    if (!samples.length) return;
    const a = analyze(Date.now());
    $.panel.dataset.state = a.state;
    $.pill.dataset.state = a.state;

    $.remain.textContent = pct(100 - a.u);
    $.fill.style.width = `${Math.min(100, Math.max(0, a.u))}%`;
    $.used.textContent = `已用 ${pct(a.u)}`;
    $.count.textContent = a.r != null ? fmtHMS(a.r) : '—';
    $.vNow.textContent = a.r == null ? '—' : a.vNow != null ? perHour(a.vNow) : '取樣中';
    $.vAvg.textContent = a.vAvg != null ? perHour(a.vAvg) : '—';
    $.proj.textContent = a.r != null ? pct(a.projected) : '—';

    const [head, detail, note] = advice(a);
    $.head.textContent = head;
    $.detail.textContent = detail;
    $.note.textContent = note;

    $.pill.textContent = a.r != null ? `剩 ${pct(100 - a.u)}　${fmtHMS(a.r)}` : `剩 ${pct(100 - a.u)}`;
  }

  function renderFoot() {
    if (lastErr) {
      $.foot.className = 'foot err';
      $.foot.textContent = `讀取失敗：${lastErr}。按「重新整理」重試。`;
    } else if (lastOk) {
      $.foot.className = 'foot';
      $.foot.textContent = `更新於 ${clock(lastOk)}，每 ${CFG.pollMs / 1000} 秒自動更新`;
    }
  }

  // ---- 抓取流程 ----
  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    $.refresh.disabled = true;
    $.refresh.textContent = '更新中…';
    try {
      addSample(await fetchUsage());
      lastOk = Date.now(); lastErr = null;
    } catch (e) {
      lastErr = e.message || String(e);
      if (!samples.length) {
        $.head.textContent = '無法取得用量';
        $.detail.textContent = '請確認已登入 claude.ai；若持續失敗，可能是網站內部端點已變更。';
      }
    } finally {
      busy = false;
      $.refresh.disabled = false;
      $.refresh.textContent = '重新整理';
      render(); renderFoot();
    }
  }

  render();
  refresh();
  setInterval(refresh, CFG.pollMs);
  setInterval(render, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
})();
