from __future__ import annotations

from pathlib import Path

from local_post_runtime_examples import clamp, parse_runtime_args, run_ffmpeg, write_result


def main() -> None:
    request, output_json = parse_runtime_args()
    input_path = Path(str(request["inputPath"])).resolve()
    output_path = Path(str(request["outputPath"])).resolve()
    strength = clamp(request.get("strength"), 0, 1, 0.68)

    run_ffmpeg([
        "-i",
        str(input_path),
        "-vf",
        f"format=gray,colorlevels=romin=0.000:gomin=0.000:bomin=0.000:romax={0.86 + strength * 0.12:.3f}:gomax={0.86 + strength * 0.12:.3f}:bomax={0.86 + strength * 0.12:.3f},gblur=sigma={0.6 + strength * 2.2:.2f}",
        "-frames:v",
        "1",
        "-c:v",
        "png",
        str(output_path),
    ])

    write_result(
        output_json,
        output_path,
        engine="Depth Anything Example Runtime",
        meta={
            "strength": strength,
            "depthMode": "grayscale-preview",
        },
    )


if __name__ == "__main__":
    main()
