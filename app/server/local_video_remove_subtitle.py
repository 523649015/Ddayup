import argparse

import cv2
import numpy as np


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mode", default="auto")
    parser.add_argument("--x", type=float, default=12.0)
    parser.add_argument("--y", type=float, default=80.0)
    parser.add_argument("--width", type=float, default=76.0)
    parser.add_argument("--height", type=float, default=12.0)
    parser.add_argument("--feather", type=int, default=8)
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise RuntimeError("无法打开视频文件")

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 24.0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    writer = cv2.VideoWriter(
        args.output,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps if fps > 0 else 24.0,
        (width, height),
    )
    if not writer.isOpened():
        cap.release()
        raise RuntimeError("无法创建处理后视频文件")

    if args.mode == "manual":
        percent_x = clamp(args.x, 0.0, 95.0)
        percent_y = clamp(args.y, 0.0, 95.0)
        percent_w = clamp(args.width, 4.0, 100.0 - percent_x)
        percent_h = clamp(args.height, 4.0, 100.0 - percent_y)
    else:
        percent_x = 0.0
        percent_y = 86.0
        percent_w = 100.0
        percent_h = 14.0

    feather = max(1, int(args.feather))
    x = int(round((percent_x / 100.0) * width))
    y = int(round((percent_y / 100.0) * height))
    w = max(16, int(round((percent_w / 100.0) * width)))
    h = max(16, int(round((percent_h / 100.0) * height)))
    x = max(0, min(width - 2, x))
    y = max(0, min(height - 2, y))
    w = min(width - x, w)
    h = min(height - y, h)

    while True:
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        mask = np.zeros((height, width), dtype=np.uint8)
        cv2.rectangle(mask, (x, y), (x + w, y + h), 255, thickness=-1)
        if feather > 1:
            blur_size = max(3, feather * 2 + 1)
            mask = cv2.GaussianBlur(mask, (blur_size, blur_size), feather / 2)
            _, mask = cv2.threshold(mask, 6, 255, cv2.THRESH_BINARY)
        inpainted = cv2.inpaint(frame, mask, max(3, feather // 2), cv2.INPAINT_TELEA)
        writer.write(inpainted)

    writer.release()
    cap.release()


if __name__ == "__main__":
    main()
