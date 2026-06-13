/* 本地管理界面：联系人列表 / 聊天气泡（双向加载）/ 日历跳转 / 搜索 / 导出 */
const $ = (id) => document.getElementById(id);
const PAGE = 100;

let currentUid = null;
let currentContact = null;
let contactsCache = [];
let selfInfo = {};
// 当前渲染的消息窗口（时间正序），两端可继续加载
let view = { msgs: [], hasEarlier: false, hasLater: false };
let dayCounts = new Map(); // "YYYY-MM-DD" -> 条数
let calCursor = null; // { y, m } 日历当前显示的月份

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const stripTags = (s) => String(s ?? "").replace(/<[^>]+>/g, "");
const pad = (n) => String(n).padStart(2, "0");

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), 3000);
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function fmtBytes(b) {
  if (!b) return "0 MB";
  const mb = b / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb.toFixed(1) + " MB";
}

async function loadStats() {
  const s = await api("/api/stats");
  $("stats-line").textContent = `${s.messages} 条消息 · ${s.contacts} 位联系人`;
  $("welcome-stats").innerHTML = `
    <div class="stat-card"><b>${s.messages}</b><span>消息</span></div>
    <div class="stat-card"><b>${s.contacts}</b><span>联系人</span></div>
    <div class="stat-card"><b>${s.media_done}</b><span>媒体文件</span></div>
    <div class="stat-card"><b>${fmtBytes(s.media_bytes)}</b><span>媒体体积</span></div>`;
}

// 头像优先用本地化文件（远程签名 URL 会过期），其次远程，最后首字降级
function bestAvatarSrc(c) {
  if (c.avatar_path && c.avatar_path !== "failed") return "/media/" + c.avatar_path;
  return c.avatar_url || "";
}

function avatarHtml(c) {
  const ch = esc((c.screen_name || c.uid || "?").slice(0, 1));
  const src = bestAvatarSrc(c);
  if (src)
    return `<img class="avatar" src="${esc(src)}" referrerpolicy="no-referrer" alt=""
      onerror="this.outerHTML='<div class=&quot;avatar-fallback&quot;>${ch}</div>'">`;
  return `<div class="avatar-fallback">${ch}</div>`;
}

async function loadContacts() {
  contactsCache = await api("/api/contacts");
  const list = $("contact-list");
  if (!contactsCache.length) return;
  list.innerHTML = contactsCache
    .map(
      (c) => `
    <div class="contact${c.uid === currentUid ? " active" : ""}" data-uid="${esc(c.uid)}">
      ${avatarHtml(c)}
      <div class="info">
        <div class="name">${esc(c.screen_name || "UID " + c.uid)}</div>
        <div class="meta">${c.last_msg_at ? c.last_msg_at.slice(0, 10) : "尚未同步"}</div>
      </div>
      <div class="count">${c.msg_count}</div>
    </div>`
    )
    .join("");
  list.querySelectorAll(".contact").forEach((el) =>
    el.addEventListener("click", () => openChat(el.dataset.uid)));
}

// ---------- 消息窗口 ----------
async function fetchMsgs(params) {
  const qs = new URLSearchParams({ uid: currentUid, limit: PAGE, ...params });
  return api("/api/messages?" + qs);
}

function msgAvatarHtml(direction) {
  const src =
    direction === "in"
      ? currentContact && bestAvatarSrc(currentContact)
      : (selfInfo.avatar_local ? "/media/" + selfInfo.avatar_local : selfInfo.avatar_url);
  const name = direction === "in"
    ? (currentContact && currentContact.screen_name) || "?"
    : selfInfo.screen_name || "我";
  const ch = esc(name.slice(0, 1));
  if (src)
    return `<img class="msg-ava" src="${esc(src)}" referrerpolicy="no-referrer" alt=""
      onerror="this.outerHTML='<div class=&quot;msg-ava fallback&quot;>${ch}</div>'">`;
  return `<div class="msg-ava fallback">${ch}</div>`;
}

function bubbleHtml(m) {
  const mediaHtml = (m.media || [])
    .map((md) =>
      md.type === "video"
        ? `<video controls src="/media/${esc(md.path)}"></video>`
        : md.type === "voice"
        ? `<audio controls src="/media/${esc(md.path)}"></audio>`
        : `<img src="/media/${esc(md.path)}" loading="lazy" onclick="window.open(this.src)">`
    )
    .join("");
  const tag =
    m.type !== "text" && !(m.media || []).length
      ? `<div class="media-tag">[${esc(m.type)} 媒体未下载或下载中]</div>`
      : "";
  return `<div class="bubble">${esc(stripTags(m.text))}${mediaHtml}${tag}</div>`;
}

// scrollMode: 'bottom' 滚到底 | 'top' 滚到顶 | 'keep' 保持可视位置(向上补历史) | 'restore' 保持 scrollTop
function renderView(scrollMode) {
  const box = $("messages");
  const prevH = box.scrollHeight;
  const prevTop = box.scrollTop;
  const html = [];
  if (view.hasEarlier)
    html.push(`<div class="load-inline"><button id="btn-earlier" class="btn ghost">↑ 加载更早的消息</button></div>`);
  let lastDay = null;
  for (const m of view.msgs) {
    const day = (m.created_at || "").slice(0, 10);
    if (day && day !== lastDay) {
      html.push(`<div class="day-divider" id="day-${day}"><span>${esc(day)}</span></div>`);
      lastDay = day;
    }
    const dir = m.direction === "in" ? "in" : "out";
    const ava = msgAvatarHtml(dir);
    const time = `<div class="time">${esc((m.created_at || "").slice(11, 16))}</div>`;
    html.push(`
      <div class="msg ${dir}">
        ${dir === "in" ? ava + bubbleHtml(m) + time : time + bubbleHtml(m) + ava}
      </div>`);
  }
  if (view.hasLater)
    html.push(`<div class="load-inline"><button id="btn-later" class="btn ghost">↓ 加载之后的消息</button></div>`);
  box.innerHTML = html.join("");
  if (scrollMode === "bottom") box.scrollTop = box.scrollHeight;
  else if (scrollMode === "top") box.scrollTop = 0;
  else if (scrollMode === "keep") box.scrollTop = box.scrollHeight - prevH + prevTop;
  else if (scrollMode === "restore") box.scrollTop = prevTop;
}

async function openChat(uid, jumpDate) {
  currentUid = uid;
  $("welcome").hidden = true;
  $("search-results").hidden = true;
  $("chat").hidden = false;
  hideCalendar();
  const c = contactsCache.find((x) => x.uid === uid);
  currentContact = c || null;
  $("chat-name").textContent = c ? c.screen_name || "UID " + uid : uid;
  $("chat-meta").textContent = `UID ${uid} · ${c ? c.msg_count : "?"} 条消息`;
  document.querySelectorAll(".contact").forEach((el) =>
    el.classList.toggle("active", el.dataset.uid === uid));
  // 日历数据
  const days = await api(`/api/days?uid=${uid}`).catch(() => []);
  dayCounts = new Map(days.map((d) => [d.day, d.n]));
  calCursor = null;
  if (jumpDate) return jumpToDate(jumpDate);
  const rows = await fetchMsgs({});
  view = { msgs: rows.slice().reverse(), hasEarlier: rows.length === PAGE, hasLater: false };
  renderView("bottom");
}

async function loadEarlier() {
  if (!view.msgs.length) return;
  const rows = await fetchMsgs({ before_mid: view.msgs[0].mid });
  if (!rows.length) {
    view.hasEarlier = false;
    renderView("restore");
    return toast("已经到最早的消息了");
  }
  view.msgs = rows.slice().reverse().concat(view.msgs);
  view.hasEarlier = rows.length === PAGE;
  renderView("keep");
}

async function loadLater() {
  if (!view.msgs.length) return;
  const rows = await fetchMsgs({ after_mid: view.msgs[view.msgs.length - 1].mid });
  if (!rows.length) {
    view.hasLater = false;
    renderView("restore");
    return toast("已经是最新的消息了");
  }
  view.msgs = view.msgs.concat(rows);
  view.hasLater = rows.length === PAGE;
  renderView("restore");
}

async function jumpToDate(day) {
  const rows = await fetchMsgs({ from_date: day });
  if (!rows.length) return toast("那天之后没有消息");
  view = { msgs: rows, hasEarlier: true, hasLater: rows.length === PAGE };
  renderView("top");
  hideCalendar();
  const divider = document.getElementById("day-" + day);
  if (divider) divider.classList.add("flash");
}

$("messages").addEventListener("click", (e) => {
  if (e.target.id === "btn-earlier") loadEarlier();
  else if (e.target.id === "btn-later") loadLater();
});

// ---------- 日历 ----------
function calRange() {
  const keys = [...dayCounts.keys()].sort();
  if (!keys.length) return null;
  const first = keys[0], last = keys[keys.length - 1];
  return {
    min: { y: +first.slice(0, 4), m: +first.slice(5, 7) - 1 },
    max: { y: +last.slice(0, 4), m: +last.slice(5, 7) - 1 },
  };
}

function renderCalendar() {
  const range = calRange();
  const pop = $("cal-pop");
  if (!range) {
    pop.innerHTML = `<div class="cal-empty">暂无消息日期</div>`;
    return;
  }
  if (!calCursor) calCursor = { ...range.max };
  const { y, m } = calCursor;
  const atMin = y === range.min.y && m === range.min.m;
  const atMax = y === range.max.y && m === range.max.m;
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);

  let cells = "";
  for (const w of ["日", "一", "二", "三", "四", "五", "六"])
    cells += `<div class="cal-dow">${w}</div>`;
  for (let i = 0; i < firstDow; i++) cells += `<div class="cal-day"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
    const has = dayCounts.has(ds);
    const cls = "cal-day" + (has ? " has" : "") + (ds === todayStr ? " today" : "");
    const title = has ? ` title="${dayCounts.get(ds)} 条消息"` : "";
    cells += `<div class="${cls}"${has ? ` data-day="${ds}"` : ""}${title}>${d}</div>`;
  }
  pop.innerHTML = `
    <div class="cal-head">
      <button class="cal-nav" id="cal-prev" ${atMin ? "disabled" : ""}>‹</button>
      <b>${y} 年 ${m + 1} 月</b>
      <button class="cal-nav" id="cal-next" ${atMax ? "disabled" : ""}>›</button>
    </div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-tip">加粗带点的日期有聊天记录</div>`;
}

function showCalendar() {
  renderCalendar();
  $("cal-pop").hidden = false;
}
function hideCalendar() {
  $("cal-pop").hidden = true;
}

$("btn-calendar").addEventListener("click", (e) => {
  e.stopPropagation();
  $("cal-pop").hidden ? showCalendar() : hideCalendar();
});

$("cal-pop").addEventListener("click", (e) => {
  e.stopPropagation();
  if (e.target.id === "cal-prev" || e.target.id === "cal-next") {
    const delta = e.target.id === "cal-prev" ? -1 : 1;
    const d = new Date(calCursor.y, calCursor.m + delta, 1);
    calCursor = { y: d.getFullYear(), m: d.getMonth() };
    renderCalendar();
  } else if (e.target.dataset && e.target.dataset.day) {
    jumpToDate(e.target.dataset.day);
  }
});

document.addEventListener("click", (e) => {
  if (!$("cal-pop").hidden && !$("cal-pop").contains(e.target)) hideCalendar();
});

// ---------- 导出 ----------
function openExportModal() {
  if (!currentUid) return;
  const keys = [...dayCounts.keys()].sort();
  const from = $("exp-from"), to = $("exp-to");
  if (keys.length) {
    from.min = to.min = keys[0];
    from.max = to.max = keys[keys.length - 1];
    from.value = keys[0];
    to.value = keys[keys.length - 1];
  }
  document.querySelector('input[name="exp-range"][value="all"]').checked = true;
  $("exp-dates").hidden = true;
  $("exp-tip").textContent = "";
  $("export-modal").hidden = false;
}

$("btn-export").addEventListener("click", openExportModal);
$("exp-cancel").addEventListener("click", () => ($("export-modal").hidden = true));
$("export-modal").addEventListener("click", (e) => {
  if (e.target.id === "export-modal") $("export-modal").hidden = true;
});
document.querySelectorAll('input[name="exp-range"]').forEach((r) =>
  r.addEventListener("change", () => {
    $("exp-dates").hidden = document.querySelector('input[name="exp-range"]:checked').value !== "range";
  }));

// 把已生成的导出文件交给浏览器：优先弹出"另存为"对话框（File System Access API），否则走下载
async function saveExport(name) {
  const blob = await fetch(`/exports/${encodeURIComponent(name)}`).then((r) => r.blob());
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "HTML 网页", accept: { "text/html": [".html"] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return "saved";
    } catch (e) {
      if (e.name === "AbortError") return "cancelled";
    }
  }
  // 兜底：触发浏览器下载
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return "downloaded";
}

$("exp-go").addEventListener("click", async () => {
  const mode = document.querySelector('input[name="exp-range"]:checked').value;
  const qs = new URLSearchParams({ uid: currentUid });
  if (mode === "range") {
    const f = $("exp-from").value, t = $("exp-to").value;
    if (!f || !t) return ($("exp-tip").textContent = "请选择起止日期");
    if (f > t) return ($("exp-tip").textContent = "起始日期不能晚于结束日期");
    qs.set("from_date", f);
    qs.set("to_date", t);
  }
  $("exp-tip").textContent = "正在生成 HTML…";
  const r = await fetch("/api/export?" + qs, { method: "POST" });
  if (!r.ok) return ($("exp-tip").textContent = "导出失败：" + (await r.text()));
  const d = await r.json();
  $("export-modal").hidden = true;
  const result = await saveExport(d.name);
  if (result === "saved") toast("已保存：" + d.name);
  else if (result === "downloaded") toast("已下载：" + d.name);
  else if (result === "cancelled") toast("已取消保存（文件仍在 data/exports/）");
});

// ---------- 搜索 ----------

let searchTimer = null;
$("search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) {
    $("search-results").hidden = true;
    $(currentUid ? "chat" : "welcome").hidden = false;
    return;
  }
  searchTimer = setTimeout(() => doSearch(q), 300);
});

async function doSearch(q) {
  const rows = await api(`/api/search?q=${encodeURIComponent(q)}&limit=100`);
  $("welcome").hidden = true;
  $("chat").hidden = true;
  $("search-results").hidden = false;
  const nameOf = (uid) => {
    const c = contactsCache.find((x) => x.uid === uid);
    return c ? c.screen_name || "UID " + uid : "UID " + uid;
  };
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  $("search-list").innerHTML = rows.length
    ? rows
        .map(
          (r) => `
      <div class="result-item" data-uid="${esc(r.uid)}" data-date="${esc((r.created_at || "").slice(0, 10))}">
        <div class="who">${esc(nameOf(r.uid))} · ${esc((r.created_at || "").slice(0, 16).replace("T", " "))} · ${r.direction === "in" ? "对方" : "我"}</div>
        <div>${esc(stripTags(r.text)).replace(re, (m) => `<mark>${m}</mark>`)}</div>
      </div>`
        )
        .join("")
    : `<div class="empty-hint"><p>没有找到「${esc(q)}」</p></div>`;
  $("search-list").querySelectorAll(".result-item").forEach((el) =>
    el.addEventListener("click", () => {
      $("search-input").value = "";
      // 点搜索结果直接跳到那一天
      openChat(el.dataset.uid, el.dataset.date || undefined);
    }));
}

$("btn-close-search").addEventListener("click", () => {
  $("search-input").value = "";
  $("search-results").hidden = true;
  $(currentUid ? "chat" : "welcome").hidden = false;
});

// ---------- 启动 ----------
async function init() {
  try {
    await loadStats();
    await loadContacts();
    selfInfo = await api("/api/self").catch(() => ({}));
  } catch (e) {
    $("stats-line").textContent = "加载失败";
  }
  // 轻量轮询，备份进行中时侧栏与统计自动更新（不打扰正在看的聊天窗口）
  setInterval(() => {
    loadStats().catch(() => {});
    loadContacts().catch(() => {});
  }, 15000);
}
init();
