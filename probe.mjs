// 插件运行测试探针：在独立 node 进程里 import 插件的 Host 入口，用假的 ctx 真跑一遍 apply()，
// 把插件注册了什么（commands.register / tools.register / effect …）记录下来写进 JSON。
// 用法：node probe.mjs <插件目录> <输出 JSON 路径>
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [pkgDir, outPath] = process.argv.slice(2)

const records = []
const TIMEOUT_MS = 8000

function labelOf(args) {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue
    if (typeof arg.name === 'string') return arg.name
    if (arg.definition && typeof arg.definition.name === 'string') return arg.definition.name
    if (typeof arg.id === 'string') return arg.id
  }
  return ''
}

function deepMock(prefix) {
  const base = function () {}
  return new Proxy(base, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then' || prop === 'toJSON' || prop === 'inspect') return undefined
      return deepMock(prefix ? prefix + '.' + String(prop) : String(prop))
    },
    apply(_target, _thisArg, args) {
      records.push({ channel: prefix, label: labelOf(args || []) })
      return deepMock(prefix)
    },
    set() {
      return true
    },
  })
}

const ctx = deepMock('')

async function main() {
  const manifestPath = path.join(pkgDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const mainRel = typeof (manifest.exports || {})['.'] === 'string' ? manifest.exports['.'] : './index.js'
  const entryPath = path.resolve(pkgDir, mainRel)
  if (!existsSync(entryPath)) {
    return { ok: false, entry: mainRel, error: '入口文件不存在：' + mainRel }
  }
  const entry = pathToFileURL(entryPath).href + '?probe=' + Date.now()
  const mod = await import(entry)
  if (typeof mod.apply === 'function') {
    const pending = Promise.resolve(mod.apply(ctx, {}))
    const timed = new Promise((resolve) => setTimeout(() => resolve('timeout'), TIMEOUT_MS))
    const settled = await Promise.race([pending.then(() => 'done'), timed])
    if (settled === 'timeout') {
      return { ok: false, entry: mainRel, error: 'apply() 超过 ' + TIMEOUT_MS + 'ms 未完成（可能阻塞等待服务）', records }
    }
    return { ok: true, entry: mainRel, records }
  }
  if (typeof mod.default === 'function') {
    return {
      ok: false,
      form: 'service-class',
      entry: mainRel,
      records,
      error: '该插件以 service class 形式导出，apply() 由框架注入，探针不实例化（可人工确认 list_plugins.fiberPhase）',
    }
  }
  return { ok: false, entry: mainRel, error: '入口没有导出 apply() 函数', records }
}

let result
try {
  result = await main()
} catch (error) {
  result = { ok: false, entry: '?', error: String((error && error.stack) || error), records }
}

if (outPath) {
  await writeFile(outPath, JSON.stringify(result), 'utf8')
}
process.exit(0)
