---
name: clawd
description: 查询或操作本机 clawd 的实际状态与数据——有多少/有哪些 persona、哪些会话在跑、联系人是谁、tunnel 开没开、某个东西为什么不工作。**任何「我的 clawd 上有什么 / 是什么情况」的问题都先用它**：状态全在 daemon 里，走 clawd-rpc MCP 取，不要扫 ~/.clawd/ 目录或猜文件结构。不用于开发 clawd 自身的源码。
---

# clawd：先问 RPC，别翻目录

用户本机跑着 clawd daemon。**它的一切状态都在 daemon 里，对外只有一个入口：RPC。**

## 第一步：走 clawd-rpc MCP

daemon 每次启动会把 `clawd-rpc` MCP 挂进所有会话，它是 agent 调 daemon RPC 的**唯一收口**。

1. `mcp__clawd-rpc__list` 拉方法表（每条带中文说明），对着问题挑方法
2. 参数拿不准就 `list` 看完整定义
3. `mcp__clawd-rpc__call` 调用

**方法表就是能力清单**——别凭印象说 clawd 没有某个能力，先查表。

要拿 clawd 的任何数据都走这条。**不要** Glob / Read / ls `~/.clawd/` 下的文件来推断：目录布局是实现细节会随版本变；跨设备「借来的」persona 根本不在本机目录里；而且 `~/.clawd/` 下躺着凭证。

## 第二步：RPC 答不了，再 fetch 线上手册

文档 base 取 env `CLAWOS_API`；**读不到就直接用 `https://api.clawos.chat`**——Claude Code
会话由 daemon 注入这个 env，Codex 会话不一定有，但两者的目标地址是同一个，缺省值永远可用。

先拉地图：`${CLAWOS_API}/api/docs/introspection/file-map.md` —— 讲 `~/.clawd/` 下每个文件是干啥的。

| 要查什么 | fetch |
|---|---|
| state/auth/tunnel/dispatch json 的字段含义 | `${CLAWOS_API}/api/docs/introspection/state-schemas.md` |
| 典型故障怎么排（tunnel 挂了、dispatch 卡住、session 报错） | `${CLAWOS_API}/api/docs/introspection/common-issues.md` |

**fetch 不到**就照本机现状 + 现有认知答；如果本机也答不了又需要文档知识，直接说「我需要那份文档但拉不到」，**别瞎猜字段含义**。

## 第三步：文件兜底（仅在 RPC 和文档都答不了时）

按 file-map 定位后再 Read。凭证不外显：`auth.json` 整份别读；`contacts.json` 里的 `connectToken` 等 token / secret 不贴进回答、不落盘。

## 路由到别的 skill

| 用户问的 | 去哪 |
|---|---|
| 派活给某人机器上的 persona / 我派的任务什么状态 | `clawd-external-dispatch` skill |
| 联系人有谁 | `clawd-external-dispatch` 的 `list-personas.mjs`（**不要**调 `contact:list`，它返回带 `connectToken` 的完整记录） |

## 调之前先问用户

`*:delete` / `*:update` / `*:create` / `persona:*` 写 / `inbox:*`（发 DM 给人）/ `contact:setRemoteAccess`（开了对方能反向执行你的机器）/ `attachment.signUrl`（本地文件变公网可下载 URL）/ `peerExec:run`（在别人机器上跑命令）——**说清楚要做什么，得到同意再调**。

只读的（`*:list` / `*:get` / `history:*` / `whoami` / `info`）随便调。读会话历史时 `history:read` **一定加 `slim:true`**，否则工具调用原文会吃掉一大块 context。

## 什么时候不适用

**开发 clawd 自身的源码**时不走这条——那是读仓库代码、改实现，跟查运行时状态是两件事。

## 排障

| 现象 | 对策 |
|---|---|
| MCP 调用报 daemon 不可达 | daemon 刚重启（端口每次都变），重试即可；仍不行让用户启动 Clawd 桌面端 |
| `METHOD_NOT_ALLOWED: unknown method` | 名字拼错。用 `list` 查正确写法——`attachment.*` / `extension.*` 用点号，其余用冒号 |
| 报缺某个参数但定义里没有 | 少数 method 有 schema 反射不出来的隐含参数，照 daemon 的报错补 |

讲给用户时**整理成人话**（表格 / 分组），别把原始 JSON 甩过去。
