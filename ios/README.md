# paboot-ios

iOS 客户端**连接、会话列表与聊天已实现，文件/设置待做**（2026-10-20）。整体定位见[根 README](../README.md)。

## 当前状态（P0–P4）

- `paboot.xcodeproj`：App target + 共享 scheme `paboot`，最低 iOS 17，纯代码 UIKit。
- `PabootCore/`：本地 SwiftPM 包，两个模块——`PabootProtocol`（纯 Foundation：DTO / 事件判别 /
  SSE 解析 / 重连策略 / URL 归一化）与 `PabootClient`（`URLSession` + 手写 SSE 的传输层）。
- `App/`：应用入口、设计 token、连接页（地址 + token → health + sessions 校验，Keychain 保存
  token，支持最近 5 个连接），连接成功后进入三个 Tab（会话 / 文件 / 设置）。
- 会话列表：只显示当前选中的工作区（顶部可切换）；根目录会话平铺、3 天前折叠为「更早」，
  子目录按 cwd 分组折叠；运行中脉冲标识、Agent 徽章、下拉刷新、重命名 / 删除、断连后引导重新连接。
- 聊天：历史重建（按 run 回放事件）、SSE 流式、工具卡 / 思考 / 问答卡 / Todo / 上下文占用、
  权限审批、模型与权限模式切换、停止、断线续接；新建会话 sheet（工作区 / Agent / 权限）。
- 文件与设置仍是占位。

## 快速开始

需要 **Xcode 15+**（iOS 17 SDK）。

```bash
cd ios
pod install              # 有 pod 依赖后必须；当前空 Podfile 可跳过
open paboot.xcodeproj    # 或打开 pod install 生成的 paboot.xcworkspace
```

命令行验证（不需要签名）：

```bash
cd ios/PabootCore && swift test

cd ios
xcodebuild -project paboot.xcodeproj -scheme paboot \
  -destination 'generic/platform=iOS Simulator' \
  build CODE_SIGNING_ALLOWED=NO
```

## 目标形态

- 原生 **UIKit**（命令式），与 Android 共用 [docs/ui/](../docs/ui/README.md) 这一套设计规范；
  token 落到 `UIColor` / `UIFont`（配 `UIFontMetrics` 支持动态字号）/ Auto Layout，图标用
  SF Symbols，逐项映射见 [docs/ui/shared/design-principles.md](../docs/ui/shared/design-principles.md) §4.5
- **纯代码 UI，不用 Storyboard / XIB**：diff 干净、好 review，也不依赖 Interface Builder
- 跨端传输契约的唯一真源是
  [daemon/src/types/api.ts](../daemon/src/types/api.ts)，
  daemon 侧协议见 [daemon/docs/protocol.md](../daemon/docs/protocol.md) 的「HTTP / SSE 协议」
- 接入方式参考 Android 侧：按 `types/api.ts` 对齐 wire DTO（字段名 / 类型 / 多态判别一一对齐），
  再实现 SSE 传输与本地设置持久化

实现适配方案（Design Token → UIKit 的逐项落地、分阶段实施）见
[../docs/ui/mobile/platforms/ios.md](../docs/ui/mobile/platforms/ios.md)。

## 应用图标

三套外观已就绪（含 iOS 18 的深色 / 着色变体），均为 1024×1024、**无透明通道**
（App Store 的硬要求）：[assets/AppIcon.appiconset](assets/AppIcon.appiconset)。

新建 Xcode 工程后，把整个 `AppIcon.appiconset` 文件夹放进工程的 `Assets.xcassets/`
（替换掉自动生成的那个空目录）即可，Xcode 会自行派生其余尺寸。图形母版在
[../docs/media/mascot-icon.png](../docs/media/mascot-icon.png)。

## 技术选型（开工前已定）

| 事项 | 决定 |
|---|---|
| 依赖管理 | **CocoaPods** —— 对齐公司技术栈。`.xcworkspace` 构建、`Podfile.lock` 入库、`Pods/` 忽略；遇只支持 SPM 的库可在同一工程内并用 |
| 本地存储 | `UserDefaults` 放普通设置，**Keychain 放 token**（敏感凭据不进 UserDefaults） |
| 网络层 | 自研：`URLSession` + `async/await`，SSE 手写解析（纯逻辑、可单测，对齐 Android 侧 `lib-network`） |
| UI 组织 | 纯代码 UIKit；导航用 `UITabBarController` + `UINavigationController`，浮层用 `UISheetPresentationController` |
| 最低 iOS 版本 | 待定 —— 决定可用 API（如 `UISheetPresentationController` 要 iOS 15+）与能对齐的 Xcode 版本 |

实现进度会同步到根 README 的「状态」一节。
