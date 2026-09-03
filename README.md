# VLESS + REALITY 与普通 HTTPS 网站共用 443

这个项目默认在同一台 VPS 上运行 Xray、Caddy 和可选的 60s API 三个容器：

```text
浏览器 ── HTTPS :443 ──┐                                      ┌─ 静态页面
                       ├─ Xray :8443 ── 未通过 REALITY 验证 ── Caddy :8443
代理客户端 ─ REALITY ──┘              └─ 验证通过 ──────────── Internet
                                                               └─ /api/60s ── 60s API :4399（可选）

ACME CA ── HTTP :80 ───────────────────────────────────────── Caddy :8080
```

公网 `443/TCP` 始终由 Xray 接收。有效的 VLESS + REALITY 流量进入代理；普通浏览器 TLS 握手会按 REALITY 的 `target` 机制转发到内部 Caddy。默认显示“60 秒读世界”新闻页；关闭该功能后只启动 Xray 与 Caddy，并显示不依赖 JavaScript 或外部服务的静态欢迎页。公网 `80/TCP` 只由 Caddy 用于证书申请和 HTTP 到 HTTPS 跳转。启用时，60s API 只接入内部 Docker 网络，不发布宿主机端口。

## 前提条件

- Ubuntu 或 Debian VPS，已安装 Docker Engine 和 Docker Compose v2。
- 一个 DNS-only 域名，例如 `node.example.com`，A/AAAA 记录直接指向该 VPS。
- 不可启用 Cloudflare 橙云或其他 CDN/四层代理，否则 REALITY 客户端无法直连 Xray。
- 公网 TCP 80、443 未被其他程序占用。
- 云厂商安全组和系统防火墙允许 TCP 80、443 入站。
- 客户端需要支持 REALITY。为兼容 Clash/Mihomo，服务端将 `minClientVer` 显式放宽为 `1.0.0`；这会绕过 Xray `26.7.11` 默认的 `26.3.27` 最低版本检查。仍建议使用最新客户端核心，因为旧核心的 TLS 指纹可能更容易被识别。

如果启用了 UFW，可执行：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status
```

如果域名有 AAAA 记录，它也必须指向这台 VPS；错误的 AAAA 记录通常会导致部分访问失败或 ACME 证书签发失败。

## 初始化新服务器

对于全新的 Ubuntu/Debian VPS，可先运行仓库自带的初始化脚本：

```bash
sudo ./scripts/bootstrap-server.sh
```

脚本会：

- 从 Docker 官方 APT 仓库安装 Docker CE、Buildx 与 Compose 插件，不使用发行版的 `docker.io`，也不执行远程 `curl | sh` 脚本。[Docker 官方 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/) / [Debian 安装说明](https://docs.docker.com/engine/install/debian/)
- 自动识别当前 SSH 会话或 `sshd -T` 中的端口，先放行 SSH，再启用 UFW。
- 放行项目必需的公网 TCP 80、443，默认拒绝其他新入站连接，不删除已有 UFW 规则。
- 安装 Fail2Ban，启用基于 systemd journal 的 `sshd` jail，并通过 UFW 封禁连续失败来源。
- 加载内核的 `tcp_bbr` 模块，将默认队列调度设为 `fq`，立即启用 BBR，并写入专用的 modules-load/sysctl 配置以便重启后继续生效。
- 将通过 sudo 调用脚本的普通用户加入 `docker` 组；该组具有等同 root 的权限，需要重新登录后生效。

先查看但不修改系统：

```bash
sudo ./scripts/bootstrap-server.sh --dry-run
```

若脚本检测到 `docker.io`、发行版 `containerd/runc` 等冲突包，会停止而不是自行删除。确认已备份现有容器状态后才可显式替换：

```bash
sudo ./scripts/bootstrap-server.sh --replace-distro-docker
```

替换 Docker 软件包可能重启 Docker daemon，请在维护窗口执行。若完整的官方 Docker CE 套件已经存在，脚本会跳过安装与升级，只校验官方仓库并继续配置安全组件。

自定义 SSH 或额外业务端口：

```bash
sudo SSH_PORTS="22,2222" EXTRA_TCP_PORTS="8080" EXTRA_UDP_PORTS="51820" \
  ./scripts/bootstrap-server.sh
```

如果不希望普通用户获得 Docker 权限：

```bash
sudo ./scripts/bootstrap-server.sh --no-docker-group
```

Docker 发布的容器端口可能绕过 UFW 的普通入站规则；本项目的 Compose 文件只发布预期的 80/443。不要在未检查防火墙影响时为其他容器增加端口映射。[Docker 官方防火墙提示](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations)

检查 BBR 状态：

```bash
sysctl net.ipv4.tcp_congestion_control
sysctl net.core.default_qdisc
sysctl net.ipv4.tcp_available_congestion_control
```

预期当前算法为 `bbr`、默认队列为 `fq`，可用算法列表中包含 `bbr`。如果 VPS 使用不允许加载模块或修改 sysctl 的受限虚拟化内核，初始化脚本会明确报错并停止。

## 部署

1. 创建环境文件：

   ```bash
   cp .env.example .env
   nano .env
   ```

   至少将 `DOMAIN` 改成真实域名。`ACME_EMAIL` 可留空；`CLIENT_NAME` 只影响分享链接显示名称。`ENABLE_60S=true` 启用新闻页，改为 `false` 则只提供静态页面。

2. 运行初始化：

   ```bash
   chmod +x manage.sh
   ./manage.sh init
   ```

   初始化会拉取固定版本的官方 Xray 镜像，并生成 UUID、X25519 密钥和 16 位 short ID。启动时 Compose 会拉取固定版本的 Caddy；仅在启用新闻功能时拉取并启动 60s API。再次运行 `init` 会保留原凭据，只重新渲染配置。

3. 验证并启动：

   ```bash
   ./manage.sh validate
   ./manage.sh up
   ```

4. 查看客户端导入链接：

   ```bash
   ./manage.sh show-client
   ```

   链接包含以下参数：

   - 地址：环境文件中的域名
   - 端口：`443`
   - 传输：TCP
   - Flow：`xtls-rprx-vision`
   - 安全：REALITY
   - SNI：同一域名
   - 指纹：Chrome
   - `pbk`：Xray `x25519` 输出的 Password/PublicKey
   - `sid`：随机 short ID

### 切换新闻页与静态页

编辑 `.env` 中的单一开关：

```dotenv
# 显示“60 秒读世界”并运行 news-api
ENABLE_60S=true

# 只显示独立静态页，不运行 news-api
ENABLE_60S=false
```

修改后执行：

```bash
./manage.sh up
```

`up` 会重新渲染配置并重启 Caddy，使页面切换立即生效。关闭功能时，已有的 `news-api` 容器会被停止并移除；它没有持久化数据卷。不要只运行 `restart`，因为该命令不会重新渲染配置。

## 验证部署结果

查看容器和日志：

```bash
./manage.sh status
./manage.sh logs caddy
./manage.sh logs xray
./manage.sh logs news-api
```

`logs news-api` 仅在 `ENABLE_60S=true` 时可用。

从 VPS 之外的网络检查普通网站：

```bash
curl -vI https://node.example.com/
openssl s_client -connect node.example.com:443 -servername node.example.com </dev/null
```

将示例域名替换为实际域名。验收结果应为：

- 启用时，浏览器访问 `https://DOMAIN` 显示“60 秒读世界”，并列出当日简报与每日微语；`https://DOMAIN/api/60s` 返回 JSON。
- 关闭时，浏览器显示“一切运行正常”的静态页，`/api/60s` 返回 404，`docker compose ps` 中没有 `news-api`。
- 无论是否启用，60s API 的 `4399` 端口都不应出现在宿主机监听列表中。
- HTTPS 证书有效，证书域名与 `DOMAIN` 一致。
- 分享链接可导入客户端，并能通过 VPS 访问 TCP 和 UDP 目标。
- 通过代理查询公网 IP 时显示 VPS 的出口地址。
- 错误 UUID 或 short ID 不能使用代理，普通浏览器访问仍会显示网站。
- `docker compose ps` 仅显示宿主机公开 `80/tcp` 和 `443/tcp`；Caddy 的 `8443` 不应出现在公网端口列表中。

## 日常运维

常用命令：

```bash
./manage.sh status
./manage.sh restart
./manage.sh down
./manage.sh logs
```

`down` 不会删除 Caddy 的证书卷。不要运行 `docker compose down -v`，除非确定要删除已签发证书和 Caddy 状态。

### 备份

```bash
./manage.sh backup
```

备份文件保存在 `backups/`，包含 `.env`、服务端私钥和客户端凭据，权限为 `0600`。请像保管密码一样保存它，并将副本放到受保护的异机存储。

### 控制日志大小

Xray、Caddy 和启用时的 60s API 均使用 Docker 推荐的 `local` 日志驱动并自动轮转。默认每个服务保留 3 个日志文件、每个最多约 10 MB，轮转文件由 Docker 自动压缩，即每个服务最多约 30 MB 未压缩日志：

```dotenv
LOG_MAX_SIZE=10m
LOG_MAX_FILE=3
```

修改 `.env` 后必须重建容器，单纯执行 `restart` 不会更新容器日志驱动：

```bash
./manage.sh validate
docker compose --env-file .env up -d --force-recreate
```

日志仍通过以下命令查看，不要直接操作 Docker 数据目录中的日志文件：

```bash
./manage.sh logs
./manage.sh logs caddy
./manage.sh logs xray
./manage.sh logs news-api
```

关闭新闻功能后没有 `news-api` 容器，此时无需查看该项日志。

Docker `local` 驱动的轮转参数参见[官方文档](https://docs.docker.com/engine/logging/drivers/local/)。

### 轮换凭据

```bash
./manage.sh rotate --yes
```

轮换会先生成私密备份，然后替换 UUID、X25519 密钥和 short ID。所有旧客户端会立即断开，必须重新导入 `show-client` 输出的新链接。上一次的凭据文件还会暂存在 `generated/credentials.env.previous`；下一次轮换前请按自己的回滚策略妥善处理。

### 升级镜像

镜像版本固定在 `.env` 中。升级前先阅读 Xray 与 Caddy 的发行说明并备份：

```bash
./manage.sh backup
nano .env
docker compose --env-file .env pull
./manage.sh validate
./manage.sh up
```

升级后必须重新测试普通网站、新闻接口与 REALITY 客户端。不要使用自动更新容器工具无审查地替换这些镜像。

## 文件与安全说明

- `templates/`：可提交的 Xray 和 Caddy 模板。
- `site/`：“60 秒读世界”前端；浏览器只请求同源 `/api/60s` 的 JSON 数据，成功结果会缓存到浏览器本地，接口暂时不可用时显示上次结果。
- `site/static/`：关闭 60s 功能时使用的独立静态页，不加载 JavaScript，也不请求任何 API。
- `generated/credentials.env`：服务端身份凭据，权限 `0600`。
- `generated/xray/config.json`：包含 REALITY 私钥，权限 `0644`，供官方镜像中的非 root Xray 进程读取；宿主机上的父目录 `generated/` 与 `generated/xray/` 均为 `0700`，其他宿主机用户无法穿过目录读取该文件。
- `generated/client.txt`：可导入客户端的分享链接，权限 `0600`。
- `generated/Caddyfile`：渲染后的站点配置，不含 REALITY 密钥。

`generated/`、`.env`、`backups/` 已加入 `.gitignore`。不要将这些文件发送到公开仓库、工单或聊天记录。

Xray 路由会阻止代理客户端访问 `geoip:private` 覆盖的私网和链路本地地址，减少凭据泄露后访问 VPS 内网服务的风险。配置默认不记录 Xray 访问日志；Caddy 仅把普通网站访问日志输出到容器日志。Caddy 只把精确路径 `/api/60s` 改写为内部 60s API 的 JSON 接口，不会向公网暴露该容器的其他接口。Caddy 不依赖新闻容器通过健康检查才启动，因此新闻服务异常时静态页面与证书服务仍保持可用。

Caddy 容器丢弃全部默认 Linux capabilities 后，只重新加入 `NET_BIND_SERVICE`。虽然 Caddy 在容器内监听的是非特权端口 `8080/8443`，官方镜像中的 `/usr/bin/caddy` 自带该文件能力；若从 capability bounding set 中完全删除，Linux 会在执行二进制时返回 `operation not permitted`。该能力不会让容器访问宿主机的其他资源。

## 故障排查

### 证书申请失败

1. 检查所有 A/AAAA 记录是否直连当前 VPS。
2. 确认未启用 CDN 代理。
3. 确认安全组、UFW 和上游网络允许 TCP 80。
4. 查看 `./manage.sh logs caddy`。
5. 注意 Let's Encrypt 的失败次数限制，不要在 DNS 错误时反复重启。

### 网站打不开但代理可用

- 查看 Caddy 是否健康：`./manage.sh status`。
- 查看 Caddy 是否已取得证书：`./manage.sh logs caddy`。
- 确认 Xray 配置的 `target` 仍为 `caddy:8443`，且两个容器位于同一 Compose 网络。

### 页面显示“新闻服务暂时不可用”

- 先确认 `.env` 中 `ENABLE_60S=true`；若希望只使用静态页，将其改为 `false` 后运行 `./manage.sh up`。
- 查看接口容器状态与日志：`./manage.sh status`、`./manage.sh logs news-api`。
- 在服务器执行 `curl -fsS http://127.0.0.1/` 检查 Caddy 的 HTTP 入口，或从外部执行 `curl -fsS https://DOMAIN/api/60s` 检查完整链路。
- 60s API 需要从互联网获取日更数据；确认 VPS 的 DNS 与出站 HTTPS 正常。
- 浏览器成功读取过一次后会保留本地缓存；接口短时不可用时页面会标记“离线缓存”。

### 网站可用但代理无法连接

- 客户端地址必须填写域名而不是 CDN 地址，端口为 443。
- SNI 必须与 `.env` 中的 `DOMAIN` 完全一致。
- 检查链接中的 UUID、`pbk`、`sid`、`flow` 和指纹是否完整。
- Clash/Mihomo 节点必须启用 REALITY、`xtls-rprx-vision` 和 Chrome 客户端指纹，并关闭 Mux。
- 更新客户端核心，然后检查 `./manage.sh logs xray`。
- 确保客户端系统时间准确；严重的时间偏差会影响 TLS/REALITY。

### 80 或 443 已被占用

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

停止或迁移现有 Web/代理服务后再运行 `./manage.sh up`。本项目按独占公网 80、443 设计，不会自动修改其他服务。

## 参考

- [Xray REALITY 官方配置文档](https://xtls.github.io/en/config/transports/reality.html)
- [Xray-core 官方容器镜像](https://github.com/XTLS/Xray-core/pkgs/container/xray-core)
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [60s API 开源项目](https://github.com/vikiboss/60s)
- [60 秒读世界接口文档](https://docs.60s-api.viki.moe/254026209e0)

## 许可证

本项目采用 [MIT License](LICENSE)。
