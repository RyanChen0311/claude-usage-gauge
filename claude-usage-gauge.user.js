// ==UserScript==
// @name         Claude 用量儀表
// @namespace    https://github.com/RyanChen0311
// @version      1.2.0
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
  // 每分鐘消耗百分比：0.5 → 「每分鐘 0.5%」，0.08 → 「每分鐘 0.08%」
  const perMin = (v) => `每分鐘 ${String(Number(v.toFixed(2)))}%`;
  const pad = (n) => String(n).padStart(2, '0');
  const fmtHMS = (min) => {
    const s = Math.max(0, Math.floor(min * 60));
    return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  };
  // 「X 小時 XX 分」
  const fmtHM = (min) => {
    const m = Math.max(0, Math.ceil(min));
    return `${Math.floor(m / 60)} 小時 ${pad(m % 60)} 分`;
  };
  const waitLine = (r) => `仍需等待 ${Math.max(0, Math.ceil(r))} 分後重置`;
  const clock = (t) => new Date(t).toLocaleTimeString('zh-TW', { hour12: false });

  // 剩餘比例 → 色相：100% 綠(145) → 50% 黃(48) → 0% 紅(0)
  const hueFor = (p) => (p >= 0.5 ? 48 + ((p - 0.5) / 0.5) * 97 : (p / 0.5) * 48).toFixed(0);

  // 建議區標題分級：暫停 ≤20 分綠、20～40 分黃、>40 分紅
  function tierFor(a) {
    if (a.state === 'safe') return 'g';
    if (a.state === 'out') return 'r';
    if (a.state === 'warn' || a.state === 'danger') {
      return a.pause <= 20 ? 'g' : a.pause <= 40 ? 'y' : 'r';
    }
    return 'n';
  }

  // 回傳 [標題, 內文（多行）, 附註]
  function advice(a) {
    const note = a.vNow == null && a.r != null ? '即時速度需累積 3 分鐘樣本，目前以週期平均估算。' : '';
    switch (a.state) {
      case 'idle':
        return ['週期尚未開始', '送出下一則訊息後，5 小時計時才會開始。', ''];
      case 'rolled':
        return ['上個週期已結束', '按「重新整理」取得新週期的資料。', ''];
      case 'out':
        return ['額度已用完', waitLine(a.r), ''];
      default: {
        const drain = a.v > 0 ? `維持目前速率：約 ${fmtHM(a.remain / a.v)}耗盡用量`
                              : '維持目前速率：目前沒有消耗';
        return [`建議暫停：${fmtHM(a.pause)}`, `${drain}\n${waitLine(a.r)}`, note];
      }
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
      --ink:#0C2340; --dim:#4A6480; --h:145;
      --tier-g:#1E9E63; --tier-y:#C98A00; --tier-r:#D93A3A; }
    * { box-sizing:border-box; }
    .wrap { font-family:"Bahnschrift","DIN Alternate","Segoe UI","Microsoft JhengHei","PingFang TC",sans-serif; }

    /* 水滴玻璃面板 */
    .panel { position:relative; width:400px; max-width:calc(100vw - 24px); color:var(--ink);
      background:linear-gradient(135deg, rgba(255,255,255,.74), rgba(214,236,255,.46));
      -webkit-backdrop-filter:blur(22px) saturate(180%); backdrop-filter:blur(22px) saturate(180%);
      border:1px solid rgba(255,255,255,.75); border-radius:24px; overflow:hidden;
      box-shadow:0 18px 40px rgba(12,35,64,.22), inset 0 1px 0 rgba(255,255,255,.95),
                 inset 0 -12px 30px rgba(120,190,255,.20); }
    .panel::before { content:""; position:absolute; width:320px; height:320px; top:-160px; left:-80px;
      border-radius:50%; pointer-events:none;
      background:radial-gradient(closest-side, rgba(255,255,255,.65), rgba(180,225,255,.25) 55%, transparent);
      animation:drift 18s ease-in-out infinite alternate; }
    .panel > * { position:relative; z-index:1; }
    @keyframes drift { to { transform:translate(220px, 260px) scale(1.15); } }

    header { display:flex; align-items:center; gap:8px; padding:12px 12px 10px 18px;
      border-bottom:1px solid rgba(255,255,255,.6); cursor:grab; user-select:none; touch-action:none; }
    header:active { cursor:grabbing; }
    .title { flex:1; font-size:14px; color:var(--dim); }
    button { font:inherit; font-size:14px; color:var(--ink); cursor:pointer; padding:6px 14px;
      background:rgba(255,255,255,.45); border:1px solid rgba(255,255,255,.85); border-radius:999px;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.9), 0 2px 6px rgba(12,35,64,.10); }
    button.primary { color:#fff; font-weight:600; border-color:rgba(255,255,255,.7);
      background:linear-gradient(180deg, rgba(110,195,255,.95), rgba(30,130,225,.95));
      box-shadow:inset 0 1px 0 rgba(255,255,255,.65), 0 4px 12px rgba(30,130,225,.35); }
    button:disabled { opacity:.6; cursor:progress; }
    button:focus-visible { outline:2px solid #2A8BE0; outline-offset:2px; }

    .stats { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding:18px 18px 8px; }
    .label { font-size:13px; color:var(--dim); margin-bottom:6px; }
    .big { font-size:60px; font-weight:600; line-height:1; font-variant-numeric:tabular-nums;
      text-shadow:0 1px 0 rgba(255,255,255,.8); }
    .remain { color:hsl(var(--h) 80% 36%); transition:color .6s ease; }
    .count { font-size:44px; line-height:60px; }

    /* 玻璃管 + 流動液體 */
    .bar { padding:8px 18px 4px; }
    .track { height:16px; border-radius:999px; overflow:hidden; background:rgba(255,255,255,.35);
      box-shadow:inset 0 2px 4px rgba(12,35,64,.18), inset 0 -1px 0 rgba(255,255,255,.85); }
    .fill { position:relative; height:100%; width:0; border-radius:999px; overflow:hidden;
      background:linear-gradient(90deg, hsl(var(--h) 85% 60%), hsl(var(--h) 90% 44%));
      box-shadow:inset 0 2px 3px rgba(255,255,255,.6);
      transition:width .8s cubic-bezier(.2,.8,.2,1), background .6s ease; }
    .fill::after { content:""; position:absolute; top:0; bottom:0; left:-40%; width:40%;
      background:linear-gradient(90deg, transparent, rgba(255,255,255,.65), transparent);
      animation:flow 2.6s ease-in-out infinite; }
    @keyframes flow { to { transform:translateX(350%); } }
    .used { margin-top:6px; font-size:14px; color:var(--dim); font-variant-numeric:tabular-nums; }

    .rates { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; padding:12px 18px; }
    .rates .v { font-size:17px; white-space:nowrap; font-weight:600; font-variant-numeric:tabular-nums; }

    /* 建議區：白色水滴卡片，標題依暫停時間分級上色 */
    .advice { margin:4px 12px 14px; padding:14px 16px; border-radius:18px; color:var(--ink);
      background:rgba(255,255,255,.88); border:1px solid rgba(255,255,255,.95);
      box-shadow:0 6px 18px rgba(12,35,64,.12), inset 0 1px 0 #fff; }
    .advice .head { font-size:24px; font-weight:700; transition:color .4s ease; }
    .advice[data-tier="g"] .head { color:var(--tier-g); }
    .advice[data-tier="y"] .head { color:var(--tier-y); }
    .advice[data-tier="r"] .head { color:var(--tier-r); }
    .advice .detail { font-size:16px; line-height:1.6; margin-top:6px; white-space:pre-line;
      font-variant-numeric:tabular-nums; }
    .advice .note { font-size:12px; color:var(--dim); margin-top:6px; }
    .advice .note:empty { display:none; }
    .foot { padding:0 18px 14px; font-size:12px; color:var(--dim); }
    .foot.err { color:var(--tier-r); }

    /* 收合後的水滴膠囊 */
    .pill { display:none; font-size:20px; font-weight:700; font-variant-numeric:tabular-nums;
      padding:10px 20px; color:hsl(var(--h) 80% 34%);
      background:linear-gradient(135deg, rgba(255,255,255,.7), rgba(214,236,255,.35));
      -webkit-backdrop-filter:blur(18px) saturate(180%); backdrop-filter:blur(18px) saturate(180%);
      box-shadow:0 10px 26px rgba(12,35,64,.22), inset 0 1px 0 #fff; }
    .collapsed .panel { display:none; }
    .collapsed .pill { display:inline-block; }

    @media (prefers-reduced-motion: reduce) {
      .panel::before, .fill::after { animation:none; }
      .fill, .remain, .advice .head { transition:none; }
    }
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
  $.advice   = h('div', { class: 'advice', 'data-tier': 'n' }, $.head, $.detail, $.note);
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
    $.advice,
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
    const rem = Math.min(100, Math.max(0, 100 - a.u));
    $.wrap.style.setProperty('--h', hueFor(rem / 100));
    $.fill.style.width = `${rem}%`;           // 液體量 = 剩餘用量
    $.advice.dataset.tier = tierFor(a);
    $.used.textContent = `已用 ${pct(a.u)}`;
    $.count.textContent = a.r != null ? fmtHMS(a.r) : '—';
    $.vNow.textContent = a.r == null ? '—' : a.vNow != null ? perMin(a.vNow) : '取樣中';
    $.vAvg.textContent = a.vAvg != null ? perMin(a.vAvg) : '—';
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
