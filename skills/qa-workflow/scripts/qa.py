#!/usr/bin/env python3
"""One JSON request on stdin or --request FILE; one compact JSON receipt on stdout."""

import argparse
import json
from pathlib import Path
import sys
import zipfile

from qaw import VERSION
from qaw import backup
from qaw.runtime import Runtime
from qaw.storage import Error, require


def execute(workspace, request):
    require(isinstance(request, dict), "INVALID_INPUT", "请求必须是 JSON 对象。")
    action = request.get("action")
    if action == "capabilities":
        path = Path(__file__).resolve().parents[1] / "assets/capabilities.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        require(data.get("schema") == 1 and data.get("version") == VERSION,
                "PACKAGE_INCONSISTENT", "能力说明与运行器版本不一致，请核对发布包。")
        return data
    require(workspace, "WORKSPACE_REQUIRED", "此操作需要明确的工作目录；只了解能力可使用 --capabilities。")
    if action == "backup.create":
        return backup.create(workspace, request)
    if action == "backup.verify":
        m = backup.verify(request["archive"])
        return {"verified": True, "files": len(m["entries"]), "backup_time": m["created_at"],
                "complete_for_registered_snapshots": m["complete_for_registered_snapshots"], "exclusions": m["exclusions"]}
    if action == "backup.restore":
        return backup.restore(request["archive"], request["destination"])
    return Runtime(workspace).dispatch(request)


def main():
    parser = argparse.ArgumentParser(description="QA 工作台基础管理；不调用浏览器、知识库或缺陷平台。")
    parser.add_argument("--workspace", help="明确的用户工作目录；说明问答不要求初始化工作空间")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--request", help="UTF-8 JSON 请求文件；省略时从标准输入读取")
    source.add_argument("--capabilities", action="store_true", help="只读当前包能力，不访问或创建工作空间")
    parser.add_argument("--version", action="version", version=VERSION)
    args = parser.parse_args()
    try:
        if args.capabilities:
            request = {"action": "capabilities"}
        else:
            raw = Path(args.request).read_text(encoding="utf-8") if args.request else sys.stdin.read(1024 * 1024 + 1)
            require(len(raw) <= 1024 * 1024, "INVALID_INPUT", "请求超过 1 MiB，请通过产物文件传递较大内容。")
            request = json.loads(raw)
        result = execute(args.workspace, request)
        print(json.dumps({"ok": True, "action": request.get("action"), "result": result}, ensure_ascii=False))
    except Error as exc:
        print(json.dumps({"ok": False, "error": {"code": exc.code, "message": exc.message, "details": exc.details}}, ensure_ascii=False))
        return 2
    except (KeyError, TypeError, ValueError, zipfile.BadZipFile) as exc:
        print(json.dumps({"ok": False, "error": {"code": "INVALID_INPUT", "message": str(exc)}}, ensure_ascii=False))
        return 2
    except OSError as exc:
        print(json.dumps({"ok": False, "error": {"code": "IO_ERROR", "message": str(exc),
              "next": "写入可能已有部分生效；先读取目标记录或检查恢复目录，不盲目重放。"}}, ensure_ascii=False))
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
