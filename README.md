> [English](README.en.md) | 中文

<div align="center">

<h1>paboot</h1>

<h4>一个客户端，操纵你所有的 agent</h4>


[📚 **文档**](docs/ui/README.md) • [📱 **Android 客户端**](android/README.md) • [🖥️ **桌面端**](desktop/README.md) • [⚙️ **daemon**](daemon/README.md) • [🍎 **iOS**](ios/README.md)

[![npm](https://img.shields.io/npm/v/@noresign/paboot?color=0E9F86)](https://www.npmjs.com/package/@noresign/paboot) [![license](https://img.shields.io/badge/license-Apache--2.0-0E9F86)](LICENSE)

</div>

**多端一体化设计，随时随地切换多客户端形态，操纵你电脑上所有的 agent（已接入 Claude Code、Codex 与 DeepSeek Harness）**
**数据始终在电脑上**，手机和桌面可操纵同一份会话，断连不影响任务，重连自动续上。

- **一个客户端，操纵所有 agent** —— 已接入 Claude Code、Codex 与 DeepSeek Harness。
  接新的 agent 不用改客户端。
- **三端同源，原生实现** —— Android / iOS / 桌面共用一份协议和一套设计规范，操作的是同一份会话，且各自原生实现。
- **数据在你自己电脑上** —— agent 用你本机的环境、工具、配置和技能；数据始终在你电脑上，paboot 自己不要账号，也不收集任何数据。
- **断线不中断** —— run 与连接解耦：锁屏、切后台、断网都不影响电脑上的任务，回来按接着看。
- **审批权在你手上** —— 每个会话独立 `ask` / `acceptEdits` / `bypass`；默认拒绝，
  Bash、写文件、MCP 调用会转成手机上的审批卡，超时自动拒绝，只读命令自动放行。
- **并发多任务，完成自动通知** —— 多个会话、多个 run 并行互不阻塞；人不在会话页时需要审批或跑完会推系统通知。
- **改动可见可回滚** —— 不离开会话就能看 Git 改动、单文件 diff、目录树和文本 / 图片 / 视频；
  每轮 run 都留 checkpoint 快照，桌面端可回滚到任意一轮。

## 快速开始

### 0. 前置

目前 paboot 支持 Claude Code / Codex / DeepSeek Harness，请提前安装并配置至少一种 agent：

> [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
>
> [Claude Code](https://code.claude.com/docs) and run `claude auth login`
>
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：`npm install -g @deepseek-ai/dsh`；模型凭据用
> `DEEPSEEK_API_KEY` 环境变量，或在 `dsh web` 的「设置 → 模型」里填写。

### 1. Server

```bash
npm install -g @noresign/paboot      # 全局命令名是 paboot

paboot  # 工作目录默认取命令启动的目录
```

- token 持久化在 `~/.paboot/token`，删掉即轮换；也可以用 `--token` 自己指定
- 完整参数、配置项与 HTTP/SSE 接口见 [daemon/README.md](daemon/README.md)

### 2. 客户端

**[release](https://github.com/noResign/paboot/releases) 页面直接下载安装包**

**(1) android**

用 Android Studio 打开 `android/` 选 flavor 后直接 Run。命令行等价于：

```bash
cd android
./gradlew :app:assembleAlphaDebug
```

两个通道：`alphaDebug`（测试）与 `prodDebug`（正式）；正式签名需要
`android/keystore.properties`。模块划分与签名说明见
[android/README.md](android/README.md)。

**(2) ios**

需要 macOS + Xcode 15+（iOS 17 SDK）。用 Xcode 打开 `ios/paboot.xcodeproj` 直接 Run；命令行等价于：

```bash
cd ios
xcodebuild -project paboot.xcodeproj -scheme paboot \
  -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

模块划分与纯逻辑测试（`ios/PabootCore`）见 [ios/README.md](ios/README.md)。

**(3) desktop**

desktop 构建会用 daemon 的 tsc 生成协议类型，所以先把两边依赖都装上：

```bash
cd daemon && pnpm install && cd ..
cd desktop && pnpm install    # 会下载 Electron 二进制（约 100MB）
```

日常开发与打包：

```bash
cd desktop
pnpm dev             # 起主进程 + 渲染层（HMR）
pnpm dist            # 打包当前平台的安装包到 release/
pnpm dist:linux      # 或 dist:mac / dist:windows
```

命令与构建细节见 [desktop/README.md](desktop/README.md)。


### 3. 手机电脑不在同一个局域网（可选）

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


## 移动端界面

| 会话列表 | 聊天（支持markdown渲染） | 审批浮层 | 新建会话 |
|---|---|---|---|
| <img src="docs/media/session_dir.jpg" width="170" alt="会话列表"> | <img src="docs/media/session.jpg" width="170" alt="聊天"> | <img src="docs/media/permission_dialog.jpg" width="170" alt="审批浮层"> | <img src="docs/media/create_session.jpg" width="170" alt="新建会话"> |

| 文件 / Diff（可添加多git目录） | 全部文件 | 工作区管理 | 设置 |
|---|---|---|---|
| <img src="docs/media/file_git.jpg" width="170" alt="文件 Diff"> | <img src="docs/media/file_full.jpg" width="170" alt="全部文件"> | <img src="docs/media/workspace_manage.jpg" width="170" alt="工作区管理"> | <img src="docs/media/setting.jpg" width="170" alt="设置"> |


## License

Apache-2.0，见 [LICENSE](LICENSE)。
