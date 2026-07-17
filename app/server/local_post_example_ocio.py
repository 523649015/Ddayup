from __future__ import annotations

from pathlib import Path

from local_post_runtime_examples import (
    clamp,
    encode_args,
    ffmpeg_filter_path,
    is_video_request,
    parse_runtime_args,
    run_ffmpeg,
    write_result,
)


def main() -> None:
    request, output_json = parse_runtime_args()
    input_path = Path(str(request["inputPath"])).resolve()
    output_path = Path(str(request["outputPath"])).resolve()
    is_video = is_video_request(request)
    color = request.get("colorConfig") or {}

    exposure = clamp(color.get("exposure"), -1, 1, 0)
    contrast = clamp(color.get("contrast"), -0.8, 1.2, 0.08)
    saturation = clamp(color.get("saturation"), 0, 2.5, 1)
    hue = clamp(color.get("hue"), -180, 180, 0)
    ocio_view = str(color.get("ocioView") or "default").strip()
    ocio_display = str(color.get("ocioDisplay") or "rec709-monitor").strip()
    look_strength = clamp(color.get("ocioLookStrength"), 0, 1, 0.72)
    lut_path = Path(str(request.get("lutPath") or "")).resolve() if request.get("lutPath") else None
    ocio_config_path = Path(str(request.get("ocioConfigPath") or "")).resolve() if request.get("ocioConfigPath") else None

    out_min = max(0.0, min(0.45, 0.5 - (1 + contrast * 0.4) * 0.5 + exposure * 0.12))
    out_max = max(0.55, min(1.0, 0.5 + (1 + contrast * 0.4) * 0.5 + exposure * 0.12))
    filters = [
        f"colorlevels=romin={out_min:.3f}:gomin={out_min:.3f}:bomin={out_min:.3f}:romax={out_max:.3f}:gomax={out_max:.3f}:bomax={out_max:.3f}",
        f"hue=h={hue:.2f}:s={saturation:.3f}",
    ]
    if ocio_view == "filmic":
        filters.append("curves=all='0/0 0.18/0.12 0.75/0.84 1/1'")
    elif ocio_view == "aces":
        filters.append("curves=all='0/0 0.24/0.18 0.78/0.86 1/1'")
    if ocio_display == "web-srgb":
        filters.append(f"curves=all='0/0 0.45/{0.45 + look_strength * 0.03:.3f} 1/1'")
    elif ocio_display == "p3-cinema":
        filters.append(f"eq=saturation={1 + look_strength * 0.05:.3f}:contrast={1 + look_strength * 0.04:.3f}")
    if ocio_config_path and ocio_config_path.exists():
        filters.append(f"eq=brightness={look_strength * 0.012:.3f}")

    warnings: list[str] = []
    lut_applied = False
    lut_filter = ""
    if lut_path and lut_path.exists() and lut_path.suffix.lower() in {".cube", ".3dl"}:
        lut_filter = f"lut3d=file='{ffmpeg_filter_path(lut_path)}'"
        filters.append(lut_filter)

    try:
        run_ffmpeg([
            "-i",
            str(input_path),
            "-vf",
            ",".join(filters),
            *encode_args(output_path, is_video),
        ])
        lut_applied = bool(lut_filter)
    except RuntimeError:
        if not lut_filter:
            raise
        warnings.append("LUT 文件不可用，已自动回退到无 LUT 的 OCIO 示例链路。")
        filters = [item for item in filters if item != lut_filter]
        run_ffmpeg([
            "-i",
            str(input_path),
            "-vf",
            ",".join(filters),
            *encode_args(output_path, is_video),
        ])

    write_result(
        output_json,
        output_path,
        engine="OCIO Example Runtime",
        meta={
            "ocioView": ocio_view,
            "ocioDisplay": ocio_display,
            "ocioLookStrength": look_strength,
            "lutApplied": lut_applied,
            "ocioConfigApplied": bool(ocio_config_path and ocio_config_path.exists()),
            "ocioConfigName": ocio_config_path.name if ocio_config_path and ocio_config_path.exists() else "",
            "ocioConfigPath": str(ocio_config_path) if ocio_config_path and ocio_config_path.exists() else "",
        },
        warnings=warnings,
    )


if __name__ == "__main__":
    main()
