---
name: clawd-external-dispatch
description: 把任务派给 clawd 上联系人设备的 persona（「借来的」persona）并拿回结果，以及盘点派出去的任务台账。当用户说「让 XX persona 去做…」「派给某人机器上的 persona」「问问 XX 的 clawd 助手」「我派的任务怎么样了」「有什么在跑」「XX 那个任务好了没」，或要列出有哪些可派活的 persona 时使用。只覆盖派活 + 查结果这条链路，不做 clawd 的其它管理操作（那些走 clawd skill）。
---

# 给 clawd persona 派活 & 查台账

> 名字里的 external 是刻意的：daemon 自己有个同名的 `clawd-dispatch` MCP
> （`mcp__clawd-dispatch__*`，给 clawd 内部 persona 用，结果自动回注会话）。
> 本 skill 是给**没有 clawd 会话**的外部 agent 用的轮询版，两者不是一回事。

用户本机跑着 clawd daemon，联系人设备上开放了一些 persona 给他用。这个 skill 把任务派
过去、等对方干完、把结果拿回来，也负责盘点派过的所有任务。

脚本都在 `${CLAUDE_PLUGIN_ROOT}/skills/clawd-external-dispatch/scripts/` 下，只用 node 内建模块。
下面用 `$S` 指代这个目录。

## ⚠️ 能力边界：只能派给联系人设备上的 persona

派给**本机** persona 走不通——daemon 要用发起方的 clawd 会话 id 反查一个真实会话（拿工作
目录和上下文），而你（外部的 Claude Code）没有 clawd 会话。跨设备不受这个限制，因为那条
路径本来就允许来源会话不在本机。

所以 `--device` **实际上是必须的**。用户要求派给本机 persona 时，直接告诉他这个限制，让他
在 clawd 里直接跟那个 persona 对话。

## 派活三步

### 1. 看有哪些 persona 可派

```bash
node $S/list-personas.mjs
```

输出每个联系人开放的 `personaId` 和该联系人的 `deviceId`。用户说「派给王亮那个 crm 的」
时，靠这一步把人话对应到 id。

### 2. 派活并等结果

```bash
node $S/dispatch.mjs \
  --persona persona-clawd-helper \
  --device owner-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --prompt "帮我看一下 xxx" \
  --wait 120
```

- 任务内容长或带引号/换行时用 `--prompt-file <path>`（`-` = stdin），别在命令行里硬转义
- Bash 工具本身有超时，`--wait` 别设得比它还大（120–300 秒合适）

**退出码**（据此决定下一步，别只看文字）：

| 码 | 含义 | 你该做什么 |
|---|---|---|
| 0 | 干完了，stdout 就是对方的回复 | 转述给用户 |
| 2 | 还在跑，等超时了 | 告诉用户「还在做」，附 dispatchId；用户催时走第 3 步 |
| 3 | 任务失败 | 把 reason 告诉用户 |
| 1 | 调用出错（daemon 没在跑、persona 不存在、对方离线） | 按 stderr 排障 |

### 3. 续查一个还在跑的任务

```bash
node $S/dispatch.mjs --dispatch-id <上一步给的 dispatchId> --wait 300
```

`dispatchId` 是这件事的唯一凭据，daemon 重启也还在台账里。用户过一小时回来问，用它查就行。

## 查台账

**列最近的任务**（默认 20 条，新到旧）：

```bash
node $S/task-board.mjs
node $S/task-board.mjs --status running
node $S/task-board.mjs --status failed
node $S/task-board.mjs --show <dispatchId>   # 某条的完整正文和结果全文
```

**不要为了"省一步"直接调 `personaDispatch:list`** —— 它不接受分页也不做投影，一次返回全部
台账行连完整正文和完整结果，实测轻易几千 token。脚本只提摘要，要全文再 `--show` 单查。

## 必须知道的几件事

**结果只能轮询拿，没有推送。** clawd 原生的通知方式是把结果注入回发起方的 clawd 会话，而你
没有 clawd 会话，那条路径对你无效。台账才是结果的真源，`--dispatch-id` 查它不会漏。脚本已
经在做轮询，你不用自己实现。

**派活是异步的。** `personaDispatch:run` 秒回一个 dispatchId 就返回了，对方 persona 在它自己
机器上慢慢干。「命令返回了」≠「活干完了」——只有退出码 0 才是干完。

**跨设备派的活不能追问。** 协议层不允许在跨设备任务上接着发第二条指令。用户要补充或追问，
只能用新的 `--prompt` 再派一次，把上下文写全。

**不要碰凭证。** `~/.clawd/state.json` 的 `authToken`、`~/.clawd/contacts.json` 的
`connectToken` 都是能操作 clawd / 以用户身份连对方设备的密钥。脚本内部读它们发请求，不打印。
你不要 cat 这两个文件、不要把 token 写进任何输出、日志或文件。同理**不要调 `contact:list`
RPC** —— 它返回的记录里带 connectToken，要联系人信息就用 `list-personas.mjs`。

**派活前先跟用户确认目标。** 派给借来的 persona 会在**别人的机器**上真起一个 AI 会话干活、
消耗对方资源，对方也看得到这条任务。第一次派某个 persona，或任务内容敏感时，先把「派给谁、
什么内容」说给用户听，得到同意再发。

## 讲给用户时

按状态分组讲（在跑的 / 完成的 / 失败的），不要把列表原样念一遍。`failed` 里
`daemon restarted while dispatch in flight` 是 daemon 重启导致的中断，不是任务本身出错——
用户关心的话可以建议重派。用户问某条的结果，用 `--show` 取全文再总结，别只报截断的那行。

## 排障

| 现象 | 原因 / 对策 |
|---|---|
| `找不到 ~/.clawd/state.json` | daemon 没在跑，让用户启动 Clawd |
| `DAEMON_UNREACHABLE` | daemon 刚重启（端口会变），重跑一次即可 |
| 列 persona 时某联系人显示连不上 | 对方 daemon 离线 / tunnel 断了，不是你的问题 |
| `source session not found` | 你没带 `--device`（派了本机 persona）。见上面的能力边界 |
| `persona not dispatchable` | 对方那个 persona 不是公开的，或没授权给用户 |
| 等了很久一直 `running` | 对方在干真活。用 `--dispatch-id` 隔一阵查一次，别反复重派 |
| 台账列表是空的 | 用户还没派过任务 |
