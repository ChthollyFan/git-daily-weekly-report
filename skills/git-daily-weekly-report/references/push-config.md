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
| `runtime.pythonPath` | 文本 | 设置页「测试此通道」试发时调用脚本用的解释器，默认 `python`；定时推送不读此字段 |

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

## 本地窗口推送

不走任何网络请求，也不依赖 Windows 通知服务：正文照常归档到本机后，用 Python 标准库 tkinter 在屏幕右下角弹一个置顶小窗，提示报告已归档，可一键用记事本打开归档文件。

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否启用；本通道没有目标地址，开关打开即可用 |
| `notifyTitleTemplate` | 窗口标题模板，默认 `{{title}} - {{date}}` |
| `includeExcerpt` | 为 `true` 时窗口正文里带一段报告摘要 |
| `openOnClick` | 为 `true` 时窗口带「打开报告」按钮，用记事本打开当天归档 |
| `closeAfterSeconds` | 自动关闭秒数，默认 `15`；`0` 表示不自动关 |

行为约定：

- 点开报告后窗口不会自动消失，而是停在「报告已在记事本中打开」的提示上，等用户看完自己点「关闭」。原因是脚本进程退出时，同一作业对象里的记事本会被连带清理（`CREATE_BREAKAWAY_FROM_JOB` 与 WMI 启动都被系统拒绝），所以只能让进程活到用户关窗为止。点开报告也会取消 `closeAfterSeconds` 的定时关闭。
- 归档目录下当天已有同名文件时，本通道复用已有文件继续弹窗，不报「今天已推送过」；换命令行走 `--force` 的语义不变。
- 只启用本通道时，自动推送默认就发到本地，不会产生任何外发内容。

## 定时

`schedule` 段存参数，也记录承载会话；真正的定时任务由 dsh 的调度能力承载。

日报与周报在调度层都用 `weekly` 选择器表达（官方没有「daily + 指定星期」的选择器），区别只在标题和任务指令，所以手动复制的指令里看到的也是 `kind=weekly`。

定时任务没有开关：有没有定时，完全由设置页里「创建」和「取消」任务决定，配置里只存参数。

| 字段 | 说明 |
| --- | --- |
| `daily.weekdays` | 日报发送日，ISO 星期数组；默认 `[1,2,3,4,5]`，勾满 `1-7` 就等于每天 |
| `daily.time` / `daily.timeZone` | 日报发送时刻 `HH:mm` 与 IANA 时区名 |
| `weekly.time` / `weekly.timeZone` | 周报发送时刻与时区 |

时区在设置页是下拉，只列中国常用值（上海、香港、澳门、台北、乌鲁木齐）；配置里写别的 IANA 名也照样能用，界面会把列表外的值作为一项补进下拉显示。
| `weekly.weekdays` | ISO 星期数组（`1` 为周一），可多选 |
| `taskTitles.daily` / `taskTitles.weekly` | 显示在 dsh 任务列表里的标题 |
| `session.id` / `session.cwd` / `session.createdAt` | 承载会话的 id、工作目录与创建时间；由设置页在首次建任务时自动写入，不必手填 |

接入方式：

1. **设置页直接创建**（推荐）：在「自动推送」→「定时任务」里点「创建日报定时任务」或「创建周报定时任务」。首次创建会自动新建一个落在「未分组」的承载会话，日报与周报共用；卡片下方列出已建任务，可逐条取消。
2. **手动粘贴指令**（只在直接创建失败时出现）：创建失败会弹出确认框，里面是完整指令和「确认 / 重试 / 取消」，点「确认」复制后粘给任意 dsh 会话，由它调用调度工具建任务。页面平时不再展示这段指令。

两种方式都要求先在插件管理页启用「自动化任务」bundle，且 dsh 宿主当时在运行；关机期间不会补跑，重启后只补发最近一次错过的时点。调度能力无法在 `dsh headless` 里单独挂载，所以系统计划任务那条路走不通。

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
