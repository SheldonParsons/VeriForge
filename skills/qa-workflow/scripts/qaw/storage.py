"""Checked JSON records, immutable revisions and cooperative workspace writes."""

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import tempfile
import uuid


class Error(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def require(condition, code, message, **details):
    if not condition:
        raise Error(code, message, **details)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2,
                       allow_nan=False) + "\n").encode("utf-8")


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def file_digest(path):
    sha = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def slug(value):
    require(isinstance(value, str) and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", value),
            "INVALID_ID", "标识须为 1—64 位小写字母、数字、下划线或连字符。")
    require(value.upper() not in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(10)],
                                  *[f"LPT{i}" for i in range(10)]},
            "INVALID_ID", "该标识是系统保留名称。")
    return value


def text(value, field, limit=4000):
    require(isinstance(value, str) and bool(value.strip()) and len(value) <= limit,
            "INVALID_INPUT", f"{field} 须为非空文本，最多 {limit} 字。")
    return value


def relative(value):
    require(isinstance(value, str) and value and "\\" not in value and "\x00" not in value,
            "INVALID_PATH", "需要工作空间内的相对路径。")
    p = PurePosixPath(value)
    require(not p.is_absolute() and all(x not in (".", "..") for x in value.split("/"))
            and all(":" not in x for x in p.parts), "INVALID_PATH", "路径不能越出工作空间。")
    return p


def sync_directory(path):
    if os.name == "posix":
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def atomic_bytes(path, content, replace=True):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".qaw-tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.chmod(name, 0o600)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(name, path)
        else:
            os.link(name, path)  # An existing destination is never overwritten.
            os.unlink(name)
        sync_directory(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Store:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        package = Path(__file__).resolve().parents[2]
        require(not self.root.is_relative_to(package), "INVALID_WORKSPACE", "工作资料应保存在用户项目中，不能写入 Skill 安装目录。")

    def path(self, ref):
        parts = relative(ref).parts
        p = self.root
        for part in parts:
            p = p / part
            require(not p.is_symlink(), "SYMLINK", "受管路径不能通过符号链接访问。", path=ref)
        return p

    @contextmanager
    def locked(self):
        lock = self.path(".qa/write.lock")
        lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        token = uuid.uuid4().hex
        try:
            lock.mkdir(mode=0o700)
        except FileExistsError:
            raise Error("WORKSPACE_BUSY", "工作空间正在写入，或上次写入中断留下了锁。先检查，不自动抢占。",
                        lock=str(lock))
        try:
            atomic_bytes(lock / "owner.json", encoded({"token": token, "pid": os.getpid(),
                         "host": socket.gethostname(), "started_at": now()}), replace=False)
            yield
        finally:
            owner = lock / "owner.json"
            if owner.exists() and json.loads(owner.read_text()).get("token") == token:
                owner.unlink()
                lock.rmdir()

    def checked(self, record, ref):
        require(isinstance(record, dict) and record.get("schema") == 1,
                "UNSUPPORTED_SCHEMA", "数据格式版本不支持；保留原文件，先核对升级方式。", path=ref)
        body = {k: v for k, v in record.items() if k != "sha256"}
        require(record.get("sha256") == digest(body), "INTEGRITY", "记录摘要不符，可能被手工修改或损坏。", path=ref)
        require(isinstance(record.get("revision"), int) and record["revision"] > 0
                and isinstance(record.get("data"), dict), "INTEGRITY", "记录结构不完整。", path=ref)
        return record

    def read(self, ref, missing=False):
        path = self.path(ref)
        if missing and not path.exists():
            return None
        require(path.is_file(), "NOT_FOUND", "未找到记录。", path=ref)
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError):
            raise Error("INTEGRITY", "记录无法解析；请保留原文件并核对历史或备份。", path=ref)
        return self.checked(record, ref)

    def history_path(self, ref, revision, sha):
        key = hashlib.sha256(ref.encode()).hexdigest()
        return f".qa/history/{key}/{revision:08d}-{sha}.json"

    def version(self, ref, revision):
        current = self.read(ref)
        require(isinstance(revision, int) and 1 <= revision <= current["revision"],
                "NOT_FOUND", "引用版本不存在。", path=ref, revision=revision)
        while current["revision"] > revision:
            current = self.read(self.history_path(ref, current["revision"] - 1, current["previous"]))
        return current

    def write(self, ref, data, expected):
        current = self.read(ref, missing=True)
        actual = current["revision"] if current else 0
        require(isinstance(expected, int) and not isinstance(expected, bool) and expected == actual,
                "REVISION_CONFLICT", "记录已变化，请重新读取再修改。", path=ref, expected=expected, actual=actual)
        record = {"schema": 1, "revision": actual + 1, "updated_at": now(),
                  "previous": current["sha256"] if current else None, "data": data}
        record["sha256"] = digest(record)
        raw = encoded(record)
        atomic_bytes(self.path(self.history_path(ref, record["revision"], record["sha256"])), raw, replace=False)
        # A crash before this replace leaves the previous valid current record intact.
        atomic_bytes(self.path(ref), raw)
        return record

    def refs(self, pattern):
        return sorted(p.relative_to(self.root).as_posix() for p in self.root.glob(pattern)
                      if p.is_file() and not p.is_symlink())

    def records(self):
        patterns = ["workspace.json", "shared/*.json", "projects/*/project.json",
                    "projects/*/requirements/*/state.json", "projects/*/requirements/*/tasks/*.json",
                    "projects/*/requirements/*/operations/*.json", "projects/*/requirements/*/artifacts/*.json",
                    "projects/*/requirements/*/runs/*/*.json", ".qa/resources/*.json", ".qa/recovery.json"]
        return sorted({ref for pattern in patterns for ref in self.refs(pattern)})

    def catalog(self, persist=False):
        refs = self.refs("projects/*/project.json") + self.refs("projects/*/requirements/*/state.json")
        stamp = [[ref, self.path(ref).stat().st_mtime_ns, self.path(ref).stat().st_size] for ref in refs]
        cache_path = self.path(".qa/catalog.json")
        if not persist and cache_path.exists():
            try:
                cached = self.checked(json.loads(cache_path.read_text()), ".qa/catalog.json")["data"]
                if cached["stamp"] == stamp:
                    return cached["items"]
            except (Error, ValueError, KeyError):
                pass  # Derived cache; canonical records remain the authority.
        items = []
        for ref in refs:
            r = self.read(ref)
            d = r["data"]
            items.append({"path": ref, "revision": r["revision"], "kind": d["kind"],
                          "project": d["project"], "requirement": d.get("requirement"),
                          "title": d["title"], "archived": d.get("archived", False)})
        if persist:
            cache = {"schema": 1, "revision": 1, "data": {"stamp": stamp, "items": items}}
            cache["sha256"] = digest(cache)
            atomic_bytes(cache_path, encoded(cache))
        return items

    def ready(self, execution=False):
        require(not self.path(".restore-incomplete").exists(), "RESTORE_INCOMPLETE", "恢复尚未完成，请保留目录检查。")
        self.read("workspace.json")
        recovery = self.read(".qa/recovery.json", missing=True)
        require(not execution or not recovery or recovery["data"]["reviewed"], "RECOVERY_REVIEW",
                "这是恢复副本。先核对旧执行者、未知操作和资源，再明确启用执行记录。")
