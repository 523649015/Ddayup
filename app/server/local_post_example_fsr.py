from __future__ import annotations

from pathlib import Path

from local_post_runtime_examples import (
    clamp,
    encode_args,
    is_video_request,
    parse_runtime_args,
    run_ffmpeg,
    scale_expression,
    write_result,
)


def main() -> None:
    request, output_json = parse_runtime_args()
    input_path = Path(str(request["inputPath"])).resolve()
    output_path = Path(str(request["outputPath"])).resolve()
    is_video = is_video_request(request)

    scale = clamp(request.get("scale"), 1, 8, 2)
    denoise = clamp(request.get("denoise"), 0, 1, 0.18)
    sharpen = clamp(request.get("sharpen"), 0, 1, 0.34)
    temporal = clamp(request.get("temporalStability"), 0, 1, 0.65)
    seam_fix = bool(request.get("seamFix"))

    filters = [f"scale={scale_expression(scale)}:flags=bicubic"]
    if denoise > 0.01:
        filters.append(f"gblur=sigma={max(0.05, denoise * 1.1):.2f}")
    if sharpen > 0.01:
        filters.append(f"unsharp=7:7:{(0.24 + sharpen * 1.8):.2f}:7:7:0")
    if seam_fix:
        filters.append("gblur=sigma=0.35")
    if is_video and temporal > 0.55:
        mix_weight = temporal * 0.18
        filters.append(f"tmix=frames=2:weights='{(1 - mix_weight):.2f} {mix_weight:.2f}'")

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
        engine="FSR Example Runtime",
        meta={
            "scale": scale,
            "denoise": denoise,
            "sharpen": sharpen,
            "seamFix": seam_fix,
            "temporalStability": temporal,
        },
    )


if __name__ == "__main__":
    main()
