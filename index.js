import { existsSync, readFileSync, rmSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage', '.cache', '.turbo'])
const MAX_DEPTH = 4
const MAX_PACKAGES = 6
const CONFIG_FILE = '.dsh-plugin-test.json'

export const inject = ['commands']

export function apply(ctx) {
  ctx.commands.register({
    name: 'plugin-test',
    description: '自检当前工作区内正在开发的 DeepSeek Harness 插件的效果（结构 / 语法 / 装载 / UI 构建）',
    handler: async (invocation) => {
      try {
        const dir = await resolveWorkspace(ctx, invocation)
        const text = await buildReport(ctx, dir)
        return { kind: 'success', text }
      } catch (error) {
        return { kind: 'error', text: '插件自检失败：' + describe(error) }
      }
    },
  })
}

function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

async function resolveWorkspace(ctx, invocation) {
  const wd = safeGet(ctx, 'workingDirectory')
  if (wd) {
    if (typeof wd.ensure === 'function') {
      try {
        const dir = await wd.ensure(invocation.agent, invocation.signal)
        if (dir) return dir
      } catch {
        /* fall through */
      }
    }
    if (typeof wd.defaultDirectory === 'string' && wd.defaultDirectory) return wd.defaultDirectory
  }
  return process.cwd()
}

function safeGet(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    /* ignore */
  }
  return undefined
}

function isPluginManifest(pkg) {
  const dsh = pkg && typeof pkg === 'object' ? pkg.dsh : undefined
  return !!(dsh && typeof dsh === 'object' && (dsh.bundle || dsh.client))
}

// 扫描范围：默认只扫会话工作区本身 + 其直接子目录（depth 1），
// 或用工作区根的 .dsh-plugin-test.json 显式声明 roots / depth / exclude。
async function resolveScan(workspace) {
  const configPath = path.join(workspace, CONFIG_FILE)
  let config = null
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(await readFile(configPath, 'utf8'))
    } catch (error) {
      return { roots: [workspace], depth: 1, exclude: [], source: '⚠️ ' + CONFIG_FILE + ' 解析失败（' + describe(error) + '），已退回默认范围', configured: false }
    }
  }
  if (config && typeof config === 'object') {
    const rawRoots = Array.isArray(config.roots) ? config.roots.filter((item) => typeof item === 'string' && item.length > 0) : []
    const roots = rawRoots.map((item) => (path.isAbsolute(item) ? item : path.join(workspace, item)))
    const depth = Number.isInteger(config.depth) && config.depth >= 0 ? Math.min(config.depth, 6) : 1
    const exclude = Array.isArray(config.exclude) ? config.exclude.filter((item) => typeof item === 'string') : []
    if (roots.length > 0) {
      return { roots, depth, exclude, source: '由 ' + CONFIG_FILE + ' 声明：' + roots.join(', ') + '（depth=' + depth + '）', configured: true }
    }
    return { roots: [workspace], depth, exclude, source: '由 ' + CONFIG_FILE + ' 声明的 depth 生效，roots 未声明，仍用会话工作区', configured: true }
  }
  return { roots: [workspace], depth: 1, exclude: [], source: '默认：会话工作区本身 + 直接子目录（depth 1）；可用工作区根的 ' + CONFIG_FILE + ' 声明 roots/depth/exclude', configured: false }
}

function isExcludedExact(dir, exclude) {
  const base = path.basename(dir)
  return exclude.includes(base) || exclude.includes(dir)
}

async function findPluginPackages(root, maxDepth = MAX_DEPTH, exclude = []) {
  const found = []
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && found.length < MAX_PACKAGES) {
    const { dir, depth } = queue.shift()
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
      try {
        const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
        if (isPluginManifest(pkg)) {
          found.push(dir)
          continue
        }
      } catch {
        /* ignore malformed manifest here; reported by checkOne when root itself */
      }
    }
    if (depth >= maxDepth) continue
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.')) continue
      if (isExcludedExact(path.join(dir, entry.name), exclude)) continue
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
    }
  }
  return found
}

async function newestMtime(dir) {
  let newest = 0
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return newest
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      const info = await stat(path.join(dir, entry.name))
      if (info.mtimeMs > newest) newest = info.mtimeMs
    } catch {
      /* ignore */
    }
  }
  return newest
}

async function buildReport(ctx, dir) {
  const lines = ['🧪 插件自检 · ' + dir]
  const scan = await resolveScan(dir)
  if (scan.source) lines.push('扫描范围：' + scan.source)
  const found = []
  for (const root of scan.roots) {
    for (const hit of await findPluginPackages(root, scan.depth, scan.exclude)) {
      if (!found.includes(hit)) found.push(hit)
    }
  }
  if (found.length === 0) {
    lines.push('')
    lines.push('⚠️ 在扫描范围内没有找到插件包（package.json 内带 dsh.bundle 或 dsh.client 的目录）')
    lines.push('提示：把正在开发的插件放在当前会话工作区内，或用 ' + CONFIG_FILE + ' 声明 roots。')
    return lines.join('\n')
  }
  const candidates = []
  for (const pkgDir of found) candidates.push({ dir: pkgDir, mtime: await newestMtime(pkgDir) })
  candidates.sort((a, b) => b.mtime - a.mtime)
  if (candidates.length > 1) lines.push('（范围内共 ' + candidates.length + ' 个插件包，按最近修改排序）')
  let fail = 0
  let warn = 0
  let targets = []
  for (const candidate of candidates) {
    const result = await checkOne(ctx, candidate.dir)
    lines.push('')
    lines.push(...result.lines)
    fail += result.fail
    warn += result.warn
    targets.push({ dir: candidate.dir, pkg: result.pkg, fail: result.fail, clientRel: result.clientRel })
  }
  // 静态检查全通过的那个（最靠前的）才继续做运行测试
  const runnable = targets.find((item) => item.fail === 0 && item.pkg)
  if (runnable) {
    lines.push('')
    lines.push(...(await runSmoke(ctx, runnable)))
  } else if (targets.length > 0) {
    lines.push('')
    lines.push('⏭️ 运行测试已跳过：静态检查未全部通过，先修复 ❌ 项。')
  }
  lines.push('')
  if (fail === 0) {
    lines.push('结论：✅ 必检项全部通过' + (warn > 0 ? '（另有 ⚠️ ' + warn + ' 项提醒，可人工确认）' : ''))
    lines.push('提示：UI 类插件请刷新页面后肉眼确认槽位效果；Host 类插件改动后需要重启 Harness。')
  } else {
    lines.push('结论：❌ 有 ' + fail + ' 项必须修复' + (warn > 0 ? '，另有 ⚠️ ' + warn + ' 项提醒' : ''))
    lines.push('修复后：重新安装（plugin_manager install_bundle）→ 刷新页面 → 再点本按钮复测。')
  }
  return lines.join('\n')
}

// 运行测试：① 隔离子进程真正 import 并执行 Host 入口 ② 从 client.js 里读出它声明了哪些 UI 槽位
async function runSmoke(ctx, target) {
  const lines = ['▶️ 运行测试 · ' + (target.pkg.name || path.basename(target.dir))]
  const mainRel = typeof (target.pkg.exports || {})['.'] === 'string' ? target.pkg.exports['.'] : './index.js'

  // ① Host 入口真跑一遍
  const nodeBin = findNode()
  if (!nodeBin) {
    lines.push('  ⚠️ 未找到 node 可执行文件，跳过 Host 运行测试')
  } else {
    const probePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe.mjs')
    const outPath = path.join(os.tmpdir(), 'dsh-plugin-probe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json')
    let probe = null
    let spawnNote = ''
    try {
      await execFileAsync(nodeBin, [probePath, target.dir, outPath], { timeout: 20000, windowsHide: true })
      probe = JSON.parse(await readFile(outPath, 'utf8'))
    } catch (error) {
      spawnNote = '探针进程失败：' + describe(error)
    } finally {
      try {
        rmSync(outPath, { force: true })
      } catch {
        /* ignore */
      }
    }
    if (!probe) {
      lines.push('  ❌ ' + (spawnNote || '探针没有返回结果'))
    } else if (probe.ok) {
      lines.push('  ✅ Host 入口 ' + probe.entry + ' 已在独立进程执行 apply() 成功')
      const groups = new Map()
      for (const rec of probe.records || []) {
        const key = rec.channel.replace(/\.[^.]+$/, '')
        groups.set(key, (groups.get(key) || 0) + 1)
      }
      if (groups.size === 0) lines.push('     · 未捕获到注册调用（可能只做副作用或依赖真实服务）')
      else {
        const parts = []
        for (const [key, count] of groups) parts.push(key + ' ×' + count)
        lines.push('     · 捕获注册：' + parts.join('，'))
      }
      const detail = (probe.records || [])
        .filter((rec) => /register|execute|handler/.test(rec.channel))
        .map((rec) => rec.channel + (rec.label ? '（' + rec.label + '）' : ''))
      if (detail.length > 0) lines.push('     · 具体：' + Array.from(new Set(detail)).join(', '))
    } else if (probe.form === 'service-class') {
      lines.push('  ⚠️ ' + probe.error)
    } else {
      lines.push('  ❌ 运行失败：' + probe.error)
    }
  }

  // ② client.js 里声明的 UI 槽位
  if (target.clientRel) {
    const clientPath = path.join(target.dir, target.clientRel)
    if (existsSync(clientPath)) {
      let text = ''
      try {
        text = await readFile(clientPath, 'utf8')
      } catch {
        /* ignore */
      }
      const slots = extractSlotRegistrations(text)
      if (slots.length === 0) lines.push('  ⚠️ client.js 内没解析到 ctx.slots.register({...}) 调用')
      else {
        for (const slot of slots) {
          lines.push('  ✅ UI 注册槽位：' + slot.name + (slot.id ? '（id=' + slot.id : '') + (slot.order !== undefined ? ', order=' + slot.order : '') + '）')
        }
      }
    }
  }
  lines.push('  说明：以上是“插件真的跑起来了”的机器证据；界面形态与人眼观感需要你在页面上确认。')
  lines.push('  服务端入口：' + mainRel)
  return lines
}

function extractSlotRegistrations(text) {
  const results = []
  const callRx = /\.slots\.register\(\s*\{/g
  let match
  while ((match = callRx.exec(text)) !== null) {
    const tail = text.slice(match.index, match.index + 600)
    const nameMatch = /name\s*:\s*['"]([^'"]+)['"]/.exec(tail)
    const idMatch = /id\s*:\s*['"]([^'"]+)['"]/.exec(tail)
    const orderMatch = /order\s*:\s*(-?\d+)/.exec(tail)
    if (!nameMatch) continue
    results.push({
      name: nameMatch[1],
      id: idMatch ? idMatch[1] : '',
      order: orderMatch ? Number(orderMatch[1]) : undefined,
    })
    if (results.length >= 12) break
  }
  return results
}

async function checkOne(ctx, pkgDir) {
  const lines = []
  let fail = 0
  let warn = 0
  const ok = (message) => lines.push('  ✅ ' + message)
  const bad = (message) => {
    fail += 1
    lines.push('  ❌ ' + message)
  }
  const soft = (message) => {
    warn += 1
    lines.push('  ⚠️ ' + message)
  }

  let pkg
  try {
    pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8'))
  } catch (error) {
    bad('package.json 无法解析：' + describe(error))
    return { lines, fail, warn, pkg: null, clientRel: '' }
  }

  lines.push('📦 ' + (pkg.name || '(缺少 name)') + ' @ ' + (pkg.version || '(缺少 version)') + ' · ' + path.basename(pkgDir))

  if (!pkg.name) bad('package.json 缺少 name')
  if (!pkg.version) bad('package.json 缺少 version')
  if (pkg.type !== 'module') soft('缺少 "type": "module"')

  const dsh = pkg.dsh || {}
  if (!dsh.bundle && !dsh.client) bad('dsh 字段缺少 bundle / client 声明')

  // 1. 声明文件是否存在
  const declared = Array.isArray(pkg.files) ? pkg.files : []
  const missing = []
  const matched = []
  for (const pattern of declared) {
    const files = await expandPattern(pkgDir, pattern)
    if (files.length === 0) missing.push(pattern)
    else matched.push(...files)
  }
  if (declared.length === 0) soft('package.json 未声明 files 列表')
  else if (missing.length > 0) bad('files 中声明的文件不存在：' + missing.join(', '))
  else ok('files 声明的 ' + declared.length + ' 项全部存在')

  // 2. bundle patch
  let patchId = ''
  const patchRel = dsh.bundle && typeof dsh.bundle.patch === 'string' ? dsh.bundle.patch : ''
  if (patchRel) {
    const patchPath = path.join(pkgDir, patchRel)
    if (!existsSync(patchPath)) bad('bundle patch 文件不存在：' + patchRel)
    else {
      let patchText = ''
      try {
        patchText = await readFile(patchPath, 'utf8')
      } catch {
        /* ignore */
      }
      const idMatch = /-\s*id:\s*['"]?([A-Za-z0-9@/._-]+)/.exec(patchText)
      patchId = idMatch ? idMatch[1] : ''
      if (!patchText.includes(pkg.name || '\u0000')) soft('patch 内未引用包名 ' + pkg.name)
      else ok('bundle patch 正常' + (patchId ? '（配置行 id=' + patchId + '）' : ''))
    }
  } else if (dsh.client) {
    // 纯客户端插件可以没有 patch？仍然需要被插入到 Loader，给出提醒
    soft('未声明 dsh.bundle.patch')
  }

  // 3. client half
  const clientDeclared = !!(dsh.client && typeof dsh.client === 'object')
  const exportsMap = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports : {}
  const clientRel = typeof exportsMap['./client'] === 'string' ? exportsMap['./client'] : ''
  if (clientDeclared) {
    if (!clientRel) bad('声明了 dsh.client 但 exports 缺少 "./client"')
    else if (!existsSync(path.join(pkgDir, clientRel))) bad('客户端入口文件不存在：' + clientRel)
    else ok('客户端入口 ' + clientRel + ' 存在（platform=' + String(dsh.client.platform || '?') + '）')
    if (dsh.client.platform !== 'web') soft('dsh.client.platform 不是 "web"')
  }

  // 4. 语法检查（node --check）
  const syntaxTargets = []
  const mainRel = typeof exportsMap['.'] === 'string' ? exportsMap['.'] : './index.js'
  if (existsSync(path.join(pkgDir, mainRel))) syntaxTargets.push(mainRel)
  if (clientRel && existsSync(path.join(pkgDir, clientRel))) syntaxTargets.push(clientRel)
  const nodeBin = findNode()
  if (syntaxTargets.length === 0) bad('未找到 Host 入口文件 ' + mainRel)
  else if (!nodeBin) soft('未找到 node 可执行文件，跳过语法检查')
  else {
    const problems = []
    for (const rel of syntaxTargets) {
      const problem = await syntaxCheck(nodeBin, path.join(pkgDir, rel), rel)
      if (problem) problems.push(problem)
    }
    if (problems.length > 0) bad('语法错误 → ' + problems.join(' | '))
    else ok('JS 语法检查通过（' + syntaxTargets.join(', ') + '）')
  }

  // 5. 是否已安装 / UI 端可加载（clientModules 只扫描已安装包的 dsh.client）
  const cm = safeGet(ctx, 'clientModules')
  const canInspectRoutes = !!(cm && typeof cm.clientPath === 'function')
  let route = null
  if (canInspectRoutes) {
    try {
      route = cm.clientPath(pkg.name)
    } catch {
      route = null
    }
  }
  if (!canInspectRoutes) soft('clientModules 不可用，无法确认是否已安装到 Web 端')
  else if (route) ok('已安装 · UI bundle 可加载（' + route + '）')
  else if (clientDeclared) bad('未安装或 UI bundle 未注册：plugin_manager install_bundle 后刷新页面')
  else soft('Host-only 插件：Host 侧无法确认装载状态，请用 plugin_manager list_plugins 看 fiberPhase=active')

  // 7. 图标与本地化
  const iconRel = typeof exportsMap['./icon'] === 'string' ? exportsMap['./icon'] : ''
  if (iconRel && !missing.includes(iconRel)) {
    const iconPath = path.join(pkgDir, iconRel)
    if (!existsSync(iconPath)) bad('icon 文件不存在：' + iconRel)
    else {
      const size = (await readFile(iconPath)).byteLength
      if (size > 256 * 1024) bad('icon 超过 256KiB（' + size + ' 字节）')
      else ok('图标正常（' + size + ' 字节）')
    }
  }
  const localeFiles = matched.filter((file) => /[\\/]locale[\\/][^\\/]+\.json$/.test(file))
  if (localeFiles.length === 0 && declared.some((pattern) => pattern.includes('locale'))) soft('未找到 locale JSON')
  else if (localeFiles.length > 0) {
    const missingMeta = []
    for (const file of localeFiles) {
      try {
        const json = JSON.parse(await readFile(file, 'utf8'))
        if (!json || !json.meta || !json.meta.title) missingMeta.push(path.basename(file))
      } catch {
        missingMeta.push(path.basename(file))
      }
    }
    if (missingMeta.length > 0) soft('locale 缺少 meta.title：' + missingMeta.join(', '))
    else ok('locale 元数据（meta.title）正常')
  }

  return { lines, fail, warn, pkg, clientRel }
}

async function expandPattern(root, pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return []
  if (!pattern.includes('*')) {
    const absolute = path.join(root, pattern)
    return existsSync(absolute) ? [absolute] : []
  }
  const slash = pattern.lastIndexOf('/')
  const dirPart = slash >= 0 ? pattern.slice(0, slash) : '.'
  const base = slash >= 0 ? pattern.slice(slash + 1) : pattern
  const absDir = path.join(root, dirPart)
  let names = []
  try {
    names = await readdir(absDir)
  } catch {
    return []
  }
  const rx = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return names.filter((name) => rx.test(name)).map((name) => path.join(absDir, name))
}

function findNode() {
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['']
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, 'node' + ext)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* ignore */
      }
    }
  }
  return ''
}

async function syntaxCheck(nodeBin, file, label) {
  try {
    await execFileAsync(nodeBin, ['--check', file], { timeout: 20000, windowsHide: true })
    return ''
  } catch (error) {
    const raw = String((error && error.stderr) || describe(error))
    const cleaned = raw
      .split(/\r?\n/)
      .map((line) => line.split(path.dirname(file)).join('').replace(/^[\\/:\s]+/, '').trim())
      .filter((line) => line.length > 0)
      .filter((line) => !/^\^+$/.test(line))
      .filter((line) => !/^Node\.js v\d/.test(line))
      .slice(0, 3)
      .join(' / ')
    const prefix = label ? label + ' → ' : ''
    return cleaned.length > 0 ? prefix + cleaned : prefix + 'node --check 失败'
  }
}

