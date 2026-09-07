import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  allowBuilds, extractGitHubUrl, ignoredBuildScriptPackages, isBundlePackage,
  isPlaceholderTarget, normalizeSpec, parseInstallText, parsePastedCommand,
  readProfileManifest, reconcilePlugins, setPluginsEnabled, snapshot,
  writeProfileManifest,
} from '../lib/pm-core.mjs'

function makeProfile(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return dir
}

function stubBundle(name, version = '1.0.0', extra = {}) {
  const pkg = JSON.stringify({
    name,
    version,
    ...extra,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)
  return { [`node_modules/${name}/package.json`]: pkg }
}

const BASE_MANIFEST = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: [] } },
}

test('normalizeSpec: github 简写补全', () => {
  assert.deepEqual(normalizeSpec('Ayase34/gal-view'), { kind: 'github', spec: 'github:Ayase34/gal-view', display: 'github:Ayase34/gal-view' })
  assert.deepEqual(normalizeSpec('Ayase34/gal-view#main'), { kind: 'github', spec: 'github:Ayase34/gal-view#main', display: 'github:Ayase34/gal-view#main' })
  assert.deepEqual(normalizeSpec('github:Ayase34/gal-view#main'), { kind: 'github', spec: 'github:Ayase34/gal-view#main', display: 'github:Ayase34/gal-view#main' })
  assert.deepEqual(normalizeSpec('@scope/pkg'), { kind: 'other', spec: '@scope/pkg', display: '@scope/pkg' })
  assert.deepEqual(normalizeSpec('some-lib@^2'), { kind: 'other', spec: 'some-lib@^2', display: 'some-lib@^2' })
})

test('normalizeSpec: GitHub 链接识别', () => {
  assert.deepEqual(normalizeSpec('https://github.com/Mungbean-Cake/dsh-plugin-whale-fenggu'), { kind: 'github', spec: 'github:Mungbean-Cake/dsh-plugin-whale-fenggu', display: 'github:Mungbean-Cake/dsh-plugin-whale-fenggu' })
  assert.deepEqual(normalizeSpec('https://github.com/Mungbean-Cake/dsh-plugin-whale-fenggu.git'), { kind: 'github', spec: 'github:Mungbean-Cake/dsh-plugin-whale-fenggu', display: 'github:Mungbean-Cake/dsh-plugin-whale-fenggu' })
  assert.deepEqual(normalizeSpec('https://github.com/Mungbean-Cake/dsh-plugin-whale-fenggu/tree/main'), { kind: 'github', spec: 'github:Mungbean-Cake/dsh-plugin-whale-fenggu#main', display: 'github:Mungbean-Cake/dsh-plugin-whale-fenggu#main' })
  // 一般 https 资源（非 github）不误判
  assert.equal(normalizeSpec('https://registry.npmjs.org/foo').kind, 'other')
  assert.equal(normalizeSpec('https://example.com/a/b').kind, 'other')
})

test('extractGitHubUrl: 从文本提取仓库链接', () => {
  assert.equal(extractGitHubUrl('安装见 https://github.com/Ayase34/gal-view 说明'), 'https://github.com/Ayase34/gal-view')
  assert.equal(extractGitHubUrl('无链接文本'), null)
})

test('isPlaceholderTarget 与 parseInstallText：README 占位自动替换', () => {
  assert.equal(isPlaceholderTarget('<本项目路径>'), true)
  assert.equal(isPlaceholderTarget('/real/path'), false)
  // 整行命令 + 占位 + 同段 GitHub 链接 → 自动用链接
  const parsed = parseInstallText('dsh plugin --profile web add <本项目路径>\n项目地址 https://github.com/Mungbean-Cake/dsh-plugin-whale-fenggu')
  assert.deepEqual(parsed, { verb: 'add', profile: 'web', targets: ['github:Mungbean-Cake/dsh-plugin-whale-fenggu'] })
  // 占位但无链接 → 抛错提示
  assert.throws(() => parseInstallText('dsh plugin add <本项目路径>'), /占位|链接/)
  // 正常命令不变
  const parsed2 = parseInstallText('dsh plugin --profile web add github:Ayase34/gal-view#main')
  assert.deepEqual(parsed2, { verb: 'add', profile: 'web', targets: ['github:Ayase34/gal-view#main'] })
  // 裸链接默认 add
  const parsed3 = parseInstallText('https://github.com/Mungbean-Cake/dsh-plugin-whale-fenggu')
  assert.deepEqual(parsed3, { verb: 'add', targets: ['github:Mungbean-Cake/dsh-plugin-whale-fenggu'] })
})

test('parsePastedCommand: 整行 dsh plugin 命令', () => {
  const parsed = parsePastedCommand('dsh plugin --profile web add github:Ayase34/gal-view#main')
  assert.deepEqual(parsed, { verb: 'add', profile: 'web', targets: ['github:Ayase34/gal-view#main'] })
  const parsed2 = parsePastedCommand('dsh plugin remove gal-view')
  assert.deepEqual(parsed2, { verb: 'remove', profile: undefined, targets: ['gal-view'] })
  const parsed3 = parsePastedCommand('github:Ayase34/gal-view#main')
  assert.deepEqual(parsed3, { verb: 'add', targets: ['github:Ayase34/gal-view#main'] })
  assert.throws(() => parsePastedCommand(''), /空/)
})

test('isBundlePackage 与 reconcilePlugins：新增 bundle 依赖进层栈', () => {
  const dir = makeProfile({ ...stubBundle('gal-view') })
  writeProfileManifest(dir, BASE_MANIFEST)
  const before = readProfileManifest(dir)
  // 模拟 pnpm add 之后：依赖多了 gal-view
  writeProfileManifest(dir, {
    ...BASE_MANIFEST,
    dependencies: { 'gal-view': 'github:Ayase34/gal-view#main' },
  })
  assert.equal(isBundlePackage('gal-view', dir), true)
  const result = reconcilePlugins(before, dir)
  assert.equal(result.changed, true)
  assert.deepEqual(result.manifest.dsh.profile.bundles, ['gal-view'])
  rmSync(dir, { recursive: true, force: true })
})

test('reconcilePlugins：卸载后移出层栈；普通依赖告警', () => {
  const dir = makeProfile({ ...stubBundle('gal-view') })
  writeProfileManifest(dir, {
    ...BASE_MANIFEST,
    dependencies: { 'gal-view': 'github:Ayase34/gal-view#main', 'plain-lib': '^1.0.0' },
    dsh: { profile: { bundles: ['gal-view'] } },
  })
  const warnings = []
  const before = readProfileManifest(dir)
  // 模拟 pnpm remove gal-view 之后
  writeProfileManifest(dir, {
    ...BASE_MANIFEST,
    dependencies: { 'plain-lib': '^1.0.0' },
    dsh: { profile: { bundles: ['gal-view'] } },
  })
  const result = reconcilePlugins(before, dir, (name) => warnings.push(name))
  assert.equal(result.changed, true)
  assert.deepEqual(result.manifest.dsh.profile.bundles, [])
  rmSync(dir, { recursive: true, force: true })
})

test('setPluginsEnabled：停用=移出层栈保留依赖，启用=放回', () => {
  const dir = makeProfile({ ...stubBundle('gal-view') })
  writeProfileManifest(dir, {
    ...BASE_MANIFEST,
    dependencies: { 'gal-view': 'github:Ayase34/gal-view#main' },
    dsh: { profile: { bundles: ['gal-view'] } },
  })
  const off = setPluginsEnabled(dir, ['gal-view'], false)
  assert.equal(off.ok, true)
  assert.deepEqual(readProfileManifest(dir).dsh.profile.bundles, [])
  const on = setPluginsEnabled(dir, ['gal-view'], true)
  assert.equal(on.ok, true)
  assert.deepEqual(readProfileManifest(dir).dsh.profile.bundles, ['gal-view'])
  assert.throws(() => setPluginsEnabled(dir, ['not-installed'], false), /不是已安装/)
  rmSync(dir, { recursive: true, force: true })
})

test('allowBuilds：写入 pnpm.onlyBuiltDependencies 幂等', () => {
  const dir = makeProfile({})
  writeProfileManifest(dir, BASE_MANIFEST)
  const added = allowBuilds(dir, ['gal-view', 'esbuild'])
  assert.deepEqual(added, ['gal-view', 'esbuild'])
  const added2 = allowBuilds(dir, ['gal-view'])
  assert.deepEqual(added2, [])
  const manifest = readProfileManifest(dir)
  assert.deepEqual(manifest.pnpm.onlyBuiltDependencies, ['gal-view', 'esbuild'])
  rmSync(dir, { recursive: true, force: true })
})

test('ignoredBuildScriptPackages 解析 pnpm 输出', () => {
  const stderr = [
    'Progress: resolved 42, reused 32, downloaded 5, added 5',
    'Ignored build scripts: gal-view. Run "pnpm approve-builds" to pick which dependencies should be allowed to build.',
  ].join('\n')
  assert.deepEqual(ignoredBuildScriptPackages(stderr, ['gal-view']), ['gal-view'])
  assert.deepEqual(ignoredBuildScriptPackages('nothing here', ['gal-view']), [])
})

test('snapshot：列出已装插件/来源/启用状态', () => {
  const dir = makeProfile({ ...stubBundle('gal-view') })
  writeProfileManifest(dir, {
    ...BASE_MANIFEST,
    dependencies: { 'gal-view': 'github:Ayase34/gal-view#main', 'plain-lib': '^1.0.0' },
    dsh: { profile: { bundles: ['gal-view'] } },
  })
  const view = snapshot(dir)
  assert.equal(view.installed.length, 1)
  assert.equal(view.installed[0].name, 'gal-view')
  assert.equal(view.installed[0].enabled, true)
  assert.equal(view.installed[0].spec, 'github:Ayase34/gal-view#main')
  assert.equal(view.plainDeps[0].name, 'plain-lib')
  // 停用后再快照：仍在列表但 enabled=false
  setPluginsEnabled(dir, ['gal-view'], false)
  const view2 = snapshot(dir)
  assert.equal(view2.installed[0].enabled, false)
  rmSync(dir, { recursive: true, force: true })
})

test('writeProfileManifest 输出 2 空格缩进 JSON', () => {
  const dir = makeProfile({})
  writeProfileManifest(dir, { name: 'x' })
  const raw = readFileSync(join(dir, 'package.json'), 'utf8')
  assert.equal(raw, '{\n  "name": "x"\n}\n')
  rmSync(dir, { recursive: true, force: true })
})
