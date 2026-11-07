# NAS Docker 部署与数据迁移

推荐结构：Chrome 扩展 → NAS 上的 DMBox 服务 → NAS 本地数据目录。
电脑不再需要运行 `start.command`；主动采集仍需要打开并登录微博私信页、保持标签页在前台。NAS 服务继续负责媒体下载、保存和管理界面。

## 1. 准备 NAS 文件夹与访问密钥

将项目代码放到 NAS，例如 `/volume1/docker/dmbox/app`，以下命令均在该项目目录执行。路径仅为示例，飞牛、群晖等系统应替换为实际存储路径。若使用 NAS 的 Docker 图形界面，可创建 Compose 项目并填写相同的设置。

1. 创建一个独立的数据目录，例如 `/volume1/docker/dmbox/data`。它必须是 NAS 自己的磁盘目录，不是另一台机器提供的 SMB/NFS 共享挂载。
2. 选定运行容器的 NAS 用户，查询其 UID/GID（例如 `id 用户名`），并在 NAS 权限设置中授予该用户数据目录的读写权限。容器默认使用 UID/GID `10001:10001`；不要为方便而开放所有人的写权限。
3. 将 `.env.example` 复制为 `.env`，填写下列设置。`.env` 不会提交到 Git，也不会进入 Docker 构建内容。

```dotenv
DMBOX_API_TOKEN=替换成至少32字符的随机密钥
DMBOX_HOST_DATA_DIR=/volume1/docker/dmbox/data
DMBOX_BIND_IP=192.168.1.20
DMBOX_PORT=8765
DMBOX_UID=10001
DMBOX_GID=10001
```

- `DMBOX_BIND_IP` 填 NAS 的实际局域网 IP。默认 `127.0.0.1` 只允许 NAS 本机访问；不要填电脑 IP。建议在路由器中固定 NAS 地址。
- `DMBOX_API_TOKEN` 可在有 Python 的电脑上用以下命令生成，将输出妥善保存为密码。不要使用示例文字，也不要把密钥放进 URL。
- UID/GID 应替换为拥有该数据目录权限的实际用户值。

```bash
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

## 2. 构建并启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 dmbox
```

首次构建需要网络下载 Python 依赖和 ffmpeg。默认是单进程服务；不要对同一个 SQLite 数据目录运行多个容器副本。

在电脑浏览器打开 `http://NAS局域网IP:8765/`。浏览器会弹出登录窗口：

- 用户名：`dmbox`
- 密码：`.env` 中设置的 `DMBOX_API_TOKEN`

这是浏览器自带的 HTTP 身份验证，不是网页表单。管理页面、API、媒体、导出和健康检查均需要验证。浏览器可能缓存登录信息；在共享电脑上使用独立浏览器配置或关闭无痕窗口结束使用，密钥泄露时更换密钥并重建容器。

**HTTP 会明文传输访问密钥、私信和微博登录 Cookie，只适合你信任的家庭内网。跨公网或不可信网络必须使用 HTTPS 或受保护的私有网络，不能直接转发 HTTP 端口到公网。** 可使用 NAS 已有的 HTTPS 反向代理，转发到该服务，保留 `Authorization` 和原始 `Host` 请求头。

## 3. 配置 Chrome 扩展

1. 在 `chrome://extensions` 重新加载当前项目的 `extension` 文件夹（版本 1.1.0）。
2. 点扩展图标，填写 NAS 服务地址，例如 `http://192.168.1.20:8765`，以及同一个访问密钥。
3. 点「保存并测试连接」，允许扩展访问此地址。显示消息和联系人数量即连接成功。
4. 刷新已登录的 `https://api.weibo.com/chat`，再开始备份。

地址只填写协议、主机和可选端口，不含子路径、查询参数或账号密码。HTTPS 需要浏览器信任的证书。密钥保存在当前电脑的扩展本地存储，不经 Chrome 同步，也不向微博页面的内容脚本开放；其他使用者或其他浏览器需要分别配置。

远程模式会将私信和用于附件下载的微博 Cookie 发送给指定服务，Cookie 仍仅存服务内存。只填写自己的可信服务地址。服务重启后，刷新已登录的微博私信页重新推送 Cookie。

## 4. 迁移现有聊天记录

迁移前不要在新服务里开始采集。

1. 在旧管理页面记录消息、联系人和已下载媒体数量。
2. 停止旧电脑上的服务（终端 Ctrl+C；已安装自启的先运行 `./scripts/uninstall_autostart.sh`）。同时停止 NAS 容器：`docker compose stop dmbox`。
3. 完整复制旧项目 **`data/` 内的所有内容** 到 NAS 数据目录，保留文件夹层级。包括数据库、可能存在的 `weibo_dm.db-wal` / `weibo_dm.db-shm`、`media/` 和 `exports/`。不要只复制数据库主文件，不要在服务仍写入时直接复制。
4. 确认复制完成并给容器运行用户读写权限，再启动 NAS 容器：`docker compose up -d`。
5. 登录新管理页面，对照数量，抽查历史消息、图片、语音与导出。确认无误后再把扩展切到 NAS，进行一次增量备份。
6. 保留旧 `data/` 作为迁移前备份，验证完成前不删除。若要回退，先停止 NAS 采集，避免两端分别产生新数据；旧备份不包含切换后新增的数据。

相对媒体路径保持不变，不需要修改数据库。迁移应使用空的目标数据目录；不要把两个独立的数据库或媒体目录直接覆盖合并。

## 5. 日常运行、更新与备份

```bash
# 看状态和日志
docker compose ps
docker compose logs --tail=80 dmbox

# 更新项目代码后重新构建（先备份数据）
docker compose up -d --build

# 停止服务
docker compose stop dmbox
```

数据库、附件和导出全部在映射的数据目录中，重建容器不会删除这些文件；修改 `DMBOX_HOST_DATA_DIR` 则会切换到另一份数据。不要删除 NAS 的数据文件夹。`.env` 修改后用 `docker compose up -d` 重新创建服务。

简单可靠的备份方式：停止容器 → 完整备份数据目录到另一位置 → 启动容器。不要只在线复制 SQLite 主文件；NAS RAID 也不能替代独立备份。保留部署配置与访问密钥的安全副本。

## 6. 外出访问与 VPS

第一阶段建议先在家庭局域网验证稳定，再开放异地访问。

- **私有网络**：让电脑与 NAS 通过自己的 VPN / 私有网络互通，再使用对应服务地址。
- **HTTPS 反向代理 / Cloudflare Tunnel**：用一个专用域名指向 DMBox 根路径，例如 `https://dmbox.example.com`。扩展也填写同一个 HTTPS 地址；不要公开未加密的 8765 端口，不要为私信、附件或导出配置 CDN 强制缓存。
- **Tunnel 运行在 NAS 主机上**：可转发到 `http://127.0.0.1:8765`，此时端口绑定保持 `127.0.0.1`。
- **Tunnel 运行在另一容器中**：让两个容器加入同一 Docker 网络，目标使用 `http://dmbox:8765`，不能使用 Tunnel 容器自己的 `127.0.0.1`。Tunnel 凭据需要单独配置，不放入仓库。
- **Cloudflare Access**：若另外启用交互式登录保护，扩展后台请求不会自动完成登录跳转；当前扩展只支持 DMBox 自己的访问密钥，没有集成 Access 服务令牌。此时优先使用私有网络，或另行实现 Access 验证。不要为了连通而取消 DMBox 访问验证。
- **VPS**：可以使用同一套 Compose，数据目录改为 VPS 的本地磁盘目录。公网通过 HTTPS 反向代理或 Tunnel 访问；服务器容量、备份和流量需要自行安排。

Tunnel 提供连接通道；DMBox 密钥保护服务内容。更换域名后，在扩展保存新地址、授予权限并测试连接即可。

## 7. 本机外接硬盘与环境变量

默认本机模式无需访问密钥，仍只监听 `127.0.0.1`。可在项目目录执行：

```bash
DMBOX_DATA_DIR="/Volumes/外接硬盘/DMBox" ./start.command
```

该绝对目录必须事先创建且可写；目录不存在时服务会报错，不会自动创建替代数据目录。不过，如果挂载点下已经残留同名目录，程序无法仅靠路径判断磁盘是否真正挂载，因此启动前仍需确认磁盘挂载状态。设置路径不会自动迁移已有数据，先停服务再复制。

| 设置 | 默认值 | 含义 |
|---|---|---|
| `DMBOX_DATA_DIR` | 项目下 `data/` | 数据库、媒体和导出的根目录；显式设置时须为已存在的绝对目录 |
| `DMBOX_API_TOKEN` | 空 | 配置后启用 Bearer / 浏览器 Basic 验证，至少 32 字符 |
| `DMBOX_REQUIRE_AUTH` | 本机 false，Docker true | true 时缺少密钥直接拒绝启动 |

Compose 的 `DMBOX_HOST_DATA_DIR` 是 NAS 主机路径，容器内部固定使用 `/data`。环境变量不会自动读取本机 `.env`；`.env` 在本方案中由 Docker Compose 读取。macOS 的开机自启脚本也不会自动继承上述临时变量，NAS 模式应使用 Docker 的重启策略。

## 8. 常见故障

| 现象 | 处理 |
|---|---|
| 只有 NAS 上能访问 | Compose 默认绑定 `127.0.0.1`；家庭内网直连时改为 NAS 的局域网 IP，再执行 `docker compose up -d`，检查 NAS 防火墙 |
| 容器反复重启 / `Permission denied` | 查看日志，确认数据目录存在且 UID/GID 有读写权限，不要用 root 运行来掩盖权限问题 |
| 提示未设置密钥 / 密钥太短 | 在 `.env` 填至少 32 字符随机密钥，重新创建容器 |
| 401 / 浏览器反复要求登录 | 用户名为 `dmbox`，密码为访问密钥；扩展单独保存同一密钥，检查反向代理是否保留 Authorization |
| 403 / `Cross-site request rejected` | 反向代理应保留原始 Host；不支持把网页和 API 拆成不同域名，使用同一域名根路径 |
| 扩展提示网络错误 | 检查地址授权、NAS 网络、证书及端口；若使用 Access 登录，参见上一节的限制 |
| 提示绑定目录不存在 | 创建正确的 NAS 数据目录；Compose 故意禁止自动创建错误路径，避免误以为旧数据丢失 |
| 管理界面是空的 | 对照数据目录映射及迁移层级，确认 NAS 目录下直接存在 `weibo_dm.db`，而不是多套了一层 `data/` |
| 重启后部分附件不下载 | 刷新已登录微博的私信页，重新推送内存 Cookie；等待下载队列处理 |

## 开发验证

在项目运行环境准备好后，使用临时数据进行服务验证，不接触已有聊天记录：

```bash
.venv/bin/python -m unittest discover -s tests -v
node --test tests/extension.test.cjs
```

服务测试覆盖访问验证、跨站写入阻断、消息写入去重、查询、导出、指定路径持久化、错误部署配置和本机兼容。扩展测试覆盖服务地址、密钥传递、查询参数、地址授权和自动增量设置；其中 Chrome API 使用模拟环境，真实 NAS 网络与扩展安装授权仍需部署后验证。

`tests/browser_smoke.cjs` 可用 Playwright 和 Chrome 对隔离的测试服务进行浏览器验证；需自行准备测试数据，通过 `DMBOX_TEST_BASE`、`DMBOX_TEST_TOKEN` 指向测试服务，切勿使用生产聊天数据。

参考：[Docker Compose 挂载配置](https://docs.docker.com/reference/compose-file/services/)、[Chrome 可选权限](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[Chrome 存储访问级别](https://developer.chrome.com/docs/extensions/reference/api/storage)。

本地已安装 Docker 时，还可验证真实容器重建后的持久化（测试自行创建和清理临时目录、容器和网络）：

```bash
docker build -t dmbox:local-test .
.venv/bin/python tests/docker_smoke.py
```
