# git-daily-weekly-report

根据指定 Git 仓库在指定日期范围内的提交记录，生成可直接使用的个人中文日报或周报。

这个 skill 读取提交说明与文件变更，必要时补看 `git show --stat`，把同一主题的多笔提交合并成一条，最后按个人风格输出“今日工作总结”或“本周工作总结”：每条以动词开头、使用中文序号、只陈述实际完成的工作，不写汇报人、时间、计划等字段。没有提交时回退到工作区未提交改动，再回退到项目可见信息；都不足时如实说明，不编造成果。在 dsh 端，这些风格参数与推送通道都在设置页的「报告总结」里调整（页内分「报告设置」与「自动推送」两区）：生成好的正文可以按定时任务发到企业微信群机器人、任意 webhook 或邮箱，两处设置都不必改动技能文件。

## 安装

dsh（DeepSeek Harness）与 Codex 都有官方插件通道，两条通道装的是同一份 `skills/git-daily-weekly-report`，按你用的客户端选一条。

### 用 dsh 插件安装

包在 `package.json` 里声明了 `dsh.bundle`，可以直接走 dsh 自己的插件安装命令（包名带 `@chtholly-fan/` scope，技能名本身仍是 `git-daily-weekly-report`）：

```bash
dsh plugin --profile web add @chtholly-fan/git-daily-weekly-report
```

dsh 会把包装进该 profile 的 `node_modules`，并登记到 `dsh.profile.bundles`；profile 下次启动时，包内的 `index.js` 会把 `skills/git-daily-weekly-report` 植入 `$DSH_HOME/skills`（所有 profile 共享的用户级 skill 根），所以 web 与 desktop 装一次即可共用。

- 来源不限于 registry，GitHub 与本地 tarball 同样可以：`dsh plugin --profile web add ./chtholly-fan-git-daily-weekly-report-<版本>.tgz`
- desktop profile 由桌面应用独占管理，`dsh plugin --profile desktop add ...` 只在桌面版自带的 dsh 下放行，且应用运行时会撞上 profile 的文件锁；建议先完全退出应用，或改用应用内的插件市场安装。
- 如果 `$DSH_HOME/skills/git-daily-weekly-report` 已经存在、又不带本插件的版本戳，插件会跳过并在日志里说明，不会覆盖你现有的目录。

更新与卸载；应用内插件市场的更新按钮同理，装完要重启应用让插件重新植入：

```bash
dsh plugin --profile web update @chtholly-fan/git-daily-weekly-report
dsh plugin --profile web remove @chtholly-fan/git-daily-weekly-report
```

### 用 Codex 插件安装

仓库自带 `.codex-plugin/plugin.json`（技能入口）与 `.agents/plugins/marketplace.json`（市场清单），注册成 Codex 市场后即可安装：

```bash
codex plugin marketplace add ChthollyFan/git-daily-weekly-report --ref main
codex plugin add git-daily-weekly-report@git-daily-weekly-report
```

也可以只注册本地路径（`--ref` 仅对远端源有效）：

```bash
codex plugin marketplace add <本仓库路径>
```

更新要先刷新市场再重装：`.codex-plugin/plugin.json` 的 `version` 是插件缓存目录名，版本没变 Codex 不会替换文件。

```bash
codex plugin marketplace upgrade git-daily-weekly-report
codex plugin remove git-daily-weekly-report@git-daily-weekly-report
codex plugin add git-daily-weekly-report@git-daily-weekly-report
```

卸载：

```bash
codex plugin remove git-daily-weekly-report@git-daily-weekly-report
codex plugin marketplace remove git-daily-weekly-report
```

## 使用

技能触发后，向它提供仓库路径与日期即可，例如“用 git-daily-weekly-report 生成今天的日报”或“生成本周周报”。参数含义：

| 参数 | 说明 |
|------|------|
| `repo` | Git 仓库路径，缺省时若当前目录是 Git 仓库则用它 |
| `type` | `daily` 或 `weekly`，默认 `daily` |
| `date` | `YYYYMMDD` 或 `YYYY-MM-DD`，日报默认今天，周报作为范围结束日 |
| `days` | 周报最多回溯天数上限，默认 `7` |

脚本可以单独运行，输出是 JSON：

```bash
python skills/git-daily-weekly-report/scripts/fetch_git_commits.py --repo <repo> --type weekly --date 20260814 --days 7
```

返回结构包含 `ok`、`repo`、`type`、`ref`、`start`、`end`、`commits`（每笔含 `hash`、`subject`、`files` 等）与 `worktree`（未提交改动）。

## 设置页（仅 dsh web / desktop）

dsh 端装好后，设置页会多一个「报告总结」导航项。页内用「报告设置 | 自动推送」两个分区切换，顶栏显示当前插件版本与更新入口；两个分区各存各的配置。留空的字段沿用技能里的默认规则，填了才覆盖。

### 报告设置

| 分组 | 可配置项 |
|------|----------|
| 输出格式 | 日报标题、周报标题、序号格式、序号是否跨条连续、条与条之间是否空一行 |
| 写作规则 | 写作规则文本、日报与周报的条数上下限、是否强制动词开头 |
| 风格规则 | 替换 `report-style.md` 的风格规则正文 |
| 样例库 | 替换默认的样例文本 |
| 无提交时的兜底 | 替换兜底策略正文 |
| 额外提示词要求 | 纯追加的要求，不覆盖任何现有规则 |

设置保存在 `$DSH_HOME/git-daily-weekly-report/report-summary.json`。技能文件本身不会被改写：注入发生在技能被加载的那一刻，且只在 dsh 端生效——Codex 端仍使用 `skills/git-daily-weekly-report` 里的默认内容。面板上展示的默认值是从技能文件现读的，所以技能升级后默认值会跟着变。

把某一项清空并保存，等于回到技能默认；「恢复全部默认」会一次性清空所有覆盖项。

### 自动推送

同一页的「自动推送」分区负责三件事：存好推送通道的凭证、逐个通道试发验证、创建与管理定时任务。发送本身仍由技能脚本完成，面板不负责生成正文。

| 通道 | 需要的字段 | 说明 |
|------|-----------|------|
| 企业微信群机器人 | webhook 地址、消息类型 | 群设置里添加机器人后复制地址，`key` 就是全部凭证；超长正文自动分段发送 |
| 通用 webhook | URL、请求头、请求体模板 | 模板支持 `{{content}}`、`{{title}}`、`{{date}}`、`{{type}}`，可用于钉钉、飞书等 |
| 邮件 SMTP | 服务器、端口、加密方式、账号、授权码、收件人 | 支持 SSL / STARTTLS / 明文；QQ、163 这类邮箱要用授权码而非登录密码 |

配置保存在 `~/.git-daily-weekly-report/push-config.json`，是明文：里面的 webhook 地址、邮箱授权码等同于密码，别提交进仓库或分享出去。技能脚本读同一份文件，所以 Codex 端也能手工编辑它来推送。

每个通道卡片顶部有「测试此通道」，用当前填的内容（不必先保存）单独发一条固定测试消息，能在正式启用前确认该通道凭证是否可用；结果会显示在面板顶部，失败时带上具体原因。填错格式的邮箱地址会被自动忽略并提示。命令行方式验证：

```bash
python skills/git-daily-weekly-report/scripts/send_report.py --type daily --text "今日工作总结
1、完成推送联调" --dry-run
```

加 `--dry-run` 只做校验与组装、不发请求。去掉它就会真的发送，正文先归档到 `~/.git-daily-weekly-report/reports/<日期>-<类型>.md`，同一天重复推送会被拒绝，需要时加 `--force`。

定时任务可以直接在设置页创建：卡片上方显示承载会话（首次创建时自动新建一个落在「未分组」的会话，日报与周报共用），下面两个按钮分别创建日报、周报，任务列表里能看到已建的任务并逐条取消。到点后 dsh 把提醒投递到承载会话，agent 按技能步骤生成正文并调用 `send_report.py` 发送。创建失败或官方调度未启用时会弹出确认框，可把同一份指令复制给任意 dsh 会话，由模型代为创建。这条路依赖 dsh 的「自动化任务」能力，而它默认是关闭的，需要先在插件管理页启用带闹钟图标的「自动化任务」（或把 `@deepseek-ai/dsh-experimental-schedule-bundle` 加进 profile 的 `dsh.profile.bundles`）。任务绑定承载会话，且要求 dsh 宿主当时在运行；关机期间不会补跑。

### 版本与更新

顶栏的版本号取自本包 `package.json`。「检查更新」查 npm registry 上的最新版本，查不到只提示原因，不影响两个分区的读写。当前是实体包安装且确实有新版本时，按钮会变成「安装更新」，点了执行 `dsh plugin --profile <名字> add <包名>@<版本>`，装完要重启 dsh 才生效；安装还会把被 `dsh plugin add` 重写掉的加载列表补回去。

如果 `dependencies` 里写的是 `link:...`（开发链接形态，代码直接指向工作区），面板只提示而不会安装——那时直接在工作区 `git pull` 就是更新。

## 仓库内容

```text
package.json                      # npm 包元数据：dsh.bundle 指向 patch，dsh.client 指向设置面板
cordis.patch.yml                  # dsh bundle 的 patch 层，插入本包的 host 插件行
index.js                          # 该插件：植入技能，并接管设置页的读写、版本与更新接口
dsh/
├── client.js                     # 设置页面板：两个分区、版本号与更新按钮
├── push-config.js                # 自动推送配置模型、校验与定时指令生成
├── push-send.js                  # 调用推送脚本，解析并收窄其输出
└── report-summary.js             # 配置模型、技能默认值读取与注入渲染
.codex-plugin/
└── plugin.json                   # Codex 插件清单，skills 指向 ./skills/
.agents/
└── plugins/
    └── marketplace.json          # Codex 市场清单，source.path 指向仓库自身
skills/
└── git-daily-weekly-report/
    ├── SKILL.md                  # 技能正文：执行步骤与输出要求
    ├── agents/
    │   └── openai.yaml           # Codex 的界面元数据
    ├── references/
    │   ├── push-config.md        # 自动推送的配置字段与脚本调用契约
    │   └── report-style.md       # 日报/周报风格规则与样例
    └── scripts/
        ├── fetch_git_commits.py  # 采集提交与工作区改动，输出 JSON
        └── send_report.py        # 校验、归档并推送日报或周报
.github/
└── workflows/
    └── publish.yml               # 推 v* tag 自动发布到 npm
```

`SKILL.md` 提供主要工作流；`references/report-style.md` 在生成正文、需要判断写作风格时读取，`references/push-config.md` 在需要填写推送配置时读取；脚本按技能目录定位，可被 dsh、Codex 的任意安装位置调用。

## 使用范围

- 把当天或本周的 Git 提交整理成日报、周报、工作汇报或开发总结。
- 合并同一主题的多笔提交，避免逐条罗列无信息量的 commit message。
- 按用户既有日报风格输出，若运行时提供了更新版本的日报 CSV，以该 CSV 为风格来源。
- 不依据 Git 记录之外的推测补写工作内容；信息不足时向用户说明。
