import { createRequire } from 'node:module';

// package.json 是 daemon 版本的唯一来源；这里在运行时读取，保证
// `paboot --version`、/api/health 与 npm 包版本永远一致。
//
// 保持本文件在 src 根：`../package.json` 必须在两种形态下都成立——未打包时从
// `dist/version.js` 解析，被 esbuild 内联进 `dist/index.js` 时从
// `desktop/build/daemon/package.json` 解析（与 dist 同级）。移进子目录会破坏其中一种。
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION = pkg.version;
