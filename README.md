# VLESS + REALITY 与普通 HTTPS 网站共用 443

这个项目默认在同一台 VPS 上运行 Xray、Caddy，以及可选的 60s API 与网络检测服务：

```text
浏览器 ── HTTPS :443 ──┐                                      ┌─ 静态页面
                       ├─ Xray :8443 ── 未通过 REALITY 验证 ── Caddy :8443
代理客户端 ─ REALITY ──┘              └─ 验证通过 ──────────── Internet
                                                               ├─ /api/60s ── 60s API :4399（可选）
                                                               └─ /api/network-check ── 网络检测 :8080（可选）

ACME CA ── HTTP :80 ───────────────────────────────────────── Caddy :8080
```

公网 `443/TCP` 始终由 Xray 接收。有效的 VLESS + REALITY 流量进入代理；普通浏览器 TLS 握手会按 REALITY 的 `target` 机制转发到内部 Caddy。默认网站可通过顶部导航在“今日简报”、“网络延迟”和“IP 质量”之间切换；网络检测按国家和地区展示固定的门户、新闻、流媒体及社交站点。每个站点连续检测 5 次，并以成功样本的平均耗时作为结果；接口不接受用户提供的目标地址。关闭 60s 功能后只启动 Xray 与 Caddy，并显示不依赖 JavaScript 或外部服务的静态欢迎页。公网 `80/TCP` 只由 Caddy 用于证书申请和 HTTP 到 HTTPS 跳转。启用时，60s API 和网络检测服务都只接入内部 Docker 网络，不发布宿主机端口。

可选中转只作用于生成的客户端入口：客户端先连接中转机，中转机把原始 TCP 流量转发到节点 `443`，REALITY 的 SNI 和服务端域名仍使用 `DOMAIN`。

## IP 质量检测

网站顶部新增「IP 质量」标签页，展示基础信息、IP 类型、各来源风险评分、风险因子、流媒体与 AI 解锁、邮件与黑名单六个模块。点击「开始检测」后由 `network-check` 容器检测服务器出口，支持 IPv4、IPv6 和双栈；双栈分别保留每个协议的结果，单个协议失败不会覆盖另一个协议的报告。导出按钮下载 JSON，包含经脱敏的引擎数据、时间和错误信息。API、页面和导出报告中的 IPv4 只保留前两段，IPv6 只保留前两组；完整出口地址仅在服务内部用于探测。

更新代码后执行 `./manage.sh up`，会重新构建检测镜像并渲染 Caddy 路由。功能随 `ENABLE_60S=true` 的完整站点启用，关闭完整站点后不提供检测 API。

- `GET /api/ip-quality?family=4|6|dual` 读取任务状态，不启动检测。
- `POST /api/ip-quality?family=4|6|dual` 启动检测，要求 `Content-Type: application/json` 且请求体为空。只接受协议选项，不接受任意 IP、域名、代理或脚本参数。
- 同时最多运行一个 IP 检测任务，同协议请求复用任务。成功或部分成功结果缓存 5 分钟，全部失败后等待 60 秒才能重试。脚本每个协议最多运行 5 分钟，随后执行有超时限制的邮件和 DNSBL 探测。
- 新检测还受全局触发间隔限制，从上一次检测结束起计算，默认 300 秒，跨所有访客与 IPv4、IPv6、双栈生效。可在服务器 `.env` 中设置 `IP_QUALITY_MIN_INTERVAL_SECONDS=0..86400`（单位秒，`0` 关闭额外间隔），再执行 `./manage.sh up` 使配置生效；命中限制时接口返回 HTTP 429、`Retry-After` 和可重试时间。读取已有报告不受限制。
- 风险分数按来源分别展示，不生成综合分。数据缺失、流媒体探测失败、DNS 查询失败均与正常结果区分；IPv6 暂不进行 DNSBL 查询。邮件仅检查出站 SMTP 欢迎响应，不绑定公网源 IP 或特权端口，不发送邮件。
- 引擎固定为 [xykt/IPQuality](https://github.com/xykt/IPQuality) 的 `ad222ab16778be2a13a174cd1acbd69fb4cac6b7`，源码和参考数据随镜像打包。运行时不下载或安装脚本，不生成在线分享报告。查询仍需连接上游数据库、流媒体及邮件服务，外部服务变动或限流可能造成部分项目不可用。

**IPv6 网络要求：** 检测容器同时连接内部 `edge` 网络和独立的 `quality-egress` 网络；后者启用 IPv6，避免为了检测功能重建网站与代理共用的网络。宿主机仍需有可用的 IPv6 出站路由，Docker 需能为用户自定义桥接网络分配 IPv6 地址并设置 NAT。更新后可只重建检测容器：

```bash
docker compose --env-file .env --profile news up -d --build --no-deps network-check
docker compose --env-file .env --profile news exec network-check curl -6 -fsSI --max-time 10 https://api64.ipify.org
```

第二条命令应返回 HTTP 响应头；若宿主机 `curl -6 -I https://api64.ipify.org` 可以成功而容器中失败，应检查 Docker 的 IPv6 网络、出站转发及 NAT。详见 [Docker IPv6 桥接网络文档](https://docs.docker.com/engine/network/drivers/bridge/#use-ipv6-in-a-user-defined-bridge-network)。没有可用 IPv6 出口时，页面显示明确错误，不用 IPv4 结果替代。

检测服务保留上游 AGPL 许可证与适配说明；网页底部可下载包含服务、适配器和上游文件的源码包。详见 [network-check/NOTICE.md](network-check/NOTICE.md)。

## 前提条件

- Ubuntu 或 Debian VPS，已安装 Docker Engine 和 Docker Compose v2。
- 一个 DNS-only 域名，例如 `node.example.com`，A/AAAA 记录直接指向该 VPS。
- 不可使用会终止 TLS、修改流量或发送 PROXY protocol 的 CDN/代理。可使用透明的四层 TCP 中转，但它必须原样转发到节点 `443/TCP`。
- 公网 TCP 80、443 未被其他程序占用。
- 云厂商安全组和系统防火墙允许 TCP 80、443 入站。
- 客户端需要支持 REALITY。为兼容 Clash/Mihomo，服务端将 `minClientVer` 显式放宽为 `1.0.0`；这会绕过 Xray `26.9.9` 的默认最低版本检查。仍建议使用最新客户端核心，因为旧核心的 TLS 指纹可能更容易被识别。

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

   至少将 `DOMAIN` 改成真实域名。`ACME_EMAIL` 可留空；`CLIENT_NAME` 只影响分享链接显示名称。需要中转时填写 `RELAY_ADDRESS` 和 `RELAY_PORT`，否则保持地址为空。`ENABLE_60S=true` 启用新闻页，改为 `false` 则只提供静态页面。

2. 运行初始化：

   ```bash
   chmod +x manage.sh
   ./manage.sh init
   ```

   初始化会拉取固定版本的官方 Xray 镜像，并生成 UUID、X25519 密钥和 16 位 short ID。启动时 Compose 会拉取固定版本的 Caddy；仅在启用新闻功能时启动 60s API 并构建网络检测服务。再次运行 `init` 会保留原凭据，只重新渲染配置。

3. 验证并启动：

   ```bash
   ./manage.sh validate
   ./manage.sh up
   ```

   `up` 会自动重新构建网络检测镜像；修改 `network-check/` 后无需额外执行 `docker compose build`。

4. 查看客户端导入链接：

   ```bash
   ./manage.sh show-client
   ```

   Mihomo 用户应使用生成的代理配置片段，以启用分享链接无法携带的 ML-KEM 兼容选项：

   ```bash
   ./manage.sh show-mihomo
   ```

   该命令输出 `generated/mihomo.yaml`。配置固定使用 `client-fingerprint: chrome`，并在 `reality-opts` 下设置 `support-x25519mlkem768: true`；可将 `proxies` 中的节点合并到现有 Mihomo 配置。该字段是 Mihomo 专用选项，无法通过 `vless://` 分享链接携带，详见 [MetaCubeX/mihomo#3193](https://github.com/MetaCubeX/mihomo/issues/3193)。

   链接包含以下参数：

   - 地址：配置中转时为 `RELAY_ADDRESS`，否则为 `DOMAIN`
   - 端口：配置中转时为 `RELAY_PORT`，否则为 `443`
   - 传输：TCP
   - Flow：`xtls-rprx-vision`
   - 安全：REALITY
   - SNI：同一域名
   - 指纹：Chrome
   - `pbk`：Xray `x25519` 输出的 Password/PublicKey
   - `sid`：随机 short ID

### 配置中转机器

中转入口支持域名、IPv4 和 IPv6。示例：

```dotenv
DOMAIN=node.example.com
RELAY_ADDRESS=relay.example.net
RELAY_PORT=443
```

也可以直接填写 IP；IPv6 可以带或不带方括号，生成链接时会自动使用标准的 `[IPv6]:端口` 格式：

```dotenv
RELAY_ADDRESS=2001:db8::20
RELAY_PORT=8443
```

IPv6 字面量校验需要 `python3`；项目的服务器初始化脚本会安装该依赖。使用域名或 IPv4 中转时不需要它。

修改后重新生成并查看客户端链接：

```bash
./manage.sh init
./manage.sh show-client
```

生成结果的连接地址会自动替换为中转机，但查询参数中的 `sni=node.example.com` 保持不变。清空 `RELAY_ADDRESS` 后再次执行 `init`，链接会恢复为直连 `DOMAIN:443`。

中转机需要满足以下条件：

- 在 `RELAY_PORT/TCP` 上监听，并把连接原样转发到源节点 `443/TCP`。
- 使用纯四层 TCP 转发，不能终止 TLS、注入 PROXY protocol、改写 SNI 或经过 CDN HTTP 代理。
- 放行对应的云防火墙和本机防火墙入站端口。
- UDP 代理数据封装在 VLESS 的 TCP 入站连接中，因此中转入口只需转发 TCP。

本项目只生成使用中转入口的客户端配置，不会远程登录或自动修改中转服务器。`DOMAIN` 默认仍应直接解析到源节点，以保证 Caddy 的 ACME 验证和普通网站访问；如果让它解析到中转机，还必须同时正确转发 TCP 80 和 443。

从外部网络验证中转链路：

```bash
openssl s_client -connect relay.example.net:443 -servername node.example.com </dev/null
```

返回的公网证书应属于 `DOMAIN`。这只能验证普通 TLS 回落链路，REALITY 仍需使用生成的链接在客户端中实际连接验证。

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
./manage.sh logs network-check
```

`logs news-api` 和 `logs network-check` 仅在 `ENABLE_60S=true` 时可用。

从 VPS 之外的网络检查普通网站：

```bash
curl -vI https://node.example.com/
openssl s_client -connect node.example.com:443 -servername node.example.com </dev/null
```

将示例域名替换为实际域名。验收结果应为：

- 启用时，浏览器访问 `https://DOMAIN` 显示“60 秒读世界”，并可从顶部切换到网络延迟页；`https://DOMAIN/api/60s` 返回 JSON，`https://DOMAIN/api/network-check` 返回逐行 JSON（NDJSON）流。
- 关闭时，浏览器显示“一切运行正常”的静态页，两个 API 均返回 404，`docker compose ps` 中没有 `news-api` 或 `network-check`。
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
./manage.sh logs network-check
```

关闭新闻功能后没有 `news-api` 和 `network-check` 容器，此时无需查看这两项日志。

Docker `local` 驱动的轮转参数参见[官方文档](https://docs.docker.com/engine/logging/drivers/local/)。

### 轮换凭据

```bash
./manage.sh rotate --yes
```

轮换会先生成私密备份，然后替换 UUID、X25519 密钥和 short ID。所有旧客户端会立即断开，必须重新导入 `show-client` 输出的新链接或 `show-mihomo` 输出的新配置。上一次的凭据文件还会暂存在 `generated/credentials.env.previous`；下一次轮换前请按自己的回滚策略妥善处理。

### 升级镜像

检查 Xray、Caddy 与启用时的 60s API 是否有新版本：

```bash
./manage.sh check-updates
```

命令会直接查询各项目的 GitHub 发行版，版本发现不受 `.env` 中固定标签影响。Xray 的当前版本通常标记为预发布，因此检查其最新 release 条目；Caddy 和 60s 使用各自标记为 latest 的稳定发行版。若有更新，会逐项列出当前镜像与最新版，并询问是否应用；只有输入 `y` 或 `yes` 后才会更新 `.env`、拉取新镜像并继续。随后可选择自动备份（默认选择是“是”）：该操作会创建常规配置归档，并给本次涉及的旧镜像建立本地回滚快照，然后才重建已经部署的服务。直接回车或输入其他内容拒绝第一次确认时，不会修改 `.env` 或运行中的容器。

第一次执行 `./manage.sh init` 且尚未生成凭据时，也会先执行相同的最新版本检查，并让用户决定首部署是否采用最新版；拒绝后继续使用 `.env` 中的固定版本。如果 GitHub 暂时不可访问，首次初始化会给出警告并继续使用固定版本，显式执行 `check-updates` 时则会报错退出。

若更新后需要恢复最近一次已备份的旧镜像：

```bash
./manage.sh rollback
```

回滚命令会先列出快照包含的服务并要求确认，然后把 `.env` 恢复为旧镜像版本、恢复旧镜像、校验配置并强制重建对应服务。如果更新时跳过了自动备份，就不会为该次更新保留可用的回滚入口。回滚镜像只保存在本机 Docker 存储中，执行镜像清理命令可能使其失效。

`network-check` 是由本仓库源码本地构建的服务，不属于远程镜像检查范围；执行 `./manage.sh up` 时会自动重建它。

自动检查会选择上述最新发行版本，但升级前仍应阅读 Xray、Caddy 与 60s 的发行说明。也可以继续手动指定版本：

```bash
./manage.sh backup
nano .env
docker compose --env-file .env pull
./manage.sh validate
./manage.sh up
```

升级后必须重新测试普通网站、新闻与网络检测接口，以及 REALITY 客户端。不要使用自动更新容器工具无审查地替换这些镜像。

## 文件与安全说明

- `templates/`：可提交的 Xray 和 Caddy 模板。
- `site/`：“60 秒读世界”与网络延迟前端；浏览器只请求同源 API。新闻成功结果会缓存到浏览器本地，接口暂时不可用时显示上次结果。
- `network-check/`：无第三方 npm 依赖的固定目标检测服务；覆盖中国大陆、香港、日本、美国、英国、德国和法国共 22 个站点。页面先展示全部站点，再将每站 5 次检测结果逐条推送并按延迟质量着色。
- `site/static/`：关闭 60s 功能时使用的独立静态页，不加载 JavaScript，也不请求任何 API。
- `generated/credentials.env`：服务端身份凭据，权限 `0600`。
- `generated/xray/config.json`：包含 REALITY 私钥，权限 `0644`，供官方镜像中的非 root Xray 进程读取；宿主机上的父目录 `generated/` 与 `generated/xray/` 均为 `0700`，其他宿主机用户无法穿过目录读取该文件。
- `generated/client.txt`：可导入客户端的分享链接，权限 `0600`。
- `generated/mihomo.yaml`：Mihomo VLESS + REALITY 代理配置片段，默认启用 `support-x25519mlkem768`，权限 `0600`。
- `generated/Caddyfile`：渲染后的站点配置，不含 REALITY 密钥。

`generated/`、`.env`、`backups/` 已加入 `.gitignore`。不要将这些文件发送到公开仓库、工单或聊天记录。

Xray 路由会阻止代理客户端访问 `geoip:private` 覆盖的私网和链路本地地址，减少凭据泄露后访问 VPS 内网服务的风险。配置默认不记录 Xray 访问日志；Caddy 仅把普通网站访问日志输出到容器日志。Caddy 只把精确路径 `/api/60s` 和 `/api/network-check` 分别改写到对应内部接口，不会向公网暴露容器的其他路径。网络检测服务只连接源码中固定的 HTTPS 目标，不接受 URL、主机名或 IP 参数。Caddy 不依赖功能容器通过健康检查才启动，因此它们异常时静态页面与证书服务仍保持可用。

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

### 页面显示“网络检测服务暂时不可用”

- 确认 `.env` 中 `ENABLE_60S=true`，并在修改后运行 `./manage.sh up`。
- 查看服务状态与日志：`./manage.sh status`、`./manage.sh logs network-check`。
- 从外部执行 `curl -fsS -N https://DOMAIN/api/network-check`，确认能持续收到 `meta`、`sample` 和 `complete` 事件。
- 若只有个别站点显示不可达，通常是目标站点限制了当前 VPS 的地区或 IP；这不会影响其他检测结果。

### 网站可用但代理无法连接

- 未配置中转时，客户端地址必须为 `DOMAIN:443`；配置中转时必须与 `RELAY_ADDRESS:RELAY_PORT` 一致。
- 使用中转时，先确认中转机确实把原始 TCP 流量转发到源节点 `443`，且没有发送 PROXY protocol 或终止 TLS。
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

原创代码采用 [MIT License](LICENSE)。随附的 IPQuality 引擎与 shell 适配器保留 AGPL-3.0 许可，详见 [检测引擎说明](network-check/NOTICE.md) 和 [上游许可证](network-check/vendor/IPQuality/LICENSE)。
