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

import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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
    weekdayText: describeWeekdays(config.schedule.weekly.weekdays),
    taskPrompts: {
      daily: buildTaskPrompt(config, 'daily'),
      weekly: buildTaskPrompt(config, 'weekly'),
    },
    scheduleInstruction: buildScheduleInstruction(config),
    warnings,
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

        if (!isPushMethod && state.snapshot === null) {
          send(503, { ok: false, saved: false, message: '技能服务尚未就绪，请稍后重试', snapshot: null })
          return
        }

        if (isPushMethod && state.pushSnapshot === null) {
          send(503, { ok: false, saved: false, message: '自动推送服务尚未就绪，请稍后重试', snapshot: null })
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

  const state = {
    configPath: resolveConfigPath(),
    pushConfigPath: resolvePushConfigPath(),
    skillDir: join(resolveSkillRoot(), SKILL_NAME),
    planted,
    skills: null,
    disposeSkill: null,
    registered: false,
    injected: false,
    guardHost: false,
    snapshot: null,
    pushSnapshot: null,
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
    setupHttpRoute(ctx, state)
  } catch (error) {
    console.error('[git-daily-weekly-report] 初始化设置接口失败：', error)
  }
}
