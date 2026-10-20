#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把日报或周报正文推送到已配置的通道，并把正文归档到本地。

推送配置位于 ~/.git-daily-weekly-report/push-config.json，由 dsh 设置页
「自动推送」维护，也可以直接手工编辑。没有配置文件时脚本只提示路径，不会
擅自创建，避免用户在没填任何通道的情况下以为已经开通。

只依赖标准库：企业微信群机器人与通用 webhook 用 urllib，邮件用 smtplib。
"""

import argparse
import datetime as dt
import json
import os
import re
import smtplib
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from email.utils import formatdate
from pathlib import Path

# 与 dsh/push-config.js 保持一致的目录与文件名约定
CONFIG_DIRNAME = ".git-daily-weekly-report"
CONFIG_FILENAME = "push-config.json"

# 企业微信单条消息官方上限 4096 字节，这里取 4000 留出余量
DEFAULT_MAX_BYTES = 4000

# 分段前缀 (i/n) 的最大占用，切分时先扣掉它，避免加前缀后再次超限
SEGMENT_PREFIX_RESERVE = 12

# 退出码：0 全部成功，1 有通道失败，2 配置或校验问题
EXIT_OK = 0
EXIT_CHANNEL_FAILED = 1
EXIT_CONFIG_OR_VALIDATION = 2

# 报告标题由类型推导，同时也用在校验与邮件主题里
REPORT_TITLES = {"daily": "今日工作总结", "weekly": "本周工作总结"}


def configure_stdout():
    """
    @brief 把标准输出切到 UTF-8
    @note Windows 控制台默认代码页不是 UTF-8，不切会导致中文乱码或编码异常；
          重定向到文件或管道时 reconfigure 可能不被支持，失败就保持原样
    """
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass


def config_path():
    """
    @brief 计算默认配置路径
    @return 配置文件的 Path 对象
    """
    return Path.home() / CONFIG_DIRNAME / CONFIG_FILENAME


def default_config():
    """
    @brief 构造一份内置默认配置
    @return 与 dsh 设置页默认值同构的字典
    @note 时区在 Python 侧取不到可靠的 IANA 名，先用 Asia/Shanghai 占位，
          用户在设置页保存后会被替换成本机时区
    """
    return {
        "schemaVersion": 1,
        "enabled": False,
        "repo": "",
        "archiveDir": "~/{}/reports".format(CONFIG_DIRNAME),
        "validation": {"enabled": True},
        "runtime": {"pythonPath": "python"},
        "channels": {
            "wecom": {
                "enabled": False,
                "webhookUrl": "",
                "messageType": "markdown",
                "mentionAll": False,
                "mentionedList": [],
                "mentionedMobileList": [],
                "maxBytes": DEFAULT_MAX_BYTES,
            },
            "webhook": {
                "enabled": False,
                "url": "",
                "headers": {},
                "bodyTemplate": '{"text": "{{content}}"}',
                "timeoutSeconds": 15,
            },
            "smtp": {
                "enabled": False,
                "host": "",
                "port": 465,
                "security": "ssl",
                "username": "",
                "password": "",
                "from": "",
                "to": [],
                "cc": [],
                "subjectTemplate": "{{title}} - {{date}}",
                "html": False,
                "timeoutSeconds": 20,
            },
        },
        "schedule": {
            "daily": {"enabled": False, "time": "18:00", "timeZone": "Asia/Shanghai"},
            "weekly": {"enabled": False, "weekdays": [5], "time": "18:00", "timeZone": "Asia/Shanghai"},
            "taskTitles": {"daily": "每日工作日报", "weekly": "每周工作周报"},
        },
    }


def load_config(path):
    """
    @brief 读取并浅层合并配置
    @param path 配置文件路径
    @return (配置字典, 错误说明或 None)
    @note 合并只做一层：通道与 schedule 段缺失时用默认值补齐，已有字段原样保留，
          这样脚本不需要复刻 js 侧的完整校验逻辑
    """
    if not path.exists():
        return None, "配置文件不存在：{}\n可先用 --init-config 生成模板，或在 dsh 设置页「自动推送」里保存一次".format(path)

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        return None, "无法读取配置文件 {}：{}".format(path, exc)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, "配置文件不是合法 JSON（{}）：{}".format(path, exc)

    if not isinstance(parsed, dict):
        return None, "配置文件顶层不是对象：{}".format(path)

    return merge_config(parsed), None


def merge_config(raw):
    """
    @brief 把读到的配置合并到默认结构上
    @param raw 磁盘上的配置对象
    @return 合并后的配置
    """
    config = default_config()

    for key in ("enabled", "repo", "archiveDir"):
        if key in raw and isinstance(raw[key], (bool, str)):
            config[key] = raw[key]

    if isinstance(raw.get("validation"), dict) and isinstance(raw["validation"].get("enabled"), bool):
        config["validation"]["enabled"] = raw["validation"]["enabled"]

    if isinstance(raw.get("runtime"), dict) and isinstance(raw["runtime"].get("pythonPath"), str):
        config["runtime"]["pythonPath"] = raw["runtime"]["pythonPath"]

    channels = raw.get("channels")
    if isinstance(channels, dict):
        for name in ("wecom", "webhook", "smtp"):
            section = channels.get(name)
            if isinstance(section, dict):
                config["channels"][name].update(section)

    schedule = raw.get("schedule")
    if isinstance(schedule, dict):
        for name in ("daily", "weekly"):
            section = schedule.get(name)
            if isinstance(section, dict):
                config["schedule"][name].update(section)
        titles = schedule.get("taskTitles")
        if isinstance(titles, dict):
            config["schedule"]["taskTitles"].update(titles)

    return config


def mask_url(url):
    """
    @brief 把地址里的查询参数值替换成 ***
    @param url 原始地址
    @return 打码后的地址
    @note 企业微信 webhook 的 key 在 query 里，日志与回显一律用它，避免泄露到终端
    """
    try:
        parsed = urllib.parse.urlsplit(str(url))
        if parsed.query == "":
            return "{}://{}{}".format(parsed.scheme, parsed.netloc, parsed.path)
        parts = []
        for piece in parsed.query.split("&"):
            name = piece.split("=", 1)[0]
            parts.append("{}***".format(name + "=" if name else ""))
        return "{}://{}{}?{}".format(parsed.scheme, parsed.netloc, parsed.path, "&".join(parts))
    except ValueError:
        return "(无法解析的地址)"


def first_non_empty_line(text):
    """
    @brief 取首个非空行
    @param text 正文
    @return 去掉首尾空白的首行内容，全为空时返回空串
    """
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def find_item_numbers(text):
    """
    @brief 收集正文里所有形如「1、」的序号
    @param text 正文
    @return 按出现顺序排列的整数列表
    @note 只认中文顿号的序号格式，与技能输出要求一致
    """
    numbers = []
    for line in text.splitlines():
        match = re.match(r"^\s*(\d+)、", line)
        if match is not None:
            numbers.append(int(match.group(1)))
    return numbers


def validate_content(text, report_type):
    """
    @brief 校验正文是否符合技能的输出约定
    @param text 正文
    @param report_type daily 或 weekly
    @return 错误说明列表，空列表表示通过
    @note 只校验能机械判断的两项：标题与序号，风格细节交给模型
    """
    errors = []
    title = REPORT_TITLES[report_type]

    first = first_non_empty_line(text)
    if first == "":
        errors.append("正文为空")
        return errors
    if title not in first:
        errors.append("首行应包含标题「{}」，实际为「{}」".format(title, first[:40]))

    numbers = find_item_numbers(text)
    if len(numbers) < 2:
        errors.append("只识别到 {} 条「1、」形式的序号内容，至少需要 2 条".format(len(numbers)))
    elif numbers != list(range(1, len(numbers) + 1)):
        errors.append("序号应为 1 到 {} 连续递增，实际为 {}".format(len(numbers), numbers))

    return errors


def split_long_line(line, budget):
    """
    @brief 把超长单行按字符切成多段
    @param line 原始行
    @param budget 每段的字节预算
    @return 切好的字符串列表
    @note 按字符累加字节数，不会切断多字节字符
    """
    pieces = []
    current = []
    size = 0
    for char in line:
        char_bytes = len(char.encode("utf-8"))
        if size + char_bytes > budget and current:
            pieces.append("".join(current))
            current = []
            size = 0
        current.append(char)
        size += char_bytes
    if current:
        pieces.append("".join(current))
    return pieces


def split_message(text, max_bytes):
    """
    @brief 按字节上限把正文切成多段
    @param text 正文
    @param max_bytes 单条消息的字节上限
    @return 段落列表，多段时每段带 (i/n) 前缀
    @note 优先在行边界切分，只有单行本身超限时才硬切，保证每段都能被企业微信接受
    """
    limit = max(int(max_bytes), 256)
    budget = limit - SEGMENT_PREFIX_RESERVE

    segments = []
    current = []
    current_size = 0

    for line in text.splitlines():
        line_size = len(line.encode("utf-8")) + 1
        if line_size > budget:
            if current:
                segments.append("\n".join(current))
                current = []
                current_size = 0
            segments.extend(split_long_line(line, budget))
            continue
        if current_size + line_size > budget and current:
            segments.append("\n".join(current))
            current = []
            current_size = 0
        current.append(line)
        current_size += line_size

    if current:
        segments.append("\n".join(current))
    if not segments:
        segments = [""]

    total = len(segments)
    if total == 1:
        return segments
    return ["({}/{}) {}".format(index, total, segment) for index, segment in enumerate(segments, 1)]


def build_wecom_payload(channel, content):
    """
    @brief 组装企业微信消息体
    @param channel 企业微信通道配置
    @param content 该段的正文
    @return 可直接 POST 的字典
    @note markdown 类型对 @ 的支持有限，mentionAll 只追加 <@all> 标记；
          需要可靠的 @ 效果时应把消息类型切成 text
    """
    if channel.get("messageType") == "text":
        text = {"content": content}
        mentioned = [str(item) for item in channel.get("mentionedList") or []]
        mobiles = [str(item) for item in channel.get("mentionedMobileList") or []]
        if channel.get("mentionAll"):
            mentioned = ["@all"] + mentioned
        if mentioned:
            text["mentioned_list"] = mentioned
        if mobiles:
            text["mentioned_mobile_list"] = mobiles
        return {"msgtype": "text", "text": text}

    body = content
    if channel.get("mentionAll"):
        body = "{}\n<@all>".format(content)
    return {"msgtype": "markdown", "markdown": {"content": body}}


def post_json(url, payload, headers=None, timeout=15):
    """
    @brief 发一个 JSON POST 请求
    @param url 目标地址
    @param payload 请求体字典
    @param headers 附加请求头
    @param timeout 超时秒数
    @return (状态码, 响应文本)
    """
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST")
    request.add_header("Content-Type", "application/json; charset=utf-8")
    for key, value in (headers or {}).items():
        request.add_header(str(key), str(value))
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read().decode("utf-8", errors="replace")


def send_wecom(channel, content, dry_run):
    """
    @brief 推送到企业微信群机器人
    @param channel 通道配置
    @param content 正文
    @param dry_run 为真时只算分段不发送
    @return 该通道的结果字典
    """
    url = str(channel.get("webhookUrl") or "")
    if url == "":
        return {"name": "wecom", "ok": False, "reason": "未配置 Webhook 地址"}

    segments = split_message(content, channel.get("maxBytes") or DEFAULT_MAX_BYTES)
    if dry_run:
        return {
            "name": "wecom",
            "ok": True,
            "dryRun": True,
            "segments": len(segments),
            "target": mask_url(url),
        }

    for index, segment in enumerate(segments, 1):
        payload = build_wecom_payload(channel, segment)
        try:
            _, body = post_json(url, payload, timeout=15)
        except urllib.error.HTTPError as exc:
            detail = exc.read(512).decode("utf-8", errors="replace")
            return {"name": "wecom", "ok": False, "reason": "第 {} 段 HTTP {}：{}".format(index, exc.code, detail)}
        except Exception as exc:  # 网络错误、DNS 失败、超时都归到这里
            return {"name": "wecom", "ok": False, "reason": "第 {} 段发送失败：{}".format(index, exc)}

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return {"name": "wecom", "ok": False, "reason": "第 {} 段回包不是 JSON：{}".format(index, body[:200])}

        errcode = data.get("errcode")
        if errcode != 0:
            return {
                "name": "wecom",
                "ok": False,
                "reason": "第 {} 段被拒：errcode={} errmsg={}".format(index, errcode, data.get("errmsg")),
            }

        # 企业微信限流 20 条/分钟，段与段之间留出间隔
        if index < len(segments):
            time.sleep(0.5)

    return {"name": "wecom", "ok": True, "segments": len(segments)}


def send_webhook(channel, content, report_type, report_date, dry_run):
    """
    @brief 推送到通用 webhook
    @param channel 通道配置
    @param content 正文
    @param report_type daily 或 weekly
    @param report_date 报告日期
    @param dry_run 为真时只组装请求体不发送
    @return 该通道的结果字典
    @note 正文替换前先做 JSON 字符串转义，因此模板里的占位符应当自带外层引号；
          标题、日期与类型按纯文本替换，供钉钉、飞书这类需要正文自带标题的服务使用
    """
    url = str(channel.get("url") or "")
    if url == "":
        return {"name": "webhook", "ok": False, "reason": "未配置 URL"}

    template = str(channel.get("bodyTemplate") or '{"text": "{{content}}"}')
    escaped = json.dumps(content, ensure_ascii=False)[1:-1]
    # 先换标题类占位符、最后换正文：正文里若恰好出现 {{date}} 这类字样，
    # 反过来替换会被二次展开，把用户写的文字改掉
    body = template.replace("{{title}}", REPORT_TITLES[report_type])
    body = body.replace("{{date}}", report_date.isoformat())
    body = body.replace("{{type}}", report_type)
    body = body.replace("{{content}}", escaped)

    if dry_run:
        return {
            "name": "webhook",
            "ok": True,
            "dryRun": True,
            "target": mask_url(url),
            "bytes": len(body.encode("utf-8")),
        }

    timeout = channel.get("timeoutSeconds") or 15
    request = urllib.request.Request(url, data=body.encode("utf-8"), method="POST")
    request.add_header("Content-Type", "application/json; charset=utf-8")
    for key, value in (channel.get("headers") or {}).items():
        request.add_header(str(key), str(value))

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            preview = response.read(512).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read(512).decode("utf-8", errors="replace")
        return {"name": "webhook", "ok": False, "reason": "HTTP {}：{}".format(exc.code, detail)}
    except Exception as exc:
        return {"name": "webhook", "ok": False, "reason": str(exc)}

    ok = 200 <= status < 300
    result = {"name": "webhook", "ok": ok, "status": status}
    if not ok:
        result["reason"] = "HTTP {}：{}".format(status, preview[:200])
    return result


def filter_emails(items):
    """
    @brief 过滤掉不像邮箱的地址
    @param items 原始地址列表
    @return 合法地址列表（去重且保持原顺序）
    @note 与 dsh 侧 coerceEmailArray 保持同一口径：含 @、@ 两侧非空、无空白字符。
          设置页保存时已经过滤过一遍，这里是兜底：手改配置文件或旧配置里的脏地址
          会在 RCPT 阶段被服务器拒掉，导致整封邮件发不出去
    """
    result = []
    for item in items or []:
        text = str(item or "").strip()
        at = text.find("@")
        if at <= 0 or at >= len(text) - 1 or any(ch.isspace() for ch in text):
            continue
        if text not in result:
            result.append(text)
    return result


def build_mail(config, channel, content, report_type, report_date):
    """
    @brief 组装邮件对象
    @param config 完整配置
    @param channel SMTP 通道配置
    @param content 正文
    @param report_type daily 或 weekly
    @param report_date 报告日期
    @return EmailMessage 对象
    """
    title = REPORT_TITLES[report_type]
    subject = str(channel.get("subjectTemplate") or "{{title}} - {{date}}")
    subject = subject.replace("{{title}}", title)
    subject = subject.replace("{{date}}", report_date.isoformat())
    subject = subject.replace("{{type}}", report_type)

    sender = str(channel.get("from") or channel.get("username") or "")
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = ", ".join(filter_emails(channel.get("to")))
    cc = filter_emails(channel.get("cc"))
    if cc:
        message["Cc"] = ", ".join(cc)
    message["Date"] = formatdate(localtime=True)

    if channel.get("html"):
        # 纯文本先转义再按行加 <br>，避免正文里的尖括号被当成标签
        escaped = (
            content.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\n", "<br>\n")
        )
        message.set_content(content)
        message.add_alternative(
            '<html><body style="font-family:sans-serif;font-size:14px;line-height:1.7">{}</body></html>'.format(escaped),
            subtype="html",
        )
    else:
        message.set_content(content)

    return message


def send_smtp(config, channel, content, report_type, report_date, dry_run):
    """
    @brief 通过 SMTP 发送邮件
    @param config 完整配置
    @param channel 通道配置
    @param content 正文
    @param report_type daily 或 weekly
    @param report_date 报告日期
    @param dry_run 为真时只组装邮件不连接服务器
    @return 该通道的结果字典
    """
    host = str(channel.get("host") or "")
    # 非法地址在这里就剔掉：带进 send_message 会让服务器在 RCPT 阶段整封拒收
    recipients = filter_emails(channel.get("to"))
    if host == "" or not recipients:
        return {"name": "smtp", "ok": False, "reason": "未配置 SMTP 主机或收件人"}

    port = int(channel.get("port") or 465)
    security = str(channel.get("security") or "ssl")
    timeout = channel.get("timeoutSeconds") or 20

    if dry_run:
        return {
            "name": "smtp",
            "ok": True,
            "dryRun": True,
            "target": "{}:{}".format(host, port),
            "recipients": len(recipients),
        }

    message = build_mail(config, channel, content, report_type, report_date)
    cc = filter_emails(channel.get("cc"))

    server = None
    try:
        if security == "ssl":
            server = smtplib.SMTP_SSL(host, port, timeout=timeout, context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(host, port, timeout=timeout)
            if security == "starttls":
                server.starttls(context=ssl.create_default_context())

        username = str(channel.get("username") or "")
        if username != "":
            server.login(username, str(channel.get("password") or ""))

        server.send_message(message, to_addrs=recipients + cc)
    except Exception as exc:
        return {"name": "smtp", "ok": False, "reason": "{}".format(exc)}
    finally:
        if server is not None:
            try:
                server.quit()
            except Exception:
                pass

    return {"name": "smtp", "ok": True, "recipients": len(recipients)}


def list_enabled_channels(config):
    """
    @brief 列出开关打开且关键字段已填的通道
    @param config 完整配置
    @return 通道名列表，顺序固定为 wecom、webhook、smtp
    @note 与 dsh 侧的判断保持一致：半配置的通道不参与自动发送，免得必然失败
    """
    channels = config.get("channels") or {}
    wecom = channels.get("wecom") or {}
    webhook = channels.get("webhook") or {}
    smtp = channels.get("smtp") or {}

    names = []
    if wecom.get("enabled") and str(wecom.get("webhookUrl") or "") != "":
        names.append("wecom")
    if webhook.get("enabled") and str(webhook.get("url") or "") != "":
        names.append("webhook")
    if smtp.get("enabled") and str(smtp.get("host") or "") != "" and (smtp.get("to") or []):
        names.append("smtp")
    return names


def archive_report(config, content, report_type, report_date, force, no_archive, dry_run):
    """
    @brief 把正文归档为本地文件
    @param config 完整配置
    @param content 正文
    @param report_type daily 或 weekly
    @param report_date 报告日期
    @param force 为真时覆盖同名归档
    @param no_archive 为真时跳过归档
    @param dry_run 为真时只算出目标路径不落盘
    @return (归档路径或 None, 冲突说明或 None)
    @note 「同日已归档」算致命冲突（防止重复推送刷屏）；纯写入失败只打警告，
          不影响推送本身
    """
    if no_archive:
        return None, None

    raw_dir = str(config.get("archiveDir") or "~/{}/reports".format(CONFIG_DIRNAME))
    directory = Path(os.path.expanduser(raw_dir))
    target = directory / "{}-{}.md".format(report_date.strftime("%Y%m%d"), report_type)

    if target.exists() and not force:
        return None, "今天已推送过（{}），如需重发请加 --force".format(target)

    if dry_run:
        return str(target), None

    try:
        directory.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name + ".tmp")
        temp.write_text(content.rstrip("\n") + "\n", encoding="utf-8")
        temp.replace(target)
    except OSError as exc:
        print("归档写入失败（已继续推送）：{}".format(exc), file=sys.stderr)
        return None, None

    return str(target), None


def read_content(args):
    """
    @brief 按参数取正文
    @param args 命令行参数
    @return (正文, 错误说明或 None)
    """
    if args.text is not None:
        return args.text, None

    if args.file is not None:
        if args.file == "-":
            return sys.stdin.read(), None
        try:
            return Path(os.path.expanduser(args.file)).read_text(encoding="utf-8"), None
        except OSError as exc:
            return None, "无法读取正文文件 {}：{}".format(args.file, exc)

    if args.positional_text == "-":
        return sys.stdin.read(), None
    if args.positional_text:
        return args.positional_text, None

    return None, "没有正文：请用 --file <路径>、--file -、--text <正文> 或单独的 - 从标准输入读取"


def build_parser():
    """
    @brief 构造命令行解析器
    @return ArgumentParser 实例
    """
    parser = argparse.ArgumentParser(
        description="把日报或周报正文推送到企业微信、通用 webhook 或邮件，并归档到本地。",
    )
    parser.add_argument("--type", choices=["daily", "weekly"], default="daily", help="报告类型，默认 daily")
    parser.add_argument("--file", default=None, help="正文文件路径，- 表示从标准输入读取")
    parser.add_argument("--text", default=None, help="直接给定正文")
    parser.add_argument(
        "--channel",
        action="append",
        choices=["wecom", "webhook", "smtp"],
        default=None,
        help="只发指定通道，可重复；不传则发送所有已启用的通道",
    )
    # help 里用正斜杠拼接：os.path.join 在 Windows 上会渲染成反斜杠，与其他文档写法不一致
    parser.add_argument("--config", default=None, help="配置文件路径，默认 ~/{}/{}".format(
        CONFIG_DIRNAME, CONFIG_FILENAME))
    parser.add_argument("--repo", default=None, help="仓库路径，仅用于回显与将来扩展")
    parser.add_argument("--force", action="store_true", help="跳过正文校验与同日重复归档检查")
    parser.add_argument("--dry-run", action="store_true", help="只做校验与组装，不发起任何网络请求")
    parser.add_argument("--no-archive", action="store_true", help="不写归档文件")
    parser.add_argument("--init-config", action="store_true", help="生成默认配置文件后退出")
    parser.add_argument("positional_text", nargs="?", default=None, help=argparse.SUPPRESS)
    return parser


def emit(payload):
    """
    @brief 输出单行 JSON 结果
    @param payload 结果字典
    """
    print(json.dumps(payload, ensure_ascii=False))


def main():
    """
    @brief 入口：读配置 → 校验 → 归档 → 逐通道推送 → 汇总退出码
    @return 进程退出码
    """
    configure_stdout()
    args = build_parser().parse_args()

    target_config = Path(os.path.expanduser(args.config)) if args.config else config_path()

    # 初始化配置只在文件不存在时生成，绝不覆盖用户已经填好的凭证
    if args.init_config:
        if target_config.exists() and not args.force:
            emit({"ok": False, "reason": "配置已存在：{}".format(target_config)})
            return EXIT_CONFIG_OR_VALIDATION
        try:
            target_config.parent.mkdir(parents=True, exist_ok=True)
            target_config.write_text(
                json.dumps(default_config(), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except OSError as exc:
            emit({"ok": False, "reason": "无法写入配置文件：{}".format(exc)})
            return EXIT_CONFIG_OR_VALIDATION
        emit({"ok": True, "created": str(target_config)})
        return EXIT_OK

    config, error = load_config(target_config)
    if error is not None:
        emit({"ok": False, "reason": error, "configPath": str(target_config)})
        return EXIT_CONFIG_OR_VALIDATION

    report_type = args.type
    report_date = dt.date.today()
    title = REPORT_TITLES[report_type]

    # 总开关关闭时，没有显式指定通道就不发；显式指定说明用户就是要发
    if not config.get("enabled") and not args.channel:
        emit({"ok": False, "reason": "自动推送总开关未启用（push-config.json 里 enabled 为 false）"})
        return EXIT_CONFIG_OR_VALIDATION

    content, error = read_content(args)
    if error is not None:
        emit({"ok": False, "reason": error})
        return EXIT_CONFIG_OR_VALIDATION

    content = content.rstrip("\n")
    if content.strip() == "":
        emit({"ok": False, "reason": "正文为空"})
        return EXIT_CONFIG_OR_VALIDATION

    validation_on = (config.get("validation") or {}).get("enabled", True)
    if validation_on and not args.force:
        errors = validate_content(content, report_type)
        if errors:
            emit({"ok": False, "reason": "正文校验未通过：" + "；".join(errors), "type": report_type})
            return EXIT_CONFIG_OR_VALIDATION

    archived, conflict = archive_report(
        config, content, report_type, report_date, args.force, args.no_archive, args.dry_run,
    )
    if conflict is not None:
        emit({"ok": False, "reason": conflict, "type": report_type, "date": report_date.isoformat()})
        return EXIT_CONFIG_OR_VALIDATION

    if args.channel:
        # 去重并保持命令行给出的顺序
        selected = []
        for name in args.channel:
            if name not in selected:
                selected.append(name)
    else:
        selected = list_enabled_channels(config)

    if not selected:
        emit({"ok": False, "reason": "没有任何已启用的推送通道，请先在设置页填好至少一个通道"})
        return EXIT_CONFIG_OR_VALIDATION

    channels = config.get("channels") or {}
    results = []
    for name in selected:
        channel = channels.get(name) or {}
        if name == "wecom":
            result = send_wecom(channel, content, args.dry_run)
        elif name == "webhook":
            result = send_webhook(channel, content, report_type, report_date, args.dry_run)
        else:
            result = send_smtp(config, channel, content, report_type, report_date, args.dry_run)
        results.append(result)
        if not result.get("ok"):
            print("通道 {} 失败：{}".format(name, result.get("reason", "未知原因")), file=sys.stderr)

    failed = [item for item in results if not item.get("ok")]
    payload = {
        "ok": not failed,
        "type": report_type,
        "date": report_date.isoformat(),
        "title": title,
        "archived": archived,
        "channels": results,
    }
    if failed:
        payload["reason"] = "；".join(
            "{}：{}".format(item.get("name"), item.get("reason", "未知原因")) for item in failed
        )
    if args.dry_run:
        payload["dryRun"] = True

    emit(payload)
    return EXIT_OK if not failed else EXIT_CHANNEL_FAILED


if __name__ == "__main__":
    sys.exit(main())
