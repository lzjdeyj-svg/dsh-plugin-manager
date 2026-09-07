// dsh-plugin-manager 核心引擎（Node 侧共享逻辑：CLI 与宿主 half 复用；浏览器不依赖本文件）。
//
// 职责：
//  1. 路径发现 —— $DSH_HOME（env DSH_HOME > ~/.dsh）与 <home>/profiles/<name>；
//  2. profile manifest（package.json + dsh.profile.bundles）的读写与“对账”；
//  3. 粘贴命令/插件 spec 的解析与归一化（github: 简写、npm 包名、file/link 等透传）；
//  4. 真实安装/卸载/更新 —— 在 profile 目录里跑 pnpm（自动发现 pnpm / corepack pnpm），
//     处理 pnpm 对 git 仓库 prepare 脚本的构建拦截（onlyBuiltDependencies），
//     然后按官方 dsh plugin 的规则对账 bundles 列表；
//  5. 停用/启用 —— 直接编辑 manifest：保留依赖但摘出/放回 dsh.profile.bundles；
//  6. 快照 —— 列出已装插件及其来源/启用状态（无需 pnpm）。

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 路径发现
// ---------------------------------------------------------------------------

export const PROFILES_DIR = 'profiles'

/** 默认 dsh 家目录：~/.dsh（与官方 dsh-home-paths 一致）。 */
export function defaultDshHome(env = process.env) {
  return join(homedir(), '.dsh')
}

/** 解析 Harness 家目录：显式传参 > $DSH_HOME > ~/.dsh。 */
export function resolveDshHome(configured, env = process.env) {
  const raw = configured ?? env.DSH_HOME
  return resolve(raw !== undefined && String(raw).trim() !== '' ? String(raw).trim() : defaultDshHome(env))
}

export function validateProfileName(name) {
  if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name === 'node_modules') {
    throw new Error(`invalid profile name ${JSON.stringify(name)}`)
  }
}

/** 解析 profile 目录：<home>/profiles/<name>（可能不存在）。 */
export function resolveProfileDir(name, home = resolveDshHome()) {
  validateProfileName(name)
  return join(home, PROFILES_DIR, name)
}

// ---------------------------------------------------------------------------
// profile manifest
// ---------------------------------------------------------------------------

export function profileManifestPath(dir) {
  return join(dir, 'package.json')
}

export function readProfileManifest(dir) {
  const path = profileManifestPath(dir)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`failed to read profile manifest ${path}: ${String(error?.message ?? error)}`)
  }
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`profile manifest ${path} must hold a JSON object`)
  }
  return parsed
}

export function writeProfileManifest(dir, manifest) {
  writeFileSync(profileManifestPath(dir), JSON.stringify(manifest, undefined, 2) + '\n')
}

function bundlesOf(manifest) {
  return manifest.dsh?.profile?.bundles ?? []
}

/** 浅复制并返回写入了 bundles 的新 manifest（不落盘）。 */
export function withBundles(manifest, bundles) {
  return {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: [...bundles],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 已装包解析（模拟官方两个解析锚点：profile 目录向上，含共享 profiles/node_modules）
// ---------------------------------------------------------------------------

function nodeModulesAnchors(fromDir) {
  const out = []
  let dir = resolve(fromDir)
  for (;;) {
    out.push(join(dir, 'node_modules'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

/**
 * 在 profile 目录的依赖树里找已装包目录（升序遍历 node_modules 锚点）。
 * @param name - 包名（可为 @scope/pkg）。
 * @param profileDir - profile 目录。
 * @returns 包目录绝对路径；找不到返回 null。
 */
export function findInstalledPackageDir(name, profileDir) {
  for (const anchor of nodeModulesAnchors(profileDir)) {
    const candidate = join(anchor, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function readInstalledManifest(packageDir) {
  try {
    return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 该依赖是否是一个 dsh bundle 插件（manifest 声明 dsh.bundle.patch）。
 * @returns {boolean}
 */
export function isBundlePackage(name, profileDir) {
  const dir = findInstalledPackageDir(name, profileDir)
  if (dir === null) return false
  const manifest = readInstalledManifest(dir)
  return manifest?.dsh?.bundle?.patch !== undefined
}

// ---------------------------------------------------------------------------
// bundles 对账（语义与官方 dsh plugin 一致：按“已安装状态”而非依赖 diff）
// ---------------------------------------------------------------------------

/**
 * 对账 dsh.profile.bundles 与已装依赖：解析到 bundle 的依赖加入层栈；
 * 不再解析到 bundle 的（被卸载/丢了声明）离开层栈。必要时写回 manifest。
 * @param before - 本次 pnpm 调用前的 manifest。
 * @param profileDir - profile 目录。
 * @param warn - 对新增的普通（非 bundle）依赖的告警回调。
 * @returns {changed, manifest} 是否变更与最新 manifest。
 */
export function reconcilePlugins(before, profileDir, warn = () => {}) {
  const after = readProfileManifest(profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = bundlesOf(after)
  let changed = false

  for (const packageName of dependencies) {
    const isBundle = isBundlePackage(packageName, profileDir)
    if (isBundle && !plugins.includes(packageName)) {
      plugins.push(packageName)
      changed = true
    } else if (!isBundle && !beforeDeps.has(packageName)) {
      warn(packageName)
    }
  }

  const dependencySet = new Set(dependencies)
  for (const packageName of [...plugins]) {
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && isBundlePackage(packageName, profileDir)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }

  if (!changed) return { changed: false, manifest: after }
  const manifest = withBundles(after, plugins)
  writeProfileManifest(profileDir, manifest)
  return { changed: true, manifest }
}

// ---------------------------------------------------------------------------
// spec / 粘贴命令解析
// ---------------------------------------------------------------------------

const GITHUB_SHORT = /^(?<owner>[\w.-]+)\/(?<repo>[\w.-]+)(?:#(?<ref>[\w./-]+))?$/

/** GitHub 网页/克隆地址 → 安装 spec。匹配 owner/repo、/tree/<ref>、#frag、.git 后缀等。 */
const GITHUB_URL = /^(?:https?:\/\/|git\+https?:\/\/|git@)(?:www\.)?github\.com[/:](?<owner>[\w.-]+)\/(?<repo>[\w.-]+?)(?:\.git)?(?:[/#](?<rest>[\w./-]*))?$/

/** 从任意文本中提取第一个 github 仓库链接（形如 https://github.com/owner/repo...）。 */
export function extractGitHubUrl(text) {
  const raw = String(text ?? '')
  const match = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\/tree\/[\w./-]+)?/i.exec(raw)
  return match === null ? null : match[0].replace(/\/$/u, '')
}

/** 把 GitHub 链接归一化（含 owner/repo、分支提取）。返回 null 表示不像 GitHub 链接。 */
export function githubUrlToSpec(raw) {
  const input = String(raw ?? '').trim().replace(/\/+$/u, '')
  if (!/^(?:https?:\/\/|git\+https?:\/\/)/i.test(input)) return null
  const match = GITHUB_URL.exec(input)
  if (match === null) return null
  const owner = match.groups.owner
  const repo = match.groups.repo
  if (owner === undefined || repo === undefined) return null
  // /tree/<branch> 或裸 #<branch> 携带分支；其余路径（blob/issues 等）视为仓库主页。
  let ref = undefined
  const rest = match.groups.rest ?? ''
  const tree = /^tree\/(?<branch>[\w./-]+)$/.exec(rest)
  if (tree !== null) ref = tree.groups.branch
  else if (/^[\w./-]+$/.test(rest) && !rest.startsWith('blob/')) ref = rest
  const spec = `github:${owner}/${repo}${ref !== undefined ? '#' + ref : ''}`
  return { spec, owner, repo, ref }
}

/**
 * 把用户粘贴/输入的内容归一化成一个“安装目标 spec”：
 * - 整行 `dsh plugin [--profile p] add github:...` → github spec；
 * - `github:owner/repo#ref` → 原样；
 * - `owner/repo` / `owner/repo#ref` → github: 前缀补全；
 * - `https://github.com/owner/repo[/tree/branch]` → github:owner/repo[#branch]；
 * - `@scope/pkg`、`pkg`、`pkg@version`、`file:`/`link:`/`git+` 等 → 透传。
 * @returns {{ kind: string, spec: string, display: string }}
 */
export function normalizeSpec(input) {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('空 spec')
  if (raw.startsWith('github:')) {
    return { kind: 'github', spec: raw, display: raw }
  }
  const short = GITHUB_SHORT.exec(raw)
  if (short !== null && raw.split('/').length === 2) {
    const { owner, repo, ref } = short.groups
    const spec = `github:${owner}/${repo}${ref !== undefined ? '#' + ref : ''}`
    return { kind: 'github', spec, display: spec }
  }
  const url = githubUrlToSpec(raw)
  if (url !== null) {
    return { kind: 'github', spec: url.spec, display: url.spec }
  }
  return { kind: 'other', spec: raw, display: raw }
}

const VERB_ALIASES = {
  add: 'add',
  install: 'add',
  rm: 'remove',
  remove: 'remove',
  uninstall: 'remove',
  up: 'update',
  update: 'update',
}

const DSH_PLUGIN_LINE = /^\s*dsh\s+plugin\b(.*)$/i
const PROFILE_FLAG = /--profile\s+([\w.-]+)/

/**
 * 解析用户粘贴的整行命令（或裸 spec）。
 * 支持的形态：
 *   dsh plugin --profile web add github:owner/repo#main
 *   dsh plugin add github:owner/repo#main
 *   dsh plugin --profile web remove <name> / update <name>
 *   裸 spec：github:owner/repo#main、owner/repo、owner/repo#main、@scope/pkg 等
 * @param text - 用户输入。
 * @returns { verb, profile?, targets: string[] }；无法识别时抛错。
 */
export function parsePastedCommand(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') throw new Error('粘贴内容为空')
  const line = DSH_PLUGIN_LINE.exec(raw)
  if (line === null) {
    // 当作裸 spec（默认 add）
    return { verb: 'add', targets: [raw] }
  }
  const rest = line[1].trim()
  const profileMatch = PROFILE_FLAG.exec(rest)
  const profile = profileMatch !== null ? profileMatch[1] : undefined
  const afterProfile = profileMatch !== null ? rest.replace(PROFILE_FLAG, '').trim() : rest
  const tokens = afterProfile.split(/\s+/).filter((token) => token !== '')
  if (tokens.length === 0) throw new Error('命令缺少子命令（add/remove/update）')
  const verbToken = tokens[0].toLowerCase()
  const verb = VERB_ALIASES[verbToken]
  if (verb === undefined) throw new Error(`不支持的子命令 ${JSON.stringify(tokens[0])}（支持 add/remove/update）`)
  const targets = tokens.slice(1)
  if (targets.length === 0) throw new Error(`子命令 ${tokens[0]} 缺少目标参数`)
  return { verb, profile, targets }
}

/** 判断某 token 是否是 README 占位路径（<本项目路径> 之类尖括号写法）。 */
export function isPlaceholderTarget(token) {
  return /^<[^>]+>$/.test(String(token ?? '').trim())
}

/**
 * 解析一次“安装”语义（GUI 粘贴框/CLI add 共用）。
 * 针对 README 里 `dsh plugin --profile web add <本项目路径>` 这类写法：
 * 若目标是占位符（<…>）而同一段文本里能提取到 GitHub 链接，自动用该链接替换目标。
 * @param text - 用户输入（可为整行命令、裸 spec、或夹带链接的文本）。
 * @returns { verb, profile?, targets: string[] } targets 已是归一化 spec；无法识别时抛错。
 */
export function parseInstallText(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') throw new Error('粘贴内容为空')
  // 取首个非空行作为命令行；后续行（README 说明/链接）仅用于占位替换。
  const firstLine = raw.split(/\r?\n/u).find((line) => line.trim() !== '') ?? ''
  const looksLikeCommand = /^dsh\s+plugin\b/i.test(firstLine.trim())
  let parsed
  if (looksLikeCommand) {
    try {
      parsed = parsePastedCommand(firstLine)
    } catch {
      parsed = { verb: 'add', targets: [firstLine] }
    }
  } else {
    parsed = { verb: 'add', targets: [raw] }
  }
  if (parsed.verb !== 'add') return parsed
  // 若目标是占位符（README 里的 <本项目路径>），尝试从整段文本中找 GitHub 链接顶替。
  const needsReplace = parsed.targets.some((target) => isPlaceholderTarget(target))
  if (needsReplace) {
    const url = extractGitHubUrl(raw)
    if (url !== null) {
      const normalized = normalizeSpec(url)
      return { ...parsed, targets: [normalized.spec] }
    }
    throw new Error('该命令写的是占位路径（如 <本项目路径>）；请把它的 GitHub 仓库链接一起粘贴进来（https://github.com/owner/repo）。')
  }
  parsed.targets = parsed.targets.map((target) => {
    const normalized = normalizeSpec(target)
    return normalized.spec
  })
  return parsed
}

// ---------------------------------------------------------------------------
// pnpm 执行
// ---------------------------------------------------------------------------

function findOnPath(name, env = process.env) {
  const pathVar = env.PATH ?? ''
  for (const dir of pathVar.split(':').filter(Boolean)) {
    const candidate = join(dir, name)
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // 目录不可读则跳过
    }
  }
  return null
}

/**
 * 找到可用的 pnpm 命令。
 * 顺序：env.DSHPM_PNPM > PATH 上的 pnpm > corepack pnpm > node 同目录 corepack。
 * @returns {string[]} argv 前缀，如 ['pnpm'] 或 ['/path/corepack','pnpm']。
 */
export function resolvePnpmCommand(env = process.env) {
  if (env.DSHPM_PNPM !== undefined && String(env.DSHPM_PNPM).trim() !== '') {
    return [String(env.DSHPM_PNPM).trim()]
  }
  const pnpm = findOnPath('pnpm', env)
  if (pnpm !== null) return [pnpm]
  const corepack = findOnPath('corepack', env) ?? join(dirname(process.execPath), 'corepack')
  try {
    if (existsSync(corepack)) return [corepack, 'pnpm']
  } catch {
    // 不存在则继续
  }
  throw new Error('未找到 pnpm：设置 DSHPM_PNPM 环境变量，或把 pnpm/corepack 放入 PATH')
}

/**
 * 在指定目录异步执行命令，收集输出。
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
export function runCommand(argv, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      resolvePromise({ code, stdout, stderr })
    })
  })
}

// ---------------------------------------------------------------------------
// pnpm 构建拦截（allowBuilds / onlyBuiltDependencies）
// ---------------------------------------------------------------------------

/**
 * 把若干包名加入 profile package.json 的 pnpm.onlyBuiltDependencies（pnpm ≥9.1 支持），
 * 允许其 prepare/lifecycle 脚本在安装时执行。
 * @returns {string[]} 实际新增的包名。
 */
export function allowBuilds(profileDir, packageNames) {
  const manifest = readProfileManifest(profileDir)
  const current = manifest.pnpm?.onlyBuiltDependencies
  const list = Array.isArray(current) ? [...current] : []
  const added = []
  for (const name of packageNames) {
    if (!list.includes(name)) {
      list.push(name)
      added.push(name)
    }
  }
  if (added.length === 0) return []
  const next = { ...manifest, pnpm: { ...(manifest.pnpm ?? {}), onlyBuiltDependencies: list } }
  writeProfileManifest(profileDir, next)
  return added
}

/** 从 pnpm stderr 里识别 “Ignored build scripts: …” 的包名清单。 */
export function ignoredBuildScriptPackages(stderr, wantedNames) {
  const names = new Set()
  if (/ignored build scripts/i.test(stderr)) {
    // pnpm 的提示可能是一行（逗号分隔），也可能每条带 @version。
    const marker = /ignored build scripts:([^\n]*)/i.exec(stderr)
    if (marker !== null) {
      let chunk = marker[1]
      // 截到提示句的句号处（“... run pnpm approve-builds” 等后续说明不要混入包名）
      const cut = chunk.search(/\.\s*(?:run|$)/i)
      if (cut !== -1) chunk = chunk.slice(0, cut)
      for (const token of chunk.split(/[,，]\s*/)) {
        let name = token.trim()
        if (name === '') continue
        name = name.replace(/@[^@]+$/, '') // 去掉尾部 @version（scoped 包的开头 @ 不受影响）
        if (wantedNames.length === 0 || wantedNames.includes(name)) names.add(name)
      }
    }
  }
  return [...names]
}

// ---------------------------------------------------------------------------
// profile 体检（dshpm check）—— 专门针对“cordis.patch.yml 被拼坏/依赖缺失”这类
// 让 dsh 启动即 code 1 的事故做启动前诊断。
// ---------------------------------------------------------------------------

/**
 * 解析 profile 用户层 cordis.patch.yml。
 * 用 js-yaml 校验是否为“单个 YAML 文档的补丁列表”；补丁允许 `!!js` 自定义标签
 * （loader 会用自定义 schema 求值），这里出现该标签时退化为宽松校验。
 * @returns {{ ok: boolean, reason?: string, entries?: unknown[] }}
 */
/**
 * 装载 js-yaml：优先从调用方模块树解析；失败时回退到 dsh 安装的
 * profiles/node_modules 锚点（CLI 从任意 cwd 运行时也能命中）。
 */
async function loadYamlModule() {
  try {
    return await import('js-yaml')
  } catch {
    // 从 harness 家目录的 profiles 共享 node_modules 解析 CJS 版
  }
  const home = resolveDshHome()
  const anchors = [join(home, 'profiles', 'web'), join(home, 'profiles'), join(home, 'node_modules')]
  for (const anchor of anchors) {
    try {
      const req = createRequire(join(anchor, '__probe__.js'))
      const resolved = req.resolve('js-yaml')
      if (resolved !== undefined) return req('js-yaml')
    } catch {
      // 该锚点没有 js-yaml，试下一个
    }
  }
  return null
}

async function parsePatchFile(profileDir) {
  const path = join(profileDir, 'cordis.patch.yml')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, reason: '无用户层补丁文件（可选）' }
    return { ok: false, reason: `读取 ${path} 失败：${String(error?.message ?? error)}` }
  }
  const yamlModule = await loadYamlModule()
  if (yamlModule === null) {
    return { ok: false, reason: 'js-yaml 不可用，无法校验补丁文件（请安装 js-yaml 或人工检查 ' + path + '）' }
  }
  const { loadAll, Schema, Type, DEFAULT_SCHEMA } = yamlModule.default ?? yamlModule
  const lenientSchema = new Schema({
    include: [DEFAULT_SCHEMA],
    explicit: [new Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: (value) => value })],
  })
  let docs = null
  let error = null
  try {
    docs = loadAll(text)
  } catch (err) {
    error = err
    try {
      docs = loadAll(text, { schema: lenientSchema })
      error = null
    } catch {
      // 宽松 schema 也不行：保留原错误
    }
  }
  if (error !== null || docs === null) {
    return { ok: false, reason: `${path} 不是合法的单个 YAML 文档：${String(error?.message ?? error)}（常见：把新片段直接接在模板 [] 后面导致一个文件两个文档）` }
  }
  if (docs.length === 0) return { ok: false, reason: `${path} 为空` }
  if (docs.length > 1) {
    return { ok: false, reason: `${path} 含 ${docs.length} 个 YAML 文档 —— 补丁文件必须只有一个文档（列表）。请把多个片段合并进同一个列表。` }
  }
  const doc = docs[0]
  if (!Array.isArray(doc)) return { ok: false, reason: `${path} 顶层必须是 YAML 数组（loader patch 条目列表），得到 ${doc === null ? 'null' : typeof doc}` }
  for (const [index, entry] of doc.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: `${path} 第 ${index + 1} 条不是对象（应为 id 覆盖行或 insert 列表）` }
    }
    const keys = Object.keys(entry)
    if (!keys.includes('id') && !keys.includes('insert')) {
      return { ok: false, reason: `${path} 第 ${index + 1} 条缺少 id 或 insert 键：${keys.join(',')}` }
    }
  }
  return { ok: true, entries: doc }
}

/**
 * 体检一个 profile（只读）。
 * @param profileName - profile 名。
 * @param home - harness 家目录。
 * @returns {{ ok, issues: Array<{level:'error'|'warn'|'ok', message}>, summary: string }}
 */
export async function checkProfile(profileName, home = resolveDshHome()) {
  const profileDir = resolveProfileDir(profileName, home)
  const issues = []
  if (!existsSync(join(profileDir, 'package.json'))) {
    return { ok: false, issues: [{ level: 'error', message: `profile ${profileName} 不存在（${profileDir}）` }], summary: 'fail' }
  }
  let manifest
  try {
    manifest = readProfileManifest(profileDir)
  } catch (error) {
    return { ok: false, issues: [{ level: 'error', message: String(error?.message ?? error) }], summary: 'fail' }
  }
  const dependencies = manifest.dependencies ?? {}
  const bundles = bundlesOf(manifest)

  for (const name of Object.keys(dependencies)) {
    const dir = findInstalledPackageDir(name, profileDir)
    if (dir === null) issues.push({ level: 'error', message: `依赖 ${name} 未安装（node_modules 找不到）` })
  }
  for (const name of bundles) {
    const dir = findInstalledPackageDir(name, profileDir)
    if (dir === null) {
      issues.push({ level: 'error', message: `层 ${name} 无法解析到已安装包 —— 启动会失败` })
      continue
    }
    const installedManifest = readInstalledManifest(dir)
    if (installedManifest?.dsh?.bundle?.patch === undefined) {
      issues.push({ level: 'error', message: `层 ${name} 的 package.json 未声明 dsh.bundle.patch —— 启动会失败` })
    } else {
      issues.push({ level: 'ok', message: `层 ${name} → ${installedManifest.version ?? ''}` })
    }
  }
  const patch = await parsePatchFile(profileDir)
  issues.push({ level: patch.ok ? 'ok' : 'error', message: patch.ok ? 'cordis.patch.yml：单个 YAML 文档，结构合法' : String(patch.reason) })

  const errors = issues.filter((issue) => issue.level === 'error')
  const summary = errors.length === 0 ? 'ok' : `发现 ${errors.length} 个问题`
  return { ok: errors.length === 0, issues, summary }
}

// ---------------------------------------------------------------------------
// 高层操作（供 CLI 与宿主 half 共用）
// ---------------------------------------------------------------------------

/** 截断展示用长文本。 */
export function clip(text, max = 4000) {
  const value = String(text ?? '')
  return value.length <= max ? value : value.slice(0, max) + '\n…（已截断）'
}

/** 单个操作的统一结果。 */
export class OperationResult {
  constructor({ ok, text, code = null }) {
    this.ok = ok
    this.text = text
    this.code = code
  }
}

async function runPnpmInProfile(profileDir, args) {
  const argv = [...resolvePnpmCommand(), ...args]
  const result = await runCommand(argv, { cwd: profileDir })
  return { ...result, argv }
}

/**
 * 安装插件（add）。
 * @param profileDir - profile 目录。
 * @param specs - 归一化后的 spec 数组（pnpm 参数）。
 * @param opts - { allowBuilds: boolean } 默认 true：git 仓库 prepare 被拦时自动放行并重建。
 */
export async function addPlugins(profileDir, specs, opts = {}) {
  const allow = opts.allowBuilds !== false
  const before = readProfileManifest(profileDir)
  const warnings = []
  const run = await runPnpmInProfile(profileDir, ['add', ...specs])
  if (run.code !== 0) {
    const text = [
      'pnpm add 失败（exit ' + String(run.code) + '）',
      clip(run.stderr.trim() || run.stdout.trim()),
    ].join('\n')
    return new OperationResult({ ok: false, text })
  }
  // 构建拦截自动处理：先把“这次新增的依赖名”识别出来再放行。
  if (allow) {
    const afterDeps = Object.keys(readProfileManifest(profileDir).dependencies ?? {})
    const wanted = afterDeps.filter((name) => !Object.prototype.hasOwnProperty.call(before.dependencies ?? {}, name))
    const blocked = ignoredBuildScriptPackages(run.stderr, wanted)
    if (blocked.length > 0) {
      const added = allowBuilds(profileDir, blocked)
      if (added.length > 0) {
        const rebuild = await runPnpmInProfile(profileDir, ['rebuild', ...added])
        if (rebuild.code !== 0) {
          warnings.push('依赖已放行但 pnpm rebuild 未完全成功（见 stderr 尾部）：\n' + clip(rebuild.stderr.trim() || rebuild.stdout.trim(), 1500))
        }
      }
    }
  }
  let reconciled
  try {
    reconciled = reconcilePlugins(before, profileDir, (packageName) => {
      warnings.push(`注意：${packageName} 未声明 dsh.bundle —— 已作为普通依赖安装，不会作为 profile 层加载（后续版本若声明会自动激活）。`)
    })
  } catch (error) {
    return new OperationResult({ ok: false, text: '安装完成但对账失败：' + String(error?.message ?? error) })
  }
  const lines = []
  lines.push('✅ 安装成功：' + specs.join(', '))
  for (const spec of specs) lines.push('   pnpm add ' + spec)
  if (reconciled.changed) lines.push('已把新插件加入 profile 层列表（dsh.profile.bundles）。')
  for (const w of warnings) lines.push(w)
  lines.push('⚠️ 需要重启 web 后插件才会加载生效。')
  return new OperationResult({ ok: true, text: lines.join('\n') })
}

/**
 * 卸载插件（remove）。支持包名或来源 spec 匹配。
 */
export async function removePlugins(profileDir, names, opts = {}) {
  const before = readProfileManifest(profileDir)
  const warnings = []
  const run = await runPnpmInProfile(profileDir, ['remove', ...names])
  if (run.code !== 0) {
    const text = [
      'pnpm remove 失败（exit ' + String(run.code) + '）',
      clip(run.stderr.trim() || run.stdout.trim()),
    ].join('\n')
    return new OperationResult({ ok: false, text })
  }
  let reconciled
  try {
    reconciled = reconcilePlugins(before, profileDir, (packageName) => warnings.push(packageName))
  } catch (error) {
    return new OperationResult({ ok: false, text: '卸载完成但对账失败：' + String(error?.message ?? error) })
  }
  const lines = []
  lines.push('🗑️ 卸载成功：' + names.join(', '))
  if (reconciled.changed) lines.push('已把对应条目移出 profile 层列表。')
  for (const w of warnings) lines.push(w)
  lines.push('⚠️ 重启 web 后卸载才会完全生效。')
  return new OperationResult({ ok: true, text: lines.join('\n') })
}

/**
 * 更新插件（update）。
 */
export async function updatePlugins(profileDir, names, opts = {}) {
  const before = readProfileManifest(profileDir)
  const warnings = []
  const run = await runPnpmInProfile(profileDir, ['update', ...names])
  if (run.code !== 0) {
    const text = [
      'pnpm update 失败（exit ' + String(run.code) + '）',
      clip(run.stderr.trim() || run.stdout.trim()),
    ].join('\n')
    return new OperationResult({ ok: false, text })
  }
  let reconciled
  try {
    reconciled = reconcilePlugins(before, profileDir, (packageName) => {
      warnings.push(`注意：${packageName} 未声明 dsh.bundle —— 普通依赖更新，不涉及 profile 层。`)
    })
  } catch (error) {
    return new OperationResult({ ok: false, text: '更新完成但对账失败：' + String(error?.message ?? error) })
  }
  const lines = []
  lines.push('🔄 更新成功：' + names.join(', '))
  if (reconciled.changed) lines.push('层列表已按最新安装状态对账。')
  for (const w of warnings) lines.push(w)
  lines.push('⚠️ 重启 web 后新版本才会生效。')
  return new OperationResult({ ok: true, text: lines.join('\n') })
}

// ---------------------------------------------------------------------------
// 停用/启用 与 快照
// ---------------------------------------------------------------------------

/**
 * 停用/启用：保留依赖，但摘出/放回 dsh.profile.bundles。
 * @param names - 插件名（须是已装依赖且声明 dsh.bundle）。
 * @param enabled - true 启用（放回层栈）；false 停用（摘出层栈）。
 * @returns {ok, text}
 */
export function setPluginsEnabled(profileDir, names, enabled) {
  const manifest = readProfileManifest(profileDir)
  const plugins = bundlesOf(manifest)
  const changed = []
  for (const name of names) {
    const hasDep = Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, name)
    if (!hasDep || !isBundlePackage(name, profileDir)) {
      throw new Error(`${name} 不是已安装的 dsh bundle 依赖，无法停用/启用`)
    }
    const inStack = plugins.includes(name)
    if (enabled && !inStack) {
      plugins.push(name)
      changed.push(name)
    } else if (!enabled && inStack) {
      plugins.splice(plugins.indexOf(name), 1)
      changed.push(name)
    }
  }
  if (changed.length === 0) {
    return new OperationResult({ ok: true, text: `没有变化（目标已处于${enabled ? '启用' : '停用'}状态）。` })
  }
  writeProfileManifest(profileDir, withBundles(manifest, plugins))
  const text = enabled
    ? `✅ 已启用（重新加入 profile 层）：${changed.join(', ')}\n⚠️ 重启 web 后生效。`
    : `⏸️ 已停用（移出 profile 层，依赖保留未卸载）：${changed.join(', ')}\n⚠️ 重启 web 后生效。`
  return new OperationResult({ ok: true, text })
}

/** 运行时环境描述（快照头部展示）。 */
export function environmentInfo(profileName, home) {
  let pnpm = '未找到'
  try {
    pnpm = resolvePnpmCommand().join(' ')
  } catch {
    pnpm = '未找到（可设置 DSHPM_PNPM）'
  }
  return { profile: profileName, home, pnpm }
}

/**
 * 已装插件快照（不跑 pnpm）。
 * @returns {{
 *   installed: Array<{name, spec, enabled, bundle, version}>,
 *   plainDeps: Array<{name, spec, version}>,
 *   builtin: string[],
 *   manifest: object
 * }}
 */
export function snapshot(profileDir) {
  const manifest = readProfileManifest(profileDir)
  const dependencies = manifest.dependencies ?? {}
  const bundles = bundlesOf(manifest)
  const builtin = []
  const installed = []
  const plainDeps = []
  for (const [name, spec] of Object.entries(dependencies)) {
    const dir = findInstalledPackageDir(name, profileDir)
    const installedManifest = dir === null ? null : readInstalledManifest(dir)
    const bundle = isBundlePackage(name, profileDir)
    const version = installedManifest?.version
    const row = {
      name,
      spec: typeof spec === 'string' ? spec : String(spec),
      version: typeof version === 'string' ? version : undefined,
      enabled: bundles.includes(name),
      bundle,
    }
    if (bundle && bundles.includes(name)) installed.push(row)
    else if (bundle) {
      // 已声明 bundle 但被移出层栈（停用中）：仍按插件列出。
      installed.push({ ...row, enabled: false })
    } else plainDeps.push(row)
  }
  // 内置 bundle（官方模板层，不在 dependencies 中）
  for (const name of bundles) {
    if (!installed.some((row) => row.name === name)) {
      const dir = findInstalledPackageDir(name, profileDir)
      const installedManifest = dir === null ? null : readInstalledManifest(dir)
      builtin.push(name + (installedManifest?.version ? '@' + installedManifest.version : ''))
    }
  }
  return { installed, plainDeps, builtin, manifest }
}
