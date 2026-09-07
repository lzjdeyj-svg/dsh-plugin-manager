// dsh-plugin-manager 宿主 half（loader 行插件）。
//
// 契约（官方 bundle 插件）：index.mjs 导出 { name, inject, apply }（同时给 default）。
// apply(ctx, config) 在 host ctx 上执行：
//   1) ctx.inject(['settings'], …) 等待宿主 settings 服务（dsh-settings-file 提供方）；
//   2) 注册自己的 settings 命名空间 `plugin-manager` —— 客户端「插件管理」页经官方
//      settingsScope 通道读写同一份文档，形成“命令 + 状态”信箱；
//   3) 监听文档变化：发现新 pending 命令 → 在 profile 目录执行 pnpm（add/remove/update）
//      或直接编辑 manifest（停用/启用）→ 回写 busy/result/installed 字段。
//
// 不做任何私有 RPC / Typert 注册 —— 全部走通用 settings 域，跨版本稳定、可分发。

import z from '@deepseek-ai/schemastery'

import {
  addPlugins, clip, environmentInfo, parseInstallText,
  removePlugins, resolveDshHome, resolveProfileDir, setPluginsEnabled, snapshot,
  updatePlugins,
} from '../lib/pm-core.mjs'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-plugin-manager'
export const inject = ['settings']

const NS = 'plugin-manager'
const OP_LIMIT = 12 * 60 * 1000 // 单次操作超时 12 分钟（git 安装可能较慢）

// settings 文档结构：字段尽量扁平、全部可选，降低跨端 schema 重建风险。
//   busy        bool    是否正在执行
//   pending     {op,arg,at}   待执行命令（op: add/remove/update/on/off/refresh；arg 原始输入）
//   result      string  最近一次操作结果文本
//   installed   string  最近一次插件快照的 JSON（{installed, plainDeps, builtin, profile, home, pnpm}）
const PmSchema = z.object({
  busy: z.boolean().required(false),
  pending: z.object({
    op: z.string(),
    arg: z.string().required(false),
    at: z.number(),
  }).required(false),
  result: z.string().required(false),
  installed: z.string().required(false),
})

/** 从本模块真实路径反推 <home>/profiles/<name>/node_modules 布局（链接安装不可用时兜底）。 */
function deriveContextFromModuleUrl() {
  const url = fileURLToPath(import.meta.url)
  const parts = normalize(url).split(sep)
  const idx = parts.lastIndexOf('profiles')
  if (idx !== -1 && idx + 2 < parts.length) {
    return { home: parts.slice(0, idx).join(sep), profile: parts[idx + 1] }
  }
  return null
}

function pickProfile(config) {
  const fromConfig = config?.profile
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim()
  const fromEnv = process.env.DSH_PROFILE
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  return 'web'
}

function pickHome(config, derived) {
  const fromConfig = config?.home
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim()
  return resolveDshHome(derived?.home)
}

function log(line) {
  try {
    process.stderr.write(`[plugin-manager] ${line}\n`)
  } catch {
    // 忽略日志失败
  }
}

/**
 * 执行一条 pending 命令，返回 {ok, text}。全部操作在 profile 目录上发生。
 * @param op - add/remove/update/on/off/refresh
 * @param arg - 原始用户输入（命令或插件名）。
 */
async function executeOp(profileDir, op, arg) {
  const text = String(arg ?? '').trim()
  if (op === 'refresh') {
    const view = snapshot(profileDir)
    return { ok: true, text: '已刷新', installed: view }
  }
  if (op === 'add') {
    // 兼容粘贴整行 dsh plugin 命令；裸 spec 默认 add；README 占位 <本项目路径> + 链接自动替换。
    let parsed
    try {
      parsed = parseInstallText(text)
    } catch (error) {
      return { ok: false, text: '无法解析安装目标：' + String(error?.message ?? error) }
    }
    if (parsed.verb !== 'add') {
      return { ok: false, text: '粘贴的是 ' + parsed.verb + ' 命令，请使用对应操作按钮。' }
    }
    if (parsed.profile !== undefined && parsed.profile !== profileDir.split(sep).pop()) {
      return { ok: false, text: `该命令针对 profile ${parsed.profile}，本面板管理的是 ${profileDir.split(sep).pop()}。如需管理其它 profile，请在对应 profile 里也装上 dsh-plugin-manager。` }
    }
    const result = await addPlugins(profileDir, parsed.targets)
    return { ok: result.ok, text: result.text }
  }
  if (op === 'remove' || op === 'update') {
    const names = text.split(/\s+/).filter(Boolean)
    if (names.length === 0) return { ok: false, text: '缺少插件名。' }
    const result = op === 'remove'
      ? await removePlugins(profileDir, names)
      : await updatePlugins(profileDir, names)
    return { ok: result.ok, text: result.text }
  }
  if (op === 'on' || op === 'off') {
    const names = text.split(/\s+/).filter(Boolean)
    if (names.length === 0) return { ok: false, text: '缺少插件名。' }
    try {
      const result = setPluginsEnabled(profileDir, names, op === 'on')
      return { ok: result.ok, text: result.text }
    } catch (error) {
      return { ok: false, text: String(error?.message ?? error) }
    }
  }
  return { ok: false, text: '未知操作：' + op }
}

function installedPayload(profileDir, profileName) {
  try {
    const view = snapshot(profileDir)
    const env = environmentInfo(profileName, resolveDshHome())
    return JSON.stringify({ ...view, profile: profileName, home: env.home, pnpm: env.pnpm })
  } catch (error) {
    return JSON.stringify({ error: String(error?.message ?? error), profile: profileName })
  }
}

async function apply(ctx, config) {
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    const derived = deriveContextFromModuleUrl()
    const profileName = pickProfile(config)
    const home = pickHome(config, derived)
    const profileDir = resolveProfileDir(profileName, home)
    let scope
    try {
      scope = settings.register(NS, PmSchema)
    } catch (error) {
      log('settings.register 失败：' + String(error?.message ?? error))
      return
    }

    // 处理中状态（串行、幂等）。
    let busy = false
    let lastHandledAt = 0

    const settle = async (pending, ok, message, extraInstalled) => {
      try {
        const payload = {
          busy: false,
          pending: undefined,
          result: JSON.stringify({ ok, text: message, at: Date.now() }),
          installed: extraInstalled ?? installedPayload(profileDir, profileName),
        }
        // 用 replace 一次清空命令并写回结果，避免残留。
        await scope.replace(payload)
      } catch (error) {
        log('回写结果失败：' + String(error?.message ?? error))
      }
    }

    const pump = async () => {
      if (busy) return
      let pending
      try {
        pending = scope.get()?.pending
      } catch {
        pending = undefined
      }
      if (pending === undefined || pending === null || typeof pending !== 'object') return
      if (typeof pending.at === 'number' && pending.at <= lastHandledAt) return
      const op = typeof pending.op === 'string' ? pending.op : ''
      const arg = typeof pending.arg === 'string' ? pending.arg : ''
      if (op === '') return
      busy = true
      lastHandledAt = typeof pending.at === 'number' ? pending.at : Date.now()
      try {
        await scope.update({ busy: true })
      } catch (error) {
        log('写入 busy 失败：' + String(error?.message ?? error))
      }
      log(`执行 ${op} ${arg.slice(0, 120)}`)
      let outcome
      try {
        outcome = await Promise.race([
          executeOp(profileDir, op, arg),
          new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('操作超时（' + OP_LIMIT + 'ms），请查看 pnpm 输出或重试')), OP_LIMIT)
            timer.unref?.()
          }),
        ])
      } catch (error) {
        outcome = { ok: false, text: String(error?.message ?? error) }
      }
      // 若 add/remove/update 成功，附上最新快照；refresh 自带快照。
      const payload = outcome.installed !== undefined ? outcome.installed : undefined
      if (op === 'refresh') {
        await settle(undefined, outcome.ok, '已刷新列表', payload)
      } else {
        await settle(pending, outcome.ok, outcome.text, payload)
      }
      log('完成 ' + op + ' → ' + (outcome.ok ? 'ok' : 'fail'))
    }

    // 任何文档变化都尝试泵一次（含并发窗口里我方写入触发的空转）。
    scope.watch(() => {
      void pump()
    })

    // 启动：处理上次中断的命令（pending 残留且非 busy），然后刷新快照。
    void (async () => {
      try {
        const current = scope.get()
        if (current?.pending && current.busy === true) {
          // 上次执行中被重启打断：清掉并提示重启。
          await scope.replace({
            busy: false,
            pending: undefined,
            result: JSON.stringify({ ok: false, text: '上一次操作在重启前未完成，已取消。请重新发起。', at: Date.now() }),
            installed: installedPayload(profileDir, profileName),
          })
        } else {
          await scope.replace({
            busy: false,
            pending: undefined,
            result: current?.result ?? undefined,
            installed: installedPayload(profileDir, profileName),
          })
        }
      } catch (error) {
        log('启动初始化失败：' + String(error?.message ?? error))
      }
    })()
  })
}

export default { name, inject, apply }
