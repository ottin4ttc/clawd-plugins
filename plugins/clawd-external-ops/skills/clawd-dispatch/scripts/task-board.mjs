#!/usr/bin/env node
// 盘点 clawd 上派出去的任务（dispatch 台账），输出摘要而不是原始 JSON。
//
// 为什么要这个脚本而不是直接调 RPC：`personaDispatch:list` 不接受分页也不做投影，
// 一次返回全部台账行，**连每条任务的完整正文和完整结果一起**——实测轻易几千 token。
// agent 直接调它会吃掉一大块 context。这里只提取状态摘要；要看某条的完整结果，
// 再按 dispatchId 单查。
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 执行器是本 plugin 自带的内部 lib——不再依赖外部 skill 的绝对路径。
const RPC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'clawd-rpc.mjs')
const STATUS_MARK = { running: '● 进行中', completed: '✓ 完成', failed: '✗ 失败' }

async function loadRpc() {
  try {
    return (await import(pathToFileURL(RPC_PATH).href)).rpc
  } catch (e) {
    process.stderr.write(
      `载入执行器失败（${RPC_PATH}）：${e?.message ?? e}\n` +
      '执行器是本 plugin 自带的 scripts/lib/clawd-rpc.mjs，请确认文件完整。\n',
    )
    process.exit(1)
  }
}

const clip = (s, n) => {
  const t = (s ?? '').split(/\s+/).join(' ')
  return t.length <= n ? t : t.slice(0, n - 1) + '…'
}

function parseArgv(argv) {
  const out = { limit: 20 }
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--status') { out.status = v; i += 1 }
    else if (k === '--limit') { out.limit = Number(v); i += 1 }
    else if (k === '--show') { out.show = v; i += 1 }
    else if (k === '--help' || k === '-h') out.help = true
    else { process.stderr.write(`不认识的参数：${k}\n`); process.exit(1) }
  }
  return out
}

const USAGE = `盘点 clawd dispatch 台账

  task-board.mjs [--status running|completed|failed] [--limit 20]
  task-board.mjs --show <dispatchId>     看某条的完整内容与结果全文`

async function main() {
  const a = parseArgv(process.argv.slice(2))
  if (a.help) { console.log(USAGE); return 0 }

  const rpc = await loadRpc()
  const res = await rpc('personaDispatch:list', {})
  if (!res.ok) {
    process.stderr.write(`调 personaDispatch:list 失败：${res.error}: ${res.message}\n`)
    return 1
  }
  const records = res.result.records ?? []

  if (a.show) {
    const rec = records.find((r) => r.dispatchId === a.show)
    if (!rec) { console.log(`没有这条任务：${a.show}`); return 1 }
    console.log(`任务 ${rec.dispatchId}`)
    console.log(`  派给     : ${rec.targetPersonaId}`)
    console.log(`  状态     : ${STATUS_MARK[rec.status] ?? rec.status}`)
    console.log(`  创建     : ${rec.createdAt}`)
    if (rec.completedAt) console.log(`  完成     : ${rec.completedAt}`)
    console.log(`\n--- 任务内容 ---\n${rec.taskText ?? ''}`)
    const o = rec.outcome ?? {}
    if (o.kind === 'success') {
      console.log(`\n--- 结果 ---\n${o.text ?? ''}`)
      for (const p of o.filePaths ?? []) console.log(`\n产出文件：${p}`)
    } else if (o.kind === 'failure') {
      console.log(`\n--- 失败原因 ---\n${o.reason ?? ''}`)
    }
    return 0
  }

  let rows = a.status ? records.filter((r) => r.status === a.status) : records
  rows = rows.slice().sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))
  const total = rows.length
  rows = rows.slice(0, a.limit)

  if (rows.length === 0) { console.log('没有匹配的任务。'); return 0 }

  console.log(`${total} 条任务${total > rows.length ? `（显示最近 ${rows.length} 条）` : ''}\n`)
  for (const r of rows) {
    const when = String(r.createdAt ?? '').slice(0, 16).replace('T', ' ')
    console.log(`${STATUS_MARK[r.status] ?? r.status}  ${r.targetPersonaId}  ${when}`)
    console.log(`    ${clip(r.taskText, 70)}`)
    const o = r.outcome ?? {}
    if (o.kind === 'success') console.log(`    → ${clip(o.text, 70)}`)
    else if (o.kind === 'failure') console.log(`    → 失败：${clip(o.reason, 60)}`)
    console.log(`    id: ${r.dispatchId}`)
  }
  console.log('\n看某条的完整内容和结果：task-board.mjs --show <id>')
  return 0
}

main().then((c) => process.exit(c)).catch((e) => {
  process.stderr.write(`失败：${e?.stack ?? e}\n`)
  process.exit(1)
})
