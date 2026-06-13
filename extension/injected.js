// 运行在页面 MAIN world：被动捕获微博自己发出的 conversation.json 响应。
// 用户正常翻看聊天时，这些数据“顺路”被备份——零额外请求，风控特征为零。
(function () {
  const TARGET = "/webim/2/direct_messages/conversation.json";

  function report(url, json) {
    try {
      window.postMessage(
        { __wdb: true, type: "WDB_PASSIVE_CAPTURE", url: String(url), payload: json },
        window.location.origin
      );
    } catch (e) {
      /* 忽略 */
    }
  }

  // 包一层 fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
      if (url && url.includes(TARGET)) {
        resp.clone().json().then((j) => report(url, j)).catch(() => {});
      }
    } catch (e) {
      /* 忽略 */
    }
    return resp;
  };

  // 包一层 XHR（微博网页端主要用 XHR）
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__wdb_url = url;
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__wdb_url && String(this.__wdb_url).includes(TARGET)) {
      this.addEventListener("load", () => {
        try {
          report(this.__wdb_url, JSON.parse(this.responseText));
        } catch (e) {
          /* 非 JSON，忽略 */
        }
      });
    }
    return origSend.apply(this, args);
  };
})();
