// git-daily-weekly-report —— dsh bundle 的技能植入插件。
//
// dsh 按 `<root>/<name>/SKILL.md` 发现技能，其中用户级根 `$DSH_HOME/skills`
// 被所有 profile 共享。本插件作为 bundle 的一层，在 profile 启动时把包内
// `skills/git-daily-weekly-report` 复制到该根下，于是 `dsh plugin add` 装一次，
// web、desktop 以及之后新建的 profile 都能看到这个技能。
//
// 用“植入 + 版本戳”而不是在 patch 里直接引用包内目录：patch 是静态 YAML，
// 而包的实际安装路径随 profile 变化，只有 apply() 运行时才能确定。
// “目标没有我们的版本戳就拒绝触碰”的约定来自 @ziduup/dsh-programming-mode，
// 用来保护用户手写的同名技能目录，以及仓库内安装脚本建立的目录链接。

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 技能标识：必须与 SKILL.md 的 frontmatter name 以及目录名一致 */
const SKILL_NAME = 'git-daily-weekly-report'

/** 版本戳文件名：标记该目录由本插件植入，据此决定是覆盖还是跳过 */
const STAMP_FILENAME = '.git-daily-weekly-report.planted.json'

/** 本包根目录，用于定位随包分发的 skills/ */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** 随包分发的技能源目录 */
const SOURCE_DIR = join(PACKAGE_DIR, 'skills', SKILL_NAME)

/** cordis 插件名，显示在 loader 日志里 */
export const name = 'git-daily-weekly-report-plant'

/**
 * @brief 计算 dsh 用户级 skill 根目录
 * @param explicit 显式指定的根目录，可为空
 * @return skill 根目录的绝对路径
 * @note 与 dsh 自身的回退规则保持一致：优先 $DSH_HOME，其次 ~/.dsh
 */
function resolveSkillRoot(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim())
  const envHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(resolve(envHome), 'skills')
}

/**
 * @brief 读取本包版本，作为植入内容的版本标记
 * @return 版本字符串，读取失败时回退为 0.0.0
 */
function readOwnVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
    return String(manifest.version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

/**
 * @brief 读取目标目录里的版本戳
 * @param targetDir 已植入的技能目录
 * @return 版本戳对象，缺失或格式不符时返回 null
 * @note 返回 null 表示该目录不是本插件植入的，调用方必须跳过
 */
function readStamp(targetDir) {
  try {
    const stamp = JSON.parse(readFileSync(join(targetDir, STAMP_FILENAME), 'utf8'))
    return typeof stamp?.version === 'string' ? stamp : null
  } catch {
    return null
  }
}

/**
 * @brief 写入版本戳，记录植入来源、版本与时间
 * @param targetDir 已植入的技能目录
 * @param version 本次植入的包版本
 */
function writeStamp(targetDir, version) {
  const stamp = { version, source: 'git-daily-weekly-report', plantedAt: new Date().toISOString() }
  writeFileSync(join(targetDir, STAMP_FILENAME), JSON.stringify(stamp, null, 2) + '\n')
}

/**
 * @brief 把随包技能植入用户级 skill 根
 * @param options 可选覆盖项：sourceDir（技能源目录）、targetRoot（skill 根）、version（版本号）
 * @return 结果对象，action 取值 planted / updated / unchanged / skipped / error
 * @note 目标已存在但没有本插件的版本戳时一律跳过，不覆盖用户手写目录或仓库内
 *       安装脚本建立的目录链接；升级时用 force 覆盖同名文件，但不会删除目标里
 *       多出的旧文件（避免误删用户放进该目录的内容）
 */
export function plantSkill(options = {}) {
  const sourceDir = resolve(options.sourceDir ?? SOURCE_DIR)
  const version = String(options.version ?? readOwnVersion())
  const targetRoot = resolveSkillRoot(options.targetRoot)
  const targetDir = join(targetRoot, SKILL_NAME)

  if (!existsSync(sourceDir)) {
    return { action: 'error', reason: `随包技能目录不存在：${sourceDir}`, targetDir }
  }

  if (!existsSync(targetDir)) {
    mkdirSync(targetRoot, { recursive: true })
    cpSync(sourceDir, targetDir, { recursive: true })
    writeStamp(targetDir, version)
    return { action: 'planted', version, targetDir }
  }

  const stamped = readStamp(targetDir)
  if (stamped === null) {
    return {
      action: 'skipped',
      reason: `${targetDir} 已存在且没有本插件的版本戳，未做任何修改`,
      targetDir,
    }
  }

  if (stamped.version !== version) {
    cpSync(sourceDir, targetDir, { recursive: true, force: true })
    writeStamp(targetDir, version)
    return { action: 'updated', from: stamped.version, to: version, version, targetDir }
  }

  return { action: 'unchanged', version, targetDir }
}

/**
 * @brief cordis 插件入口：profile 启动时植入技能
 * @note 不需要 cordis 上下文：本插件只按 $DSH_HOME 约定写文件，不注册任何服务。
 *       所有异常都在这里吞掉——插件不能让宿主的 profile 启动失败。
 */
export function apply() {
  try {
    const result = plantSkill()
    const detail = result.reason
      ?? (result.action === 'updated' ? `${result.from} -> ${result.to}` : result.version ?? '')
    console.log(`[git-daily-weekly-report] ${result.action}${detail ? `：${detail}` : ''}`)
  } catch (error) {
    console.log(`[git-daily-weekly-report] 植入技能失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
