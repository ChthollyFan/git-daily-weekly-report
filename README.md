# git-daily-weekly-report

根据指定 Git 仓库在指定日期范围内的提交记录，生成可直接使用的个人中文日报或周报。

这个 skill 读取提交说明与文件变更，必要时补看 `git show --stat`，把同一主题的多笔提交合并成一条，最后按个人风格输出“今日工作总结”或“本周工作总结”：每条以动词开头、使用中文序号、只陈述实际完成的工作，不写汇报人、时间、计划等字段。没有提交时回退到工作区未提交改动，再回退到项目可见信息；都不足时如实说明，不编造成果。

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

## 仓库内容

```text
package.json                      # npm 包元数据：dsh.bundle 指向 patch
cordis.patch.yml                  # dsh bundle 的 patch 层，插入本包的 host 插件行
index.js                          # 该插件：把随包技能植入 $DSH_HOME/skills
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
    │   └── report-style.md       # 日报/周报风格规则与样例
    └── scripts/
        └── fetch_git_commits.py  # 采集提交与工作区改动，输出 JSON
.github/
└── workflows/
    └── publish.yml               # 推 v* tag 自动发布到 npm
```

`SKILL.md` 提供主要工作流；`references/report-style.md` 在生成正文、需要判断写作风格时读取；脚本按技能目录定位，可被 dsh、Codex 的任意安装位置调用。

## 使用范围

- 把当天或本周的 Git 提交整理成日报、周报、工作汇报或开发总结。
- 合并同一主题的多笔提交，避免逐条罗列无信息量的 commit message。
- 按用户既有日报风格输出，若运行时提供了更新版本的日报 CSV，以该 CSV 为风格来源。
- 不依据 Git 记录之外的推测补写工作内容；信息不足时向用户说明。
