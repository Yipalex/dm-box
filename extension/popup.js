chrome.runtime.sendMessage({ type: "api", path: "/api/health" }, (resp) => {
  const dot = document.getElementById("dot-server");
  const txt = document.getElementById("txt-server");
  const hint = document.getElementById("hint-server");
  if (resp && resp.ok) {
    dot.classList.add("ok");
    txt.textContent = "本地服务运行中";
    chrome.runtime.sendMessage({ type: "api", path: "/api/stats" }, (s) => {
      if (s && s.ok) hint.textContent = `已备份 ${s.data.messages} 条消息 · ${s.data.contacts} 位联系人`;
    });
  } else {
    dot.classList.add("bad");
    txt.textContent = "本地服务未启动";
    hint.textContent = "请先双击项目里的 start.command 启动本地服务";
  }
});
