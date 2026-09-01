#!/usr/bin/env node
// 把一个任务派给 clawd 上的 persona（可跨设备），然后等结果。
//
// 两种用法：
//   1) 派活并等结果：  dispatch.mjs --persona <id> [--device <deviceId>] --prompt "..."
//   2) 只查已派的活：  dispatch.mjs --dispatch-id <id>
//
// 链路（省略 --device = 派给本机 persona，带 --device = 派给联系人设备上的 persona）：
//   本机 daemon POST /rpc/personaDispatch:run  → 秒回 { dispatchId }，任务在后台跑
//   本机 daemon POST /rpc/personaDispatch:get  → { status, outcome? } 轮询到终态
//
// 为什么必须轮询：clawd 原生的「结果通知」是把结果注入回发起方的 clawd session。外部
// 调用方（你的 Claude Code）没有 clawd session，注入无处可去，所以结果只能从台账取。
// 台账是结果的真源，轮询不会漏。
//
// 退出码：0 = 完成拿到结果 / 2 = 还在跑（等超时，可用 --dispatch-id 续查）
//         3 = 任务失败 / 1 = 调用出错
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const POLL_INTERVAL_MS = 10_000
const HTTP_TIMEOUT_MS = 30_000

function die(msg) {
  process.stderr.write(msg + '\n')
  process.exit(1)
}

/**
 * 从 ~/.clawd/state.json 取 daemon 地址 + owner token。
 *
 * 端口是 daemon 每次启动时分配的（不是固定 18790），token 与 auth.json 的同一个。
 * state.json 只在 daemon 运行期间存在 —— 读不到就是 daemon 没在跑。
 */
function daemon() {
  const envUrl = process.env.CLAWD_DAEMON_URL
  const envToken = process.env.CLAWD_DAEMON_TOKEN
  if (envUrl && envToken) return { base: envUrl.replace(/\/+$/, ''), token: envToken }
  const p = path.join(os.homedir(), '.clawd', 'state.json')
  if (!fs.existsSync(p)) die(`找不到 ${p} —— clawd daemon 没在跑？（启动 Clawd 桌面端或 \`clawd\`）`)
  const st = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (!st.url || !st.authToken) die(`${p} 里没有 url / authToken —— daemon 状态异常`)
  const base = String(st.url).replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/+$/, '')
  return { base, token: st.authToken }
}

async function rpc(method, args) {
  const { base, token } = daemon()
  let res
  try {
    res = await fetch(`${base}/rpc/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, error: 'DAEMON_UNREACHABLE', message: e?.message ?? String(e) }
  }
  const raw = await res.text()
  try {
    return JSON.parse(raw)
  } catch {
    return { ok: false, error: 'BAD_RESPONSE', message: `daemon 返回非 JSON（HTTP ${res.status}）` }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function poll(dispatchId, waitSec) {
  const deadline = Date.now() + waitSec * 1000
  for (;;) {
    const res = await rpc('personaDispatch:get', { dispatchId })
    if (!res.ok) {
      process.stderr.write(`查询失败：${res.error}: ${res.message}\n`)
      return 1
    }
    const { status, outcome } = res.result
    if (status === 'completed') {
      console.log('status: completed\n')
      console.log(outcome?.text ?? '(完成但没有 text)')
      for (const p of outcome?.filePaths ?? []) console.log(`\n产出文件：${p}`)
      return 0
    }
    if (status === 'failed') {
      const reason = outcome?.reason ?? '(未给原因)'
      process.stderr.write(`status: failed\nreason: ${reason}\n`)
      // 已知限制：派给**本机** persona 时，daemon 要用 sourceSessionId 反查一个真实
      // session（拿 cwd / transcript）。外部调用方没有 clawd session，哨兵值查不到就失败。
      // 跨设备不受影响——那条路径本来就允许 source session 不在本机（走占位 transcript）。
      if (String(reason).includes('source session not found')) {
        process.stderr.write(
          '\n说明：外部调用方目前只能派给**联系人设备上的** persona（带 --device）。\n' +
          '派给本机 persona 需要一个真实的 clawd 会话作来源，这个脚本没有。\n' +
          '用 list-personas.mjs 看有哪些联系人 persona 可派。\n',
        )
      }
      return 3
    }
    if (Date.now() >= deadline) {
      console.log(`status: ${status}（还在跑，已等 ${waitSec}s）`)
      console.log(`续查：dispatch.mjs --dispatch-id ${dispatchId} --wait 300`)
      return 2
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

function parseArgv(argv) {
  const out = { wait: 90 }
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--persona') { out.persona = v; i += 1 }
    else if (k === '--device') { out.device = v; i += 1 }
    else if (k === '--prompt') { out.prompt = v; i += 1 }
    else if (k === '--prompt-file') { out.promptFile = v; i += 1 }
    else if (k === '--dispatch-id') { out.dispatchId = v; i += 1 }
    else if (k === '--wait') { out.wait = Number(v); i += 1 }
    else if (k === '--help' || k === '-h') out.help = true
    else die(`不认识的参数：${k}`)
  }
  return out
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

const USAGE = `派活给 clawd persona 并等结果

  dispatch.mjs --persona <id> [--device <deviceId>] --prompt "..." [--wait 90]
  dispatch.mjs --dispatch-id <id> [--wait 300]

  --device 省略 = 派给本机 persona；带上 = 派给该联系人设备上的 persona
  --prompt-file <path>  任务内容来自文件（'-' = stdin），长文本用它避免转义`

async function main() {
  const a = parseArgv(process.argv.slice(2))
  if (a.help) { console.log(USAGE); return 0 }

  if (a.dispatchId) return poll(a.dispatchId, a.wait)

  if (!a.persona) die('新派活需要 --persona（或用 --dispatch-id 查已派的活）\n\n' + USAGE)
  if (a.prompt === undefined && !a.promptFile) die('需要 --prompt 或 --prompt-file')

  const prompt = a.promptFile
    ? (a.promptFile === '-' ? await readStdin() : fs.readFileSync(a.promptFile, 'utf8'))
    : a.prompt

  // 不传 sessionId：daemon 缺省会把台账行的 sourceSessionId 兜底成 'external-agent'
  // （发起方不是本机 clawd session）。别在这里编一个假值——编出来的假值五花八门，
  // 台账反而没法辨识来源。
  const body = { targetPersona: a.persona, prompt }
  if (a.device) body.targetDeviceId = a.device

  const res = await rpc('personaDispatch:run', body)
  if (!res.ok) {
    process.stderr.write(`派活失败：${res.error}: ${res.message}\n`)
    return 1
  }
  const { dispatchId } = res.result
  console.log(`已派给 ${a.device ? a.device + ' 上的 ' : '本机 '}${a.persona}`)
  console.log(`dispatchId: ${dispatchId}\n`)
  return poll(dispatchId, a.wait)
}

main().then((c) => process.exit(c)).catch((e) => {
  process.stderr.write(`失败：${e?.stack ?? e}\n`)
  process.exit(1)
})
