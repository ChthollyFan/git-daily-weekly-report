#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把日报或周报正文推送到已配置的通道，并把正文归档到本地。

推送配置位于 ~/.git-daily-weekly-report/push-config.json，由 dsh 设置页
「自动推送」维护，也可以直接手工编辑。没有配置文件时脚本只提示路径，不会
擅自创建，避免用户在没填任何通道的情况下以为已经开通。

只依赖标准库：企业微信群机器人与通用 webhook 用 urllib，邮件用 smtplib。
"""

import argparse
import ctypes
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
            # 本地通道：不发网络请求，只把报告归档到本机并弹窗提示
            "local": {
                "enabled": False,
                "notifyTitleTemplate": "{{title}} - {{date}}",
                "includeExcerpt": True,
                "openOnClick": True,
                # 提示窗自动关闭秒数，0 表示不自动关，等用户自己点
                "closeAfterSeconds": 15,
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
        # local 与三个网络通道并列，同样做一层合并，缺字段沿用默认值
        for name in ("wecom", "webhook", "smtp", "local"):
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


# 圆角靠色键抠出来：Tk 只能整窗透明或按色键透明，色键方案只抠掉四角，
# 窗口主体仍然可点可拖；这个颜色必须挑界面上永远不会出现的值
HOLE_COLOR = "#010203"
ROUND_RADIUS = 36

GA_ROOT = 2

# 无边框窗口拖动：把客户区点击伪装成标题栏按下，交给系统搬窗口
WM_NCLBUTTONDOWN = 0xA1
HTCAPTION = 2


def _round_rect(canvas, x1, y1, x2, y2, radius, **kwargs):
    """
    @brief 在 Canvas 上画圆角矩形
    @param canvas 目标画布
    @param x1 左上角横坐标
    @param y1 左上角纵坐标
    @param x2 右下角横坐标
    @param y2 右下角纵坐标
    @param radius 圆角半径
    @return 画布图元 id
    @note 用平滑多边形近似圆弧，避免引入图像素材，抗锯齿效果也能接受
    """
    points = [
        x1 + radius, y1, x2 - radius, y1, x2, y1, x2, y1 + radius,
        x2, y2 - radius, x2, y2, x2 - radius, y2, x1 + radius, y2,
        x1, y2, x1, y2 - radius, x1, y1 + radius, x1, y1,
    ]
    return canvas.create_polygon(points, smooth=True, **kwargs)


def _launch_notepad(path):
    """
    @brief 用记事本打开报告文件
    @param path 报告文件路径
    @return 记事本是否成功启动
    @note 走 ShellExecuteW 让资源管理器代为拉起：直接 subprocess 启动时记事本
          会挂在当前进程的作业对象下，本进程一退出就被连带清理，表现成「点了
          打开报告就闪退」；改用 shell 启动后进程归属 explorer，与本脚本解耦
    """
    try:
        # 返回值大于 32 才算成功，小于等于 32 是 ShellExecute 的错误码
        result = ctypes.windll.shell32.ShellExecuteW(None, "open", "notepad.exe", path, None, 1)
        return int(result) > 32
    except Exception:
        return False


def show_local_window(title, text, target_path, close_after):
    """
    @brief 用 tkinter 弹一个置顶小窗展示报告摘要
    @param title 窗口标题
    @param text 提示正文
    @param target_path 点击「打开报告」时打开的文件路径，空串表示不显示按钮
    @param close_after 自动关闭秒数，0 或负数表示不自动关闭
    @return 窗口是否成功创建并显示
    @note 不走 PowerShell 和 Windows 通知服务：本机应用控制策略会拦「从临时
          目录执行 PowerShell 脚本」（WinError 786），托盘气泡在这台机器上也
          一直没能真正显示，tkinter 是标准库且不需要 shell 宿主
    @note 函数会阻塞到窗口关闭为止，调用方是命令行场景，由 close_after 兜底
    """
    try:
        import tkinter as tk
    except ImportError:
        return False

    try:
        root = tk.Tk()
    except Exception:
        return False

    background = "#151517"
    root.title("报告已归档")
    # 去掉系统标题栏：系统标题栏配这个深色底很割裂，改成自绘的同色标题栏
    root.overrideredirect(True)
    # 置顶：定时任务跑完时用户通常正在别的窗口里，不置顶就会被压在后面
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass

    width, height = 380, 176
    pos_x = max(0, root.winfo_screenwidth() - width - 60)
    pos_y = max(0, root.winfo_screenheight() - height - 140)
    root.geometry("{}x{}+{}+{}".format(width, height, pos_x, pos_y))
    root.update_idletasks()

    # 圆角靠色键抠：画布上画一个圆角矩形填主题色，四角露出色键色，再由
    # -transparentcolor 抠成透明。这样只有四角穿透，窗口主体照样可点可拖
    backdrop = tk.Canvas(root, width=width, height=height, bg=HOLE_COLOR,
                         highlightthickness=0, bd=0)
    backdrop.place(x=0, y=0)
    _round_rect(backdrop, 1, 1, width - 1, height - 1, ROUND_RADIUS,
                fill=background, outline="#242427")
    try:
        root.wm_attributes("-transparentcolor", HOLE_COLOR)
    except Exception:
        pass
    root.configure(bg=HOLE_COLOR)

    def close():
        root.destroy()

    # 无边框窗口没有系统标题栏可拖：把点击转成系统的标题栏拖动消息，
    # 由 Windows 接管拖拽，比在 Python 里手算坐标可靠（手算在部分缩放/DPI 下会漂）
    def start_move(_event):
        try:
            hwnd = ctypes.windll.user32.GetAncestor(int(root.winfo_id()), GA_ROOT)
            ctypes.windll.user32.ReleaseCapture()
            ctypes.windll.user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0)
        except Exception:
            pass

    header = tk.Frame(root, bg=background)
    header.pack(fill="x", padx=14, pady=(10, 2))
    title_label = tk.Label(
        header, text=title, font=("Microsoft YaHei UI", 11, "bold"),
        fg="#ffffff", bg=background, anchor="w", justify="left",
    )
    title_label.pack(side="left")
    close_label = tk.Label(
        header, text="×", font=("Microsoft YaHei UI", 13),
        fg="#81858c", bg=background, cursor="hand2",
    )
    close_label.pack(side="right")
    close_label.bind("<Button-1>", lambda _event: close())
    # 整个窗口都能拖：绑在顶层 tag 上，子控件未消费的事件会传上来；
    # 按钮自己 bind 并返回 "break"，所以拖按钮不会带着窗口跑
    root.bind("<Button-1>", start_move)

    text_label = tk.Label(
        root, text=text, font=("Microsoft YaHei UI", 9),
        fg="#adb2b8", bg=background, anchor="nw", justify="left",
        wraplength=width - 32,
    )
    text_label.pack(fill="both", expand=True, padx=16, pady=(2, 0))

    open_button = None
    # 自动关闭定时器句柄：点开报告后要取消它，否则窗口到点被收掉，
    # 脚本一退出记事本又会被作业对象连带清理
    close_timer = None

    def open_report():
        # 打开成功后刻意不销毁窗口：脚本一退出，dsh 的作业对象就会把同一作业里的
        # 记事本一起清理（breakaway 与 WMI 启动都被拒绝访问），所以窗口留着提示，
        # 由用户看完报告再手动关
        nonlocal close_timer
        if not target_path:
            root.destroy()
            return
        if not _launch_notepad(target_path):
            return
        if close_timer is not None:
            root.after_cancel(close_timer)
            close_timer = None
        title_label.config(text="报告已在记事本中打开")
        text_label.config(text="看完报告后点「关闭」结束这个提示。")
        if open_button is not None:
            open_button.pack_forget()

    bar = tk.Frame(root, bg=background)
    bar.pack(fill="x", padx=16, pady=(4, 10))

    def make_round_button(parent, label, command, fill, hover, width=92, height=28, radius=7):
        # tk.Button 画不出圆角，改用 Canvas 自绘：底色与窗口同色，四角随窗口一起透明
        canvas = tk.Canvas(
            parent, width=width, height=height, bg=background,
            highlightthickness=0, bd=0, cursor="hand2",
        )
        rect = _round_rect(canvas, 1, 1, width - 1, height - 1, radius, fill=fill, outline="")
        canvas.create_text(width / 2, height / 2, text=label, fill="#ffffff",
                           font=("Microsoft YaHei UI", 9))
        canvas.bind("<Enter>", lambda _event: canvas.itemconfig(rect, fill=hover))
        canvas.bind("<Leave>", lambda _event: canvas.itemconfig(rect, fill=fill))

        def on_click(_event):
            command()
            # 返回 "break" 阻止事件继续传到顶层，否则点按钮会被当成拖窗口
            return "break"

        canvas.bind("<Button-1>", on_click)
        return canvas

    # 按钮色对齐 dsh 的深灰填充 rgb(44,44,46)，主次按钮同一底色
    if target_path:
        open_button = make_round_button(bar, "打开报告", open_report, "#2c2c2e", "#3a3a3d")
        open_button.pack(side="right", padx=(8, 0))
    make_round_button(bar, "关闭", close, "#2c2c2e", "#3a3a3d").pack(side="right")

    if int(close_after) > 0:
        close_timer = root.after(int(close_after) * 1000, close)

    try:
        root.mainloop()
    except Exception:
        return False
    return True


def send_local(channel, content, report_type, report_date, archived, dry_run):
    """
    @brief 本地通道：在桌面弹一个置顶小窗告知报告已归档
    @param channel local 通道配置
    @param content 正文
    @param report_type daily 或 weekly
    @param report_date 报告日期
    @param archived 归档路径，None 表示本次没有写归档
    @param dry_run 为真时只回显将要显示的内容
    @return 统一结果字典，name 固定为 local
    @note 只在本机登录桌面有效：服务或 Session 0 下建不出窗口，
          这种情况必须返回失败，否则定时任务显示成功却没人看到报告
    """
    template = str(channel.get("notifyTitleTemplate") or "{{title}} - {{date}}")
    title = (
        template
        .replace("{{title}}", REPORT_TITLES.get(report_type, "工作总结"))
        .replace("{{date}}", report_date.isoformat())
    )

    lines = []
    if archived:
        lines.append("报告已存到 {}".format(archived))
    else:
        lines.append("报告已生成，但本次未写归档文件（--no-archive）")
    if bool(channel.get("includeExcerpt", True)):
        # 摘要只取首个非空行，小窗里放不下整篇正文
        excerpt = first_non_empty_line(content)
        if excerpt:
            lines.append(excerpt[:80])
    text = "\n".join(lines)

    if dry_run:
        # dry-run 也带上点击打开开关，方便确认配置是否生效
        return {
            "name": "local",
            "ok": True,
            "dryRun": True,
            "title": title,
            "text": text,
            "clickToOpen": bool(archived) and bool(channel.get("openOnClick", True)),
        }

    if not sys.platform.startswith("win"):
        return {"name": "local", "ok": False, "reason": "本地通道目前只支持 Windows 桌面"}

    # 只有存在归档文件才值得挂点击：没有目标路径时点击也无处可去
    clickable = bool(archived) and bool(channel.get("openOnClick", True))
    # 自动关闭秒数防止窗口一直挂在屏幕上；0 表示不自动关闭，交给用户手动点
    close_after = int(channel.get("closeAfterSeconds", 15) or 0)
    shown = show_local_window(title, text, archived if clickable else "", close_after)
    if not shown:
        return {"name": "local", "ok": False, "reason": "无法创建本地提示窗口（缺少 tkinter 或当前没有可用桌面）"}
    return {"name": "local", "ok": True, "title": title, "clickToOpen": clickable}


def list_enabled_channels(config):
    """
    @brief 列出开关打开且关键字段已填的通道
    @param config 完整配置
    @return 通道名列表，顺序固定为 wecom、webhook、smtp、local
    @note 与 dsh 侧的判断保持一致：半配置的通道不参与自动发送，免得必然失败
    """
    channels = config.get("channels") or {}
    wecom = channels.get("wecom") or {}
    webhook = channels.get("webhook") or {}
    smtp = channels.get("smtp") or {}
    local = channels.get("local") or {}

    names = []
    if wecom.get("enabled") and str(wecom.get("webhookUrl") or "") != "":
        names.append("wecom")
    if webhook.get("enabled") and str(webhook.get("url") or "") != "":
        names.append("webhook")
    if smtp.get("enabled") and str(smtp.get("host") or "") != "" and (smtp.get("to") or []):
        names.append("smtp")
    # 本地通道没有目标地址要校验，开关打开即可用
    if local.get("enabled"):
        names.append("local")
    return names


def archive_report(config, content, report_type, report_date, force, no_archive, dry_run, reuse_existing=False):
    """
    @brief 把正文归档为本地文件
    @param config 完整配置
    @param content 正文
    @param report_type daily 或 weekly
    @param report_date 报告日期
    @param force 为真时覆盖同名归档
    @param no_archive 为真时跳过归档
    @param dry_run 为真时只算出目标路径不落盘
    @param reuse_existing 为真时「同日已归档」不算冲突，直接复用已有文件路径
    @return (归档路径或 None, 冲突说明或 None)
    @note 「同日已归档」默认算致命冲突（防止重复推送刷屏）；只发本地通道时允许复用，
          这样同一天反复验证本地通知不会被归档冲突挡住
    """
    if no_archive:
        return None, None

    raw_dir = str(config.get("archiveDir") or "~/{}/reports".format(CONFIG_DIRNAME))
    directory = Path(os.path.expanduser(raw_dir))
    target = directory / "{}-{}.md".format(report_date.strftime("%Y%m%d"), report_type)

    if target.exists() and not force:
        if reuse_existing:
            return str(target), None
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
        choices=["wecom", "webhook", "smtp", "local"],
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

    # 先定好要发哪些通道，归档那步才能知道要不要容忍「同日已归档」
    if args.channel:
        # 去重并保持命令行给出的顺序
        selected = []
        for name in args.channel:
            if name not in selected:
                selected.append(name)
    else:
        selected = list_enabled_channels(config)

    # 只发本地通道时允许复用当天已有归档：同一天反复验证气泡不该被归档冲突挡住
    archived, conflict = archive_report(
        config, content, report_type, report_date, args.force, args.no_archive, args.dry_run,
        reuse_existing="local" in selected,
    )
    if conflict is not None:
        emit({"ok": False, "reason": conflict, "type": report_type, "date": report_date.isoformat()})
        return EXIT_CONFIG_OR_VALIDATION

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
        elif name == "local":
            result = send_local(channel, content, report_type, report_date, archived, args.dry_run)
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
