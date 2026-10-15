# 仓库公约

本文件约束在本仓库里协助维护的 agent。技能本身的执行步骤与写作规则在 `skills/git-daily-weekly-report/SKILL.md`，不在这里重复。

## 维护规则

- 执行步骤与风格规则只维护在 `skills/git-daily-weekly-report/`（正文在 `SKILL.md`，风格细节在 `references/report-style.md`），不要在 README、本文件或其他地方复制一份，避免多处漂移。
- 改 `SKILL.md` 时保持 frontmatter 只出现 Codex 白名单内的键（`name`、`description`、`license`、`allowed-tools`、`metadata`）：多出任何一个都会让 Codex 拒绝整个 skill；dsh 侧另要求 `name` 匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`、`description` 非空。
- 改动技能内容后，同步 `package.json` 与 `.codex-plugin/plugin.json` 两处 `version`，二者必须一致：前者决定 npm 版本，后者是 Codex 的插件缓存目录名。
- 发布走 tag：打 `vX.Y.Z` 后推送，`.github/workflows/publish.yml` 会校验 tag 与 `package.json` 的版本一致，已发布过的版本直接跳过。
- 待提交文件的编码保持 UTF-8 无 BOM，提交前检查乱码与冲突标记。
- `scripts/__pycache__/` 是 Python 运行缓存，已移入 `待删除/scripts-pycache/` 等待手工清理，不要提交，也不要在文档里引用它。
- `待删除/` 是待清理文件的暂存目录，被 `.gitignore` 忽略，不要提交。
- 仓库与 npm 包面向技能分发，不要往 `package.json` 的 `files` 白名单里加与运行无关的文件。

## 校验

改动后至少检查：

```bash
node --check index.js
node -e "JSON.parse(require('node:fs').readFileSync('package.json','utf8'))"
python skills/git-daily-weekly-report/scripts/fetch_git_commits.py --help
```

涉及 SKILL.md 里脚本调用路径的改动，还要确认 `references/` 与 `agents/` 的相对引用未被破坏。
