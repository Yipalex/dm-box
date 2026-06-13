// 内容脚本：在微博私信页 (api.weibo.com/chat) 注入备份控制面板。
// 设计原则：只读、保守限速、命中风控信号立即退避/停止。
(() => {
  "use strict";

  // ---------- 保守限速参数（宁慢勿快） ----------
  const PACING = {
    pageDelayMin: 5000,      // 每页请求间隔下限 5s
    pageDelayMax: 10000,     // 上限 10s（随机抖动，避免规律）
    longRestEvery: 10,       // 每 10 页（约 2000 条）……
    longRestMin: 45000,      // ……长休 45–90s
    longRestMax: 90000,
    contactGapMin: 30000,    // 多联系人之间休 30–60s
    contactGapMax: 60000,
    backoffBase: 120000,     // 命中限流：首次退避 2 分钟，指数翻倍
    backoffMax: 1800000,     // 最长 30 分钟
    backoffAbort: 3,         // 连续 3 次限流 → 终止今天的备份
    pageSize: 200,
    dailyRequestCap: 400,    // 每天对微博接口的主动请求上限
  };
  const SOURCE = "209678993"; // 网页端固定 source

  const state = {
    running: false,
    stopFlag: false,
    requestsToday: 0,
    dayKey: new Date().toDateString(),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => min + Math.random() * (max - min);

  // ---------- 与本地服务通信（经 background 中转） ----------
  // 插件被刷新/更新后，本页里残留的旧脚本会“失联”（Extension context invalidated）。
  // 这里统一捕获，提示刷新页面，而不是抛红色错误、也不让正在跑的备份崩掉。
  let contextDead = false;

  function isContextInvalidated(err) {
    return (
      !chrome.runtime?.id ||
      (err && /Extension context invalidated|message port closed|receiving end does not exist/i.test(String(err.message || err)))
    );
  }

  function handleContextDead() {
    if (contextDead) return;
    contextDead = true;
    state.stopFlag = true;
    log("🔄 插件已更新或重新加载，本页脚本已失效。请刷新本页面（按 ⌘R / Ctrl+R）后继续。");
    showRefreshBanner();
  }

  function serverApi(path, method = "GET", body) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) {
          handleContextDead();
          return resolve({ ok: false, error: "context invalidated" });
        }
        chrome.runtime.sendMessage({ type: "api", path, method, body }, (resp) => {
          if (chrome.runtime.lastError) {
            if (isContextInvalidated(chrome.runtime.lastError)) handleContextDead();
            return resolve({ ok: false, error: chrome.runtime.lastError.message });
          }
          resolve(resp || { ok: false, error: "no response" });
        });
      } catch (e) {
        if (isContextInvalidated(e)) handleContextDead();
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function showRefreshBanner() {
    if (document.getElementById("wdb-refresh-banner")) return;
    const b = document.createElement("div");
    b.id = "wdb-refresh-banner";
    b.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:linear-gradient(135deg,#ff8a3d,#ff5e62);" +
      "color:#fff;font:14px/1.5 -apple-system,'PingFang SC',sans-serif;text-align:center;padding:10px 16px;" +
      "box-shadow:0 2px 12px rgba(0,0,0,.2);cursor:pointer";
    b.textContent = "🔄 私信匣 DMBox 已更新，请点此刷新页面后继续备份";
    b.addEventListener("click", () => location.reload());
    document.documentElement.appendChild(b);
  }

  // ---------- 对微博接口的受控请求 ----------
  class RateLimitError extends Error {}
  class DailyCapError extends Error {}

  async function weiboGet(path, params) {
    if (state.dayKey !== new Date().toDateString()) {
      state.dayKey = new Date().toDateString();
      state.requestsToday = 0;
    }
    if (state.requestsToday >= PACING.dailyRequestCap) throw new DailyCapError();
    state.requestsToday++;

    const qs = new URLSearchParams({ ...params, source: SOURCE, t: Date.now() });
    const resp = await fetch(`https://api.weibo.com${path}?${qs}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if ([414, 418, 432].includes(resp.status)) throw new RateLimitError(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (text.includes("访问频次过高") || text.includes("频次超过上限"))
      throw new RateLimitError("访问频次过高");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 120)}`);
    return JSON.parse(text);
  }

  // 从各种可能的响应形态里取消息数组（经 WeiboBot 源码核实，真实字段是 direct_messages）
  function pickMessages(data) {
    if (!data) return [];
    return (
      data.direct_messages ||
      data.messages ||
      (data.data && (data.data.direct_messages || data.data.messages)) ||
      []
    );
  }

  async function fetchConversationPage(uid, maxId) {
    const data = await weiboGet("/webim/2/direct_messages/conversation.json", {
      convert_emoji: 1,
      uid,
      count: PACING.pageSize,
      max_id: maxId,
      is_include_group: 0,
      from_contacts: 1,
    });
    return pickMessages(data);
  }

  async function fetchContacts() {
    const data = await weiboGet("/webim/2/direct_messages/contacts.json", { count: 500 });
    const raw = data.contacts || (data.data && data.data.contacts) || [];
    return raw
      .map((c) => {
        const u = c.user || c;
        return {
          uid: String(u.id || u.uid || ""),
          name: u.screen_name || u.name || "",
          avatar: u.avatar_large || u.profile_image_url || "",
        };
      })
      .filter((c) => c.uid);
  }

  // ---------- 备份引擎 ----------
  async function backupContact(contact, mode) {
    const { uid, name } = contact;
    log(`开始${mode === "full" ? "全量" : "增量"}备份：${name || uid}`);
    await serverApi("/api/contacts", "POST", {
      uid, screen_name: contact.name, avatar_url: contact.avatar,
    });

    let maxId = 0;
    let page = 0;
    let total = 0;
    let backoffCount = 0;

    // 全量模式断点续传：从库里最旧一条继续向更早翻，不重复拉已备份的页
    if (mode === "full") {
      const st = await serverApi(`/api/sync_state?uid=${uid}`);
      const minMid = st.ok && st.data ? st.data.min_mid : null;
      if (minMid && /^\d+$/.test(String(minMid)) && minMid !== "0" && st.data.count > 0) {
        maxId = (BigInt(minMid) - 1n).toString();
        log(`检测到已备份 ${st.data.count} 条，从最旧处续传更早的历史…`);
      }
    }

    while (!state.stopFlag) {
      let messages;
      try {
        messages = await fetchConversationPage(uid, maxId);
        backoffCount = 0;
      } catch (e) {
        if (e instanceof DailyCapError) {
          log(`⚠️ 已达今日请求上限（${PACING.dailyRequestCap} 次），明天再继续。已自动保存进度。`);
          return { aborted: true };
        }
        if (e instanceof RateLimitError) {
          backoffCount++;
          if (backoffCount >= PACING.backoffAbort) {
            log(`🛑 连续 ${backoffCount} 次被限流（${e.message}），今天到此为止，建议明天再试。`);
            return { aborted: true };
          }
          const wait = Math.min(PACING.backoffBase * 2 ** (backoffCount - 1), PACING.backoffMax);
          log(`⚠️ 被限流（${e.message}），退避 ${Math.round(wait / 60000)} 分钟后重试…`);
          await sleep(wait);
          continue;
        }
        log(`❌ 请求失败：${e.message}，30 秒后重试一次…`);
        await sleep(30000);
        try {
          messages = await fetchConversationPage(uid, maxId);
        } catch (e2) {
          log(`❌ 重试仍失败，跳过该联系人：${e2.message}`);
          return { aborted: false };
        }
      }

      if (!messages.length) {
        log(`✅ ${name || uid}：已到最早消息，本轮共入库 ${total} 条新消息`);
        return { aborted: false };
      }

      const resp = await serverApi("/api/ingest", "POST", { uid, mode, messages });
      if (!resp.ok) {
        log(`❌ 本地服务写入失败（${resp.error || resp.status}），停止。请确认本地服务在运行。`);
        return { aborted: true };
      }
      total += resp.data.new;
      page++;
      setProgress(`${name || uid} · 第 ${page} 页 · 新增 ${total} 条`);

      // 增量模式：碰到库里已有的消息，说明更早的都备份过了
      if (mode === "incremental" && resp.data.hit_known) {
        log(`✅ ${name || uid}：增量完成，新增 ${total} 条`);
        return { aborted: false };
      }

      // 翻页游标：本页最旧 mid - 1
      const oldest = messages[messages.length - 1];
      const oldestMid = BigInt(String(oldest.mid || oldest.idstr || oldest.id));
      maxId = (oldestMid - 1n).toString();

      // —— 保守限速 ——
      if (page % PACING.longRestEvery === 0) {
        const rest = rand(PACING.longRestMin, PACING.longRestMax);
        log(`😴 已拉取 ${page} 页，长休 ${Math.round(rest / 1000)} 秒…`);
        await sleep(rest);
      } else {
        await sleep(rand(PACING.pageDelayMin, PACING.pageDelayMax));
      }
    }
    log("⏹ 已手动停止，进度已保存（下次增量会自动续上）");
    return { aborted: true };
  }

  function pushCookies() {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) {
          handleContextDead();
          return resolve({ ok: false });
        }
        chrome.runtime.sendMessage({ type: "send_cookies" }, (r) => {
          if (chrome.runtime.lastError) {
            if (isContextInvalidated(chrome.runtime.lastError)) handleContextDead();
            return resolve({ ok: false });
          }
          resolve(r || { ok: false });
        });
      } catch (e) {
        if (isContextInvalidated(e)) handleContextDead();
        resolve({ ok: false });
      }
    });
  }

  async function runBackup(contacts, mode) {
    if (state.running) return;
    state.running = true;
    state.stopFlag = false;
    setButtonsRunning(true);
    await pushCookies(); // 附件下载需要登录态

    try {
      for (let i = 0; i < contacts.length; i++) {
        if (state.stopFlag) break;
        const result = await backupContact(contacts[i], mode);
        if (result.aborted && !state.stopFlag) break;
        // 全量(续传)只往更早翻；结束后补一轮增量，把中断期间的新消息也收齐
        if (mode === "full" && !result.aborted && !state.stopFlag) {
          await sleep(rand(PACING.pageDelayMin, PACING.pageDelayMax));
          const inc = await backupContact(contacts[i], "incremental");
          if (inc.aborted && !state.stopFlag) break;
        }
        if (i < contacts.length - 1 && !state.stopFlag) {
          const gap = rand(PACING.contactGapMin, PACING.contactGapMax);
          log(`下一位联系人前休息 ${Math.round(gap / 1000)} 秒…`);
          await sleep(gap);
        }
      }
      await chrome.storage.local.set({ lastIncrementalAt: Date.now() });
      log("🎉 本轮备份结束。可打开 http://127.0.0.1:8765 查看。");
    } finally {
      state.running = false;
      setButtonsRunning(false);
      setProgress("");
    }
  }

  // ---------- 被动捕获：用户翻看聊天时顺路入库 ----------
  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (!d || !d.__wdb || d.type !== "WDB_PASSIVE_CAPTURE") return;
    try {
      const u = new URL(d.url, location.origin);
      const uid = u.searchParams.get("uid");
      const messages = pickMessages(d.payload);
      if (uid && messages.length) {
        const r = await serverApi("/api/ingest", "POST", { uid, mode: "passive", messages });
        if (r.ok && r.data.new > 0) log(`📥 被动捕获入库 ${r.data.new} 条（uid ${uid}）`);
      }
    } catch (e) {
      /* 忽略 */
    }
  });

  // ---------- 面板 UI（Shadow DOM 隔离样式） ----------
  let ui = {};
  function log(msg) {
    if (!ui.log) return;
    const line = document.createElement("div");
    line.className = "line";
    line.textContent = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
    ui.log.appendChild(line);
    ui.log.scrollTop = ui.log.scrollHeight;
    while (ui.log.children.length > 200) ui.log.removeChild(ui.log.firstChild);
  }
  function setProgress(text) {
    if (ui.progress) ui.progress.textContent = text;
  }
  function setButtonsRunning(running) {
    ["btnFull", "btnInc", "btnAll"].forEach((k) => (ui[k].disabled = running));
    ui.btnStop.disabled = !running;
  }

  function buildPanel() {
    const host = document.createElement("div");
    host.id = "wdb-panel-host";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
          width: 320px; background: #fff; border-radius: 16px;
          box-shadow: 0 8px 40px rgba(0,0,0,.18); overflow: hidden;
          font: 13px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
          color: #2b2a28;
        }
        .head {
          display: flex; align-items: center; gap: 9px; padding: 12px 14px;
          background: linear-gradient(135deg, #ff8a3d, #ff5e62); color: #fff;
          cursor: pointer; user-select: none;
        }
        .head svg { width: 20px; height: 20px; flex-shrink: 0; }
        .head b { flex: 1; font-size: 14px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #ffe9c9; }
        .dot.ok { background: #7dff9b; } .dot.bad { background: #ffd2d2; }
        .body { padding: 12px 14px; }
        .body.collapsed { display: none; }
        select, button {
          font: inherit; border-radius: 9px; border: 1px solid #ece7dd;
          padding: 7px 10px; background: #fff; cursor: pointer;
        }
        select { width: 100%; margin-bottom: 9px; }
        .row { display: flex; gap: 7px; margin-bottom: 7px; }
        .row button { flex: 1; }
        button.primary { background: linear-gradient(135deg,#ff8a3d,#ff5e62); color:#fff; border: none; }
        button:disabled { opacity: .45; cursor: not-allowed; }
        .progress { font-size: 12px; color: #98917f; min-height: 18px; margin: 2px 0 6px; }
        .log {
          background: #faf7f2; border-radius: 9px; padding: 8px 10px;
          height: 120px; overflow-y: auto; font-size: 11.5px; color: #6b655a;
        }
        .log .line { margin-bottom: 2px; word-break: break-all; }
        .tip { font-size: 11px; color: #b3ac9b; margin-top: 8px; }
        label.auto { display:flex; gap:6px; align-items:center; font-size:12px; color:#6b655a; margin-top:8px; cursor:pointer; }
      </style>
      <div class="panel">
        <div class="head" id="head">
          <svg viewBox="0 0 24 24" fill="none"><path d="M4 6a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-5l-4.2 3.36A1 1 0 0 1 5 18.58V16a4 4 0 0 1-1-2.65V6Z" fill="#fff" fill-opacity=".92"/><path d="M12 6.5v5m0 0 2.2-2.2M12 11.5 9.8 9.3" stroke="#ff5e62" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <b>私信匣 DMBox</b>
          <span class="dot" id="dot"></span>
        </div>
        <div class="body" id="body">
          <select id="contact-select"><option value="">点击「加载联系人」获取列表</option></select>
          <div class="row">
            <button id="btn-load">加载联系人</button>
            <button id="btn-inc" class="primary">增量备份</button>
          </div>
          <div class="row">
            <button id="btn-full">全量备份</button>
            <button id="btn-all">全部联系人(增量)</button>
          </div>
          <div class="row"><button id="btn-stop" disabled>停止</button></div>
          <div class="progress" id="progress"></div>
          <div class="log" id="log"></div>
          <label class="auto"><input type="checkbox" id="auto-inc">打开本页超过 24h 未备份时自动增量</label>
          <div class="tip">保守限速：每页 5–10s · 每 10 页长休 · 限流即退避 · 仅读取</div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    ui = {
      dot: shadow.getElementById("dot"),
      body: shadow.getElementById("body"),
      select: shadow.getElementById("contact-select"),
      btnLoad: shadow.getElementById("btn-load"),
      btnFull: shadow.getElementById("btn-full"),
      btnInc: shadow.getElementById("btn-inc"),
      btnAll: shadow.getElementById("btn-all"),
      btnStop: shadow.getElementById("btn-stop"),
      progress: shadow.getElementById("progress"),
      log: shadow.getElementById("log"),
      autoInc: shadow.getElementById("auto-inc"),
    };

    shadow.getElementById("head").addEventListener("click", () =>
      ui.body.classList.toggle("collapsed"));

    let contacts = [];
    const selectedContacts = () => {
      const v = ui.select.value;
      if (!v) return [];
      return contacts.filter((c) => c.uid === v);
    };

    ui.btnLoad.addEventListener("click", async () => {
      ui.btnLoad.disabled = true;
      log("拉取联系人列表（1 次请求）…");
      try {
        contacts = await fetchContacts();
        ui.select.innerHTML =
          `<option value="">— 选择要备份的联系人（共 ${contacts.length} 位）—</option>` +
          contacts.map((c) => `<option value="${c.uid}">${c.name || c.uid}</option>`).join("");
        log(`已加载 ${contacts.length} 位联系人`);
      } catch (e) {
        log(`❌ 加载联系人失败：${e.message}（请确认已登录微博）`);
      }
      ui.btnLoad.disabled = false;
    });

    const needSelection = () => {
      const sel = selectedContacts();
      if (!sel.length) log("请先加载并选择一位联系人");
      return sel;
    };
    ui.btnFull.addEventListener("click", () => {
      const sel = needSelection();
      if (sel.length) runBackup(sel, "full");
    });
    ui.btnInc.addEventListener("click", () => {
      const sel = needSelection();
      if (sel.length) runBackup(sel, "incremental");
    });
    ui.btnAll.addEventListener("click", () => {
      if (!contacts.length) return log("请先点击「加载联系人」");
      runBackup(contacts, "incremental");
    });
    ui.btnStop.addEventListener("click", () => {
      state.stopFlag = true;
      log("正在停止…（等当前请求结束）");
    });

    chrome.storage.local.get(["autoIncremental"]).then((v) => {
      ui.autoInc.checked = !!v.autoIncremental;
    });
    ui.autoInc.addEventListener("change", () =>
      chrome.storage.local.set({ autoIncremental: ui.autoInc.checked }));

    // 本地服务健康检查
    (async () => {
      const r = await serverApi("/api/health");
      if (r.ok) {
        ui.dot.classList.add("ok");
        log("✅ 已连接本地服务 (127.0.0.1:8765)");
        const c = await pushCookies();
        if (c.ok) log("🔑 登录态已同步（用于下载图片/语音附件）");
      } else {
        ui.dot.classList.add("bad");
        log("❌ 未检测到本地服务。请先运行 start.command 启动本地服务。");
      }
    })();

    // 自动增量：开关开启 + 距上次备份 >24h，页面打开 60s 后静默执行
    (async () => {
      const v = await chrome.storage.local.get(["autoIncremental", "lastIncrementalAt"]);
      if (!v.autoIncremental) return;
      if (Date.now() - (v.lastIncrementalAt || 0) < 24 * 3600 * 1000) return;
      await sleep(60000);
      if (state.running) return;
      log("⏰ 距上次备份超过 24 小时，自动开始全联系人增量备份…");
      try {
        contacts = await fetchContacts();
        runBackup(contacts, "incremental");
      } catch (e) {
        log(`自动增量启动失败：${e.message}`);
      }
    })();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildPanel);
  } else {
    buildPanel();
  }
})();
