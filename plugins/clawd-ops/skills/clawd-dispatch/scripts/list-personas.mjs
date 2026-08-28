#!/usr/bin/env node
// 列出本机 clawd 上「借来的」persona —— 即已建联的联系人设备开放给你的 persona。
//
// 数据来源：
//   ~/.clawd/contacts.json   联系人（deviceId / remoteUrl / connectToken）
//   对方 daemon POST /rpc/persona:list （Bearer = 该联系人的 connectToken）
//
// 为什么不用本机 RPC `contact:list`：它返回完整 Contact 记录，**含 connectToken**（能以你
// 的身份连对方 daemon 的凭证）。直接读文件并只取需要的字段，token 全程不进 stdout。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TIMEOUT_MS = 20_000

function loadContacts() {
  const p = path.join(os.homedir(), '.clawd', 'contacts.json')
  if (!fs.existsSync(p)) {
    process.stderr.write(`找不到 ${p} —— 本机 clawd 还没建过联系人？\n`)
    process.exit(1)
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  const items = Array.isArray(raw) ? raw : (raw.contacts ?? [])
  if (items.length === 0) {
    process.stderr.write('联系人列表为空 —— 还没有可借的 persona。\n')
    process.exit(1)
  }
  return items
}

async function listRemotePersonas(remoteUrl, connectToken) {
  const res = await fetch(`${remoteUrl.replace(/\/+$/, '')}/rpc/persona:list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${connectToken}` },
    body: '{}',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(`${body.error}: ${body.message}`)
  return body.result.personas ?? []
}

async function main() {
  const asJson = process.argv.includes('--json')
  const rows = []

  for (const c of loadContacts()) {
    const name = c.displayName || '(无名)'
    const { deviceId, remoteUrl, connectToken } = c
    if (!deviceId || !remoteUrl || !connectToken) {
      rows.push({ contact: name, deviceId, error: '缺 remoteUrl / connectToken，无法连' })
      continue
    }
    try {
      for (const p of await listRemotePersonas(remoteUrl, connectToken)) {
        rows.push({ contact: name, deviceId, personaId: p.personaId, label: p.label })
      }
    } catch (e) {
      rows.push({ contact: name, deviceId, error: e?.message ?? String(e) })
    }
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2))
    return 0
  }

  const ok = rows.filter((r) => r.personaId)
  const bad = rows.filter((r) => r.error)
  if (ok.length > 0) {
    console.log('可派活的 persona（--persona 用 personaId，--device 用 deviceId）：\n')
    const width = Math.max(...ok.map((r) => r.contact.length))
    for (const r of ok) {
      console.log(`  ${r.contact.padEnd(width)}  ${r.personaId.padEnd(28)} ${r.label ?? ''}`)
      console.log(`  ${''.padEnd(width)}  --device ${r.deviceId}`)
    }
  } else {
    console.log('没有拿到任何可派活的 persona。')
  }
  if (bad.length > 0) {
    console.log('\n连不上的联系人：')
    for (const r of bad) console.log(`  ${r.contact} (${r.deviceId}) — ${r.error}`)
    console.log('  （对方 daemon 没在跑 / tunnel 断了 / 没授权，都会这样）')
  }
  return 0
}

main().then((c) => process.exit(c)).catch((e) => {
  process.stderr.write(`失败：${e?.stack ?? e}\n`)
  process.exit(1)
})
