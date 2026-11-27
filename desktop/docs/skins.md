# 内置皮肤

桌面端的皮肤是**一整套内置外观**（配色 + 可选氛围特效），用户可在「设置 → 外观 → 皮肤」切换。
默认皮肤是 **品牌**。加一套皮肤仍然只改几行代码，不需要动架构。

## 先分清三个轴

| 轴 | 管什么 | 落在哪 |
|---|---|---|
| `theme` | **明暗**（浅色 / 深色 / 跟随系统） | `data-theme` → `ui/tokens.css` 的 CSS 变量 |
| `skin` | **整套内置外观**（配色 + 可选氛围特效） | 默认品牌在 `:root`；其他皮肤用 `data-skin` → `[data-skin='<id>']` 覆盖 token |
| `fx` | **特效层**（背景动画、鼠标波纹…），可选、默认关 | `ui/SkinFx.tsx` 挂载的 canvas |

皮肤是「另一套配色 + 可选的氛围特效」，叠在明暗之上：选了皮肤，明暗仍由用户的浅/深设置决定。
每套皮肤必须同时给浅色与深色的 token；**结构 token（字号 / 间距 / 圆角 / 动效 / 组件解剖）不随皮肤变**。
设计规则见 `docs/ui/shared/visual-language.md` §2.1。

## 首批内置皮肤

**已定**：

- `brand`（**品牌**，默认）：中性灰面 + 发丝边 + 品牌青绿主色，写在 `tokens.css` 的 `:root`
  （浅 / 深各一组）。
- `ripple`（**涟漪**，可选）：品牌配色 + 鼠标涟漪特效；特效默认关，关闭时等同品牌外观。

**待定**：其余皮肤的数量、命名、气质与配色。新增时按下面的步骤补齐浅 + 深 token。

> 旧版本存过 `default`（Mono）的本地选择，`skinById` 会把它回落到默认品牌。

## 加一套皮肤（配色为主）

两步：

**1. 在 `src/renderer/src/ui/tokens.css` 写浅 + 深两组变量**

```css
:root[data-skin='myskin'] {
  --bg: #fbf7f0;
  --surface: #fffdf9;
  --card: #f5eee3;
  --primary-fill: #2b2119;
  --on-primary-fill: #ffffff;
  /* …想覆盖哪个 token 就写哪个；没写的回落默认品牌 */
}
:root[data-skin='myskin'][data-theme='dark'] {
  --bg: #191613;
  --surface: #221e1a;
  --card: #2a2520;
  --primary-fill: #f6efe4;
  --on-primary-fill: #191613;
}
```

> 每套皮肤**必须浅、深各一组**，且不能覆盖结构 token（字号 / 间距 / 圆角 / 阴影层级 /
> 动效时长 / 图标）。未覆盖的 token 回落默认品牌。

**2. 在 `src/renderer/src/ui/skins.ts` 的 `SKINS` 加一行**

```ts
export const SKINS = [
  { id: 'brand',  label: '品牌', fx: 'none' },
  { id: 'myskin', label: '我的皮肤', fx: 'none' },   // ← 新增
] as const satisfies readonly SkinEntry[];
```

`SkinId` 是从 `SKINS` **推导**出来的，所以不用另外声明类型。改完保存，设置页
「外观 → 皮肤」里就会出现这一项，**挂载、持久化、降级全部自动生效**。

> `ripple`（涟漪）是内置的可选特效皮肤；旧 localStorage 里的无效 id 由 `skinById`
> 回落到默认品牌。

## 给皮肤加可选氛围特效

特效是皮肤的**可选属性**，默认 `none`；关闭特效时皮肤必须完整好看。三步：

**1. 写一个特效实现**，放 `src/renderer/src/ui/fx/<名字>.ts`：

```ts
/** 返回一个 disposer：必须真正停掉自己（取消 rAF、摘掉所有监听）。 */
export function startMyFx(canvas: HTMLCanvasElement): () => void {
  // …在 canvas 上画东西…
  return () => {
    // 清理
  };
}
```

**2. 在 `src/renderer/src/ui/SkinFx.tsx` 注册**：

- 给 `FxId` 加上 `'myfx'`（在 `ui/skins.ts` 里）
- 在 `EFFECTS` 表里挂一行：

```ts
const EFFECTS: Partial<Record<FxId, (canvas: HTMLCanvasElement) => () => void>> = {
  ripple: startRipple,
  myfx: startMyFx,   // ← 新增
};
```

**3. 把特效挂到某套皮肤上**：`{ id: 'myskin', label: '我的皮肤', fx: 'myfx' }`。
**特效不单独作为一套皮肤**；默认 `fx: 'none'`。

现成的参考实现是 `ui/fx/ripple.ts`（鼠标涟漪），它把下面这些约定都示范了一遍。

## 写 `fx` 实现要遵守的约定

- **必须返回一个能停干净自己的 disposer**（`cancelAnimationFrame` + `removeEventListener`）。
  `SkinFx` 靠它做三件事：窗口切后台时暂停、切换皮肤时卸载、React StrictMode 下反复挂载——
  留着一个还在跑的循环或监听，就会漏。
- **鼠标事件监听 `window`，不是 canvas**：特效层是 `pointer-events: none`，canvas 收不到事件。
- **颜色别每帧读**。从 `getComputedStyle(canvas).getPropertyValue('--primary')` 取一次缓存起来，
  用 `MutationObserver` 盯 `document.documentElement` 的 `data-theme` / `data-skin` 变化再重读
  （`getComputedStyle` 可能触发样式重算，每帧一次是纯浪费）。
- **空闲时不要空转 rAF**。没有东西要画就停掉循环，等 `pointermove` 之类的输入再唤醒；
  桌面端一开一整天，空转的帧就是电池。`ripple.ts` 里的 `schedule()` 就是这个模式。
- **分辨率按 `devicePixelRatio` 缩放**，否则高分屏上会糊。

## 页面上新增「铺满屏」的容器时

页面铺底写的是 `--page-bg`，不是 `--bg`：有特效时它会被设成 `transparent`（见 `tokens.css`），
好让画布透出来。所以**新加一个铺满屏的容器时，背景用 `var(--page-bg)`**，否则它会把特效层挡在下面——
这正是最初 `.main` / `.chat-scroll` 挡住涟漪的原因。

区分两者：

- `--page-bg`：**页面底色**（该让特效透出来）。
- `--bg`：叠在 surface 之上的**小控件**（只读框、徽章）的底色，要保持不透明——它得盖住背后的东西。

## 这些不用你管（`SkinFx` 已处理）

- `prefers-reduced-motion: reduce` 时整个特效层**不挂载**——不是「挂载了但不动」。
- 窗口隐藏（`visibilitychange`）时拆掉特效，切回来重建。
- 皮肤选择的持久化（localStorage）、`data-skin` 的同步、设置页的列表。
- 特效激活时 `--bg` / `--surface` / `--surface-2` 会**自动透明**（沉浸式：只留边框），
  所以卡片、气泡、列表这些不用为皮肤态写任何特殊处理。**前提是新写的容器自带 `border`**——
  没有边框的元素透明后会连边界一起消失。

## 三处扩展点，别的都别碰

| 想改 | 改这 |
|---|---|
| 整套配色（浅 + 深） | 默认品牌改 `:root`；其他皮肤写 `ui/tokens.css` 的 `[data-skin='<id>']` 与 `[data-skin='<id>'][data-theme='dark']` |
| 有哪些皮肤 | `ui/skins.ts` → `SKINS` 一行（id / label / fx） |
| 特效行为 | `ui/fx/<name>.ts` + `ui/SkinFx.tsx` 的 `EFFECTS` 表 |

`App.tsx`、`store/appearance.ts`、`SettingsPage.tsx` 里的皮肤相关代码是通用管线，
加皮肤**不需要**动它们。
