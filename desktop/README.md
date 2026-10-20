# paboot-desktop

paboot 的桌面客户端：Electron（主进程 + preload）+ React/Vite 渲染层。
它就是 daemon 的另一个瘦客户端——复用同一份协议与设计 token，不改变 daemon 的独立性。

设计文档：UI 设计见 [../docs/ui/desktop/design.md](../docs/ui/desktop/design.md)（已入库）；
技术方案见 `docs/local/electron_desktop_plan.md`（本机私有，未入库）。

自定义皮肤（配色 / 背景动效 / 鼠标波纹）：看 [docs/skins.md](docs/skins.md)——加一套皮肤只改几行代码。

## 运行

```bash
pnpm install          # 首次；会下载 Electron 二进制（约 100MB）
pnpm dev              # 起主进程 + 渲染层（HMR）
pnpm build            # 产出 out/{main,preload,renderer}
pnpm dist             # build + 打包当前平台安装包到 release/
pnpm dist:dir         # 只产出 release/<平台>-unpacked/，不打安装包（验证用）
pnpm typecheck        # 三份 tsconfig 都要过
pnpm test             # vitest：纯逻辑与守护测试
pnpm clean            # 删 out/ + release/
pnpm clean:all        # 再删 node_modules/（之后必须 pnpm install）
pnpm clean:cache      # 删全局 Electron 下载缓存（见下，影响别的项目）
```

三个命令分开是有意的，影响范围依次变大：

- `clean` 只删构建产物，**随时可跑**，不需要重新装依赖——日常最常用的就是这个。
- `clean:all` 连 `node_modules` 一起删，退回到刚 clone 的状态。跑完**必须先 `pnpm install`**，
  否则 `pnpm dev` 会再报一次 `Electron uninstall`（二进制没了）。重装很快：实测 **1.3 秒**
  （依赖都在 pnpm store 里，`postinstall` 会自己把 Electron 二进制装回来）。
- `clean:cache` 删的是 `~/.cache/electron` 和 `~/.cache/electron-builder`——**这是全机的**，
  同机器上别的 Electron 项目也会被清，下次打包要重新下 ~120MB，所以单独一条、不并进前两个。

`dev` / `build` 前会自动用 daemon **自己的** tsc 编译一次 daemon：协议类型走
`@noresign/paboot/protocol` 子路径导出，指向 **daemon 的 `dist/types/api.d.ts`**，
源码树里没有这个文件——不先编译 daemon，三份构建都会解析失败。
（直接调 `tsc` 而不是 `pnpm -C ../daemon build`：daemon 的 `packageManager`
锁在 pnpm 10，本机 corepack 跑的是 11，会直接报版本不匹配。）

## 打包

配置在 `electron-builder.yml`：linux `AppImage`+`deb`、mac `dmg`+`zip`、win `nsis`。
产物落到 `release/`，命名 `paboot-<version>-<arch>.<ext>`。

```bash
pnpm dist          # 当前平台
pnpm dist:dir      # 只产出 release/<平台>-unpacked/，不打安装包（验证用）
pnpm dist:linux    # Linux：AppImage + deb
pnpm dist:mac      # macOS：dmg + zip（只能在 macOS 上打）
pnpm dist:windows  # Windows：nsis（在 Linux 上打需要 wine）
```

> ⚠️ **别直接跑 `pnpm exec electron-builder`**：daemon 的编译与打包都在 `prebuild` 里
> （`pnpm build` 会触发），绕过去就会把一个**过时或不存在**的 daemon 装进包里。
> 一律走上面这几个 `pnpm dist*`。

## 结构

```
src/shared/   主/渲染两侧共用：契约（type-only）、IPC 类型、路由、纯逻辑（SSE 解析 / 重连 /
              错误文案 / 格式化 / runtime 身份）
src/main/     连接与发现、daemon 代理、流式（RunStreamer + delta 合并）、窗口与自定义 scheme、
              托盘与系统通知、关窗行为
src/preload/  零依赖 contextBridge（tests/preload-sandbox.test.ts 钉死）
src/renderer/ zustand store + 纯 reducer + React UI
tests/        跨进程守护测试（preload 依赖、协议纯度）
```
