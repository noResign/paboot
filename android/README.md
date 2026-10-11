# paboot-android

paboot 的 Android 客户端。电脑上的 daemon 负责跑 agent，这个 App 是它的入口：
看流式输出、审批工具调用、接收任务系统通知、浏览文件、管理工作区。整体定位与安装步骤见[根 README](../README.md)。

## 功能

- **聊天与任务**：流式文字、思考过程、Markdown 和工具卡片；支持多会话并发、断线续传及电脑端 Claude 会话续接。
- **权限审批**：手机上允许、拒绝工具调用，或保存会话授权；每个会话独立选择权限模式、撤销已保存的授权。
- **系统通知**：离开对应会话页后，提醒需要审批以及任务完成、失败、取消；点击直达会话。
- **文件与工作区**：目录树、文本与媒体预览、Git 改动和 Diff；管理工作区、附加目录及文件浏览书签。

### 开启系统通知

在「设置 → 通知」开启「后台任务提醒」，并允许系统通知权限。Android 13+ 在首次启动任务时
按需申请通知权限；若之前拒绝了，可从设置页进入系统通知设置重新开启。

- 正在前台查看对应会话时不重复提醒；切到其他会话、其他页面或后台时可以收到通知。
- 通知按会话聚合，点击进入对应聊天查看结果或处理审批；审批已处理或超时后撤掉审批提醒。
- 有任务在监听时显示「正在监听 N 个任务」，监听结束后自动移除。关闭提醒会停止后台监听，不会取消电脑上的任务。
- 通知依赖手机对 daemon 的后台连接。daemon 持续不可达约 60 秒后会停止监听；断网期间不保证即时提醒，审批仍按 daemon 的超时规则处理。

完整交互说明见[系统通知（后台提醒）](../docs/ui/shared/interactions.md#77-🟢-系统通知后台提醒)。

## 前置

- Android Studio（JDK 17）
- `compileSdk 36` / `minSdk 24` / `targetSdk 36`
- 电脑上的 daemon 已经跑起来（拿到地址与 token）

## 构建

用 Android Studio 打开本目录，选 flavor 后直接 Run。命令行等价于：

```bash
./gradlew :app:assembleAlphaDebug    # 测试通道
./gradlew :app:assembleProdDebug     # 正式通道
```

两个 product flavor：

| flavor | applicationId | 用途 |
|---|---|---|
| `alpha` | `com.noresign.paboot.alpha` | 测试通道，可与正式版共存 |
| `prod` | `com.noresign.paboot` | 正式通道 |

### 签名

正式签名需要 `keystore.properties`（从 `keystore.properties.example` 复制填写，该文件不入库）；
没有它只能跑未签名的本地调试包。注意 `app/build.gradle` 在存在 `keystore.properties` 时会把
release 签名同时挂到 `debug` buildType 上。

### 版本号

版本源是 [version.txt](version.txt)（语义化，手改递增）。release 构建据此生成 versionName，
versionCode 取 epoch 秒；debug 固定 versionCode=`1`、versionName=`0.0.0-*`。
**正式包的 versionCode 与 versionName 都必须高于本地 debug 构建**，否则安装器会判降级拒装。


## 模块划分

| 模块 | 职责 |
|---|---|
| `:app` | 业务上层：MVVM（`viewmodel/`）+ Compose UI（`ui/`）+ 仓库编排（`data/repository/`）+ `navigation/` |
| `:lib-network` | 网络底座：okhttp / retrofit / coroutines / kotlinx-serialization 依赖、wire DTO、Retrofit 接口与客户端工厂、SSE 传输、LLM 抽象 |
| `:lib-updater` | 应用内自更新 SDK（仅作者开发期间自用，若需要使用可行接入自己OSS；alpha / prod 双通道，从 OSS 拉 manifest） |

几条关键约定（完整规范见[CLAUDE.md](../CLAUDE.md)）：

- **网络相关的东西全在 `:lib-network`**：`:app` 不自己声明这些依赖，`:lib-network` 也不引用任何 `android.*`，依赖以 `api` 暴露
- `:lib-network` 内部单向分层：`sse/`（通用 SSE 传输）→ `http/`（REST 结果包装）→ `llm/`（供应商抽象）→ `daemon/`（daemon 协议层 + `dto/`）
- wire DTO 按业务域合并成 `<域>Dtos.kt`，与 `daemon/src/types/api.ts` 一一对齐
- UI 以 [docs/ui/](../docs/ui/README.md) 为唯一设计源；「runtime 身份」（图标 / 色 / 名）是可配置映射，新增 agent 只加一行
- 设置持久化用 MMKV（`SettingsStore`，留在 `:app`）

## 文档

| 文档 | 内容 |
|---|---|
| [docs/ui/](../docs/ui/README.md) | UI 设计文档（共享规范 / 移动端 / 桌面端三层） |
| [docs/ui/mobile/platforms/android.md](../docs/ui/mobile/platforms/android.md) | 本平台的落地映射（Design Token → Compose） |
| [CLAUDE.md](../CLAUDE.md) | 仓库纲领与开发规范 |


## License

Apache-2.0，见 [LICENSE](../LICENSE)。
