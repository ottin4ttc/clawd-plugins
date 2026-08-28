#!/usr/bin/env node
// clawd RPC 通用执行器 —— 查定义 + 真调用。
//
// 三种用法：
//   clawd-rpc.mjs --list [关键词]      列出 RPC（省略关键词 = 全部目录，带关键词 = 匹配项详情）
//   clawd-rpc.mjs --show <method>      看单个 RPC 的完整定义（说明 + 参数 JSON Schema）
//   clawd-rpc.mjs <method> ['<json>']  真调一次，打印结果
//
// 定义来自 daemon 的 `meta:methods` RPC —— daemon 现算，与真实 dispatcher 判据同源，
// 不存在「文档跟实现漂移」。不要另存一份静态副本。
//
// 凭证：~/.clawd/state.json 的 url + authToken（daemon 每次启动重新分配端口，必须现读）。
// token 只用于出站 Authorization 头，不打印、不写文件。
//
// 退出码：0 成功 / 1 失败（daemon 不可达、method 不存在、参数不对、业务报错）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HTTP_TIMEOUT_MS = 60_000

function die(msg) {
  process.stderr.write(msg + '\n')
  process.exit(1)
}

/**
 * 解析 daemon 地址 + owner token。
 *
 * env 覆盖（CLAWD_DAEMON_URL + CLAWD_DAEMON_TOKEN）优先——用于指向非默认实例
 * （开发中的 daemon、测试实例）。缺省读 ~/.clawd/state.json。
 */
export function daemon() {
  const envUrl = process.env.CLAWD_DAEMON_URL
  const envToken = process.env.CLAWD_DAEMON_TOKEN
  if (envUrl && envToken) return { base: envUrl.replace(/\/+$/, ''), token: envToken }

  const statePath = path.join(os.homedir(), '.clawd', 'state.json')
  if (!fs.existsSync(statePath)) {
    die(`找不到 ${statePath} —— clawd daemon 没在跑？（启动 Clawd 桌面端或 \`clawd\`）`)
  }
  let st
  try {
    st = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch (e) {
    die(`${statePath} 读不动或不是合法 JSON：${e.message}`)
  }
  if (!st.url || !st.authToken) die(`${statePath} 缺 url / authToken —— daemon 状态异常`)
  const base = String(st.url).replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/+$/, '')
  return { base, token: st.authToken }
}

/** 调一次 RPC。返回 daemon 的 { ok, result } / { ok:false, error, message }。 */
export async function rpc(method, args) {
  const { base, token } = daemon()
  let res
  try {
    res = await fetch(`${base}/rpc/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, error: 'DAEMON_UNREACHABLE', message: e?.message ?? String(e) }
  }
  const raw = await res.text()
  try {
    return JSON.parse(raw)
  } catch {
    return { ok: false, error: 'BAD_RESPONSE', message: `daemon 返回非 JSON（HTTP ${res.status}）：${raw.slice(0, 200)}` }
  }
}

/**
 * RPC 目录。给 method = 单查那一条（daemon 会额外附完整 args JSON Schema）。
 *
 * 单查是较新 daemon 的能力；老 daemon 不认 method 参数会把它 strip 掉后返回全集，
 * 所以这里对返回长度做兜底筛选，让 --show 在两种 daemon 上都能用（老的只是拿不到
 * argsSchema，退回扁平参数视图）。
 */
async function catalog(method) {
  const res = await rpc('meta:methods', method ? { method } : {})
  if (!res.ok) die(`拿 RPC 目录失败：${res.error}: ${res.message}`)
  let methods = res.result.methods
  if (method && methods.length > 1) methods = methods.filter((m) => m.name === method)
  return methods
}

function fmtArgs(m) {
  if (m.args === null || m.args === undefined) {
    return '    参数：(无中央 schema —— 试调一次，从 daemon 的报错里学)'
  }
  if (m.args.length === 0) return '    参数：(无)'
  return '    参数：' + m.args.map((a) => `${a.name}${a.required ? '*' : ''}`).join(', ')
}

function show(m, full = false) {
  const tail = m.reason ? ` [${m.status}: ${m.reason}]` : ` [${m.status}]`
  console.log(`${m.name}${tail}`)
  console.log(`    ${m.description ?? '(无说明)'}`)
  const schema = m.argsSchema
  if (full && schema) {
    // 完整 JSON Schema 才是拼参数的依据：类型 / 枚举取值 / 嵌套对象的键 / union 形状 /
    // 跨字段约束（anyOf = 至少给一个，not = 互斥）都在这里，扁平视图给不出。
    console.log('    参数 schema（JSON Schema draft-07）：')
    for (const line of JSON.stringify(schema, null, 2).split('\n')) console.log(`      ${line}`)
    if ('anyOf' in schema || 'not' in schema) {
      console.log('    ⚠️ 注意顶层 anyOf / not —— 那是跨字段约束（至少给一个 / 互斥），别漏。')
    }
    return
  }
  if (full) {
    console.log(fmtArgs(m))
    console.log('    ⚠️ 这个 daemon 不提供完整 args schema（版本较旧），只有字段名和必填性。')
    console.log('       类型 / 枚举取值 / 嵌套结构未知：试调一次，从 daemon 的报错里学。')
    return
  }
  console.log(fmtArgs(m))
}

const USAGE = `clawd RPC 查定义 + 调用

  clawd-rpc.mjs --list [关键词]      列出 RPC（关键词匹配名字或说明）
  clawd-rpc.mjs --show <method>      看单个 RPC 的完整定义
  clawd-rpc.mjs <method> ['<json>']  调用；也可用 --args-file <path>（'-' = stdin）`

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE)
    return argv.length === 0 ? 1 : 0
  }

  if (argv[0] === '--list') {
    const kw = (argv[1] ?? '').toLowerCase()
    const methods = await catalog()
    if (!kw) {
      // 目录态：一行一条，说明截断 —— 先让调用方扫全貌，再 --show 细看
      console.log(`共 ${methods.length} 个 RPC（* = 必填参数；细看某条用 --show <method>）\n`)
      for (const m of methods) {
        const d = (m.description ?? '').split('。')[0].replace(/\s+/g, ' ')
        console.log(`  ${m.name.padEnd(34)}${d.slice(0, 58)}`)
      }
      return 0
    }
    const hits = methods.filter(
      (m) => m.name.toLowerCase().includes(kw) || (m.description ?? '').toLowerCase().includes(kw),
    )
    if (hits.length === 0) {
      console.log(`没有匹配「${argv[1]}」的 RPC。用 --list 看全部。`)
      return 1
    }
    console.log(`匹配「${argv[1]}」的 ${hits.length} 条：\n`)
    for (const m of hits) {
      show(m)
      console.log('')
    }
    return 0
  }

  if (argv[0] === '--show') {
    const name = argv[1]
    if (!name) die('--show 需要一个 method 名')
    const m = (await catalog(name)).find((x) => x.name === name)
    if (!m) {
      console.log(`没有这个 RPC：${name}（用 --list 查正确名字）`)
      return 1
    }
    show(m, true)
    return 0
  }

  const method = argv[0]
  let payload = argv[1] ?? '{}'
  const fileIdx = argv.indexOf('--args-file')
  if (fileIdx >= 0) {
    const p = argv[fileIdx + 1]
    if (!p) die('--args-file 需要一个路径（或 - 表示 stdin）')
    payload = p === '-' ? await readStdin() : fs.readFileSync(p, 'utf8')
  }
  let args
  try {
    args = JSON.parse(payload || '{}')
  } catch (e) {
    die(`参数不是合法 JSON：${e.message}`)
  }

  const res = await rpc(method, args)
  if (!res.ok) {
    process.stderr.write(`${res.error}: ${res.message}\n`)
    return 1
  }
  console.log(JSON.stringify(res.result, null, 2))
  return 0
}

// 被当脚本直接跑时才执行 main；被 import 时只暴露 daemon/rpc。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`clawd-rpc 失败：${e?.stack ?? e}\n`)
    process.exit(1)
  })
}
