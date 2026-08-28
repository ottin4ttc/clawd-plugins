# clawd-plugins

[clawd](https://clawos.chat) 生态的 Claude Code plugin marketplace。

让任意 persona、任意项目里的 Claude Code 都能操作本机 clawd daemon。

## 安装

```bash
claude plugin marketplace add <this-repo>
claude plugin install clawd-ops@clawd-plugins
```

## 收录的 plugin

| Plugin | 说明 |
|---|---|
| **clawd-ops** | 查 clawd 状态（走 `clawd-rpc` MCP + 线上手册）、跨设备给 persona 派活、任务台账 |

## 设计原则

这些 plugin **不重复造 daemon 已经提供的东西**：

- **执行层**用 daemon 每次启动注入的 `clawd-rpc` MCP（所有 cc/codex 会话都挂），不自带 RPC 客户端
- **知识层** fetch `${CLAWOS_API}/api/docs/**` 线上手册，改了线上就生效，不把知识焊死在 SKILL.md 里
- **plugin 只做**路由、护栏，以及 MCP 覆盖不到的事（跨设备调用、异步轮询、大结果裁剪）

好处是 always-on context 极小，且知识可以随 clawd 演进而更新。

## 结构

```
.claude-plugin/marketplace.json   marketplace 清单
plugins/<name>/
  ├── .claude-plugin/plugin.json  plugin 清单
  └── skills/<skill>/SKILL.md
```

新增 plugin：在 `plugins/` 下建目录，然后在 `marketplace.json` 的 `plugins` 数组里加一条
`{"name": "...", "source": "./plugins/..."}`。
