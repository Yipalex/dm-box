// Content scripts only ask for API operations; credentials stay in trusted extension contexts.
const DEFAULT_SERVER = "http://127.0.0.1:8765";
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

async function settings() {
  const { serverUrl = DEFAULT_SERVER, apiToken = "" } = await chrome.storage.local.get(["serverUrl", "apiToken"]);
  return { serverUrl, apiToken };
}

async function request(path, method = "GET", body) {
  if (typeof path !== "string" || !/^\/api\/[a-z_]+(?:\?[^#]*)?$/.test(path)) throw new Error("无效的 API 路径");
  const { serverUrl, apiToken } = await settings();
  const headers = {};
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(serverUrl + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30000),
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data, serverUrl,
    error: response.ok ? undefined : (response.status === 401 ? "访问密钥错误或未填写" : `服务返回 ${response.status}`) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg) return;
  let task;
  if (msg.type === "get_preferences") {
    task = chrome.storage.local.get(["autoIncremental", "lastIncrementalAt"])
      .then(({ autoIncremental, lastIncrementalAt }) => ({ ok: true, data: { autoIncremental, lastIncrementalAt } }));
  } else if (msg.type === "set_preferences") {
    const values = {};
    if (typeof msg.values?.autoIncremental === "boolean") values.autoIncremental = msg.values.autoIncremental;
    if (typeof msg.values?.lastIncrementalAt === "number" && Number.isFinite(msg.values.lastIncrementalAt)) {
      values.lastIncrementalAt = msg.values.lastIncrementalAt;
    }
    task = chrome.storage.local.set(values).then(() => ({ ok: true }));
  } else if (msg.type === "send_cookies") {
    task = chrome.cookies.getAll({ domain: "weibo.com" }).then((cookies) =>
      request("/api/cookies", "POST", { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }));
  } else if (msg.type === "api") {
    task = request(msg.path, msg.method || "GET", msg.body);
  } else return;
  task.then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
  return true;
});
