// Service worker：内容脚本 → 本地服务的中转。
// 内容脚本受页面 CORS 限制不能直接访问 127.0.0.1，
// background 拥有 host_permissions，可直连本地服务。
const SERVER = "http://127.0.0.1:8765";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "send_cookies") {
    // 读取微博登录 Cookie 推送给本地服务（仅存内存），用于下载私信附件
    chrome.cookies.getAll({ domain: "weibo.com" }, (cookies) => {
      const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      fetch(SERVER + "/api/cookies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: header }),
      })
        .then((r) => sendResponse({ ok: r.ok }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
    });
    return true;
  }
  if (msg && msg.type === "api") {
    const opts = { method: msg.method || "GET" };
    if (msg.body !== undefined) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(msg.body);
    }
    fetch(SERVER + msg.path, opts)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        sendResponse({ ok: r.ok, status: r.status, data });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步 sendResponse
  }
});
