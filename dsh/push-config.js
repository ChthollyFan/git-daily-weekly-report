// dsh/push-config.js —— dsh 端「自动推送」设置项的配置模型。
//
// 职责边界：本模块只做纯逻辑——配置读写、字段校验与降级、把配置换算成定时任务的
// 参数与创建指令。它不接触 cordis、不接触 dsh 技能注册表、不 spawn 子进程，因此
// 可以脱离 dsh 单独 import 做自测。
//
// 一条硬约束：本文件里的任何内容都不得进入技能注入段（见 dsh/report-summary.js 的
// renderInjectionSection）。推送配置含 webhook key 与 SMTP 密码，一旦拼进注入文本，
// 凭证会随 prompt 进入会话日志与模型上下文。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 配置文件名，落在 <用户主目录>/.git-daily-weekly-report/ 下，与 preferences.md 同目录 */
export const CONFIG_FILENAME = 'push-config.json'

/** 配置目录名：技能与推送配置共用的用户级目录 */
export const CONFIG_DIRNAME = '.git-daily-weekly-report'

/** 配置结构版本号，供将来做结构迁移 */
export const SCHEMA_VERSION = 1

/** 单个文本字段的长度上限，够放长 webhook 地址与密码 */
export const MAX_TEXT_CHARS = 4000

/** 企业微信单条消息的字节上限（官方 4096，这里留余量给分段前缀） */
const WECOM_MAX_BYTES_LIMIT = 4096

/** 单一通道的超时上限，防止配置成离谱值把定时任务挂死 */
const MIN_TIMEOUT_SECONDS = 1
const MAX_TIMEOUT_SECONDS = 120

/** 企业微信消息类型 */
const MESSAGE_TYPES = ['markdown', 'text']

/** SMTP 加密方式 */
const SMTP_SECURITIES = ['ssl', 'starttls', 'none']

/** ISO 星期 1-7 的中文名，用于生成定时任务指令 */
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/**
 * @brief 取本机时区名，作为定时配置的默认值
 * @return IANA 时区名，取不到时回退 Asia/Shanghai
 * @note 用本机时区而不是写死，避免用户在其它时区的机器上装完就错位
 */
export function currentTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone !== '' ? zone : 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

/**
 * @brief 计算推送配置目录
 * @param homeDir 用户主目录，可覆盖以便测试
 * @return 配置目录绝对路径
 */
export function resolveConfigDir(homeDir = homedir()) {
  return join(homeDir, CONFIG_DIRNAME)
}

/**
 * @brief 构造一份内置默认配置
 * @return 默认配置对象
 * @note 默认全通道关闭、总开关关闭：装完插件不会自发往外发任何东西
 */
export function createDefaultConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: false,
    repo: '',
    archiveDir: `~/${CONFIG_DIRNAME}/reports`,
    validation: { enabled: true },
    runtime: { pythonPath: 'python' },
    channels: {
      wecom: {
        enabled: false,
        webhookUrl: '',
        messageType: 'markdown',
        mentionAll: false,
        mentionedList: [],
        mentionedMobileList: [],
        maxBytes: 4000,
      },
      webhook: {
        enabled: false,
        url: '',
        headers: {},
        bodyTemplate: '{"text": "{{content}}"}',
        timeoutSeconds: 15,
      },
      smtp: {
        enabled: false,
        host: '',
        port: 465,
        security: 'ssl',
        username: '',
        password: '',
        from: '',
        to: [],
        cc: [],
        subjectTemplate: '{{title}} - {{date}}',
        html: false,
        timeoutSeconds: 20,
      },
      // 本地通道：不发网络请求，只把报告归档到本机并弹窗提示
      local: {
        enabled: false,
        notifyTitleTemplate: '{{title}} - {{date}}',
        includeExcerpt: true,
        openOnClick: true,
        // 提示窗自动关闭秒数，0 表示不自动关，等用户自己点
        closeAfterSeconds: 15,
      },
    },
    schedule: {
      // 定时任务「有没有」由是否真的创建过任务决定，这里只存参数，不再有启用开关
      // 日报也支持挑星期：默认工作日，想要每天就把七天全勾上（调度层一律用 weekly 表达）
      daily: { time: '18:00', timeZone: currentTimeZone(), weekdays: [1, 2, 3, 4, 5] },
      weekly: { weekdays: [5], time: '18:00', timeZone: currentTimeZone() },
      taskTitles: { daily: '每日工作日报', weekly: '每周工作周报' },
      // 承载定时任务的会话：官方调度只把提醒投递回创建它的会话，故会话身份必须随配置一起持久化
      session: { id: '', cwd: '', createdAt: '' },
    },
  }
}

/**
 * @brief 把任意输入收窄为字符串
 * @param value 原始值
 * @param fallback 不合法时采用的值
 * @param label 字段名，用于生成提示
 * @param warnings 收集降级说明的数组
 * @param keepRaw 为 true 时保留首尾空白（密码类字段用）
 * @return 收窄后的字符串
 * @note 类型不符不抛错，降级并记入 warnings：脏配置不能让设置页卡死
 */
function coerceText(value, fallback, label, warnings, keepRaw = false) {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') {
    warnings.push(`${label} 不是文本，已回退为默认值`)
    return fallback
  }
  // 密码保留原样：首尾空格也可能是密码的一部分，截断会让用户莫名其妙登录失败
  const trimmed = keepRaw ? value : value.trim()
  if (trimmed.length > MAX_TEXT_CHARS) {
    warnings.push(`${label} 超过 ${MAX_TEXT_CHARS} 字符，已截断`)
    return trimmed.slice(0, MAX_TEXT_CHARS)
  }
  return trimmed
}

/**
 * @brief 把任意输入收窄为布尔值
 * @param value 原始值
 * @param fallback 不合法时采用的值
 * @param label 字段名
 * @param warnings 收集降级说明的数组
 * @return 收窄后的布尔值
 */
function coerceBool(value, fallback, label, warnings) {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'boolean') {
    warnings.push(`${label} 不是布尔值，已回退为默认值`)
    return fallback
  }
  return value
}

/**
 * @brief 把任意输入收窄为区间内的整数
 * @param value 原始值
 * @param min 允许的最小值
 * @param max 允许的最大值
 * @param fallback 不合法时采用的值
 * @param label 字段名
 * @param warnings 收集降级说明的数组
 * @return 收窄后的整数
 */
function coerceInt(value, min, max, fallback, label, warnings) {
  if (value === null || value === undefined) return fallback
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(num) || num < min || num > max) {
    warnings.push(`${label} 需为 ${min}~${max} 的整数，已回退为默认值`)
    return fallback
  }
  return num
}

/**
 * @brief 校验 http(s) 地址
 * @param value 原始值
 * @param fallback 不合法时采用的值
 * @param label 字段名
 * @param warnings 收集降级说明的数组
 * @return 收窄后的地址字符串
 */
function coerceUrl(value, fallback, label, warnings) {
  const text = coerceText(value, fallback, label, warnings)
  if (text === '' || text === fallback) return text
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    warnings.push(`${label} 不是合法 URL，已清空`)
    return fallback
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    warnings.push(`${label} 只接受 http:// 或 https://，已清空`)
    return fallback
  }
  return text
}

/**
 * @brief 校验 HH:mm 形式的时间
 * @param value 原始值
 * @param fallback 不合法时采用的值
 * @param label 字段名
 * @param warnings 收集降级说明的数组
 * @return HH:mm 字符串
 */
function coerceTimeOfDay(value, fallback, label, warnings) {
  const text = coerceText(value, fallback, label, warnings)
  if (text === fallback) return text
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
    warnings.push(`${label} 需为 HH:mm 形式，已回退为默认值`)
    return fallback
  }
  return text
}

/**
 * @brief 校验 IANA 时区名
 * @param value 原始值
 * @param fallback 不合法时采用的值
 * @param label 字段名
 * @param warnings 收集降级说明的数组
 * @return 时区名
 */
function coerceTimeZone(value, fallback, label, warnings) {
  const text = coerceText(value, fallback, label, warnings)
  if (text === fallback) return text
  try {
    // 非法时区名会让 Intl 抛 RangeError，借此判定
    new Intl.DateTimeFormat('en-US', { timeZone: text })
    return text
  } catch {
    warnings.push(`${label} 不是合法时区，已回退为 ${fallback}`)
    return fallback
  }
}

/**
 * @brief 校验枚举值
 * @param value 原始值
 * @param allowed 允许的取值集合
 * @param fallback 不合法时采用的值
 * @param label 字段名
 * @param warnings 收集降级说明的数组
 * @return 枚举值
 */
function coerceEnum(value, allowed, fallback, label, warnings) {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    warnings.push(`${label} 只能是 ${allowed.join(' / ')}，已回退为默认值`)
    return fallback
  }
  return value
}

/**
 * @brief 收窄字符串数组：去空白、去重、保持顺序
 * @param value 原始值
 * @param fallback 不合法时采用的值
 * @param label 字段名
 * @param warnings 收集降级说明的数组
 * @return 字符串数组
 */
function coerceStringArray(value, fallback, label, warnings) {
  if (value === null || value === undefined) return [...fallback]
  if (!Array.isArray(value)) {
    warnings.push(`${label} 不是数组，已回退为默认值`)
    return [...fallback]
  }
  const result = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    // 空项与重复项都丢掉：粘贴名单时最容易多出这两种
    if (text !== '' && !result.includes(text)) result.push(text)
  }
  return result
}

/**
 * @brief 收窄邮箱列表：丢掉不像邮箱的项并在 warnings 里说明
 * @param value 原始值
 * @param fallback 不合法时采用的值
 * @param label 字段名
 * @param warnings 收集降级说明的数组
 * @return 邮箱地址数组
 * @note 只做最低限度判断（含 @、@ 两侧非空、无空白字符），真正的合法性交给 SMTP 服务器；
 *       这里要拦的是把数字或备注误填进收件人，那会让整封邮件在 RCPT 阶段被服务器拒掉
 */
function coerceEmailArray(value, fallback, label, warnings) {
  if (value === null || value === undefined) return [...fallback]
  if (!Array.isArray(value)) {
    warnings.push(`${label} 不是数组，已回退为默认值`)
    return [...fallback]
  }
  const result = []
  const dropped = []
  for (const item of value) {
    const text = String(item ?? '').trim()
    if (text === '') continue
    if (!isEmailLike(text)) {
      dropped.push(text)
      continue
    }
    if (!result.includes(text)) result.push(text)
  }
  if (dropped.length > 0) {
    warnings.push(`${label}里有 ${dropped.length} 项不是邮箱，已忽略：${dropped.join('、')}`)
  }
  return result
}

/**
 * @brief 判断字符串是否像邮箱
 * @param text 待判断的字符串
 * @return 像邮箱返回 true
 */
function isEmailLike(text) {
  const at = text.indexOf('@')
  // 只接受「本地部分@域名」这种最朴素的形式，且不允许出现空白
  return at > 0 && at < text.length - 1 && !/\s/.test(text)
}

/**
 * @brief 收窄请求头对象：值一律转成字符串
 * @param value 原始值
 * @param label 字段名
 * @param warnings 收集降级说明的数组
 * @return 请求头对象
 */
function coerceHeaderObject(value, label, warnings) {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`${label} 不是对象，已清空`)
    return {}
  }
  const result = {}
  for (const [key, raw] of Object.entries(value)) {
    const name = String(key).trim()
    if (name === '') continue
    if (raw === null || raw === undefined) continue
    result[name] = typeof raw === 'string' ? raw : String(raw)
  }
  return result
}

/**
 * @brief 收窄星期集合：ISO 1-7，去重升序
 * @param value 原始值
 * @param fallback 不合法时采用的值
 * @param label 字段名
 * @param warnings 收集降级说明的数组
 * @return 星期数组
 * @note 空数组视为非法：周报没有星期就等于永不到点
 */
function coerceWeekdays(value, fallback, label, warnings) {
  if (value === null || value === undefined) return [...fallback]
  if (!Array.isArray(value)) {
    warnings.push(`${label} 不是数组，已回退为默认值`)
    return [...fallback]
  }
  const days = new Set()
  for (const item of value) {
    const num = typeof item === 'number' ? item : Number(item)
    if (Number.isInteger(num) && num >= 1 && num <= 7) days.add(num)
  }
  if (days.size === 0) {
    warnings.push(`${label} 没有任何合法星期（1-7），已回退为默认值`)
    return [...fallback]
  }
  return [...days].sort((a, b) => a - b)
}

/**
 * @brief 校验并规范化一份配置
 * @param raw 从磁盘读到或从 HTTP 收到的原始对象
 * @return { config, warnings } —— config 总是完整形状
 * @note 未知键直接忽略（向前兼容）；任何非法值都降级为默认而不是抛错
 */
export function normalizeConfig(raw) {
  const config = createDefaultConfig()
  const warnings = []

  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== null && raw !== undefined) warnings.push('配置不是对象，已整体回退为默认')
    return { config, warnings }
  }

  config.enabled = coerceBool(raw.enabled, config.enabled, '自动推送总开关', warnings)
  config.repo = coerceText(raw.repo, config.repo, '仓库路径', warnings)
  config.archiveDir = coerceText(raw.archiveDir, config.archiveDir, '归档目录', warnings)

  const validation = raw.validation
  if (validation !== null && validation !== undefined && typeof validation === 'object') {
    config.validation.enabled = coerceBool(validation.enabled, config.validation.enabled, '正文校验开关', warnings)
  }

  const runtime = raw.runtime
  if (runtime !== null && runtime !== undefined && typeof runtime === 'object') {
    const pythonPath = coerceText(runtime.pythonPath, config.runtime.pythonPath, 'Python 解释器', warnings)
    // 空值会让 spawn 直接抛 ENOENT，统一收敛回默认解释器名
    config.runtime.pythonPath = pythonPath === '' ? config.runtime.pythonPath : pythonPath
  }

  const channels = raw.channels
  if (channels !== null && channels !== undefined && typeof channels === 'object') {
    normalizeWecom(channels.wecom, config.channels.wecom, warnings)
    normalizeWebhook(channels.webhook, config.channels.webhook, warnings)
    normalizeSmtp(channels.smtp, config.channels.smtp, warnings)
    // 本地通道只做透传校验，不在这里丢字段，保住手工配置
    normalizeLocal(channels.local, config.channels.local, warnings)
  }

  const schedule = raw.schedule
  if (schedule !== null && schedule !== undefined && typeof schedule === 'object') {
    normalizeSchedule(schedule, config.schedule, warnings)
  }

  config.schemaVersion = SCHEMA_VERSION
  return { config, warnings }
}

/**
 * @brief 规范化企业微信群机器人通道
 * @param raw 该通道的原始对象
 * @param target 待填充的默认对象
 * @param warnings 收集降级说明的数组
 */
function normalizeWecom(raw, target, warnings) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return

  target.enabled = coerceBool(raw.enabled, target.enabled, '企业微信开关', warnings)
  target.webhookUrl = coerceUrl(raw.webhookUrl, target.webhookUrl, '企业微信 Webhook 地址', warnings)
  target.messageType = coerceEnum(raw.messageType, MESSAGE_TYPES, target.messageType, '企业微信消息类型', warnings)
  target.mentionAll = coerceBool(raw.mentionAll, target.mentionAll, '企业微信 @所有人', warnings)
  target.mentionedList = coerceStringArray(raw.mentionedList, target.mentionedList, '企业微信 @成员', warnings)
  target.mentionedMobileList = coerceStringArray(
    raw.mentionedMobileList, target.mentionedMobileList, '企业微信 @成员手机号', warnings,
  )
  target.maxBytes = coerceInt(
    raw.maxBytes, 256, WECOM_MAX_BYTES_LIMIT, target.maxBytes, '企业微信单条字节上限', warnings,
  )
}

/**
 * @brief 规范化通用 webhook 通道
 * @param raw 该通道的原始对象
 * @param target 待填充的默认对象
 * @param warnings 收集降级说明的数组
 */
function normalizeWebhook(raw, target, warnings) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return

  target.enabled = coerceBool(raw.enabled, target.enabled, '通用 Webhook 开关', warnings)
  target.url = coerceUrl(raw.url, target.url, '通用 Webhook 地址', warnings)
  target.headers = coerceHeaderObject(raw.headers, '通用 Webhook 请求头', warnings)

  const template = coerceText(raw.bodyTemplate, target.bodyTemplate, '通用 Webhook 请求体模板', warnings)
  target.bodyTemplate = template === '' ? target.bodyTemplate : template
  // 模板里没有内容占位符时，发出去的请求体是固定文本，用户多半是漏写了
  if (!target.bodyTemplate.includes('{{content}}')) {
    warnings.push('通用 Webhook 请求体模板不含 {{content}}，正文不会出现在请求里')
  }

  target.timeoutSeconds = coerceInt(
    raw.timeoutSeconds, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS,
    target.timeoutSeconds, '通用 Webhook 超时', warnings,
  )
}

/**
 * @brief 规范化 SMTP 通道
 * @param raw 该通道的原始对象
 * @param target 待填充的默认对象
 * @param warnings 收集降级说明的数组
 */
function normalizeSmtp(raw, target, warnings) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return

  target.enabled = coerceBool(raw.enabled, target.enabled, '邮件开关', warnings)
  target.host = coerceText(raw.host, target.host, 'SMTP 主机', warnings)
  target.port = coerceInt(raw.port, 1, 65535, target.port, 'SMTP 端口', warnings)
  target.security = coerceEnum(raw.security, SMTP_SECURITIES, target.security, 'SMTP 加密方式', warnings)
  target.username = coerceText(raw.username, target.username, 'SMTP 用户名', warnings)
  // 密码保留原样，不做 trim
  target.password = coerceText(raw.password, target.password, 'SMTP 密码', warnings, true)
  target.from = coerceText(raw.from, target.from, '发件人', warnings)
  target.to = coerceEmailArray(raw.to, target.to, '收件人', warnings)
  target.cc = coerceEmailArray(raw.cc, target.cc, '抄送', warnings)

  const subject = coerceText(raw.subjectTemplate, target.subjectTemplate, '邮件主题模板', warnings)
  target.subjectTemplate = subject === '' ? target.subjectTemplate : subject

  target.html = coerceBool(raw.html, target.html, '邮件使用 HTML', warnings)
  target.timeoutSeconds = coerceInt(
    raw.timeoutSeconds, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS,
    target.timeoutSeconds, 'SMTP 超时', warnings,
  )
}

/**
 * @brief 规范化本地通知通道
 * @param raw 该通道的原始对象
 * @param target 待填充的默认对象
 * @param warnings 收集降级说明的数组
 * @note 这里必须有这条通道：否则设置页保存一次就会把手工写进配置的 local 段丢掉，
 *       本地推送随之失效
 */
function normalizeLocal(raw, target, warnings) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return

  target.enabled = coerceBool(raw.enabled, target.enabled, '本地通知开关', warnings)
  const template = coerceText(raw.notifyTitleTemplate, target.notifyTitleTemplate, '本地通知标题模板', warnings)
  target.notifyTitleTemplate = template === '' ? target.notifyTitleTemplate : template
  target.includeExcerpt = coerceBool(raw.includeExcerpt, target.includeExcerpt, '本地通知摘要开关', warnings)
  target.openOnClick = coerceBool(raw.openOnClick, target.openOnClick, '本地通知点击打开开关', warnings)
  // 提示窗自动关闭秒数：0 表示不自动关，上限 10 分钟足够覆盖人工查看
  target.closeAfterSeconds = coerceInt(
    raw.closeAfterSeconds, 0, 600, target.closeAfterSeconds, '本地提示自动关闭秒数', warnings,
  )
}

/**
 * @brief 规范化定时参数
 * @param raw schedule 段的原始对象
 * @param target 待填充的默认对象
 * @param warnings 收集降级说明的数组
 */
function normalizeSchedule(raw, target, warnings) {
  const daily = raw.daily
  if (daily !== null && daily !== undefined && typeof daily === 'object') {
    target.daily.weekdays = coerceWeekdays(daily.weekdays, target.daily.weekdays, '日报星期', warnings)
    target.daily.time = coerceTimeOfDay(daily.time, target.daily.time, '日报定时时间', warnings)
    target.daily.timeZone = coerceTimeZone(daily.timeZone, target.daily.timeZone, '日报时区', warnings)
  }

  const weekly = raw.weekly
  if (weekly !== null && weekly !== undefined && typeof weekly === 'object') {
    target.weekly.weekdays = coerceWeekdays(weekly.weekdays, target.weekly.weekdays, '周报星期', warnings)
    target.weekly.time = coerceTimeOfDay(weekly.time, target.weekly.time, '周报定时时间', warnings)
    target.weekly.timeZone = coerceTimeZone(weekly.timeZone, target.weekly.timeZone, '周报时区', warnings)
  }

  const titles = raw.taskTitles
  if (titles !== null && titles !== undefined && typeof titles === 'object') {
    const dailyTitle = coerceText(titles.daily, target.taskTitles.daily, '日报任务标题', warnings)
    const weeklyTitle = coerceText(titles.weekly, target.taskTitles.weekly, '周报任务标题', warnings)
    target.taskTitles.daily = dailyTitle === '' ? target.taskTitles.daily : dailyTitle
    target.taskTitles.weekly = weeklyTitle === '' ? target.taskTitles.weekly : weeklyTitle
  }

  // 承载会话由插件创建后写回，手工改写没有意义且容易指错，这里只做类型收窄不做语义校验
  const session = raw.session
  if (session !== null && session !== undefined && typeof session === 'object') {
    target.session.id = coerceText(session.id, '', '承载会话 id', warnings)
    target.session.cwd = coerceText(session.cwd, '', '承载会话工作目录', warnings)
    target.session.createdAt = coerceText(session.createdAt, '', '承载会话创建时间', warnings)
  }
}

/**
 * 通道在给人看的文案里的中文名
 * @note 与 dsh/client.js 的 CHANNEL_LABELS 同一套叫法，避免指令里的通道名和设置页对不上
 */
const CHANNEL_LABELS = {
  wecom: '企业微信',
  webhook: '自定义 Webhook',
  smtp: '邮件',
  local: '本地窗口推送',
}

/**
 * @brief 列出配置齐全且已启用的通道名
 * @param config 已规范化的配置
 * @return 通道名数组，顺序固定为 wecom、webhook、smtp、local
 * @note 只有开关打开**且**关键字段已填才算可用，否则脚本发给空目标必然失败
 */
export function listEnabledChannels(config) {
  const names = []
  const { wecom, webhook, smtp, local } = config.channels
  if (wecom.enabled && wecom.webhookUrl !== '') names.push('wecom')
  if (webhook.enabled && webhook.url !== '') names.push('webhook')
  if (smtp.enabled && smtp.host !== '' && smtp.to.length > 0) names.push('smtp')
  // 本地通道没有目标地址要校验，开关打开即可用
  if (local && local.enabled) names.push('local')
  return names
}

/**
 * @brief 判断配置里是否存在「开了开关但关键字段没填」的通道
 * @param config 已规范化的配置
 * @return 有半配置通道时返回 true
 * @note 用于在保存后提示用户补全，而不是等定时到点才失败
 */
export function hasIncompleteChannel(config) {
  const { wecom, webhook, smtp } = config.channels
  if (wecom.enabled && wecom.webhookUrl === '') return true
  if (webhook.enabled && webhook.url === '') return true
  if (smtp.enabled && (smtp.host === '' || smtp.to.length === 0)) return true
  return false
}

/**
 * @brief 把 ISO 星期数组转成中文说明
 * @param weekdays 星期数组
 * @return 形如「周一、周三」或「周一至周五」的文本
 * @note 连续三天以上合并成区间：全周只写「每天」，工作日写「周一至周五」，
 *       比逐个罗列好读；不足三天的连续段仍逐个写，避免「周一至周二」这种更长的表达
 */
export function describeWeekdays(weekdays) {
  if (!Array.isArray(weekdays) || weekdays.length === 0) return '（未设置）'
  const days = [...weekdays].sort((left, right) => left - right)
  if (days.length === 7) return '每天'

  const groups = []
  let start = 0
  for (let index = 1; index <= days.length; index += 1) {
    const atEnd = index === days.length
    if (!atEnd && days[index] === days[index - 1] + 1) continue
    const span = index - start
    if (span >= 3) {
      groups.push(`${WEEKDAY_NAMES[days[start] - 1] ?? days[start]}至${WEEKDAY_NAMES[days[index - 1] - 1] ?? days[index - 1]}`)
    } else {
      for (let cursor = start; cursor < index; cursor += 1) {
        groups.push(WEEKDAY_NAMES[days[cursor] - 1] ?? String(days[cursor]))
      }
    }
    start = index
  }

  return groups.join('、')
}

/**
 * @brief 本插件定时任务在 prompt 里的标记
 * @note 官方 catalog 返回宿主全部任务（含用户手工建的），只能靠标记区分哪些归本插件管
 */
export const TASK_MARKERS = { daily: '[gdr-daily]', weekly: '[gdr-weekly]' }

/**
 * @brief 取某类报告的任务标记
 * @param type 'daily' 或 'weekly'
 * @return 标记文本，未知类型返回空串
 */
export function taskMarkerFor(type) {
  return TASK_MARKERS[type] ?? ''
}

/**
 * @brief 从任务的 prompt 反推它属于日报还是周报
 * @param prompt 任务里保存的指令原文
 * @return 'daily'、'weekly' 或空串（空串代表不是本插件创建的任务）
 */
export function typeFromPrompt(prompt) {
  const text = typeof prompt === 'string' ? prompt : ''
  if (text.includes(TASK_MARKERS.daily)) return 'daily'
  if (text.includes(TASK_MARKERS.weekly)) return 'weekly'
  return ''
}

/**
 * @brief 构造某类报告的定时任务指令
 * @param config 已规范化的配置
 * @param type 'daily' 或 'weekly'
 * @return 可直接粘贴给 agent 的中文指令
 * @note 指令必须自包含：定时投递只带这段文字，agent 不会知道是哪个仓库、发到哪
 */
export function buildTaskPrompt(config, type) {
  const repo = config.repo === '' ? '（未设置，需补全仓库路径）' : config.repo
  const channels = listEnabledChannels(config)
  // 指令是给人看的，通道名换成中文；与 dsh/client.js 的 CHANNEL_LABELS 保持同一套叫法
  const channelText = channels.length === 0
    ? '（未配置任何可用通道）'
    : channels.map((name) => CHANNEL_LABELS[name] ?? name).join('、')
  const label = type === 'weekly' ? '周报' : '日报'

  return [
    `${TASK_MARKERS[type] ?? ''} `,
    `运行 git-daily-weekly-report 技能，为仓库 ${repo} 生成今天的${label}，`,
    `生成后调用技能目录下的 scripts/send_report.py --type ${type} 推送（当前启用通道：${channelText}）。`,
    '推送失败时把失败原因告诉我，不要把 webhook 地址或密码回显到对话里。',
  ].join('')
}

/**
 * @brief 构造供设置页「复制创建指令」使用的整段说明
 * @param config 已规范化的配置
 * @param type 可选，'daily' 或 'weekly'：指定后只输出该类型
 * @return 可直接粘贴给 agent 的多行文本
 * @note 设置页默认走官方 schedule 服务直接创建；本函数只作为创建失败后的降级路径，
 *       以及想让 agent 自己决定细节时的手工入口
 * @note 按 type 判断而不是按启用开关：配置里已经没有开关，
 *       是否定时完全由「有没有创建过任务」决定
 */
export function buildScheduleInstruction(config, type) {
  const wantDaily = type !== 'weekly'
  const wantWeekly = type !== 'daily'

  const lines = ['读取 ~/.git-daily-weekly-report/push-config.json 的 schedule 段，用 schedule_create 创建定时任务：']

  if (wantDaily) {
    const dailyDays = config.schedule.daily.weekdays
    lines.push(
      `- 日报：kind=weekly，weekdays=[${dailyDays.join(',')}]（${describeWeekdays(dailyDays)}），`,
      `  time=${config.schedule.daily.time}，timeZone=${config.schedule.daily.timeZone}，`,
      `  title=${config.schedule.taskTitles.daily}，prompt=${buildTaskPrompt(config, 'daily')}`,
    )
  }

  if (wantWeekly) {
    lines.push(
      `- 周报：kind=weekly，weekdays=[${config.schedule.weekly.weekdays.join(',')}]`
        + `（${describeWeekdays(config.schedule.weekly.weekdays)}），`,
      `  time=${config.schedule.weekly.time}，timeZone=${config.schedule.weekly.timeZone}，`,
      `  title=${config.schedule.taskTitles.weekly}，prompt=${buildTaskPrompt(config, 'weekly')}`,
    )
  }

  return lines.join('\n')
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
      warnings: [`无法读取推送配置：${error instanceof Error ? error.message : String(error)}`],
      existed: true,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      config: createDefaultConfig(),
      warnings: [`推送配置不是合法 JSON，已按默认处理：${configPath}`],
      existed: true,
    }
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
    // 失败时清掉临时文件，避免下次误读半截内容
    try {
      unlinkSync(tempPath)
    } catch {
      // 临时文件本就不存在时忽略
    }
    throw error
  }

  return configPath
}
