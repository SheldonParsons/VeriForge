"""Manifest-backed local backups. Restore never replaces an existing directory."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import zipfile

from .storage import Error, Store, atomic_bytes, encoded, now, relative, require, text


def hash_stream(stream):
    sha, size = hashlib.sha256(), 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        sha.update(chunk)
        size += len(chunk)
    return sha.hexdigest(), size


def create(root, q):
    store = Store(root)
    with store.locked():
        store.ready()
        workspace = store.read("workspace.json")
        require(q.get("actor") == workspace["data"]["maintainer"], "NOT_MAINTAINER", "备份须由工作空间维护者发起。")
        destination = Path(q["destination"]).expanduser().resolve()
        require(not destination.is_relative_to(store.root), "INVALID_DESTINATION", "备份应放在工作空间之外。")
        require(destination.parent.is_dir() and not destination.exists(), "INVALID_DESTINATION", "目标父目录须存在，且不得覆盖已有备份。")
        refs = set(store.records()) | set(store.refs(".qa/history/*/*.json"))
        assets, excluded, expected_assets = set(), [], {}
        for ref in sorted(refs):
            record = store.read(ref)
            if record["data"].get("kind") == "artifact":
                d = record["data"]
                path = store.path(d["path"])
                if d.get("sensitive") and not q.get("include_sensitive", False):
                    excluded.append({"artifact": ref, "reason": "sensitive_not_included"})
                    continue
                if not path.is_file():
                    excluded.append({"artifact": ref, "reason": "missing_snapshot"})
                    continue
                with path.open("rb") as stream:
                    sha, _ = hash_stream(stream)
                if sha != d["sha256"]:
                    excluded.append({"artifact": ref, "reason": "snapshot_hash_mismatch"})
                    continue
                assets.add(d["path"])
                expected_assets[d["path"]] = d["sha256"]
        require(not excluded or q.get("allow_partial") is True, "BACKUP_INCOMPLETE",
                "存在未覆盖或损坏的快照。先处理，或明确创建标注缺口的部分备份。", exclusions=excluded)
        fd, temp = tempfile.mkstemp(prefix=".qaw-backup-", dir=destination.parent)
        os.close(fd)
        os.chmod(temp, 0o600)
        manifest = {"format": "qa-workflow-backup", "schema": 1, "created_at": now(),
                    "workspace_id": workspace["data"]["id"], "entries": [], "exclusions": excluded,
                    "complete_for_registered_snapshots": not excluded,
                    "coverage": "受管状态、历史修订和已登记快照；不含来源文件后续变化、未登记文件、浏览器会话和未导出的外部服务数据"}
        try:
            with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for ref in sorted(refs | assets):
                    path = store.path(ref)
                    info = zipfile.ZipInfo("data/" + ref)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = (stat.S_IFREG | 0o600) << 16
                    with path.open("rb") as src, archive.open(info, "w") as out:
                        sha, size = hashlib.sha256(), 0
                        for chunk in iter(lambda: src.read(1024 * 1024), b""):
                            sha.update(chunk)
                            size += len(chunk)
                            out.write(chunk)
                    if ref in expected_assets:
                        require(sha.hexdigest() == expected_assets[ref], "SOURCE_CHANGED", "备份过程中快照发生变化，备份未发布。", path=ref)
                    manifest["entries"].append({"path": ref, "sha256": sha.hexdigest(), "bytes": size})
                archive.writestr("manifest.json", encoded(manifest))
            verify(temp)
            with open(temp, "rb") as stream:
                os.fsync(stream.fileno())
            os.link(temp, destination)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
        with destination.open("rb") as stream:
            sha, size = hash_stream(stream)
        return {"path": str(destination), "sha256": sha, "bytes": size, "files": len(manifest["entries"]),
                "complete_for_registered_snapshots": not excluded, "exclusions": excluded, "coverage": manifest["coverage"],
                "off_device_copy_verified": False}


def verify(archive_path, max_bytes=2 * 1024 ** 3):
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        require(len(names) == len(set(names)) and len(names) <= 100000, "UNSAFE_ARCHIVE", "备份包含重名或过多条目。")
        require("manifest.json" in names and archive.getinfo("manifest.json").file_size <= 32 * 1024 ** 2,
                "UNSAFE_ARCHIVE", "备份清单缺失或过大。")
        require(sum(info.file_size for info in infos) <= max_bytes, "UNSAFE_ARCHIVE", "解压体积超过当前 2 GiB 限制。")
        manifest = json.loads(archive.read("manifest.json"))
        require(manifest.get("format") == "qa-workflow-backup" and manifest.get("schema") == 1,
                "UNSUPPORTED_SCHEMA", "不支持此备份格式。")
        entries = manifest.get("entries")
        require(isinstance(entries, list), "UNSAFE_ARCHIVE", "备份清单无效。")
        expected = {"manifest.json"}
        seen = set()
        metadata, hashes = [], {}
        for entry in entries:
            ref = str(relative(entry["path"]))
            require(ref not in seen, "UNSAFE_ARCHIVE", "清单存在重复路径。")
            seen.add(ref)
            require(ref == "workspace.json" or ref.startswith(("projects/", "shared/", "artifacts/", ".qa/history/", ".qa/resources/"))
                    or ref == ".qa/recovery.json", "UNSAFE_ARCHIVE", "备份包含非受管路径。", path=ref)
            name = "data/" + ref
            require(name in names, "INTEGRITY", "清单中的文件缺失。", path=ref)
            info = archive.getinfo(name)
            mode = info.external_attr >> 16
            require(not info.is_dir() and not stat.S_ISLNK(mode) and (stat.S_IFMT(mode) in {0, stat.S_IFREG}),
                    "UNSAFE_ARCHIVE", "只允许常规文件。")
            with archive.open(name) as stream:
                sha, size = hash_stream(stream)
            require(sha == entry["sha256"] and size == entry["bytes"], "INTEGRITY", "备份内容与清单不符。", path=ref)
            hashes[ref] = sha
            if ref.endswith(".json") and not ref.startswith("artifacts/"):
                record = json.loads(archive.read(name))
                Store(".").checked(record, ref)
                metadata.append((ref, record))
            expected.add(name)
        require(set(names) == expected and "workspace.json" in seen, "UNSAFE_ARCHIVE", "存在未登记条目或缺少工作空间记录。")
        workspace = json.loads(archive.read("data/workspace.json"))
        require(workspace["data"]["id"] == manifest["workspace_id"], "INTEGRITY", "工作空间身份不符。")
        excluded = {item["artifact"] for item in manifest.get("exclusions", [])}
        for ref, record in metadata:
            d = record["data"]
            if d.get("kind") == "artifact" and ref not in excluded:
                require(hashes.get(d["path"]) == d["sha256"], "INTEGRITY", "快照与登记记录不符或未说明缺口。", path=ref)
        return manifest


def restore(archive_path, destination):
    manifest = verify(archive_path)
    dest = Path(destination).expanduser().resolve()
    store = Store(dest)
    require(dest.parent.is_dir() and not dest.exists(), "INVALID_DESTINATION", "恢复目标必须是尚不存在的新目录。")
    dest.mkdir(mode=0o700)  # Exclusive creation; an existing workspace is never overwritten.
    marker = dest / ".restore-incomplete"
    atomic_bytes(marker, b"Restoration in progress. Do not use this workspace.\n", replace=False)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            for entry in manifest["entries"]:
                path = store.path(entry["path"])
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with archive.open("data/" + entry["path"]) as src, path.open("xb") as out:
                    os.chmod(path, 0o600)
                    shutil.copyfileobj(src, out, length=1024 * 1024)
                    out.flush()
                    os.fsync(out.fileno())
        # A restored copy must reconcile old holders and business actions before it can dispatch.
        with store.locked():
            old = store.read(".qa/recovery.json", missing=True)
            store.write(".qa/recovery.json", {"kind": "recovery", "reviewed": False,
                        "source_backup": str(Path(archive_path).resolve()), "restored_at": now(),
                        "backup_time": manifest["created_at"], "exclusions": manifest["exclusions"]},
                        old["revision"] if old else 0)
            for ref in store.records():
                store.read(ref)
            store.catalog(persist=True)
        marker.unlink()
    except Exception:
        raise Error("RESTORE_INCOMPLETE", "恢复未完成，新目录保留检查标记；原始备份未改动。", destination=str(dest))
    return {"path": str(dest), "files_restored": len(manifest["entries"]), "execution_enabled": False,
            "exclusions": manifest["exclusions"], "next": "先 resume 核对资料、旧执行者、未知操作及资源，再明确启用。"}
