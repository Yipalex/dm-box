const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "http://127.0.0.1:8765";

function normalizeServer(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    throw new Error("请填写 http(s)://主机:端口，不含路径、账号或查询参数");
  }
  return url.origin;
}

async function testConnection() {
  $("dot-server").className = "dot";
  $("txt-server").textContent = "连接中…";
  $("hint-server").textContent = "";
  const resp = await chrome.runtime.sendMessage({ type: "api", path: "/api/health" });
  if (resp?.ok && resp.data?.service === "weibo-dm-backup") {
    $("dot-server").className = "dot ok";
    $("txt-server").textContent = "备份服务已连接";
    const stats = await chrome.runtime.sendMessage({ type: "api", path: "/api/stats" });
    if (stats?.ok) $("hint-server").textContent = `已备份 ${stats.data.messages} 条消息 · ${stats.data.contacts} 位联系人`;
    return true;
  }
  $("dot-server").className = "dot bad";
  $("txt-server").textContent = "备份服务未连接";
  $("hint-server").textContent = resp?.error || "请检查地址、访问密钥及服务是否运行";
  return false;
}

$("save-settings").addEventListener("click", async () => {
  try {
    const serverUrl = normalizeServer($("server-url").value.trim());
    // Permission request stays in the click handler, before unrelated async work.
    const granted = await chrome.permissions.request({ origins: [`${serverUrl}/*`] });
    if (!granted) throw new Error("未授予此服务地址的访问权限，设置未保存");
    const apiToken = $("api-token").value.trim();
    await chrome.storage.local.set({ serverUrl, apiToken });
    $("manage-link").href = serverUrl;
    $("settings-result").textContent = "设置已保存，正在测试…";
    const ok = await testConnection();
    $("settings-result").textContent = ok ? "连接成功。请刷新微博私信页；管理页面用户名为 dmbox，密码为访问密钥。" : "设置已保存，但连接失败，请检查上方提示后重试。";
  } catch (error) {
    $("settings-result").textContent = error.message;
  }
});

(async () => {
  const config = await chrome.storage.local.get(["serverUrl", "apiToken"]);
  $("server-url").value = config.serverUrl || DEFAULT_SERVER;
  $("api-token").value = config.apiToken || "";
  $("manage-link").href = config.serverUrl || DEFAULT_SERVER;
  await testConnection();
})().catch((error) => { $("hint-server").textContent = error.message; });
