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

    filters = [
        f"scale={scale_expression(scale)}:flags=spline",
        f"gblur=sigma={max(0.05, denoise * 1.8):.2f}",
        f"unsharp=7:7:{(0.35 + sharpen * 2.8):.2f}:7:7:0",
        "curves=all='0/0 0.48/0.52 1/1'",
        "hue=s=1.04",
    ]

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
        engine="SUPIR Example Runtime",
        meta={
            "scale": scale,
            "denoise": denoise,
            "sharpen": sharpen,
            "detailBias": "photo",
        },
    )


if __name__ == "__main__":
    main()
