# Docker 部署

> 镜像**只含 daemon**，不含任何 agent CLI；CLI 由使用者在容器里自行安装（见
> 「装 agent CLI」）。默认**不挂宿主机任何目录**（数据、CLI、登录态都用命名卷），容器用 daemon
> 内置 fallback 工作区。
>
> 两种用法：**直接用发布镜像（推荐）**，或从源码构建。源码方式需要的文件都在 `daemon/`：
> `Dockerfile`、`docker-compose.yml`、`.dockerignore`。

## 先想清楚边界

daemon 的职责是 **spawn 本机已安装的 agent CLI 并给它 shell 权限**。放进容器后：

- agent 只能看到容器里的世界。默认工作区是 daemon 内置 fallback
  `/home/paboot/.paboot/defaultworkspace`（落在 `paboot-data` 卷里），**不碰宿主机项目**；
  要改宿主机项目，才显式挂载；
- 三个 CLI 的**登录态**在容器里默认不存在：在容器内登录一次（凭据存命名卷），
  或直接用 API key；也可以手动挂载宿主机已有登录态；
- 运行身份建议跟随宿主机用户（compose 里的 `user:`）；尤其挂宿主机项目时，否则写回的文件会归 root；
- 容器里的权限审批、hook、MCP 都走 `127.0.0.1:<port>`，同容器内自洽，不需要额外改动。

镜像**不需要挂 Docker socket**：agent 在容器内执行，不是去操纵宿主机 Docker。

## 用发布镜像部署（推荐）

只拉镜像、不 clone 仓库时，把下面这份 compose 存成 `docker-compose.yml`（没有 `build:`，
直接用镜像；镜像里已固化 `HOME`、端口、npm 前缀和内置 fallback 工作区）：

```yaml
name: paboot

services:
  daemon:
    image: noresign/paboot:latest
    container_name: paboot
    restart: unless-stopped
    init: true
    user: "${PABOOT_UID:-1000}:${PABOOT_GID:-1000}"
    ports:
      - "4780:4780"
    environment:
      HOME: /home/paboot
      PABOOT_TOKEN: ${PABOOT_TOKEN:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}
    volumes:
      - paboot-data:/home/paboot/.paboot
      - paboot-npm:/home/paboot/.npm-global
      - paboot-claude:/home/paboot/.claude
      - paboot-codex:/home/paboot/.codex
      - paboot-dsh:/home/paboot/.dsh

volumes:
  paboot-data:
  paboot-npm:
  paboot-claude:
  paboot-codex:
  paboot-dsh:
```

```bash
PABOOT_UID=$(id -u) PABOOT_GID=$(id -g) docker compose up -d

# 装 CLI（装进 paboot-npm 卷，重建容器不丢）
docker exec -it paboot npm i -g @anthropic-ai/claude-code

# 登录一次（凭据存命名卷；也可改用下面的 API key 方式）
docker exec -it paboot claude auth login

# 让 daemon 重新探测运行时（探测结果在进程内缓存）
docker compose restart daemon
```

不想用 compose 的话，最小 `docker run` 等价于：

```bash
docker run -d --name paboot --init --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  -p 4780:4780 \
  -v paboot-data:/home/paboot/.paboot \
  -v paboot-npm:/home/paboot/.npm-global \
  noresign/paboot:latest
```

## 从源码构建

```bash
cd daemon

# 1. 启动：数据 / 凭据 / CLI 全用命名卷，不挂宿主机任何目录
PABOOT_UID=$(id -u) PABOOT_GID=$(id -g) docker compose up -d --build

# 2. 在容器里装要用的 agent CLI（装进 paboot-npm 卷，重建容器不丢）
docker compose exec daemon npm i -g @anthropic-ai/claude-code
# 可选：@openai/codex / @deepseek-ai/dsh

# 3. 登录一次（凭据存命名卷，重建容器不丢）
docker exec -it paboot claude auth login

# 4. 让 daemon 重新探测运行时（探测结果在进程内缓存）
docker compose restart daemon
```

手工 `docker run`（自行构建镜像）：

```bash
docker build -t paboot-daemon:local daemon/

docker run -d --name paboot --init --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  -p 4780:4780 \
  -e HOME=/home/paboot \
  -v paboot-data:/home/paboot/.paboot \
  -v paboot-npm:/home/paboot/.npm-global \
  -v paboot-claude:/home/paboot/.claude \
  -v paboot-codex:/home/paboot/.codex \
  -v paboot-dsh:/home/paboot/.dsh \
  paboot-daemon:local
```

装完 CLI 后在容器里登录一次：`docker exec -it paboot claude auth login`；
或者用 `-e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"` 这类环境变量。

`ENTRYPOINT` 是 `node dist/index.js`，要传 flag 直接追加在镜像名后，例如
`paboot-daemon:local --permission-mode acceptEdits`。

### 镜像内容

- 基础镜像 `node:${NODE_VERSION}-slim`，默认 `24`（浮动到最新 24.x，满足 `>=24.9`）；要高版本
  major 用 `--build-arg NODE_VERSION=26`（compose 里设同名环境变量）；
- 系统包：`git`、`ripgrep`（Claude Code 搜索用）、`openssh-client`、`ca-certificates`、`less`；
- paboot 本体：`/app/dist`（编译产物）+ 生产依赖 `node_modules`，不含源码/测试/devDependencies；
- **不含任何 agent CLI**；
- `NPM_CONFIG_PREFIX=/home/paboot/.npm-global` 且在 PATH 里，保证非 root 装 CLI 可用；
- `DISABLE_AUTOUPDATER=1`：装进来的 CLI 不自更新，升级由你重装决定。

## 首次启动：token 与连接客户端

首次启动会在容器的 `paboot-data` 卷里生成 token（并打印到日志）：

```bash
docker exec paboot cat /home/paboot/.paboot/token
# 或
docker logs paboot | grep -i token
```

客户端连接 `http://<宿主机局域网 IP>:4780`，填这个 token。健康检查（免鉴权）：

```bash
curl http://127.0.0.1:4780/api/health
```

## 工作区选择

先记住一个前提：**daemon 和客户端都只能看到容器内的路径**。所以只有两种情况：

### 情况一：不挂宿主机目录（默认）

- 默认工作区是容器里的 `/home/paboot/.paboot/defaultworkspace`，位于 `paboot-data` 卷，
  重建容器不丢，但**宿主机看不到里面的文件**；
- 适合试用、让 agent 从零建项目、或只做代码审查；
- 客户端里「添加工作区」浏览到的也是容器内目录。你可以填别的容器路径，但**不在卷上的目录
  重建容器就没了**——要么给它单独挂一个卷，要么按情况二挂宿主机目录。

### 情况二：改宿主机上的真实项目

必须把宿主机目录挂进容器，并让它成为默认工作区。

**两种用法都是改 `docker-compose.yml`**：用成品镜像的人改自己保存的那份；从源码构建的人
直接改仓库里那份（已经留好注释，取消注释即可）：

```yaml
    command: ["--workspace", "/workspace"]
    volumes:                                # 原有 5 个卷 + 宿主机项目
      - paboot-data:/home/paboot/.paboot
      - paboot-npm:/home/paboot/.npm-global
      - paboot-claude:/home/paboot/.claude
      - paboot-codex:/home/paboot/.codex
      - paboot-dsh:/home/paboot/.dsh
      - ${HOME}/code/my-project:/workspace   # 换成你的项目路径
```

启动：发布镜像 `docker compose up -d`；源码 `docker compose up -d --build`。

### 多个项目

每个项目挂到一个**不同的容器内路径**，不要求都叫 `/workspace`：

```yaml
    volumes:
      - paboot-data:/home/paboot/.paboot
      - paboot-npm:/home/paboot/.npm-global
      - paboot-claude:/home/paboot/.claude
      - paboot-codex:/home/paboot/.codex
      - paboot-dsh:/home/paboot/.dsh
      - ${HOME}/code/a:/projects/a
      - ${HOME}/code/b:/projects/b
    # 可选：启动时默认进入 a；不写则默认仍是内置 fallback
    command: ["--workspace", "/projects/a"]
```

连上客户端后，把 `/projects/b` 等路径依次「添加工作区」即可。工作区记录存在 `paboot-data`
里，重启 / 重建容器后还在——前提是挂载也还在，否则那些路径会变成空目录。

源码方式同样直接往 `docker-compose.yml` 的 `volumes` 里加。

### 几点说明

- 宿主机目录**必须已经存在**：bind mount 指向不存在的路径时，Docker 会静默创建一个 root
  所有的空目录，看起来像“项目是空的”，注意别把路径写错。
- `--workspace /workspace` 是**权威值**：每次启动都确保该目录存在并设为默认，不需要
  `PABOOT_WORKSPACE`。
- 只影响工作区；数据 / CLI / 登录态仍是命名卷。
- 切回情况一：删掉 `command` 和那行挂载（源码方式不带 override）后重启。库里 `/workspace`
  这条工作区还在，客户端里切回内置 fallback 或添加其他目录即可；宿主机文件不受影响。
- 写回宿主机的文件归属由 `PABOOT_UID/PABOOT_GID` 决定，不设置时默认 1000。

## 挂载表

| 宿主机 / 卷 | 容器 | 作用 | 必需 |
|---|---|---|---|
| `paboot-data`（命名卷） | `/home/paboot/.paboot` | SQLite / token / serverId / 内置 fallback 工作区 | 是 |
| `paboot-npm`（命名卷） | `/home/paboot/.npm-global` | 容器内装的 agent CLI | 默认 |
| `paboot-claude`（命名卷） | `/home/paboot/.claude` | Claude Code 登录态与配置 | 默认 |
| `paboot-codex`（命名卷） | `/home/paboot/.codex` | Codex 登录态、`config.toml`（MCP） | 默认 |
| `paboot-dsh`（命名卷） | `/home/paboot/.dsh` | DeepSeek Harness 凭据与插件 | 默认 |
| 宿主机项目目录（override） | `/workspace` | 要改真实项目时挂载并设为默认工作区 | 可选 |
| `~/.gitconfig` / `~/.ssh` | 同路径 | 让容器里的 git 能提交 / 推远端 | 可选，需手动加 |

## 认证方式

**A. 在容器里登录（默认，推荐）**

```bash
# Claude：打印一个 URL，在宿主机浏览器打开后把 code 粘回来
docker exec -it paboot claude auth login

# Codex：交互式登录依赖 localhost 回调，容器里用 API key 写入更稳
printenv OPENAI_API_KEY | docker exec -i paboot codex login --with-api-key

# DSH
docker exec -it paboot dsh web        # 或直接用 DEEPSEEK_API_KEY
```

凭据写在 `/home/paboot/.claude`、`~/.codex`、`~/.dsh`，这三个目录是命名卷，
`docker compose down` / 重建容器都不会丢；只有 `down -v` 会删。

**B. 环境变量 / API key（无状态）**

在 `daemon/.env`（源码方式下 compose 自动读取）或 `docker run -e` 里设置：

| 运行时 | 变量 |
|---|---|
| Claude Code | `ANTHROPIC_API_KEY`，或 `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token` 生成的长效 token） |
| Codex | `OPENAI_API_KEY` |
| DeepSeek Harness | `DEEPSEEK_API_KEY` |

**C. 复用宿主机登录态（可选）**

Linux 宿主机可以手动在 compose 里给 `~/.claude` 等目录加 bind mount，直接复用已有的
`credentials.json` / `auth.json`。macOS 不要这样做：Claude 的 OAuth 凭据在 Keychain 里，
挂目录带不进去，请用 A 或 B。

## 装 agent CLI

镜像不带 CLI，daemon 按 PATH 里的裸命令名探测（`claude` / `codex` / `dsh`）。装法两种：

**A. 起容器后手动装**（改动立即生效，适合试）

```bash
docker exec -it paboot npm i -g @anthropic-ai/claude-code
docker compose restart daemon          # 探测结果在进程内缓存，必须重启（docker run 用 docker restart paboot）
```

`npm` 的全局前缀已指向 `/home/paboot/.npm-global`（镜像里设了 `NPM_CONFIG_PREFIX`），
所以用 compose 映射的非 root 用户直接装即可；该目录挂的是 `paboot-npm` 命名卷，
`docker compose down` / 重建容器都不会丢，只有 `down -v` 会删。

**B. 派生镜像**（推荐长期使用：可复现、可版本化）

```dockerfile
FROM noresign/paboot:latest   # 源码方式改用 paboot-daemon:local

RUN npm i -g \
      @anthropic-ai/claude-code@2.1.314 \
      @openai/codex@0.166.0 \
      @deepseek-ai/dsh@0.2.1-rc.5
```

```bash
docker build -t my-paboot .
```

> npm 11.19+ 默认拦截第三方 install scripts（会有 `install-scripts not yet covered by
> allowScripts` 警告）。三个 CLI 都是随包预编译产物，实测可直接用；如果某次升级后起不来，
> 在安装命令上加 `--allow-scripts=<包名>`。

只装其中一个也行：daemon 把没装到的运行时标为 unavailable，客户端里显示为不可用，不影响其他运行时。

## 已知限制

1. **数据根固定**：`config.ts` 写死 `$HOME/.paboot`，容器里就是 `/home/paboot/.paboot`，
   所以 compose 必须设 `HOME=/home/paboot`（镜像已默认）。
2. **`serverId` 跟数据目录走**：想保留「同一台 daemon」的识别，就保留同一个 `paboot-data` 卷；
   删卷等于换了一台机器，token / SQLite / 会话也一起没了。
3. **CLI 要自己装且要重启**：镜像不带 CLI；容器里装完必须重启 daemon（探测结果在进程内缓存），
   宿主 CLI 和容器 CLI 互不影响，版本不同没关系，daemon 只按协议探测能力。
4. **只有显式挂载宿主机配置目录才会共享登录态**：默认用命名卷（`paboot-claude` 等），
   和宿主机的 `~/.claude` 互不影响。若你改成 bind mount 复用宿主登录态，本机和容器并发写同一
   目录可能互相覆盖缓存（不影响 paboot 自己的会话，它另行持久化）。
5. **宿主 `settings.json` / `config.toml` 里的绝对路径**：如果改成挂载宿主机配置目录，而
   `~/.claude/settings.json` 配了 statusline、hooks 或 `~/.codex/config.toml` 配了指向宿主路径的
   MCP server，这些条目在容器里会找不到命令。paboot 自己的 hook/MCP 由 daemon 注入，不受影响。
6. **数据 / 登录态都在命名卷里**：内置工作区、SQLite、token 在 `paboot-data`，CLI 登录态在
   `paboot-claude` / `paboot-codex` / `paboot-dsh`，装的 CLI 在 `paboot-npm`；
   `docker compose down -v` 会**一并删除**这些卷。客户端里新加的“容器内目录”若不在任何卷上，
   重建容器后就会消失；要长期可用，就挂宿主目录（override）或给它单独建一个命名卷。
7. **安全**：容器隔离的是宿主机文件系统，不是强安全沙箱；agent 在容器里仍有 shell 权限。
   默认不挂宿主机代码；需要挂宿主机项目时，明确知道该目录会被容器读写。默认 `ask` 审批、
   Bearer token 仍然有效；跨网络请走加密组网或反代加 TLS，不要把 4780 直接暴露到公网。
