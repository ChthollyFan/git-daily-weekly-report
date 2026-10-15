#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按日期范围获取 Git 提交，输出 JSON 供日报或周报总结使用。"""

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path


def parse_date(value):
    raw = str(value).strip().replace("-", "").replace("/", "")
    if not re.fullmatch(r"\d{8}", raw):
        raise argparse.ArgumentTypeError("日期格式应为 YYYYMMDD 或 YYYY-MM-DD")
    try:
        return dt.date(int(raw[:4]), int(raw[4:6]), int(raw[6:8]))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"日期无效：{value}") from exc


def run_git(repo, args, check=True):
    command = ["git", "-C", str(repo), *args]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if check and completed.returncode != 0:
        message = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"git 命令执行失败：{' '.join(command)}\n{message}")
    return completed


def ensure_git_repo(repo):
    if not repo.exists():
        raise RuntimeError(f"仓库路径不存在：{repo}")
    if not repo.is_dir():
        raise RuntimeError(f"仓库路径不是目录：{repo}")
    completed = run_git(repo, ["rev-parse", "--is-inside-work-tree"])
    if completed.stdout.strip() != "true":
        raise RuntimeError(f"路径不是 Git 工作树：{repo}")


def local_timezone():
    return dt.datetime.now().astimezone().tzinfo


def git_since(start):
    start_dt = dt.datetime.combine(start, dt.time(0, 0, 0), tzinfo=local_timezone())
    return (start_dt - dt.timedelta(seconds=1)).isoformat()


def git_until(end):
    end_dt = dt.datetime.combine(end, dt.time(23, 59, 59), tzinfo=local_timezone())
    return end_dt.isoformat()


def weekly_start(report_date, max_days):
    """
    @brief 计算周报起始日期：从结束日回溯到最近的星期一，而非固定回看若干天
    @param report_date 周报结束日期，本身计入范围
    @param max_days 最多回溯天数上限，起始日不早于 report_date-(max_days-1)
    @return 周报起始日期
    @note 结束日为星期一时起始日即当天；回溯天数超过上限时按上限截断
    """
    # 星期一的 weekday() 为 0，故回溯天数即当天是星期几的序号，上限用于约束跨周跨度
    days_back = min(report_date.weekday(), max_days - 1)
    return report_date - dt.timedelta(days=days_back)


def fetch_files(repo, commit_hash, max_files):
    completed = run_git(
        repo,
        ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit_hash],
        check=False,
    )
    if completed.returncode != 0:
        return []
    files = [name for name in completed.stdout.split("\x00") if name]
    return files[:max_files]


def fetch_commits(repo, start, end, ref, max_files):
    completed = run_git(repo, ["rev-parse", "--verify", "--quiet", ref], check=False)
    if completed.returncode != 0:
        return []

    fmt = "%H%x00%cI%x00%aI%x00%an%x00%ae%x00%s"
    completed = run_git(
        repo,
        [
            "log",
            f"--since={git_since(start)}",
            f"--until={git_until(end)}",
            "--date=iso-strict",
            f"--pretty=format:{fmt}",
            ref,
        ],
    )

    commits = []
    for line in completed.stdout.splitlines():
        parts = line.split("\x00")
        if len(parts) < 6:
            continue
        commit_hash, commit_date, author_date, author, email, subject = parts[:6]
        commits.append(
            {
                "hash": commit_hash,
                "date": commit_date,
                "author_date": author_date,
                "author": author,
                "email": email,
                "subject": subject,
                "files": fetch_files(repo, commit_hash, max_files),
            }
        )
    return commits


def fetch_worktree_changes(repo):
    changed = []
    commands = [
        ["diff", "--cached", "--name-only", "-z"],
        ["diff", "--name-only", "-z"],
        ["ls-files", "--others", "--exclude-standard", "-z"],
    ]
    for command in commands:
        completed = run_git(repo, command, check=False)
        if completed.returncode not in (0, 1):
            continue
        changed.extend(name for name in completed.stdout.split("\x00") if name)
    changed = list(dict.fromkeys(changed))
    return {"dirty": bool(changed), "changed_files": changed}


def main():
    parser = argparse.ArgumentParser(description="获取 Git 提交记录并输出 JSON。")
    parser.add_argument(
        "--repo",
        type=Path,
        default=Path.cwd(),
        help="Git 仓库路径，默认当前目录",
    )
    parser.add_argument(
        "--type",
        choices=["daily", "weekly"],
        default="daily",
        help="daily 或 weekly",
    )
    parser.add_argument(
        "--date",
        type=parse_date,
        default=None,
        help="日期 YYYYMMDD 或 YYYY-MM-DD，默认今天",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="周报最多回溯天数上限，默认 7，起始日取最近一个星期一",
    )
    parser.add_argument("--ref", default="HEAD", help="Git ref，默认 HEAD")
    parser.add_argument(
        "--max-files",
        type=int,
        default=200,
        help="每笔提交最多输出的文件数",
    )
    args = parser.parse_args()

    try:
        repo = args.repo.expanduser().resolve()
        ensure_git_repo(repo)
        if args.days < 1:
            raise ValueError("--days 必须大于等于 1")

        report_date = args.date or dt.date.today()
        if args.type == "daily":
            start = end = report_date
        else:
            end = report_date
            # 周报起点按星期判断，回溯到最近一个星期一，不再盲目取过去 days 天
            start = weekly_start(report_date, args.days)

        commits = fetch_commits(repo, start, end, args.ref, args.max_files)
        worktree = fetch_worktree_changes(repo)
    except Exception as exc:
        print(
            json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False),
            file=sys.stderr,
        )
        sys.exit(1)

    output = {
        "ok": True,
        "repo": str(repo),
        "type": args.type,
        "ref": args.ref,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "commits": commits,
        "worktree": worktree,
    }
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
