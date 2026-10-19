// dsh/report-summary.js —— dsh 端「报告总结」设置项的配置模型与技能注入渲染。
//
// 职责边界：本模块只做纯逻辑——配置读写、校验规范化、从技能文件读默认值、
// 把配置渲染成一段要插进技能正文的文本。它不接触 cordis、不接触 dsh 的
// 技能注册表、不注册任何服务，因此可以脱离 dsh 单独 require 做自测。
//
// 一条硬约束：技能默认值一律从 skills/ 下的文件**现读**，本文件不保存任何
// 规则文本副本，避免与 SKILL.md、references/report-style.md 漂移。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 配置文件名，落在 <dsh home>/git-daily-weekly-report/ 下 */
export const CONFIG_FILENAME = 'report-summary.json'

/** 配置结构版本号，供将来做结构迁移 */
export const SCHEMA_VERSION = 1

/** 单个文本字段的长度上限 */
export const MAX_TEXT_CHARS = 20000

/** 条数区间的上下界，防止配置成离谱的数值 */
const MIN_ITEMS = 1
const MAX_ITEMS = 20

/** 注入段里固定不变的约束文案：不随配置变化，也不允许被配置覆盖 */
const FACT_BASELINE = [
  '事实底线：无论本节与用户偏好记忆如何设置，都只依据真实提交说明与文件变更作答，',
  '不得编造、不得臆测未发生的工作；证据不足时按兜底规则处理。',
].join('\n')

/**
 * @brief 构造一份全为“沿用默认”的空配置
 * @return 默认配置对象
 * @note null 表示该字段不参与注入，模型继续按技能文件里的默认规则执行
 */
export function createDefaultConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    output: {
      dailyTitle: null,
      weeklyTitle: null,
      numberingStyle: null,
      numberingContinuous: null,
      blankLineBetweenItems: null,
    },
    writing: {
      rules: null,
      dailyMin: null,
      dailyMax: null,
      weeklyMin: null,
      weeklyMax: null,
      verbFirst: null,
    },
    style: {
      rules: null,
      samples: null,
    },
    fallback: {
      strategy: null,
    },
    extraPrompt: null,
  }
}

/**
 * @brief 把任意输入值收窄为可用的配置值
 * @param value 原始值
 * @param kind 期望类型：'text' | 'bool' | 'count'
 * @param warnings 收集被降级字段名的数组
 * @param label 字段名，用于生成提示
 * @return 收窄后的值；不合法时返回 null（即沿用默认）
 * @note 类型不符不抛错，降级为“沿用默认”并记入 warnings，保证面板不会被脏数据卡死
 */
function coerceValue(value, kind, warnings, label) {
  if (value === null || value === undefined) return null

  if (kind === 'text') {
    if (typeof value !== 'string') {
      warnings.push(`${label} 不是文本，已视为沿用默认`)
      return null
    }
    const trimmed = value.length > MAX_TEXT_CHARS ? value.slice(0, MAX_TEXT_CHARS) : value
    if (trimmed.length !== value.length) warnings.push(`${label} 超过 ${MAX_TEXT_CHARS} 字符，已截断`)
    // 全空白等价于没填，统一收敛成 null，避免生成空小节
    return trimmed.trim() === '' ? null : trimmed
  }

  if (kind === 'bool') {
    if (typeof value !== 'boolean') {
      warnings.push(`${label} 不是布尔值，已视为沿用默认`)
      return null
    }
    return value
  }

  if (kind === 'count') {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(num) || num < MIN_ITEMS || num > MAX_ITEMS) {
      warnings.push(`${label} 需为 ${MIN_ITEMS}~${MAX_ITEMS} 的整数，已视为沿用默认`)
      return null
    }
    return num
  }

  return null
}

/**
 * @brief 校验并规范化一份配置
 * @param raw 从磁盘读到或从 HTTP 收到的原始对象
 * @return { config, warnings } —— config 总是完整形状
 * @note 未知键直接忽略（向前兼容）；条数区间倒挂视为非法并整对回退
 */
export function normalizeConfig(raw) {
  const config = createDefaultConfig()
  const warnings = []

  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== null && raw !== undefined) warnings.push('配置不是对象，已整体回退为默认')
    return { config, warnings }
  }

  const pick = (group, key, kind, label) => {
    const source = raw[group]
    if (source === null || source === undefined || typeof source !== 'object') return
    return coerceValue(source[key], kind, warnings, label)
  }

  config.output.dailyTitle = pick('output', 'dailyTitle', 'text', '日报标题')
  config.output.weeklyTitle = pick('output', 'weeklyTitle', 'text', '周报标题')
  config.output.numberingStyle = pick('output', 'numberingStyle', 'text', '序号格式')
  config.output.numberingContinuous = pick('output', 'numberingContinuous', 'bool', '序号连续')
  config.output.blankLineBetweenItems = pick('output', 'blankLineBetweenItems', 'bool', '条间空行')

  config.writing.rules = pick('writing', 'rules', 'text', '写作规则')
  config.writing.dailyMin = pick('writing', 'dailyMin', 'count', '日报条数下限')
  config.writing.dailyMax = pick('writing', 'dailyMax', 'count', '日报条数上限')
  config.writing.weeklyMin = pick('writing', 'weeklyMin', 'count', '周报条数下限')
  config.writing.weeklyMax = pick('writing', 'weeklyMax', 'count', '周报条数上限')
  config.writing.verbFirst = pick('writing', 'verbFirst', 'bool', '动词开头')

  config.style.rules = pick('style', 'rules', 'text', '风格规则')
  config.style.samples = pick('style', 'samples', 'text', '样例库')

  config.fallback.strategy = pick('fallback', 'strategy', 'text', '无提交兜底策略')

  config.extraPrompt = coerceValue(raw.extraPrompt, 'text', warnings, '额外提示词要求')

  // 区间倒挂时整对回退：单边保留另一边的默认值，会让条数约束变得语义混乱
  const fixPair = (minKey, maxKey, label) => {
    const min = config.writing[minKey]
    const max = config.writing[maxKey]
    if (min !== null && max !== null && min > max) {
      warnings.push(`${label}条数下限大于上限，已整对沿用默认`)
      config.writing[minKey] = null
      config.writing[maxKey] = null
    }
  }
  fixPair('dailyMin', 'dailyMax', '日报')
  fixPair('weeklyMin', 'weeklyMax', '周报')

  config.schemaVersion = SCHEMA_VERSION
  return { config, warnings }
}

/**
 * @brief 判断配置里是否有任何一项真正参与注入
 * @param config 已规范化的配置
 * @return 有任何非 null 字段时返回 true
 * @note 全空时不需要注入段，技能正文与磁盘内容等价
 */
export function hasAnyValue(config) {
  const groups = [config.output, config.writing, config.style, config.fallback]
  for (const group of groups) {
    for (const value of Object.values(group)) {
      if (value !== null) return true
    }
  }
  return config.extraPrompt !== null
}

/**
 * @brief 从 SKILL.md 原文里切出 frontmatter 与正文
 * @param raw SKILL.md 全文
 * @return { description, body } —— 没有 frontmatter 时 description 为空串、body 为全文
 */
export function parseFrontmatter(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { description: '', body: text.trim() }

  const descriptionLine = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('description:'))

  // description 可能是单行纯文本，也可能带引号；只取第一行，够用即可
  const description = descriptionLine === undefined
    ? ''
    : descriptionLine.slice('description:'.length).trim().replace(/^["']|["']$/g, '')

  return { description, body: text.slice(match[0].length).trim() }
}

/**
 * @brief 按二级标题切出一节正文
 * @param markdown 目标 Markdown 全文
 * @param heading 二级标题文字（不含 ## 与空格）
 * @return 该节正文（已去掉首尾空行），找不到时返回 null
 */
function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`)
  if (start < 0) return null

  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break
    body.push(lines[index])
  }
  const text = body.join('\n').trim()
  return text === '' ? null : text
}

/**
 * @brief 从写作规则里提取条数区间
 * @param text 「写作规则」小节正文
 * @param label '日报' 或 '周报'
 * @return { min, max }，解析不出时返回 null
 * @note 兼容“2 至 4 条”“2~4 条”“2-4 条”这几种写法
 */
function parseCountRange(text, label) {
  if (typeof text !== 'string') return null
  const pattern = new RegExp(`${label}[^。；\\n]*?(\\d+)\\s*(?:至|到|~|～|-|—)\\s*(\\d+)\\s*条`)
  const match = pattern.exec(text)
  if (match === null) return null

  const min = Number(match[1])
  const max = Number(match[2])
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) return null
  return { min, max }
}

/**
 * @brief 从输出要求小节里提取标题、序号格式与排版开关
 * @param section 「输出要求」小节正文
 * @return 部分填好的 output 默认值；解析不出的字段保持 null
 */
function parseOutputDefaults(section) {
  const result = {
    dailyTitle: null,
    weeklyTitle: null,
    numberingStyle: null,
    numberingContinuous: null,
    blankLineBetweenItems: null,
  }
  if (typeof section !== 'string') return result

  const titleOf = (label) => {
    const match = new RegExp(`${label}[^。\\n]*?[“"]([^”"]+)[”"]\\s*作为标题`).exec(section)
    return match === null ? null : match[1]
  }
  result.dailyTitle = titleOf('日报')
  result.weeklyTitle = titleOf('周报')

  const numbering = /严格写成\s*`?(\d+[、.])/.exec(section)
  result.numberingStyle = numbering === null ? null : numbering[1]

  if (section.includes('编号内容连续输出')) result.numberingContinuous = true
  if (section.includes('不要插入多余空行')) result.blankLineBetweenItems = false

  return result
}

/**
 * @brief 现读技能文件，得到各字段对应的默认内容
 * @param skillDir 植入的技能目录（含 SKILL.md 与 references/report-style.md）
 * @return { skill: {...}, defaults: {...} }，读取失败时对应字段为 null
 * @note 这里只把内容读出来给面板展示与“留空即默认”作对照，绝不写进配置文件
 */
export function readSkillDefaults(skillDir) {
  const defaults = {
    output: {
      dailyTitle: null,
      weeklyTitle: null,
      numberingStyle: null,
      numberingContinuous: null,
      blankLineBetweenItems: null,
    },
    writing: { rules: null, dailyMin: null, dailyMax: null, weeklyMin: null, weeklyMax: null, verbFirst: null },
    style: { rules: null, samples: null },
    fallback: { strategy: null },
  }

  const skill = { description: '', body: '', skillDir }

  const readText = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }

  const skillRaw = readText(join(skillDir, 'SKILL.md'))
  if (typeof skillRaw === 'string') {
    const parsed = parseFrontmatter(skillRaw)
    skill.description = parsed.description
    skill.body = parsed.body

    const outputSection = extractSection(skillRaw, '输出要求')
    Object.assign(defaults.output, parseOutputDefaults(outputSection))

    const writingSection = extractSection(skillRaw, '写作规则')
    defaults.writing.rules = writingSection
    const daily = parseCountRange(writingSection, '日报')
    if (daily !== null) {
      defaults.writing.dailyMin = daily.min
      defaults.writing.dailyMax = daily.max
    }
    const weekly = parseCountRange(writingSection, '周报')
    if (weekly !== null) {
      defaults.writing.weeklyMin = weekly.min
      defaults.writing.weeklyMax = weekly.max
    }
    if (typeof writingSection === 'string' && writingSection.includes('动词开头')) {
      defaults.writing.verbFirst = true
    }
  }

  const styleRaw = readText(join(skillDir, 'references', 'report-style.md'))
  if (typeof styleRaw === 'string') {
    defaults.style.rules = extractSection(styleRaw, '风格规则')
    defaults.fallback.strategy = extractSection(styleRaw, '无提交兜底')

    // 样例库默认由两节拼成：先给精炼样例，再给完整历史语料
    const representative = extractSection(styleRaw, '代表性样例')
    const full = extractSection(styleRaw, '完整原始样例')
    const parts = [representative, full].filter((part) => typeof part === 'string')
    defaults.style.samples = parts.length === 0 ? null : parts.join('\n\n')
  }

  return { skill, defaults }
}

/**
 * @brief 把配置渲染成要插进技能正文最前的一段文本
 * @param config 已规范化的配置
 * @return Markdown 文本；没有任何可注入内容时返回空串
 */
export function renderInjectionSection(config) {
  if (config === null || config === undefined || !hasAnyValue(config)) return ''

  const blocks = []
  const addBlock = (heading, lines) => {
    const body = lines.filter((line) => typeof line === 'string' && line.trim() !== '')
    if (body.length > 0) blocks.push(`### ${heading}\n${body.join('\n')}`)
  }

  // 输出格式：逐项列出被改过的字段，未改的由技能默认规则负责
  const formatLines = []
  if (config.output.dailyTitle !== null) formatLines.push(`- 日报标题使用「${config.output.dailyTitle}」，标题后逐条输出。`)
  if (config.output.weeklyTitle !== null) formatLines.push(`- 周报标题使用「${config.output.weeklyTitle}」，标题后逐条输出。`)
  if (config.output.numberingStyle !== null) {
    formatLines.push(`- 每条使用序号「${config.output.numberingStyle}」，形如 ${config.output.numberingStyle}xxx，每条单独占一行。`)
  }
  if (config.output.numberingContinuous !== null) {
    formatLines.push(config.output.numberingContinuous
      ? '- 序号在各条之间连续递增。'
      : '- 序号不必在条与条之间连续。')
  }
  if (config.output.blankLineBetweenItems !== null) {
    formatLines.push(config.output.blankLineBetweenItems
      ? '- 条与条之间空一行。'
      : '- 条与条之间不留空行。')
  }
  addBlock('输出格式', formatLines)

  // 写作规则：用户整段替换，附加条数与动词开头的硬性要求
  const writingLines = []
  if (config.writing.rules !== null) writingLines.push(config.writing.rules)
  if (config.writing.verbFirst !== null) {
    writingLines.push(config.writing.verbFirst
      ? '每条必须以动词开头。'
      : '不强制每条以动词开头。')
  }
  const countParts = []
  if (config.writing.dailyMin !== null && config.writing.dailyMax !== null) {
    countParts.push(`日报 ${config.writing.dailyMin} 至 ${config.writing.dailyMax} 条`)
  }
  if (config.writing.weeklyMin !== null && config.writing.weeklyMax !== null) {
    countParts.push(`周报 ${config.writing.weeklyMin} 至 ${config.writing.weeklyMax} 条`)
  }
  if (countParts.length > 0) writingLines.push(`条数要求：${countParts.join('，')}。`)
  addBlock('写作规则', writingLines)

  addBlock('风格规则', [config.style.rules])
  addBlock('风格样例', [config.style.samples])
  addBlock('无提交时的兜底', [config.fallback.strategy])
  addBlock('额外要求', [config.extraPrompt])

  const header = [
    '## 运行时设置（dsh「报告总结」）',
    '',
    '本节由 dsh 设置页「报告总结」生成，只在本机 dsh 端生效；内容为空的小节不会出现。',
    '',
    '优先级：本节 > 用户偏好记忆（`~/.git-daily-weekly-report/preferences.md`）> 本技能默认规则与 `references/report-style.md`。发生冲突时以本节为准。',
    '',
    FACT_BASELINE,
  ].join('\n')

  return `${header}\n\n${blocks.join('\n\n')}`
}

/**
 * @brief 把注入段与技能正文合成为模型最终看到的技能内容
 * @param injection 注入段文本，可为空串
 * @param rawSkillMd 磁盘上的 SKILL.md 全文
 * @return 合成后的技能正文（不含 frontmatter）
 * @note 注入段放在最前，且在它为空时正文与磁盘内容等价，此时运行时注册不改变任何行为
 */
export function composeSkillContent(injection, rawSkillMd) {
  const { body } = parseFrontmatter(rawSkillMd)
  if (typeof injection !== 'string' || injection.trim() === '') return body
  return `${injection}\n\n${body}`
}

/**
 * @brief 读取配置文件
 * @param configPath 配置文件绝对路径
 * @return { config, warnings, existed } —— 文件缺失或损坏时返回全默认配置
 */
export function readConfig(configPath) {
  if (!existsSync(configPath)) return { config: createDefaultConfig(), warnings: [], existed: false }

  let raw
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (error) {
    return {
      config: createDefaultConfig(),
      warnings: [`无法读取配置文件：${error instanceof Error ? error.message : String(error)}`],
      existed: true,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { config: createDefaultConfig(), warnings: [`配置文件不是合法 JSON，已按默认处理：${configPath}`], existed: true }
  }

  const normalized = normalizeConfig(parsed)
  return { config: normalized.config, warnings: normalized.warnings, existed: true }
}

/**
 * @brief 原子写入配置文件
 * @param configPath 配置文件绝对路径
 * @param config 已规范化的配置
 * @note 先写同目录临时文件再 rename，避免进程中途退出留下半截 JSON
 */
export function writeConfig(configPath, config) {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })

  const tempPath = `${configPath}.tmp`
  const payload = `${JSON.stringify(config, null, 2)}\n`
  try {
    writeFileSync(tempPath, payload, 'utf8')
    renameSync(tempPath, configPath)
  } catch (error) {
    // 失败时清掉临时文件，避免下次启动误读
    try {
      unlinkSync(tempPath)
    } catch {
      // 临时文件本就不存在时忽略
    }
    throw error
  }

  return configPath
}
