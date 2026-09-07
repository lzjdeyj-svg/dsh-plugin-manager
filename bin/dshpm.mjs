#!/usr/bin/env node
// dshpm —— dsh 插件管理 CLI（dsh-plugin-manager 附带的命令行引擎）。
//
// 用法：
//   dshpm ls [--profile <name>]                     列出已装插件
//   dshpm add <spec...> [--profile <name>]          安装（支持 github:owner/repo#分支 / owner/repo#分支 / npm 包名）
//   dshpm rm  <name...> [--profile <name>]          卸载
//   dshpm up  <name...> [--profile <name>]          更新
//   dshpm on  <name...> [--profile <name>]          启用（放回 profile 层）
//   dshpm off <name...> [--profile <name>]          停用（移出 profile 层，依赖保留）
//
// 默认 profile：$DSH_PROFILE，否则 web。家目录：$DSH_HOME，否则 ~/.dsh。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addPlugins, checkProfile, environmentInfo, parseInstallText, readProfileManifest,
  removePlugins, resolveDshHome, resolveProfileDir, setPluginsEnabled, snapshot,
  updatePlugins,
} from '../lib/pm-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))

function usage() {
  process.stdout.write(`dshpm ${PKG.version} —— dsh 插件管理（bundle 插件命令行引擎）\n\n` +
    '用法：\n' +
    '  dshpm ls [--profile <p>]\n' +
    '  dshpm check [--profile <p>]\n' +
    '  dshpm add <spec...> [--profile <p>]\n' +
    '  dshpm rm|remove <name...> [--profile <p>]\n' +
    '  dshpm up|update <name...> [--profile <p>]\n' +
    '  dshpm on <name...> [--profile <p>]\n' +
    '  dshpm off <name...> [--profile <p>]\n\n' +
    '默认 profile：$DSH_PROFILE 或 web；家目录：$DSH_HOME 或 ~/.dsh\n' +
    'pnpm 解析顺序：$DSHPM_PNPM > PATH pnpm > corepack pnpm\n')
}

async function main(argv) {
  const args = [...argv]
  const profileFlagIndex = args.indexOf('--profile')
  let profile
  if (profileFlagIndex !== -1) {
    profile = args[profileFlagIndex + 1]
    if (profile === undefined) {
      process.stderr.write('dshpm: --profile 需要一个值\n')
      process.exit(2)
    }
    args.splice(profileFlagIndex, 2)
  }
  profile = profile ?? process.env.DSH_PROFILE ?? 'web'

  const home = resolveDshHome()
  const profileDir = resolveProfileDir(profile, home)

  try {
    let verb = args[0]
    let targets = args.slice(1)

    // 兼容：把整行 `dsh plugin ...` 命令（含 README 占位 <本项目路径> + 链接）当作参数粘贴。
    if (verb !== undefined && /^dsh\s+plugin\b/i.test(verb) && args.length === 1) {
      let parsed
      try {
        parsed = parseInstallText(verb)
      } catch (error) {
        process.stderr.write('dshpm: ' + String(error?.message ?? error) + '\n')
        process.exit(2)
      }
      if (parsed.profile !== undefined && parsed.profile !== profile) {
        process.stderr.write(`dshpm: 该命令针对 profile ${parsed.profile}，当前管理的是 ${profile}；请用 --profile ${parsed.profile} 重试。\n`)
        process.exit(2)
      }
      verb = parsed.verb
      targets = parsed.targets
    }

    if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
      usage()
      process.exit(verb === undefined && args.length === 0 ? 2 : 0)
    }

    const env = environmentInfo(profile, home)

    switch (verb) {
      case 'ls':
      case 'list': {
        const view = snapshot(profileDir)
        const line = []
        line.push(`profile: ${profile}  目录: ${profileDir}`)
        line.push(`pnpm: ${env.pnpm}`)
        line.push('')
        if (view.installed.length === 0) {
          line.push('（profile 层插件为空）')
        } else {
          line.push('已装插件：')
          for (const row of view.installed) {
            const state = row.enabled ? '启用' : '停用'
            const version = row.version !== undefined ? `@${row.version}` : ''
            line.push(`  • ${row.name}${version}  [${state}]  ← ${row.spec}`)
          }
        }
        if (view.plainDeps.length > 0) {
          line.push('')
          line.push('普通依赖（非插件）：')
          for (const row of view.plainDeps) {
            line.push(`  • ${row.name}  ← ${row.spec}`)
          }
        }
        if (view.builtin.length > 0) {
          line.push('')
          line.push('内置层（官方，不在依赖里）：')
          for (const name of view.builtin) line.push(`  • ${name}`)
        }
        process.stdout.write(line.join('\n') + '\n')
        process.exit(0)
        break
      }
      case 'add':
      case 'install': {
        if (targets.length === 0) {
          process.stderr.write('dshpm: add 需要至少一个 spec（支持 github:owner/repo#分支、owner/repo、https://github.com/owner/repo、npm 包名）\n')
          process.exit(2)
        }
        // 每个参数都支持 GitHub 链接 / owner/repo 简写 / README 占位 <…>+链接 自动归一化。
        const specs = targets.map((target) => {
          try {
            return parseInstallText(target).targets.join(' ')
          } catch {
            return target
          }
        }).filter((spec) => spec !== '')
        const result = await addPlugins(profileDir, specs.length > 0 ? specs : targets)
        process.stdout.write(result.text + '\n')
        process.exit(result.ok ? 0 : 1)
        break
      }
      case 'rm':
      case 'remove':
      case 'uninstall': {
        if (targets.length === 0) {
          process.stderr.write('dshpm: rm 需要插件名\n')
          process.exit(2)
        }
        const result = await removePlugins(profileDir, targets)
        process.stdout.write(result.text + '\n')
        process.exit(result.ok ? 0 : 1)
        break
      }
      case 'up':
      case 'update': {
        if (targets.length === 0) {
          process.stderr.write('dshpm: up 需要插件名\n')
          process.exit(2)
        }
        const result = await updatePlugins(profileDir, targets)
        process.stdout.write(result.text + '\n')
        process.exit(result.ok ? 0 : 1)
        break
      }
      case 'check': {
        const result = await checkProfile(profile, home)
        for (const issue of result.issues) {
          const marker = issue.level === 'error' ? '✖' : '✔'
          process.stdout.write(`${marker} ${issue.message}\n`)
        }
        process.stdout.write(`结果：${result.summary}\n`)
        process.exit(result.ok ? 0 : 1)
        break
      }
      case 'on':
      case 'enable': {
        if (targets.length === 0) {
          process.stderr.write('dshpm: on 需要插件名\n')
          process.exit(2)
        }
        const result = setPluginsEnabled(profileDir, targets, true)
        process.stdout.write(result.text + '\n')
        process.exit(result.ok ? 0 : 1)
        break
      }
      case 'off':
      case 'disable': {
        if (targets.length === 0) {
          process.stderr.write('dshpm: off 需要插件名\n')
          process.exit(2)
        }
        const result = setPluginsEnabled(profileDir, targets, false)
        process.stdout.write(result.text + '\n')
        process.exit(result.ok ? 0 : 1)
        break
      }
      default: {
        process.stderr.write(`dshpm: 未知命令 ${JSON.stringify(verb)}\n`)
        usage()
        process.exit(2)
      }
    }
  } catch (error) {
    process.stderr.write('dshpm: ' + String(error?.message ?? error) + '\n')
    process.exit(1)
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write('dshpm: ' + String(error?.message ?? error) + '\n')
  process.exit(1)
})
