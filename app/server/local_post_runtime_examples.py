from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any

VIDEO_SUFFIXES = {".webm", ".mp4", ".mov", ".mkv", ".avi", ".m4v"}


def parse_runtime_args() -> tuple[dict[str, Any], Path]:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hmdao-request", required=True)
    parser.add_argument("--hmdao-output", required=True)
    args = parser.parse_args()
    request_path = Path(args.hmdao_request).resolve()
    output_json = Path(args.hmdao_output).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8-sig"))
    output_json.parent.mkdir(parents=True, exist_ok=True)
    return request, output_json


def clamp(value: Any, minimum: float, maximum: float, default: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, numeric))


def is_video_request(request: dict[str, Any]) -> bool:
    media_kind = str(request.get("mediaKind") or "").strip().lower()
    if media_kind:
        return media_kind == "video"
    output_path = Path(str(request.get("outputPath") or "")).suffix.lower()
    return output_path in VIDEO_SUFFIXES


def scale_expression(scale: float) -> str:
    return f"trunc(iw*{scale:.4f}/2)*2:trunc(ih*{scale:.4f}/2)*2"


def encode_args(output_path: Path, is_video: bool) -> list[str]:
    if is_video:
        return [
            "-an",
            "-c:v",
            "libvpx",
            "-deadline",
            "good",
            "-cpu-used",
            "4",
            "-crf",
            "18",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
            str(output_path),
        ]
    return [
        "-frames:v",
        "1",
        "-c:v",
        "png",
        str(output_path),
    ]


def ffmpeg_filter_path(file_path: str | Path) -> str:
    return str(file_path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def run_ffmpeg(args: list[str]) -> None:
    completed = subprocess.run(
        ["ffmpeg", "-y", *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout).strip() or "ffmpeg failed")


def write_result(
    output_json: Path,
    output_path: Path,
    *,
    engine: str,
    meta: dict[str, Any] | None = None,
    warnings: list[str] | None = None,
) -> None:
    payload: dict[str, Any] = {
        "outputPath": str(output_path),
        "engine": engine,
        "meta": meta or {},
    }
    if warnings:
        payload["warnings"] = warnings
    output_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
