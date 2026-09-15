# clawd-plugins

[clawd](https://clawos.chat) 生态的 Claude Code / Codex plugin marketplace。

## 收录分两类

| 类别 | 命名 | 谁用 | 现有 |
|---|---|---|---|
| **外部接入** | `clawd-external-*` | clawd **之外**的 agent 会话（你在某个项目里开的 CC / Codex） | `clawd-external-ops` |
| **clawd 自身组件** | 待定 | clawd 产品自己依赖的 MCP / skills / agents | — |
| **面向用户** | `clawd` | 只用 Codex app 的业务用户 | `clawd` |

分类的依据是**依赖方向**：

- **外部接入**类是 clawd 能力的*消费侧指引*。clawd 产品不依赖它们，删了 clawd 照常跑。
  它们服务的是没有 clawd 上下文的 agent——那些会话拿不到 daemon 注入的 MCP 和 env。
- **clawd 自身组件**类是产品的一部分，跟 daemon 一起演进。

## 安装

```bash
# Claude Code
claude plugin marketplace add ottin4ttc/clawd-plugins
claude plugin install clawd-external-ops@clawd

# Codex
codex plugin marketplace add https://github.com/ottin4ttc/clawd-plugins.git
codex plugin add clawd-external-ops@clawd
```

两边是**独立的 cache**（`~/.claude/plugins/cache/` 和 `~/.codex/plugins/cache/`），升级时各装一次：

```bash
claude plugin marketplace update clawd && claude plugin update clawd-external-ops@clawd
codex   plugin marketplace upgrade clawd && codex plugin add clawd-external-ops@clawd
```

改内容时记得 bump `marketplace.json` 和 `plugin.json` 的 `version`，否则两边察觉不到新版。

## clawd-external-ops

**装它之前先确认你需要它**：clawd 内部的 persona 已经有 daemon 自动注入的
`clawd-rpc` MCP 和  `clawd-external-dispatch` MCP，派活结果会自动回注会话——那条路比本 plugin
的轮询脚本更直接。本 plugin 是给**没有 clawd 会话**的 agent 用的。

两个 skill：

| skill | 干什么 |
|---|---|
| `clawd` | 查 clawd 状态。纯路由：先走 `clawd-rpc` MCP → 答不了 fetch 线上手册 → 再按 file-map 读文件兜底。含安全护栏（不碰凭证、写操作先确认） |
|  `clawd-external-dispatch` | 跨设备给 persona 派活 + 任务台账，带 3 个脚本 |

### 设计原则：不重复造 daemon 已有的东西

- **执行层**用 daemon 注入的 `clawd-rpc` MCP，不自带 RPC 客户端
- **知识层** fetch `${CLAWOS_API}/api/docs/**` 线上手册，改了线上就生效，不把知识焊死在 SKILL.md 里
- **只有 MCP 覆盖不到的才写脚本**：跨设备调用（打对方 daemon）、派活轮询（多步编排）、大结果裁剪

代价是 always-on context 极小（~395 tok），且知识随 clawd 演进自动更新。

### 双引擎依赖差异

| 依赖 | Claude Code | Codex |
|---|---|---|
| `clawd-rpc` MCP | daemon 注入 | daemon 注入（`-c mcp_servers.*`） |
| `CLAWOS_API` env | daemon 注入 | 不一定有——skill 里写死了缺省 `https://api.clawos.chat` 兜底 |

## 加新 plugin

```
plugins/<name>/
├── .claude-plugin/plugin.json
├── skills/        ┐
├── agents/        │ 一个 plugin 内可同时有这几类
├── commands/      │
├── hooks/         │
└── .mcp.json      ┘ 零 skill 的纯 MCP plugin 也合法
```

然后在 `.claude-plugin/marketplace.json` 的 `plugins` 数组加一条
`{"name": "...", "source": "./plugins/..."}`，按上面的分类给名字加前缀。

## clawd

给只用 Codex app 的业务用户：登录一次 clawd 账号（飞书扫码，与 clawd 桌面端共用 `~/.clawd/owner-identity.json`），之后一句话把本地文件变成公网链接。

```bash
codex plugin marketplace add https://github.com/ottin4ttc/clawd-plugins.git
codex plugin add clawd@clawd
```

| tool | 干什么 |
|---|---|
| `login` | 登录 clawd 账号 |
| `share_file` | 本地文件 → 公网链接（Codex 弹一次审批） |

**这里只放产物**：源码在 clawos monorepo `clawd/daemon/src/codex-plugin/`，`pnpm build:codex-plugin` 出单文件 `mcp-server.cjs`（复用 daemon 的登录代码，运行时只要 node——Codex 自带），`scripts/publish-codex-plugin.mjs --to <本仓库>` 同步过来。改功能去改 monorepo，不要在这里改。
