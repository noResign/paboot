> [English](README.en.md) | 中文

<div align="center">

<h1>paboot</h1>

<h4>一个客户端，操纵你所有的 agent</h4>


[📚 **文档**](docs/ui/README.md) • [📱 **Android 客户端**](android/README.md) • [🖥️ **桌面端**](desktop/README.md) • [⚙️ **daemon**](daemon/README.md) • [🍎 **iOS**](ios/README.md) • [🔒 **安全模型**](#安全模型-)

[![npm](https://img.shields.io/npm/v/@noresign/paboot?color=0E9F86)](https://www.npmjs.com/package/@noresign/paboot) [![license](https://img.shields.io/badge/license-Apache--2.0-0E9F86)](LICENSE)

</div>

**多端一体化设计，随时随地切换多客户端形态，操纵你电脑上所有的 agent（已接入 Claude Code 与 Codex，后续还有更多）** 
客户端只是入口，**任务始终在电脑上执行**——断连不影响任务，重连自动续上；同一份会话，手机和桌面可以接着来。


## 快速开始

### 1. 装 daemon

前置：**Node `~24`**，以及本机已装并登录的 agent CLI——Claude Code（`claude auth login`）或 Codex，装哪个就能用哪个。

```bash
npm install -g @noresign/paboot      # 全局命令名是 paboot

paboot  # 工作目录默认取命令启动的目录
```

- token 持久化在 `~/.paboot/token`，删掉即轮换；也可以用 `--token` 自己指定
- 完整参数、配置项与 HTTP/SSE 接口见 [daemon/README.md](daemon/README.md)

### 2. Android 客户端

**(1) [release](https://github.com/noResign/paboot/releases) 页面直接下载apk包**

**(2) 自行编译运行**

用 Android Studio 打开 `android/` 选 flavor 后直接 Run。命令行等价于：

```bash
cd android
./gradlew :app:assembleAlphaDebug
```

两个通道：`alphaDebug`（测试）与 `prodDebug`（正式）；正式签名需要
`android/keystore.properties`。模块划分与签名说明见
[android/README.md](android/README.md)。


### 3. 操作步骤

1. 打开 App，填 daemon 地址（就是启动时打印的那个 LAN 地址）和 token，连接
2. 新建会话 → 选工作区目录 → 发一句话
3. agent 在电脑上干活，手机上看流式输出；需要你确认的工具调用会弹审批卡
4. 在「设置 → 通知」开启「后台任务提醒」并授予系统通知权限；离开会话页后，需要审批或任务完成、失败、取消时会收到通知，点击直达对应会话
5. 想走就走——任务在电脑上继续跑，回来重连自动续上

### 4. 手机电脑不在同一个局域网（可选）

daemon 默认监听局域网，公网连接有以下两种方法：

**(1) SSH 中转** 

适合自用，需要一台公网服务器，在**跑 daemon 的电脑**上执行：

```bash
ssh -N -R 0.0.0.0:4788:localhost:4780 user@your-server
```

然后手机连 `http://your-server:4788`，4788端口为服务器端口，可自定义选择。但要注意：**SSH 只加密了「电脑 → 服务器」这一段，手机到服务器
那一跳仍是明文 HTTP**，token 在这段上等于裸奔——所以这条路只适合自己临时用。


- `-R` 默认只在服务器的 **loopback** 上监听，手机连不上；需要在服务器 `/etc/ssh/sshd_config`
  里设 `GatewayPorts clientspecified`
- 隧道断了不会自愈，做成 systemd 服务常驻或用 `autossh -M 0 -N -R ...`

**(2) 组网工具**

把电脑和手机加进同一个虚拟内网，之后就像在同一个 LAN 里一样，直接用 daemon 打印的地址（或虚拟网 IP）连接，daemon 侧不用改任何配置。

- **Tailscale / ZeroTier** —— 装好登录即用，手机端有 App，打不通 NAT 时自动走中继
- **WireGuard** —— 自己搭，最干净，但要维护密钥与路由

好处是**整条链路本来就是加密的**，不用再操心证书和端口暴露。

> ⚠️ 上面任何一种做法都让 daemon 暴露到公网，不再是「只有本机能碰」的，而它驱动的是一个带 shell 权限的
> agent——任何人连上即可指挥它操作你的电脑。因此注意不要泄露 ip 及 token，确保 token 复杂度足够高。


## 功能

手机与桌面客户端是同一套能力，下表按手机端描述；**系统通知为 Android 独有**。

| 能力 | 说明 |
|---|---|
| 手机上看流式输出 | 文字与思考过程实时刷出来，工具调用渲染成可展开的卡片 |
| 工具审批 | 按会话模式将 Bash / 写文件 / MCP 调用转发到手机，支持允许、拒绝、允许全部；**超时未处理默认拒绝** |
| 会话权限管理 | 每个会话独立选择 `ask` / `acceptEdits` / `bypass`；「允许全部」授权可持久保存和撤销，普通工具按工具名、MCP 按 Server 授权 |
| Android 系统通知 | 不在对应会话页时，提醒需要审批、任务完成、失败或取消；点击通知直达会话，正在查看时不重复打扰 |
| 只读白名单 | `ls` / `cat` / `git status` 这类只读命令自动放行，不打扰你 |
| 断线续传 | run 与连接解耦：手机断网、切后台、锁屏都不影响电脑上的任务，回来接着看 |
| 多会话并发 | 多个会话、多个任务并行跑，互不阻塞 |
| 双向续接 | 电脑上 TUI 开的 Claude 会话能导入手机继续；手机开的会话也能用 `claude --resume` 在电脑接续 |
| 工作区与附加目录 | 手机可新增 / 切换工作区、手动管理附加目录；每个会话绑定工作区，同一工作区的会话共用附加目录 |
| 文件快捷目录 | 为常用目录添加浏览书签，方便切换；书签与 agent 的附加目录分开管理 |
| 文件与 Diff | 手机上直接看工作区的 Git 未提交改动、单文件 diff、目录树与文本文件；图片 / MP4 可就地预览 |

## 移动端界面

| 会话列表 | 聊天（支持markdown渲染） | 审批浮层 | 新建会话 |
|---|---|---|---|
| <img src="docs/media/session_dir.jpg" width="170" alt="会话列表"> | <img src="docs/media/session.jpg" width="170" alt="聊天"> | <img src="docs/media/permission_dialog.jpg" width="170" alt="审批浮层"> | <img src="docs/media/create_session.jpg" width="170" alt="新建会话"> |

| 文件 / Diff（可添加多git目录） | 全部文件 | 工作区管理 | 设置 |
|---|---|---|---|
| <img src="docs/media/file_git.jpg" width="170" alt="文件 Diff"> | <img src="docs/media/file_full.jpg" width="170" alt="全部文件"> | <img src="docs/media/workspace_manage.jpg" width="170" alt="工作区管理"> | <img src="docs/media/setting.jpg" width="170" alt="设置"> |


## 安全模型 ⚠️

**`workspace` 不是沙箱。** 它只决定 agent 从哪个目录启动（spawn cwd），不限制它能碰哪些路径。
`Read` / `Grep` 默认显式允许，不走客户端审批，也不会自动添加附加目录；用户或管理员的
显式限制仍然有效。写入按会话模式、工具审批及 Claude Code 自身规则处理，`acceptEdits`
不等于允许写入任意路径。文件级隔离需要 OS 层沙箱（bwrap / firejail / 容器）。

daemon 提供的边界：

- **认证**：所有非 health 的 `/api/*` 都要 Bearer token（常量时间比较）
- **权限模式**：默认 `ask`，`bypass` 必须用户在客户端明确切换
- **默认拒绝**：审批超时未处理 → 拒绝；客户端断线不会立即结束任务或拒绝审批
- **Bash 自动允许**：无 shell 元字符且命中命令白名单时自动允许；当前按命令前缀匹配，不保证所有参数组合都只读
- **审计**：写操作（chat / cancel / permission_decision / session 重命名与删除 / 配置与工作区变更…）记入 `audit_log`

公开网络上使用，请先用ssh中转或者组网工具（Tailscale / ZeroTier / WireGuard）把设备放进一个加密的虚拟内网
（见上文「手机电脑不在同一个局域网」），并保管好 token。只想本机使用就 `--host 127.0.0.1`。

## 状态

- **agent**：已接入 Claude Code 与 Codex（实验性）
- **daemon**：可用（会话 / 审批 / 工作区 / 文件 均已落地）
- **Android**：已实现（连接、会话列表、聊天、审批、会话权限管理、系统通知、新建会话、设置、文件、工作区管理）
- **Desktop**：已实现（Electron 客户端，见 [desktop/README.md](desktop/README.md)）
- **iOS**：预留，待实现

## License

Apache-2.0，见 [LICENSE](LICENSE)。
