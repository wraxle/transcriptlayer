#!/usr/bin/env python3

import argparse
import base64
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import tomllib
import zipfile


SOURCE_FILES = (
    "transcriptlayer/__init__.py",
    "transcriptlayer/client.py",
    "transcriptlayer/models.py",
)
DEFAULT_SOURCE_DATE_EPOCH = 315532800


def safe_project(source: Path) -> dict:
    with (source / "pyproject.toml").open("rb") as handle:
        value = tomllib.load(handle)
    project = value.get("project")
    if not isinstance(project, dict):
        raise ValueError("pyproject.toml must contain a project table")
    if project.get("name") != "transcriptlayer":
        raise ValueError("wheel project name must be transcriptlayer")
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){2}(?:[A-Za-z0-9.-]+)?", project.get("version", "")):
        raise ValueError("wheel project version is invalid")
    for field in ("description", "requires-python"):
        if not isinstance(project.get(field), str) or "\n" in project[field] or "\r" in project[field]:
            raise ValueError(f"wheel project {field} is invalid")
    if project.get("readme") != "README.md":
        raise ValueError("wheel project readme must be README.md")
    if project.get("license") != "Apache-2.0":
        raise ValueError("wheel project license must be Apache-2.0")
    return project


def source_epoch() -> int:
    raw = os.environ.get("SOURCE_DATE_EPOCH", str(DEFAULT_SOURCE_DATE_EPOCH))
    if not raw.isascii() or not raw.isdigit():
        raise ValueError("SOURCE_DATE_EPOCH must be a non-negative integer")
    epoch = int(raw)
    if epoch < DEFAULT_SOURCE_DATE_EPOCH:
        raise ValueError("SOURCE_DATE_EPOCH must be at or after 1980-01-01")
    return epoch


def zip_timestamp(epoch: int) -> tuple[int, int, int, int, int, int]:
    observed = datetime.fromtimestamp(epoch, timezone.utc)
    return observed.year, observed.month, observed.day, observed.hour, observed.minute, observed.second


def record_row(name: str, body: bytes) -> tuple[str, str, str]:
    digest = base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b"=").decode("ascii")
    return name, f"sha256={digest}", str(len(body))


def record_bytes(payloads: dict[str, bytes], record_name: str) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    for name in sorted(payloads):
        writer.writerow(record_row(name, payloads[name]))
    writer.writerow((record_name, "", ""))
    return output.getvalue().encode("utf-8")


def metadata_bytes(project: dict, readme: bytes) -> bytes:
    headers = (
        "Metadata-Version: 2.4\n"
        f"Name: {project['name']}\n"
        f"Version: {project['version']}\n"
        f"Summary: {project['description']}\n"
        f"Requires-Python: {project['requires-python']}\n"
        f"License-Expression: {project['license']}\n"
        "Description-Content-Type: text/markdown\n"
        "\n"
    ).encode("utf-8")
    return headers + readme + (b"" if readme.endswith(b"\n") else b"\n")


def read_regular_file(source: Path, relative: str) -> bytes:
    path = source / relative
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"wheel source must be a regular file: {relative}")
    return path.read_bytes()


def build_wheel(source: Path, wheel_dir: Path) -> Path:
    source = source.resolve(strict=True)
    wheel_dir = wheel_dir.resolve(strict=True)
    if not source.is_dir() or not wheel_dir.is_dir():
        raise ValueError("source and wheel directory must exist")
    project = safe_project(source)
    version = project["version"]
    distribution = re.sub(r"[-_.]+", "_", project["name"])
    dist_info = f"{distribution}-{version}.dist-info"
    record_name = f"{dist_info}/RECORD"
    payloads = {name: read_regular_file(source, name) for name in SOURCE_FILES}
    payloads[f"{dist_info}/licenses/LICENSE"] = read_regular_file(source, "LICENSE")
    payloads[f"{dist_info}/METADATA"] = metadata_bytes(project, read_regular_file(source, "README.md"))
    payloads[f"{dist_info}/WHEEL"] = (
        "Wheel-Version: 1.0\n"
        "Generator: transcriptlayer-build-wheel\n"
        "Root-Is-Purelib: true\n"
        "Tag: py3-none-any\n"
    ).encode("ascii")
    payloads[f"{dist_info}/top_level.txt"] = b"transcriptlayer\n"
    payloads[record_name] = record_bytes(payloads, record_name)

    filename = f"{distribution}-{version}-py3-none-any.whl"
    target = wheel_dir / filename
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{filename}.", suffix=".tmp", dir=wheel_dir)
    os.close(descriptor)
    temporary = Path(temporary_name)
    timestamp = zip_timestamp(source_epoch())
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
            for name in sorted(payloads):
                info = zipfile.ZipInfo(name, date_time=timestamp)
                info.compress_type = zipfile.ZIP_STORED
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, payloads[name])
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the deterministic TranscriptLayer Python wheel")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--wheel-dir", required=True, type=Path)
    arguments = parser.parse_args()
    artifact = build_wheel(arguments.source, arguments.wheel_dir)
    print(json.dumps({"wheel": artifact.name}, separators=(",", ":")))


if __name__ == "__main__":
    main()
