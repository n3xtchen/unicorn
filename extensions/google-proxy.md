---
title: Google 专用代理扩展
---

记录给 `google` provider 单独挂 HTTP 代理的扩展：为什么 pi 本身做不到、扩展靠什么生效、怎么用、有哪些坑。扩展本体位于本仓库：

```text
extensions/google-proxy.ts
```

通过 `~/.pi/agent/settings.json` 的 `extensions` 注册（与 `skills` 指向本仓库同一种方式）：

```json
{
  "extensions": ["/Users/nextchen/Dev/project_pig/unicorn/extensions/google-proxy.ts"]
}
```

## 1. 为什么需要扩展

pi 的代理配置只有全局一个 `httpProxy`（`settings.json`，写进 `process.env.HTTPS_PROXY`），它作用于 Pi 管理的全局 HTTP dispatcher，无法按 provider 区分。`models.json` 与 `auth.json` 里都没有代理字段，`auth.json` 的凭据级 `env` 只参与 key 解析，不会写进 `process.env`。

唯一能"只让某个 provider 走代理"的注入点是 `globalThis.fetch`：Google provider 走 `@google/genai`，其 `DEFAULT_FETCHER` 就是裸 `fetch(input, init)`，且 pi 的适配层明确拒绝任何非全局 fetch（`Custom fetch is not supported by the Google Generative AI adapter`）。所以包装全局 `fetch`、只在命中 Google 域名时补一个 `dispatcher`，是唯一可行路径。

## 2. 为什么是 extension 而不是 `--import` 预加载

`dist/core/http-dispatcher.js` 在每次 `configureHttpDispatcher()` 里只于下列条件成立时才执行 `undici.install()`（内部即 `globalThis.fetch = undici.fetch`）：

- 第一次调用：`globalThis.fetch === originalGlobalFetch`，即没人动过 fetch
- 之后每次：`globalThis.fetch === installedGlobalFetch`，即仍是 Pi 上次装的那一个

扩展在 Pi 首次 install 之后运行，把自己换上去，之后任何 rebind 都因身份不匹配而跳过 install，包装自然存活，不需要任何拦截技巧。预加载则在 install 之前运行，会被第一次 install 覆盖，必须额外用 `Object.defineProperty` 的 setter 拦赋值。

## 3. 配置与使用

```bash
export PI_GOOGLE_PROXY="http://127.0.0.1:7890"
```

已写入 `~/.zshrc`。不设该变量时扩展直接 `return`，不改变任何行为。

| 变量 | 作用 |
| --- | --- |
| `PI_GOOGLE_PROXY` | 代理地址，支持 `http://user:pass@host:port` |
| `PI_GOOGLE_PROXY_HOSTS` | 逗号分隔的域名集合，默认见下 |
| `PI_UNDICI_PATH` | undici 的 `package.json` 路径，仅在自动探测失败时使用 |

默认域名集合：

```text
generativelanguage.googleapis.com
aiplatform.googleapis.com
oauth2.googleapis.com
accounts.google.com
```

条目不带点表示精确匹配；带前导 `.` 表示匹配该域及其子域（例如 `.googleapis.com`）。会话内可执行 `/google-proxy` 查看当前代理、域名集合、包装是否仍然生效。

## 4. 关键约束

1. **不要同时 `export HTTPS_PROXY`，也不要在 `settings.json` 里设 `httpProxy`。** 扩展只能做到"给 Google 加代理"，无法"给其它 provider 摘代理"；一旦 Pi 自己的 dispatcher 带了代理，所有 provider 都会走代理。扩展在检测到这两个变量时会于 `session_start` 给出 warning。
2. **只覆盖 `fetch` 链路。** AWS SDK（Bedrock）、`gaxios`（Vertex 取 token）不走全局 `fetch`，本来就各自认 `HTTPS_PROXY`，不受此扩展影响。
3. **改了 `PI_GOOGLE_PROXY` 要重启 pi**，扩展只在启动时读取环境变量。
4. **重复加载不会套娃**：包装状态挂在 `Symbol.for("pi-google-proxy.state")` 上，重载只更新 `agent`，`fetch` 身份保持稳定。这一点是必须的，因为 Google 适配层有 `options.fetch !== globalThis.fetch` 的身份校验。
5. **undici 来自包目录，不是 bundle**：CLI 入口把 undici 内联进了 `dist/bundle/chunks`，所以扩展用 `createRequire` 从 pi 包的 `node_modules/undici` 取 `ProxyAgent`。跨实例可用，因为 undici dispatcher 是鸭子类型（只经公开的 `.dispatch()` 调用）。

## 5. 验证记录

在本机真 `pi` 二进制上实测（`google/gemini-2.5-flash`，本机直连 Google 会超时）：

```text
PI_GOOGLE_PROXY=http://127.0.0.1:9     → fetch failed: connect ECONNREFUSED 127.0.0.1:9
PI_GOOGLE_PROXY=http://127.0.0.1:7890  → {"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users..."}}
```

第一条证明请求确实进了代理（否则会是直连超时），第二条拿到 Google 的真实响应，证明端到端打通。

非 Google 不受影响，同一个进程内：

```text
PI_GOOGLE_PROXY=http://127.0.0.1:9 pi -p --model work/gpt-5.1 "..."
work API error (503): model_not_found ... 分组 test1 下模型 gpt-5.1 无可用渠道

generativelanguage.googleapis.com → ERR ECONNREFUSED   （走代理）
example.com                      → HTTP 200           （直连）
api.anthropic.com                → HTTP 403           （直连）
```
