// git-daily-weekly-report —— dsh bundle 插件。
//
// 两件事：
// 1. 技能植入：dsh 按 `<root>/<name>/SKILL.md` 发现技能，其中用户级根
//    `$DSH_HOME/skills` 被所有 profile 共享。本插件作为 bundle 的一层，在
//    profile 启动时把包内 `skills/git-daily-weekly-report` 复制到该根下，于是
//    `dsh plugin add` 装一次，web、desktop 以及之后新建的 profile 都能看到它。
// 2. 报告总结设置：dsh web/desktop 端在设置页多一个「报告总结」导航项，用户
//    改的输出格式 / 写作规则 / 风格规则 / 样例库 / 兜底策略 / 额外要求会渲染成
//    一段文本，在技能被调用的那一刻插进技能正文最前（见 dsh/report-summary.js）。
//    注入靠运行时技能注册（rank 250）遮蔽文件系统 provider（user-dsh，rank 400），
//    磁盘上的 SKILL.md 与 references/ 保持原样，Codex 端完全不受影响。
//
// 用“植入 + 版本戳”而不是在 patch 里直接引用包内目录：patch 是静态 YAML，
// 而包的实际安装路径随 profile 变化，只有 apply() 运行时才能确定。
// “目标没有我们的版本戳就拒绝触碰”的约定来自 @ziduup/dsh-programming-mode，
// 用来保护用户手写的同名技能目录，以及仓库内安装脚本建立的目录链接。

import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONFIG_FILENAME as PUSH_CONFIG_FILENAME,
  buildScheduleInstruction,
  buildTaskPrompt,
  createDefaultConfig as createDefaultPushConfig,
  describeWeekdays,
  hasIncompleteChannel,
  listEnabledChannels,
  normalizeConfig as normalizePushConfig,
  readConfig as readPushConfig,
  resolveConfigDir as resolvePushConfigDir,
  typeFromPrompt,
  writeConfig as writePushConfig,
} from './dsh/push-config.js'

import { TEST_REPORT_TEXT, resolveScriptPath, runSendReport } from './dsh/push-send.js'

import {
  CONFIG_FILENAME,
  composeSkillContent,
  createDefaultConfig,
  hasAnyValue,
  normalizeConfig,
  parseFrontmatter,
  readConfig,
  readSkillDefaults,
  renderInjectionSection,
  writeConfig,
} from './dsh/report-summary.js'

/** 技能标识：必须与 SKILL.md 的 frontmatter name 以及目录名一致 */
const SKILL_NAME = 'git-daily-weekly-report'

/** 版本戳文件名：标记该目录由本插件植入，据此决定是覆盖还是跳过 */
const STAMP_FILENAME = '.git-daily-weekly-report.planted.json'

/** 本包根目录，用于定位随包分发的 skills/ */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** 随包分发的技能源目录 */
const SOURCE_DIR = join(PACKAGE_DIR, 'skills', SKILL_NAME)

/** 设置面板自建 HTTP 路由的前缀，客户端侧必须与此一致 */
const API_PREFIX = '/git-daily-weekly-report/api'

/** 请求体上限，够放全部文本字段，同时挡住误发的大包 */
const MAX_BODY_CHARS = 60000

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
 * @brief 计算「报告总结」配置文件路径
 * @param explicit 显式指定的 skill 根目录，可为空
 * @return 配置文件绝对路径
 * @note 落在 dsh 主目录下而不是 skills/ 里：skills/ 是技能发现根，塞非技能目录会污染扫描
 */
function resolveConfigPath(explicit) {
  const home = dirname(resolveSkillRoot(explicit))
  return join(home, SKILL_NAME, CONFIG_FILENAME)
}

/**
 * @brief 计算「自动推送」配置文件路径
 * @return 配置文件绝对路径
 * @note 与「报告总结」不同，这份配置必须落在 ~/.git-daily-weekly-report 下：它唯一的
 *       消费方是 send_report.py（定时任务里由 agent 直接调用），两侧路径不一致就会
 *       出现「面板里改了、脚本读不到」的情况
 */
function resolvePushConfigPath() {
  return join(resolvePushConfigDir(homedir()), PUSH_CONFIG_FILENAME)
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

  // 目标是指向别处的目录链接（例如仓库安装脚本把技能目录链到工作区）时直接跳过：
  // 那种情况下目标就是源本身，cpSync 会把链接当普通文件处理并报错
  try {
    if (lstatSync(targetDir).isSymbolicLink()) {
      return {
        action: 'skipped',
        reason: `${targetDir} 是指向别处的目录链接，未做任何修改`,
        targetDir,
      }
    }
  } catch {
    // lstat 失败时按普通目录继续
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
 * @brief 组装给设置面板的当前状态
 * @param state 插件运行期状态
 * @return 可直接 JSON 序列化的快照
 * @note 技能默认值每次现读，不缓存：技能升级后面板展示的默认值自动跟随
 */
function buildSnapshot(state) {
  const { config, warnings } = readConfig(state.configPath)
  let defaults = null
  let injectable = false
  let injectionChars = 0
  try {
    const read = readSkillDefaults(state.skillDir)
    defaults = read.defaults
    const injection = renderInjectionSection(config)
    injectable = injection !== ''
    injectionChars = injection.length
  } catch (error) {
    warnings.push(`读取技能默认值失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    configPath: state.configPath,
    skillDir: state.skillDir,
    planted: state.planted?.action ?? null,
    skillRegistered: state.registered === true,
    injected: injectable,
    injectionChars,
    config,
    defaults,
    warnings,
  }
}

/**
 * @brief 组装给「自动推送」设置分区用的快照
 * @param state 插件运行期状态
 * @return 可直接 JSON 序列化的快照
 * @note 派生字段（可用通道、待补全提醒、定时指令）都在服务端算好：前端只做展示，
 *       避免两处各写一套判断逻辑导致面板说「可发」而脚本实际跳过
 */
function buildPushSnapshot(state) {
  const { config, warnings, existed } = readPushConfig(state.pushConfigPath)
  const scriptPath = resolveScriptPath(state.skillDir)
  const channels = listEnabledChannels(config)

  return {
    configPath: state.pushConfigPath,
    skillDir: state.skillDir,
    scriptPath,
    // 脚本随技能一起植入，缺失说明技能目录不完整，先提示而不是等定时到点才报错
    scriptExists: existsSync(scriptPath),
    existed,
    config,
    channels,
    incomplete: hasIncompleteChannel(config),
    // 日报与周报各有自己的星期集合，界面上的「当前：…」提示分别取用
    dailyWeekdayText: describeWeekdays(config.schedule.daily.weekdays),
    weekdayText: describeWeekdays(config.schedule.weekly.weekdays),
    taskPrompts: {
      daily: buildTaskPrompt(config, 'daily'),
      weekly: buildTaskPrompt(config, 'weekly'),
    },
    scheduleInstruction: buildScheduleInstruction(config),
    schedule: buildScheduleStatus(state, config),
    warnings,
  }
}

/**
 * @brief 汇报官方调度服务的可用性
 * @param state 插件运行期状态
 * @param config 已规范化的推送配置
 * @return { available, canCreate, reason, session }
 * @note 官方调度来自可选 bundle：服务没注入时如实报告，设置页据此禁用创建按钮，
 *       避免点了按钮没有任何反应
 */
function buildScheduleStatus(state, config) {
  const service = state.scheduleService
  const controller = state.sessionController
  const available = service !== null && service !== undefined && typeof service.create === 'function'
  const canCreate = available && controller !== null && controller !== undefined
    && typeof controller.create === 'function'
  return {
    available,
    canCreate,
    reason: available
      ? ''
      : '未启用官方「自动化任务」（dsh-experimental-schedule-bundle），无法创建或管理定时任务',
    session: config.schedule.session,
  }
}

/**
 * @brief 列出本插件创建的定时任务
 * @param state 插件运行期状态
 * @return { available, tasks, reason }
 * @note 用 catalog 而不是 list：list 要按会话过滤，而设置页关心的是全部日报/周报任务；
 *       catalog 返回宿主里所有提醒，必须按 prompt 标记筛掉用户手工建的那些
 */
async function listScheduleTasks(state) {
  const service = state.scheduleService
  if (service === null || service === undefined || typeof service.catalog !== 'function') {
    return { available: false, tasks: [], reason: '未启用官方「自动化任务」bundle' }
  }

  let records
  try {
    records = await service.catalog()
  } catch (error) {
    return {
      available: true,
      tasks: [],
      reason: `读取定时任务失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const tasks = (Array.isArray(records) ? records : [])
    .map((record) => {
      const type = typeFromPrompt(record?.prompt)
      // 没有本插件标记的一律不显示：既不是我们建的，也就不该由我们取消
      if (type === '') return null
      return {
        id: typeof record.id === 'string' ? record.id : '',
        type,
        kind: typeof record.kind === 'string' ? record.kind : '',
        title: typeof record.title === 'string' ? record.title : '',
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
        status: typeof record.status === 'string' ? record.status : '',
        scheduledAt: typeof record.scheduledAt === 'string' ? record.scheduledAt : '',
        time: typeof record.time === 'string' ? record.time : '',
        timeZone: typeof record.timeZone === 'string' ? record.timeZone : '',
        weekdays: Array.isArray(record.weekdays) ? record.weekdays : [],
        expression: typeof record.expression === 'string' ? record.expression : '',
      }
    })
    .filter((item) => item !== null)

  return { available: true, tasks, reason: '' }
}

/**
 * @brief 取用或新建承载定时任务的会话
 * @param state 插件运行期状态
 * @param config 已规范化的推送配置，新建会话后会就地写回 session 字段
 * @return { ok, sessionId, reason }
 * @note 不传 workspaceId 即落在「未分组」；复用已记录的会话是安全的，因为 dsh 规定
 *       「还有活动任务的会话不允许归档」，任务有效期间这个会话删不掉
 */
async function ensureCarrierSession(state, config) {
  const existing = config.schedule.session
  if (existing.id !== '') return { ok: true, sessionId: existing.id, reason: '' }

  const controller = state.sessionController
  if (controller === null || controller === undefined || typeof controller.create !== 'function') {
    return { ok: false, sessionId: '', reason: '会话服务不可用，无法新建承载会话' }
  }

  // 承载会话只接收投递，工作目录优先对齐被统计的仓库，仓库没填时退回主目录
  const cwd = config.repo === '' ? homedir() : config.repo
  try {
    const created = await controller.create({ cwd })
    const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
    if (sessionId === '') {
      return { ok: false, sessionId: '', reason: '新建承载会话后没有拿到会话 id' }
    }
    config.schedule.session = { id: sessionId, cwd, createdAt: new Date().toISOString() }
    writePushConfig(state.pushConfigPath, config)
    return { ok: true, sessionId, reason: '' }
  } catch (error) {
    return {
      ok: false,
      sessionId: '',
      reason: `新建承载会话失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * @brief 把配置里的 HH:mm 补成 dsh 调度服务要求的 HH:mm:ss
 * @param value 配置里保存的时间文本
 * @return 可直接交给调度选择器的字符串；已带秒或格式异常时原样返回
 * @note 调度服务严格要求带秒，而设置页只让人填到分，不补秒会被直接拒掉
 */
function normalizeClockTime(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^\d{2}:\d{2}$/.test(text) ? `${text}:00` : text
}

/**
 * @brief 用当前配置直接创建一条定时任务
 * @param state 插件运行期状态
 * @param type 'daily' 或 'weekly'
 * @return { ok, reason, instruction, sessionId, task, tasks }
 * @note 失败时把降级指令一并回传：设置页据此弹「确认粘贴 / 重试 / 取消」
 */
async function createScheduleTask(state, type) {
  const { config } = readPushConfig(state.pushConfigPath)
  // 降级指令必须只针对刚点的那个类型，不能把另一类也塞进去
  const instruction = buildScheduleInstruction(config, type)

  const status = buildScheduleStatus(state, config)
  if (!status.canCreate) {
    return { ok: false, reason: status.reason, instruction, tasks: [] }
  }

  const carrier = await ensureCarrierSession(state, config)
  if (!carrier.ok) return { ok: false, reason: carrier.reason, instruction, tasks: [] }

  const isWeekly = type === 'weekly'
  const timing = isWeekly ? config.schedule.weekly : config.schedule.daily
  const title = isWeekly ? config.schedule.taskTitles.weekly : config.schedule.taskTitles.daily
  // dsh 的选择器输入用 snake_case 的 time_zone，且 time 必须是 HH:mm:ss（可带 1-3 位小数秒）；
  // 配置里存的是给人看的 HH:mm，这里补秒，否则会被 "daily must contain exactly ..." 直接拒掉
  const clockTime = normalizeClockTime(timing.time)
  // 日报也要能挑星期（「不一定每天都发」），而官方没有「daily + 指定星期」的选择器，
  // 统一用 weekly + weekdays 表达：传满 1-7 等于每天，传 1-5 就是工作日
  const request = {
    title,
    prompt: buildTaskPrompt(config, type),
    weekly: { time: clockTime, time_zone: timing.timeZone, weekdays: timing.weekdays },
  }

  try {
    const task = await state.scheduleService.create(carrier.sessionId, request)
    const listed = await listScheduleTasks(state)
    return {
      ok: true,
      reason: '',
      instruction: '',
      sessionId: carrier.sessionId,
      task: {
        id: typeof task?.id === 'string' ? task.id : '',
        type,
        title,
        scheduledAt: typeof task?.scheduledAt === 'string' ? task.scheduledAt : '',
      },
      tasks: listed.tasks,
    }
  } catch (error) {
    return {
      ok: false,
      reason: `创建定时任务失败：${error instanceof Error ? error.message : String(error)}`,
      instruction,
      sessionId: carrier.sessionId,
      tasks: [],
    }
  }
}

/**
 * @brief 取消一条本插件创建的定时任务
 * @param state 插件运行期状态
 * @param id 任务 id
 * @return { ok, reason, tasks }
 * @note 先查 catalog 拿到归属会话：delete 要求 sessionId 与任务绑定一致，
 *       并且只允许删带本插件标记的任务
 */
async function deleteScheduleTask(state, id) {
  const service = state.scheduleService
  if (service === null || service === undefined || typeof service.delete !== 'function') {
    return { ok: false, reason: '官方调度服务不可用，无法取消任务', tasks: [] }
  }
  if (id === '') return { ok: false, reason: '缺少要取消的任务 id', tasks: [] }

  const listed = await listScheduleTasks(state)
  const target = listed.tasks.find((item) => item.id === id)
  if (target === undefined) {
    return { ok: false, reason: '没有找到该任务，可能已被删除', tasks: listed.tasks }
  }

  try {
    const result = await service.delete({ sessionId: target.sessionId, id })
    const after = await listScheduleTasks(state)
    const deleted = result?.deleted === true
    return {
      ok: deleted,
      reason: deleted ? '' : '任务未被删除，可能已不存在',
      tasks: after.tasks,
    }
  } catch (error) {
    return {
      ok: false,
      reason: `取消任务失败：${error instanceof Error ? error.message : String(error)}`,
      tasks: listed.tasks,
    }
  }
}

/**
 * @brief 用当前配置重新注册运行时技能
 * @param state 插件运行期状态
 * @return 是否注册成功
 * @note 必须先注销再注册：同层同名的 runtime 条目是 first-wins，重复注册只会拿到
 *       一个空 disposer 并记一条 warning，第二次改配置就悄无声息地不生效了
 */
function refreshRuntimeSkill(state) {
  const skills = state.skills
  if (skills === null || typeof skills.register !== 'function') return false

  if (state.disposeSkill !== null) {
    try {
      state.disposeSkill()
    } catch (error) {
      console.error('[git-daily-weekly-report] 注销旧的运行时技能失败：', error)
    }
    state.disposeSkill = null
    state.registered = false
  }

  try {
    const rawSkill = readFileSync(join(state.skillDir, 'SKILL.md'), 'utf8')
    const { description } = parseFrontmatter(rawSkill)
    const { config } = readConfig(state.configPath)
    const injected = hasAnyValue(config)
    const content = composeSkillContent(injected ? renderInjectionSection(config) : '', rawSkill)

    const dispose = skills.register({
      name: SKILL_NAME,
      // description 影响模型的路由判断，保持与磁盘 frontmatter 一致，不开放配置
      description: description === '' ? '根据 Git 提交记录生成中文日报或周报' : description,
      source: 'runtime',
      // 真实目录：执行步骤要读 references/ 与跑 scripts/，不能让模型拿到虚拟路径
      resourceBase: { kind: 'directory', path: state.skillDir },
      path: join(state.skillDir, 'SKILL.md'),
      content,
    })

    state.disposeSkill = typeof dispose === 'function' ? dispose : null
    state.registered = true
    state.injected = injected
    return true
  } catch (error) {
    console.error('[git-daily-weekly-report] 注册运行时技能失败，回退到磁盘默认技能：', error)
    state.registered = false
    state.injected = false
    return false
  }
}

/**
 * @brief 校验运行时注册确实生效
 * @param state 插件运行期状态
 * @note 遮蔽依赖 rank 语义（runtime 250 < user-dsh 400），这不是公开承诺；
 *       一旦取回的 source 不是 runtime，说明 dsh 改了裁决规则，立刻在日志里点明
 */
async function verifyRuntimeSkill(state) {
  const skills = state.skills
  if (skills === null || typeof skills.get !== 'function') return
  try {
    const loaded = await skills.get(SKILL_NAME)
    if (loaded !== undefined && loaded.source !== 'runtime') {
      console.error(`[git-daily-weekly-report] 运行时技能未生效：取回的 source 是 ${loaded.source}，报告总结设置可能不起作用`)
    }
  } catch (error) {
    console.error('[git-daily-weekly-report] 校验运行时技能失败：', error)
  }
}

/**
 * @brief 判断主机名是否是回环地址
 * @param host 主机名或 IP
 * @return 是回环时返回 true
 */
function isLoopbackName(host) {
  const name = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0:0:0:0:0:0:0:1'
}

/**
 * @brief 读取本包的 npm 包名
 * @return 包名字符串，读取失败时回退为空串
 * @note 安装命令与 registry 查询都要按包名拼接，写死包名在改名后就会失效
 */
function readOwnName() {
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
    return typeof manifest.name === 'string' ? manifest.name.trim() : ''
  } catch {
    return ''
  }
}

/**
 * @brief 定位本插件所在的 profile 目录
 * @param packageName 本包名
 * @return { name, dir }，dir 为 <dsh 主目录>/profiles/<name>
 * @note 不直接信任 $DSH_PROFILE：宿主进程与终端进程的环境变量未必一致（实测终端里就是
 *       desktop），认错 profile 会读出错误的安装形态。改为在 profiles/ 下逐个找
 *       dependencies 里登记了本包的目录，都找不到才退回环境变量或 web
 */
function resolveProfileDir(packageName) {
  const profilesRoot = join(dirname(resolveSkillRoot()), 'profiles')
  const envName = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : ''

  let discovered = []
  try {
    discovered = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    discovered = []
  }

  const candidates = []
  const push = (name) => {
    if (name !== '' && !candidates.includes(name)) candidates.push(name)
  }
  push(envName)
  push('web')
  push('desktop')
  for (const name of discovered) push(name)

  for (const profileName of candidates) {
    const dir = join(profilesRoot, profileName)
    const manifest = readProfileManifest(dir)
    const dependencies = manifest !== null && typeof manifest.dependencies === 'object' && manifest.dependencies !== null
      ? manifest.dependencies
      : {}
    if (packageName !== '' && typeof dependencies[packageName] === 'string') return { name: profileName, dir }
  }

  const fallbackName = envName === '' ? 'web' : envName
  return { name: fallbackName, dir: join(profilesRoot, fallbackName) }
}

/**
 * @brief 读取 profile 的 package.json
 * @param profileDir profile 目录
 * @return 解析后的对象，文件缺失或损坏时返回 null
 */
function readProfileManifest(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @brief 判断本插件在 profile 里的安装形态
 * @param profileDir profile 目录
 * @param packageName 包名
 * @return { mode, spec, target }，mode 为 link / package / unknown
 * @note link 形态下运行的就是工作区源码，从 npm 重装会把这条链接换成实体包，
 *       之后对工作区的改动不再自动生效，所以更新逻辑必须区分两种形态
 */
function detectInstallShape(profileDir, packageName) {
  const manifest = readProfileManifest(profileDir)
  const dependencies = manifest !== null && typeof manifest.dependencies === 'object' && manifest.dependencies !== null
    ? manifest.dependencies
    : {}
  const spec = packageName !== '' && typeof dependencies[packageName] === 'string'
    ? dependencies[packageName].trim()
    : ''
  if (spec === '') return { mode: 'unknown', spec: '', target: '' }
  const matched = /^(?:link|file):(.+)$/i.exec(spec)
  if (matched !== null) return { mode: 'link', spec, target: matched[1] }
  return { mode: 'package', spec, target: '' }
}

/**
 * @brief 比较两个点分版本号
 * @param left 左侧版本
 * @param right 右侧版本
 * @return 左侧更大返回 1，相等返回 0，更小返回 -1
 * @note 只比较前三段数字，预发布标签不参与，够用于“有没有新版”的判定
 */
function compareVersions(left, right) {
  const parse = (text) => String(text ?? '').split('.').slice(0, 3).map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })
  const leftParts = parse(left)
  const rightParts = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1
  }
  return 0
}

/**
 * @brief 查询 npm registry 上的最新版本
 * @param packageName 包名
 * @return 最新版本号字符串
 * @throw 网络失败或回包异常时抛出 Error
 */
async function fetchLatestVersion(packageName) {
  const response = await fetch(`https://registry.npmjs.org/${packageName}/latest?write=true`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`npm registry 返回 HTTP ${response.status}`)
  const body = await response.json()
  const version = typeof body?.version === 'string' ? body.version.trim() : ''
  if (version === '') throw new Error('npm registry 回包里没有 version 字段')
  return version
}

/**
 * @brief 组装设置页顶部要展示的插件元信息
 * @param state 插件运行期状态
 * @param latest 最近一次查到的远端版本，未查过时留空
 * @return 元信息对象
 */
function buildPluginInfo(state, latest) {
  const shape = detectInstallShape(state.profile.dir, state.packageName)
  return {
    name: state.packageName,
    version: readOwnVersion(),
    latest: typeof latest === 'string' ? latest : '',
    installMode: shape.mode,
    installSpec: shape.spec,
    linkTarget: shape.target,
    profileName: state.profile.name,
    profileDir: state.profile.dir,
  }
}

/**
 * @brief 记录 profile 当前的加载列表，供安装后对账
 * @param profileDir profile 目录
 * @return { bundles } 或 null
 */
function captureBundleState(profileDir) {
  const manifest = readProfileManifest(profileDir)
  if (manifest === null) return null
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((item) => typeof item === 'string')
    : []
  return { bundles }
}

/**
 * @brief 把被 `dsh plugin add` 摘掉的 bundle 条目补回去
 * @param profileDir profile 目录
 * @param before 安装前由 captureBundleState 记录的状态
 * @return 结果说明数组，为空表示无需补写
 * @note `dsh plugin add` 会按 dependencies 重新生成整份 bundles，装上本插件时
 *       会把不在 dependencies 里的条目删掉（本仓库已被这种情况摘掉过两次插件）
 */
function restoreBundleState(profileDir, before) {
  if (before === null) return []
  const manifest = readProfileManifest(profileDir)
  if (manifest === null) return ['安装后读不到 profile 的 package.json，请手动检查加载列表']

  const current = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((item) => typeof item === 'string')
    : []
  const missing = before.bundles.filter((item) => !current.includes(item))
  if (missing.length === 0) return []

  const nextManifest = {
    ...manifest,
    dsh: {
      ...(manifest.dsh ?? {}),
      profile: {
        ...(manifest.dsh?.profile ?? {}),
        bundles: [...current, ...missing],
      },
    },
  }
  try {
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8')
  } catch (error) {
    return [`补回加载列表失败：${error instanceof Error ? error.message : String(error)}`]
  }
  return missing.map((item) => `已把 ${item} 补回加载列表`)
}

/**
 * @brief 跑一条子进程命令并收集输出
 * @param command 可执行文件
 * @param args 参数数组
 * @param timeoutMs 超时毫秒数
 * @return { ok, code, stdout, stderr, reason }
 */
function runChild(command, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let child = null
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        reason: `无法启动命令：${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      resolvePromise(payload)
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已经退出时忽略
      }
      finish({
        ok: false,
        code: null,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
        reason: `命令超过 ${Math.round(timeoutMs / 1000)} 秒未结束`,
      })
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, code: null, stdout: '', stderr: '', reason: `无法启动命令：${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const tail = stderr.trim().split('\n').slice(-4).join('\n')
      finish({
        ok: code === 0,
        code,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
        reason: code === 0 ? '' : tail === '' ? `命令退出码 ${code}` : tail,
      })
    })
  })
}

/**
 * @brief 从 npm 安装指定版本并修复加载列表
 * @param state 插件运行期状态
 * @param version 目标版本号
 * @return { ok, skipped, installed, info, reason, output }
 * @note link 形态不执行安装：那种形态下代码就是工作区那份，重装等于切断链接
 */
async function installUpdate(state, version) {
  // 一律带上目标版本回包：安装失败时前端仍能保留「安装更新」按钮直接重试
  const info = buildPluginInfo(state, version)

  if (info.installMode === 'link') {
    return {
      ok: false,
      skipped: true,
      installed: '',
      info,
      reason: `当前是开发链接形态（指向 ${info.linkTarget}），更新请在该目录执行 git pull`,
      output: '',
    }
  }

  if (info.installMode === 'unknown') {
    return {
      ok: false,
      skipped: true,
      installed: '',
      info,
      reason: `在 ${info.profileDir} 里找不到本插件的依赖登记，无法执行安装`,
      output: '',
    }
  }

  if (info.name === '') {
    return { ok: false, skipped: true, installed: '', info, reason: '读不到本包名，无法执行安装', output: '' }
  }

  // 版本号与 profile 名都要拼进命令行，先按最严的形式校验，挡住来自 registry 的注入
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return { ok: false, skipped: false, installed: '', info, reason: `版本号不合法：${version}`, output: '' }
  }
  if (!/^[A-Za-z0-9_-]+$/.test(state.profile.name)) {
    return { ok: false, skipped: false, installed: '', info, reason: `profile 名不合法：${state.profile.name}`, output: '' }
  }

  const before = captureBundleState(state.profile.dir)
  const commandLine = `dsh plugin --profile ${state.profile.name} add ${info.name}@${version}`
  // Windows 下 dsh 是 .cmd，必须经 cmd.exe 才能启动；整条命令作为单个参数传入，不做二次分词
  const outcome = await runChild(
    typeof process.env.ComSpec === 'string' ? process.env.ComSpec : 'cmd.exe',
    ['/d', '/s', '/c', commandLine],
    300000,
  )

  const repairs = outcome.ok ? restoreBundleState(state.profile.dir, before) : []
  const output = [outcome.stdout, outcome.stderr].filter((text) => text !== '').join('\n').trim()

  return {
    ok: outcome.ok,
    skipped: false,
    installed: outcome.ok ? version : '',
    info,
    reason: outcome.ok ? '' : outcome.reason,
    output: output.slice(-4000),
    repairs,
  }
}

/**
 * @brief 处理一个 HTTP 请求：读体 → 分发 → 回包
 * @param state 插件运行期状态
 * @param req Node 请求对象
 * @param res Node 响应对象
 */
function handleRequest(state, req, res) {
  const jsonHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  const send = (status, payload) => {
    res.writeHead(status, jsonHeaders)
    res.end(JSON.stringify(payload))
  }

  // 只在绑定为回环时才校验 Host；绑定 0.0.0.0 属于有意对外发布，强制回环会 403 掉合法客户端
  if (state.guardHost === true) {
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : ''
    const hostName = hostHeader.replace(/:\d+$/, '')
    if (hostHeader !== '' && !isLoopbackName(hostName)) {
      send(403, { ok: false, saved: false, message: '仅允许回环地址访问', snapshot: null })
      return
    }
  }

  let body = ''
  let overflow = false
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    if (overflow) return
    body += chunk
    if (body.length > MAX_BODY_CHARS) overflow = true
  })
  req.on('error', () => {
    send(400, { ok: false, saved: false, message: '读取请求体失败', snapshot: null })
  })
  req.on('end', () => {
    if (overflow) {
      send(413, { ok: false, saved: false, message: `请求体超过 ${MAX_BODY_CHARS} 字符上限`, snapshot: null })
      return
    }

    void (async () => {
      try {
        const payload = body === '' ? {} : JSON.parse(body)
        const method = typeof payload?.method === 'string' ? payload.method : ''
        const args = payload?.args === undefined ? null : payload.args

        // 自动推送分区独立于运行时技能：技能未能注册时，用户仍然可以先把推送配好，
        // 所以先分辨方法归属，再各自检查对应的快照是否就绪
        const isPushMethod = method === 'push-snapshot' || method === 'push-save'
          || method === 'push-reset' || method === 'push-test'
          // 定时任务读的也是这份推送配置（时间、标题、提示词），一样依赖该快照
          || method === 'schedule-list' || method === 'schedule-create'
          || method === 'schedule-delete' || method === 'schedule-instruction'

        // 版本信息、检查更新、安装更新只碰包元信息与子进程，与两个快照都无关，
        // 技能服务没起来时设置页顶部照样要能显示版本号
        const isMetaMethod = method === 'plugin-info' || method === 'check-update'
          || method === 'install-update'

        if (!isPushMethod && !isMetaMethod && state.snapshot === null) {
          send(503, { ok: false, saved: false, message: '技能服务尚未就绪，请稍后重试', snapshot: null })
          return
        }

        if (isPushMethod && state.pushSnapshot === null) {
          send(503, { ok: false, saved: false, message: '自动推送服务尚未就绪，请稍后重试', snapshot: null })
          return
        }

        if (method === 'plugin-info') {
          send(200, { ok: true, saved: false, message: '', info: buildPluginInfo(state) })
          return
        }

        if (method === 'check-update') {
          const current = readOwnVersion()
          let latest = ''
          let message = ''
          if (state.packageName === '') {
            message = '读不到本包名，无法检查更新'
          } else {
            try {
              latest = await fetchLatestVersion(state.packageName)
              // 本地版本可能领先于 npm（改完还没发布），这种要单独说明，不能笼统说成“最新”
              const comparison = compareVersions(latest, current)
              if (comparison > 0) message = `发现新版本 ${latest}（当前 ${current}）`
              else if (comparison === 0) message = `已是最新版本 ${current}`
              else message = `npm 上是 ${latest}，本地 ${current} 更新，该版本可能尚未发布`
            } catch (error) {
              message = `检查更新失败：${error instanceof Error ? error.message : String(error)}`
            }
          }
          // ok 固定为 true：查不到新版或网络失败都只是提示，不该让客户端当成接口异常
          send(200, { ok: true, saved: false, message, info: buildPluginInfo(state, latest) })
          return
        }

        if (method === 'install-update') {
          const targetVersion = typeof args?.version === 'string' ? args.version.trim() : ''
          const outcome = await installUpdate(state, targetVersion)
          const repairNotes = Array.isArray(outcome.repairs) ? outcome.repairs : []
          const baseMessage = outcome.ok
            ? `已安装 ${outcome.installed}，重启 dsh 后生效`
            : outcome.reason
          send(200, {
            ok: outcome.ok,
            saved: false,
            skipped: outcome.skipped === true,
            message: repairNotes.length === 0 ? baseMessage : `${baseMessage}；${repairNotes.join('；')}`,
            info: outcome.info,
            install: {
              ok: outcome.ok,
              skipped: outcome.skipped === true,
              installed: outcome.installed,
              reason: outcome.reason,
              output: outcome.output,
              repairs: repairNotes,
            },
          })
          return
        }

        if (method === 'snapshot') {
          send(200, { ok: true, saved: false, message: '', snapshot: state.snapshot() })
          return
        }

        if (method === 'save') {
          const { config, warnings } = normalizeConfig(args?.config)
          writeConfig(state.configPath, config)
          refreshRuntimeSkill(state)
          const message = warnings.length === 0
            ? '已保存并生效'
            : `已保存，但有字段被忽略：${warnings.join('；')}`
          send(200, { ok: true, saved: true, message, snapshot: state.snapshot() })
          return
        }

        if (method === 'reset') {
          const config = createDefaultConfig()
          writeConfig(state.configPath, config)
          refreshRuntimeSkill(state)
          send(200, { ok: true, saved: true, message: '已恢复全部默认', snapshot: state.snapshot() })
          return
        }

        if (method === 'push-snapshot') {
          send(200, { ok: true, saved: false, message: '', snapshot: state.pushSnapshot() })
          return
        }

        if (method === 'push-save') {
          const { config, warnings } = normalizePushConfig(args?.config)
          writePushConfig(state.pushConfigPath, config)
          // 半填的通道不会报错，只会在定时到点那天静默失败，所以保存时就把隐患说清楚
          const notes = [...warnings]
          if (hasIncompleteChannel(config)) notes.push('有通道已开启但关键字段为空，到点推送会失败')
          if (listEnabledChannels(config).length === 0) notes.push('当前没有任何可用通道，推送会被全部跳过')
          const message = notes.length === 0 ? '已保存自动推送配置' : `已保存，但需注意：${notes.join('；')}`
          // 同时把 notes 单独回给前端：客户端据此决定用成功色还是待确认色
          send(200, { ok: true, saved: true, message, warnings: notes, snapshot: state.pushSnapshot() })
          return
        }

        if (method === 'push-reset') {
          const config = createDefaultPushConfig()
          writePushConfig(state.pushConfigPath, config)
          send(200, {
            ok: true,
            saved: true,
            message: '已恢复自动推送的默认配置',
            warnings: [],
            snapshot: state.pushSnapshot(),
          })
          return
        }

        if (method === 'push-test') {
          // 用草稿配置测试：写一份临时配置文件、跑完即删，这样改了字段不必先落盘就能试
          const { config } = normalizePushConfig(args?.config)
          const type = args?.type === 'weekly' ? 'weekly' : 'daily'
          const channel = ['wecom', 'webhook', 'smtp'].includes(args?.channel) ? String(args.channel) : ''
          const testConfigPath = `${state.pushConfigPath}.test`

          let outcome
          try {
            writePushConfig(testConfigPath, config)
            const scriptArgs = [
              '--type', type,
              '--text', TEST_REPORT_TEXT,
              '--config', testConfigPath,
              '--no-archive',
            ]
            if (channel !== '') scriptArgs.push('--channel', channel)
            outcome = await runSendReport({
              pythonPath: config.runtime.pythonPath,
              scriptPath: resolveScriptPath(state.skillDir),
              args: scriptArgs,
            })
          } catch (error) {
            outcome = {
              ok: false,
              exitCode: null,
              stdout: '',
              stderr: '',
              result: null,
              reason: `测试发送未完成：${error instanceof Error ? error.message : String(error)}`,
            }
          } finally {
            try {
              unlinkSync(testConfigPath)
            } catch {
              // 临时文件没写成功时忽略
            }
          }

          send(200, {
            ok: outcome.ok,
            saved: false,
            message: outcome.ok ? '测试发送成功，去目标应用里确认一下' : `测试发送失败：${outcome.reason}`,
            snapshot: state.pushSnapshot(),
            test: {
              ok: outcome.ok,
              exitCode: outcome.exitCode,
              reason: outcome.reason,
              stdout: outcome.stdout,
              stderr: outcome.stderr,
              result: outcome.result,
              channel: channel === '' ? '全部启用通道' : channel,
              type,
            },
          })
          return
        }

        if (method === 'schedule-list') {
          const listed = await listScheduleTasks(state)
          send(200, { ok: true, saved: false, message: listed.reason, ...listed })
          return
        }

        if (method === 'schedule-instruction') {
          // 降级路径：官方调度不可用或用户明确要求自己粘贴时，把指令单独取出来
          const { config } = readPushConfig(state.pushConfigPath)
          send(200, {
            ok: true,
            saved: false,
            message: '',
            instruction: buildScheduleInstruction(config),
          })
          return
        }

        if (method === 'schedule-create') {
          const type = args?.type === 'weekly' ? 'weekly' : 'daily'
          const outcome = await createScheduleTask(state, type)
          const label = type === 'weekly' ? '周报' : '日报'
          send(200, {
            ok: outcome.ok,
            // 只有承载会话新建后才会写配置，这里统一不宣称“已保存”，由前端按任务列表刷新
            saved: false,
            message: outcome.ok ? `已创建${label}定时任务` : `创建${label}定时任务失败：${outcome.reason}`,
            reason: outcome.reason,
            instruction: outcome.instruction,
            sessionId: outcome.sessionId ?? '',
            tasks: outcome.tasks,
          })
          return
        }

        if (method === 'schedule-delete') {
          const id = typeof args?.id === 'string' ? args.id.trim() : ''
          const outcome = await deleteScheduleTask(state, id)
          send(200, {
            ok: outcome.ok,
            saved: false,
            message: outcome.ok ? '已取消定时任务' : `取消定时任务失败：${outcome.reason}`,
            reason: outcome.reason,
            tasks: outcome.tasks,
          })
          return
        }

        send(400, {
          ok: false,
          saved: false,
          message: `未知方法：${method || '(空)'}`,
          snapshot: state.snapshot(),
        })
      } catch (error) {
        send(400, {
          ok: false,
          saved: false,
          message: error instanceof Error ? error.message : String(error),
          snapshot: state.snapshot === null ? null : state.snapshot(),
        })
      }
    })()
  })
}

/**
 * @brief 注册设置面板用来读写配置的 HTTP 路由
 * @param ctx cordis 上下文
 * @param state 插件运行期状态
 * @note 用非阻塞子 fiber：headless / tui 这类没有 webServer 的 profile 不能因此
 *       卡住整行，否则技能注册也会跟着一起丢掉
 */
function setupHttpRoute(ctx, state) {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['webServer'], (scope) => {
      const webServer = scope.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') {
        console.error('[git-daily-weekly-report] webServer 不可用，设置面板的读写接口未注册')
        return
      }

      const boundHost = typeof webServer.host === 'string' ? webServer.host.trim().toLowerCase() : ''
      // 绑定为 0.0.0.0 或具体地址属于有意对外发布，此时不启用回环白名单
      state.guardHost = boundHost === '' || isLoopbackName(boundHost)

      let routeDispose = null
      try {
        routeDispose = webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: (req, res) => handleRequest(state, req, res),
        })
      } catch (error) {
        console.error('[git-daily-weekly-report] 路由注册失败：', error)
        routeDispose = null
      }

      scope.effect(() => () => {
        if (routeDispose !== null) {
          const dispose = routeDispose
          routeDispose = null
          try {
            dispose()
          } catch (error) {
            console.error('[git-daily-weekly-report] 路由注销失败：', error)
          }
        }
      })
    })
  } catch (error) {
    console.error('[git-daily-weekly-report] 初始化 HTTP 路由失败：', error)
  }
}

/**
 * @brief cordis 插件入口：植入技能，并在 dsh 端接管「报告总结」设置
 * @param ctx cordis 上下文。为 undefined 时退化为只做技能植入（旧行为）
 * @note 所有异常都在这里吞掉——插件不能让宿主的 profile 启动失败
 */
export function apply(ctx) {
  // 第一步永远是植入，失败也只记日志：这一步与设置功能互不依赖
  let planted = null
  try {
    planted = plantSkill()
    const detail = planted.reason
      ?? (planted.action === 'updated' ? `${planted.from} -> ${planted.to}` : planted.version ?? '')
    console.log(`[git-daily-weekly-report] ${planted.action}${detail ? `：${detail}` : ''}`)
  } catch (error) {
    console.log(`[git-daily-weekly-report] 植入技能失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 没有 cordis 上下文就到此为止：保持 1.0.2 及以前“只植入”的行为
  if (ctx === null || typeof ctx !== 'object') return

  // 设置页顶部要显示版本号并支持一键更新，包名与所在 profile 在这里一次定好
  const packageName = readOwnName()
  const state = {
    configPath: resolveConfigPath(),
    pushConfigPath: resolvePushConfigPath(),
    skillDir: join(resolveSkillRoot(), SKILL_NAME),
    packageName,
    profile: resolveProfileDir(packageName),
    planted,
    skills: null,
    disposeSkill: null,
    registered: false,
    injected: false,
    guardHost: false,
    snapshot: null,
    pushSnapshot: null,
    // 官方调度与会话控制来自可选 bundle，未启用时恒为 null
    scheduleService: null,
    sessionController: null,
  }

  // 自动推送只看配置文件与随包脚本，不依赖 skills 服务，所以在等注入之前就挂上快照：
  // 技能注册失败或 profile 没有 skill 服务时，「自动推送」分区仍然可读可写
  state.pushSnapshot = () => buildPushSnapshot(state)

  try {
    if (typeof ctx.inject === 'function') {
      // 等技能服务就绪再注册：服务不存在时不阻塞，只是不启用注入
      ctx.inject(['skills'], (scope) => {
        const skills = scope.skills ?? (typeof scope.get === 'function' ? scope.get('skills') : undefined)
        if (skills === undefined || skills === null || typeof skills.register !== 'function') {
          console.error('[git-daily-weekly-report] 技能服务不可用，报告总结设置不会生效')
          return
        }

        state.skills = skills
        refreshRuntimeSkill(state)
        state.snapshot = () => buildSnapshot(state)
        void verifyRuntimeSkill(state)

        scope.effect(() => () => {
          if (state.disposeSkill !== null) {
            const dispose = state.disposeSkill
            state.disposeSkill = null
            state.registered = false
            try {
              dispose()
            } catch (error) {
              console.error('[git-daily-weekly-report] 插件卸载时注销技能失败：', error)
            }
          }
        })
      })
    }
  } catch (error) {
    console.error('[git-daily-weekly-report] 初始化运行时技能失败：', error)
  }

  try {
    if (typeof ctx.inject === 'function') {
      // 官方调度来自可选 bundle：未启用时这次注入永远不会触发，设置页据此显示「未启用」
      // 并退回「复制指令」路径，而不是让创建按钮点了没反应
      ctx.inject(['schedule', 'sessionController'], (scope) => {
        const lookup = (name) => {
          const direct = scope[name]
          if (direct !== undefined) return direct
          return typeof scope.get === 'function' ? scope.get(name) : undefined
        }
        state.scheduleService = lookup('schedule') ?? null
        state.sessionController = lookup('sessionController') ?? null

        scope.effect(() => () => {
          state.scheduleService = null
          state.sessionController = null
        })
      })
    }
  } catch (error) {
    console.error('[git-daily-weekly-report] 初始化定时任务服务失败：', error)
  }

  try {
    setupHttpRoute(ctx, state)
  } catch (error) {
    console.error('[git-daily-weekly-report] 初始化设置接口失败：', error)
  }
}
