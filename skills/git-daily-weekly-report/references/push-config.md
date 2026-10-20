# 自动推送配置

`scripts/send_report.py` 的配置字段与调用契约。执行步骤见 `SKILL.md`，风格规则见 `report-style.md`，本文只讲配置怎么写。

## 配置位置与生成

- 位置：`~/.git-daily-weekly-report/push-config.json`（Windows 形如 `C:\Users\<用户名>\.git-daily-weekly-report\push-config.json`）。
- dsh 端由设置页「自动推送」读写；Codex 端没有设置页，只能手工编辑同一个文件。
- 文件不存在时脚本只提示路径并以退出码 2 结束，不会自动创建：没填任何通道就创建配置，容易让人误以为已经开通。
- 需要一份带注释的骨架时执行 `python scripts/send_report.py --init-config`，它只在文件不存在时写入默认配置。
- 默认配置里所有开关都是关闭的，装好插件不会自发往外发任何东西。

## 顶层字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 整数 | 当前为 `1`，用于以后做迁移 |
| `enabled` | 布尔 | 自动推送总开关；为 `false` 时技能侧直接跳过推送 |
| `repo` | 文本 | 目标仓库绝对路径，定时任务的指令靠它认仓库 |
| `archiveDir` | 文本 | 归档目录，支持 `~/` 开头；留空用默认值 |
| `validation.enabled` | 布尔 | 发送前校验标题与序号，不合格直接拒发 |
| `runtime.pythonPath` | 文本 | 调用脚本用的解释器，默认 `python` |

## 企业微信群机器人

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否启用 |
| `webhookUrl` | 群设置 → 群机器人 → 添加后复制的地址，`key` 就是全部凭证 |
| `messageType` | `markdown` 或 `text` |
| `mentionAll` | 是否 `@所有人` |
| `mentionedList` | 要 `@` 的成员 ID 数组，可留空 |
| `mentionedMobileList` | 要 `@` 的手机号数组，可留空 |
| `maxBytes` | 单条消息字节上限，默认 `4000`（官方上限 4096，留出余量） |

正文超过 `maxBytes` 时按行切分后分多条发送，每条前面加 `(i/n)` 序号，条之间间隔 0.5 秒避开频率限制。

```json
{
  "enabled": true,
  "webhookUrl": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx",
  "messageType": "markdown",
  "mentionAll": false,
  "mentionedList": [],
  "mentionedMobileList": [],
  "maxBytes": 4000
}
```

## 自定义 Webhook

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否启用 |
| `url` | 只接受 `http://` 或 `https://` |
| `headers` | 附加请求头对象，用于钉钉、飞书这类需要 token 或签名的服务 |
| `bodyTemplate` | 请求体模板，默认 `{"text": "{{content}}"}` |
| `timeoutSeconds` | 单次请求超时，默认 `15` |

占位符在模板里替换，可混用：

| 占位符 | 替换为 |
| --- | --- |
| `{{content}}` | 报告正文（已做 JSON 字符串转义，模板里要自带外层引号） |
| `{{title}}` | `今日工作总结` 或 `本周工作总结` |
| `{{date}}` | `YYYY-MM-DD` |
| `{{type}}` | `daily` 或 `weekly` |

替换顺序是标题类在前、正文在后，所以正文里出现 `{{date}}` 这样的字面量不会被二次展开。

```json
{
  "enabled": true,
  "url": "https://example.com/hook",
  "headers": { "Content-Type": "application/json", "X-Token": "xxx" },
  "bodyTemplate": "{\"msgtype\": \"text\", \"text\": {\"content\": \"{{title}}（{{date}}）\\n{{content}}\"}}",
  "timeoutSeconds": 15
}
```

## 邮件 SMTP

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否启用 |
| `host` / `port` | 服务器地址与端口，SSL 常用 `465`，STARTTLS 常用 `587` |
| `security` | `ssl`、`starttls`、`none` |
| `username` / `password` | 账号与密码或授权码；QQ、163 这类邮箱必须用授权码 |
| `from` | 发件人，留空则用 `username` |
| `to` / `cc` | 收件人与抄送地址数组 |
| `subjectTemplate` | 主题模板，默认 `{{title}} - {{date}}`，同样支持 `{{type}}` |
| `html` | 为 `true` 时同时附一份 HTML 正文 |
| `timeoutSeconds` | 默认 `20` |

## 定时

`schedule` 段只存参数，真正的定时任务由 dsh 的调度能力承载。

| 字段 | 说明 |
| --- | --- |
| `daily.enabled` / `daily.time` / `daily.timeZone` | 日报开关、`HH:mm`、IANA 时区名 |
| `weekly.enabled` / `weekly.time` / `weekly.timeZone` | 周报开关与时间 |
| `weekly.weekdays` | ISO 星期数组（`1` 为周一），可多选 |
| `taskTitles.daily` / `taskTitles.weekly` | 显示在 dsh 任务列表里的标题 |

接入方式二选一，配置内容相同：

1. **dsh 内置调度**：设置页「自动推送」→ 复制创建指令 → 粘贴给任意 dsh 会话，由它调用调度工具创建任务。任务到点会向原会话投递一条提醒消息，agent 据此生成正文并推送。这种方式要求 dsh 宿主当时在运行。
2. **系统计划任务**：用 Windows 任务计划程序或 cron 定时执行 `dsh headless`，把同样的任务描述作为参数传入。关机期间不会补跑，重跑策略按宿主自身规则。

## 归档与去重

- 每次推送前把正文写到 `<archiveDir>/<YYYYMMDD>-<daily|weekly>.md`，便于回溯当天实际发出去的版本。
- 同一份归档文件已存在时直接以退出码 2 结束并说明原因，避免同一天重复刷屏；确实要重发时加 `--force`。
- `--no-archive` 跳过归档，`--dry-run` 既不写归档也不发请求。

## 退出码与回包

| 退出码 | 含义 |
| --- | --- |
| `0` | 所选通道全部发送成功 |
| `1` | 有通道失败，正文已归档 |
| `2` | 配置缺失、正文校验未通过或今天已推送过 |

stdout 固定输出一行 JSON，便于上层解析：

```json
{
  "ok": false,
  "type": "daily",
  "date": "2026-10-20",
  "title": "今日工作总结",
  "archived": "C:/Users/me/.git-daily-weekly-report/reports/20261020-daily.md",
  "channels": [{ "name": "wecom", "ok": false, "reason": "HTTP 400：invalid webhook url" }],
  "reason": "wecom：HTTP 400：invalid webhook url"
}
```

失败原因只回显打码后的目标（`key=***`），不会把完整 webhook 地址或密码写进日志。

## 常见失败原因

| 现象 | 多半是 |
| --- | --- |
| `没有任何已启用的推送通道` | 通道开关没开，或开了但关键字段为空 |
| `HTTP 404：invalid webhook url` | 企业微信 webhook 的 `key` 不对或机器人已被移除 |
| `HTTP 45009` 或频率报错 | 触发群机器人每分钟 20 条限制，减小 `maxBytes` 或减少分段 |
| `正文校验未通过` | 首行不是标题，或序号不是从 1 开始的连续编号 |
| `今天已推送过` | 已有同日归档，确认要重发时加 `--force` |
| 邮件 `SMTPAuthenticationError` | 用了登录密码而不是授权码，或服务端未开启 SMTP |
| 连接超时 | 公司网络限制了 465/587 出站，或本机代理拦截 |
