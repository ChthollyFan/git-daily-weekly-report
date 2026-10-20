// dsh/push-send.js —— 设置页「测试发送」调用 send_report.py 的部分。
//
// 职责边界：只负责把子进程拉起、收口输出、把失败翻译成可读原因。它不读配置、
// 不判断通道是否可用——那些由 dsh/push-config.js 与脚本自身负责。
//
// 安全约束：这里只接受调用方拼好的固定参数，不接受前端传来的自由命令行片段，
// 避免设置页被当成任意命令执行入口。

import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** 回显给前端的日志截断长度，够看失败原因又不至于把面板撑爆 */
export const TRUNCATE_CHARS = 4000

/** 子进程最长运行时间，超过就强杀，避免面板一直转圈 */
const DEFAULT_TIMEOUT_MS = 60000

/** 测试发送用的固定正文：必须自带标题与连续序号，否则会被脚本的校验分支拦下 */
export const TEST_REPORT_TEXT = [
  '今日工作总结',
  '1、测试自动推送功能是否可用。',
  '2、验证通道参数配置是否正确。',
].join('\n')

/**
 * @brief 计算脚本路径
 * @param skillDir 已植入的技能目录
 * @return send_report.py 的绝对路径
 */
export function resolveScriptPath(skillDir) {
  return join(skillDir, 'scripts', 'send_report.py')
}

/**
 * @brief 把文本截断到可回显长度
 * @param text 原始文本
 * @return 截断后的文本，超长时附带说明
 */
function truncate(text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value.length <= TRUNCATE_CHARS) return value
  return `${value.slice(0, TRUNCATE_CHARS)}\n…（已截断，共 ${value.length} 字符）`
}

/**
 * @brief 尝试从 stdout 里解出脚本的 JSON 结果
 * @param stdout 子进程标准输出
 * @return 解析成功时返回对象，否则返回 null
 * @note 脚本约定 stdout 单行 JSON，但 stderr 的诊断信息不参与解析
 */
function parseResult(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * @brief 运行一次 send_report.py
 * @param options.pythonPath Python 解释器名或绝对路径
 * @param options.scriptPath send_report.py 的绝对路径
 * @param options.args 传给脚本的参数数组
 * @param options.timeoutMs 超时毫秒数
 * @return { ok, exitCode, stdout, stderr, result, reason }
 *         ok 为 true 表示退出码为 0；result 为脚本回包解析结果（可能为 null）
 * @note spawn 失败（如解释器不在 PATH）也走同一返回结构，reason 里给出 ENOENT 之类的说明
 */
export function runSendReport(options) {
  const pythonPath = String(options.pythonPath ?? 'python')
  const scriptPath = String(options.scriptPath ?? '')
  const args = Array.isArray(options.args) ? options.args.map((arg) => String(arg)) : []
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve(payload)
    }

    let child
    try {
      child = spawn(pythonPath, [scriptPath, ...args], {
        // 用管道收输出，便于把失败原因原样回显到面板
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        result: null,
        reason: `无法启动 Python：${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }

    // 超时强杀：脚本里网络请求自己也有超时，这里的兜底只为防脚本卡在别处
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 进程已退出时忽略
      }
      finish({
        ok: false,
        exitCode: null,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        result: parseResult(stdout),
        reason: `执行超过 ${Math.round(timeoutMs / 1000)} 秒，已终止`,
      })
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })

    child.on('error', (error) => {
      clearTimeout(timer)
      finish({
        ok: false,
        exitCode: null,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        result: null,
        reason: `无法启动 Python（${pythonPath}）：${error instanceof Error ? error.message : String(error)}`,
      })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const parsed = parseResult(stdout)
      const ok = code === 0
      let reason = ''
      if (!ok) {
        if (parsed !== null && typeof parsed.reason === 'string') {
          reason = parsed.reason
        } else {
          // 脚本失败时原因通常在 stderr 最后几行，取尾部更省阅读成本
          const tail = stderr.trim().split(/\r?\n/).slice(-4).join('\n')
          reason = tail === '' ? `脚本退出码 ${code}` : tail
        }
      }
      finish({
        ok,
        exitCode: code,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        result: parsed,
        reason,
      })
    })
  })
}
