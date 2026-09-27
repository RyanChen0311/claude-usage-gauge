// ==UserScript==
// @name         Claude 用量儀表
// @namespace    https://github.com/RyanChen0311
// @version      2.3.1
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
    // 進度條嚴重度配色（仿官方 設定 → 用量：藍 → 橘 → 紅）
    // 門檻與色碼尚未對照官方頁面確認，可依實際觀察修改
    bar: {
      warnAt: 80,          // 已用 ≥ 80% → 橘
      critAt: 95,          // 已用 ≥ 95% → 紅
      normal: '#2C84DB',
      warn:   '#E8861A',
      crit:   '#D93A3A',
    },
    // 速率分級：k = 實際速率 ÷ 目標速率（剛好在重置時用完的速率）
    rate: {
      warnK: 1.0,          // k > 1.0 → 黃：會提前耗盡
      critK: 1.5,          // k > 1.5 → 紅：剩餘時間還有 1/3 以上就會耗盡
    },
    scaleMin: 0.6,         // 面板縮放下限
    scaleMax: 2.2,         // 面板縮放上限
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
  // 每分鐘消耗百分比：0.5 → 「0.5 %/分」，0.08 → 「0.08 %/分」
  const perMin = (v) => `${String(Number(v.toFixed(2)))} %/分`;
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
  // 「X 月 X 日 X 時 X 分」（24 小時制）
  const etaText = (t) => {
    const d = new Date(t);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${d.getHours()} 時 ${d.getMinutes()} 分`;
  };
  // 重置時間：「X月X日X時X分」（不加空格）
  const resetText = (t) => {
    const d = new Date(t);
    return `${d.getMonth() + 1}月${d.getDate()}日${d.getHours()}時${d.getMinutes()}分`;
  };
  const clock = (t) => new Date(t).toLocaleTimeString('zh-TW', { hour12: false });

  // 進度條顏色：依已用量套用嚴重度
  const barColor = (u) => (u >= CFG.bar.critAt ? CFG.bar.crit : u >= CFG.bar.warnAt ? CFG.bar.warn : CFG.bar.normal);

  // 速率分級：正常不上色，只有過快才轉黃或紅
  function rateLevel(v, a) {
    if (v == null || a.r == null || !(a.r > 0) || a.state === 'out' || !(a.vTarget > 0)) return 'n';
    const k = v / a.vTarget;
    return k > CFG.rate.critK ? 'r' : k > CFG.rate.warnK ? 'y' : 'n';
  }

  // 建議區標題分級：與速率欄共用同一套 k 值門檻
  // 暫停時間 P = r × (1 − 1/k)，所以 k > 1 ⇔ 需要暫停（黃），k > 1.5 ⇔ P > r/3（紅）
  function tierFor(a) {
    if (a.state === 'out') return 'r';
    if (a.state === 'warn' || a.state === 'danger') return rateLevel(a.v, a);
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
        // 只有照目前速率會在重置前耗盡時，才顯示等待重置的提醒
        const early = a.state === 'warn' || a.state === 'danger';
        // 空等時間 = 距離重置 − 照目前速率的耗盡時間（等於建議暫停時間）
        const body = early ? `${drain}\n${waitLine(a.pause)}` : drain;
        // 不需要暫停時，不顯示「建議暫停」這一行
        return [early ? `建議暫停：${fmtHM(a.pause)}` : '', body, note];
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
      --ink:#0C2340; --dim:#4A6480;
      --tier-y:#C98A00; --tier-r:#D93A3A; }
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

    /* 四個角的縮放把手（透明，只改變游標） */
    .panel > .rz { position:absolute; z-index:3; touch-action:none; width:18px; height:18px; }
    .rz.ne { top:0; right:0; cursor:nesw-resize; } .rz.sw { bottom:0; left:0; cursor:nesw-resize; }
    .rz.nw { top:0; left:0; cursor:nwse-resize; }  .rz.se { bottom:0; right:0; cursor:nwse-resize; }
    @keyframes drift { to { transform:translate(220px, 260px) scale(1.15); } }

    header { display:flex; align-items:center; gap:8px; padding:12px 12px 10px 18px;
      border-bottom:1px solid rgba(255,255,255,.6); }
    /* 整個面板都可以抓著拖曳；按鈕與縮放把手維持各自的游標 */
    .panel, .pill { cursor:grab; user-select:none; -webkit-user-select:none; touch-action:none; }
    .dragging .panel, .dragging .pill { cursor:grabbing; }
    .title { flex:1; font-size:14px; color:var(--dim); }
    button { font:inherit; font-size:14px; color:var(--ink); cursor:pointer; padding:6px 14px;
      background:rgba(255,255,255,.45); border:1px solid rgba(255,255,255,.85); border-radius:999px;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.9), 0 2px 6px rgba(12,35,64,.10); }
    button:disabled { opacity:.6; cursor:progress; }
    button:focus-visible { outline:2px solid #2A8BE0; outline-offset:2px; }
    /* 圖示按鈕：只顯示圖示，無背景與框線 */
    .icon-btn { display:inline-flex; padding:6px; background:none; border:0; box-shadow:none;
      border-radius:8px; color:var(--dim); transition:color .2s ease; }
    .icon-btn:hover { color:var(--ink); }
    /* 重新整理固定在面板右下角，避開角落縮放把手 */
    .panel > .icon-btn.corner-refresh { position:absolute; right:20px; bottom:16px; z-index:4; }
    .icon-btn svg { display:block; width:20px; height:20px; }
    .icon-btn.busy svg { animation:spin .9s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .icon-btn.busy svg { animation:none; } }

    .stats { display:grid; grid-template-columns:auto auto; justify-content:space-between; gap:12px;
      padding:18px 18px 8px; }
    .label { font-size:13px; color:var(--dim); margin-bottom:6px; }
    .big { font-size:50px; font-weight:600; line-height:1; font-variant-numeric:tabular-nums;
      text-shadow:0 1px 0 rgba(255,255,255,.8); }
    .remain, .count { color:var(--bar, #2C84DB); transition:color .6s ease; }

    /* 進度條：扁平細條，仿官方 設定 → 用量 */
    .bar { padding:10px 18px 4px; }
    .track { height:8px; border-radius:999px; overflow:hidden; background:rgba(12,35,64,.10); }
    .fill { height:100%; width:0; border-radius:999px; background:var(--bar, #2C84DB); }
    .used { display:flex; justify-content:space-between; gap:8px; margin-top:6px;
      font-size:14px; color:var(--dim); white-space:nowrap;
      font-family:"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif; }

    .rates { display:grid; grid-template-columns:auto auto auto; justify-content:space-between;
      gap:8px; padding:12px 18px; }
    .rates .v { font-size:17px; white-space:nowrap;
      /* 數字與中文用同一套字型，避免混排時大小不一 */
      font-family:"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif; font-weight:600; font-variant-numeric:tabular-nums;
      transition:color .4s ease; }
    .rates .v[data-level="y"] { color:var(--tier-y); }
    .rates .v[data-level="r"] { color:var(--tier-r); }

    /* 建議區：純文字，標題依暫停時間分級上色 */
    .advice { padding:6px 56px 14px 18px; color:var(--ink); }   /* 右側留位置給重新整理圖示 */
    .advice .head { font-size:24px; font-weight:700; transition:color .4s ease; }
    .advice .head:empty { display:none; }
    .advice[data-tier="y"] .head { color:var(--tier-y); }
    .advice[data-tier="r"] .head { color:var(--tier-r); }
    .advice .detail { font-size:16px; line-height:1.6; margin-top:6px; white-space:pre-line;
      font-variant-numeric:tabular-nums; }
    .advice .note { font-size:12px; color:var(--dim); margin-top:6px; }
    .advice .note:empty { display:none; }
    .foot { padding:0 56px 14px 18px; font-size:12px; color:var(--dim); }
    .foot.err { color:var(--tier-r); }
    .foot:empty { display:none; }

    /* 收合後的水滴膠囊 */
    .pill { display:none; font-size:20px; font-weight:700; font-variant-numeric:tabular-nums;
      padding:10px 20px; color:var(--bar, #2C84DB);
      background:linear-gradient(135deg, rgba(255,255,255,.7), rgba(214,236,255,.35));
      -webkit-backdrop-filter:blur(18px) saturate(180%); backdrop-filter:blur(18px) saturate(180%);
      box-shadow:0 10px 26px rgba(12,35,64,.22), inset 0 1px 0 #fff; }
    .collapsed .panel { display:none; }
    .collapsed .pill { display:inline-block; }

    @media (prefers-reduced-motion: reduce) {
      .panel::before { animation:none; }
      .remain, .advice .head { transition:none; }
    }
  `;

  const $ = {};
  // 以 createElementNS 建立 SVG，避開 innerHTML（claude.ai 可能啟用 Trusted Types）
  function icon(...paths) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
      svg.setAttribute(k, v);
    }
    for (const d of paths) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }
  $.refresh  = h('button', { class: 'icon-btn corner-refresh', type: 'button', title: '重新整理', 'aria-label': '重新整理',
    onclick: () => refresh() },
    icon('M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'));
  $.collapse = h('button', { class: 'icon-btn', type: 'button', title: '收合', 'aria-label': '收合',
    onclick: () => setCollapsed(true) },
    icon('M5 12h14'));
  $.header   = h('header', {}, h('div', { class: 'title' }, 'Claude 5 小時用量'), $.collapse);
  $.remain   = h('div', { class: 'big remain' }, '—');
  $.count    = h('div', { class: 'big count' }, '—');
  $.fill     = h('div', { class: 'fill' });
  $.usedText = h('span', {}, '已用 —');
  $.resetAt  = h('span', {}, '');
  $.used     = h('div', { class: 'used' }, $.usedText, $.resetAt);
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
      h('div', {}, h('div', { class: 'label' }, '距離重置剩餘時間'), $.count)),
    h('div', { class: 'bar' }, h('div', { class: 'track' }, $.fill), $.used),
    h('div', { class: 'rates' },
      h('div', {}, h('div', { class: 'label' }, '目前速度'), $.vNow),
      h('div', {}, h('div', { class: 'label' }, '週期平均'), $.vAvg),
      h('div', {}, h('div', { class: 'label' }, '預估用完時間'), $.proj)),
    $.advice,
    $.refresh,
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
  const ui = loadJSON(CFG.uiKey, { x: null, y: null, collapsed: false, scale: 1 });
  const clampScale = (v) => Math.min(CFG.scaleMax, Math.max(CFG.scaleMin, v));
  function applyScale(v) {
    ui.scale = clampScale(v);
    $.wrap.style.zoom = String(ui.scale);   // 等比縮放整個面板（含文字）
  }
  applyScale(Number(ui.scale) || 1);
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
  // 面板實際尺寸一有變化（收合↔展開、縮放、文字行數增減、視窗縮小），
  // 就用目前的實際位置重新夾一次邊界，確保永遠留在可視範圍內
  function keepInView() {
    const r = host.getBoundingClientRect();
    if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) {
      place(r.left, r.top);
      saveJSON(CFG.uiKey, ui);
    }
  }
  new ResizeObserver(keepInView).observe(host);
  addEventListener('resize', keepInView);

  // ---- 拖曳移動 ----
  // 按下時記錄「游標起點」與「面板起點」，移動時把位移量加回面板起點。
  // 位移超過門檻才算拖曳，否則視為點擊（讓收合膠囊仍可點一下展開）。
  const DRAG_THRESHOLD = 4;   // px
  function makeDraggable(el) {
    let st = null;            // 拖曳狀態：null 代表沒有按住
    let suppressClick = false;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;                       // 只接受主要按鍵
      if (el === $.panel && e.target.closest('button, .rz')) return;  // 按鈕與縮放把手不觸發拖曳
      const r = host.getBoundingClientRect();
      st = { px: e.clientX, py: e.clientY, left: r.left, top: r.top, moved: false, id: e.pointerId };
      el.setPointerCapture(e.pointerId);                // 游標移出元素也持續收到事件（小膠囊特別需要）
    });

    el.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.px, dy = e.clientY - st.py;
      if (!st.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        st.moved = true;
        $.wrap.classList.add('dragging');
      }
      place(st.left + dx, st.top + dy);                 // 新位置 = 面板起點 + 游標位移
    });

    const end = () => {
      if (!st) return;
      if (st.moved) {
        suppressClick = true;                           // 拖曳結束後的那次 click 不算數
        $.wrap.classList.remove('dragging');
        saveJSON(CFG.uiKey, ui);                        // 記住位置
      }
      st = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    // 捕獲階段攔截拖曳後誤觸的 click
    el.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); }
    }, true);
  }
  makeDraggable($.panel);
  makeDraggable($.pill);

  // ---- 拖曳邊緣等比縮放 ----
  // 內容版面固定，因此寬高鎖定比例一起縮放，文字與數字跟著放大縮小
  (function enableResize() {
    for (const dir of ['ne', 'nw', 'se', 'sw']) {   // 只保留四個角
      const grip = h('div', { class: `rz ${dir}`, title: '拖曳調整大小，雙擊還原' });
      let st = null;
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const r = host.getBoundingClientRect();
        st = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height, s: ui.scale };
        grip.setPointerCapture(e.pointerId);
      });
      grip.addEventListener('pointermove', (e) => {
        if (!st) return;
        const dx = e.clientX - st.x, dy = e.clientY - st.y;
        const fx = dir.includes('e') ? (st.w + dx) / st.w : dir.includes('w') ? (st.w - dx) / st.w : null;
        const fy = dir.includes('s') ? (st.h + dy) / st.h : dir.includes('n') ? (st.h - dy) / st.h : null;
        // 角落取變化較大的一軸；邊緣只看該軸
        const f = fx == null ? fy : fy == null ? fx : (Math.abs(fx - 1) > Math.abs(fy - 1) ? fx : fy);
        applyScale(st.s * f);
        const k = ui.scale / st.s;
        // 拖左邊或上邊時，固定對側邊緣不動
        const left = dir.includes('w') ? st.left + st.w - st.w * k : st.left;
        const top  = dir.includes('n') ? st.top + st.h - st.h * k : st.top;
        place(left, top);
      });
      const end = () => { if (st) { st = null; saveJSON(CFG.uiKey, ui); } };
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
      grip.addEventListener('dblclick', () => {
        const r = host.getBoundingClientRect();
        applyScale(1);
        place(r.left, r.top);
        saveJSON(CFG.uiKey, ui);
      });
      $.panel.append(grip);
    }
  })();

  // ---- 每秒重繪 ----
  let lastOk = null, lastErr = null;

  function render() {
    if (!samples.length) return;
    const a = analyze(Date.now());
    $.panel.dataset.state = a.state;
    $.pill.dataset.state = a.state;

    $.remain.textContent = pct(100 - a.u);
    const used = Math.min(100, Math.max(0, a.u));
    $.fill.style.width = `${used}%`;          // 進度條 = 已用量（同官方）
    $.wrap.style.setProperty('--bar', barColor(used));   // 進度條、剩餘數字、膠囊共用
    $.advice.dataset.tier = tierFor(a);
    $.usedText.textContent = `已用 ${pct(a.u)}`;
    const resetTs = samples[samples.length - 1].r;
    $.resetAt.textContent = resetTs && a.state !== 'rolled' ? `${resetText(resetTs)} 重置` : '';
    $.count.textContent = a.r != null ? fmtHMS(a.r) : '—';
    $.vNow.textContent = a.r == null ? '—' : a.vNow != null ? perMin(a.vNow) : '取樣中';
    $.vAvg.textContent = a.vAvg != null ? perMin(a.vAvg) : '—';
    $.vNow.dataset.level = rateLevel(a.vNow, a);
    $.vAvg.dataset.level = rateLevel(a.vAvg, a);
    $.proj.dataset.level = rateLevel(a.vNow, a);   // 預估用完時間由目前速度推算，顏色跟著目前速度
    // 依目前實際速率（最近 15 分鐘）推算用完時刻，不考慮中途重置
    $.proj.textContent =
      a.state === 'out' ? '已用完'
      : a.r == null ? '—'
      : a.vNow == null ? '取樣中'
      : a.vNow <= 0 ? '目前無消耗'
      : etaText(Date.now() + (a.remain / a.vNow) * 60_000);

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
    } else {
      $.foot.className = 'foot';
      $.foot.textContent = '';                         // 正常時不顯示，只在出錯時提示
    }
  }

  // ---- 抓取流程 ----
  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    $.refresh.disabled = true;
    $.refresh.classList.add('busy');
    $.refresh.title = '更新中…';
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
      $.refresh.classList.remove('busy');
      $.refresh.title = '重新整理';
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
