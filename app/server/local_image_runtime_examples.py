from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image

STYLE_MAP = {
    "cinematic": "电影感写实风格",
    "film": "电影感写实风格",
    "photography": "写实摄影风格",
    "realistic": "写实摄影风格",
    "photo": "写实摄影风格",
    "illustration": "插画风格",
    "anime": "动漫风格",
    "concept art": "概念设计风格",
    "fashion": "时尚商业风格",
    "luxury": "高端商业风格",
    "editorial": "时尚大片风格",
    "minimal": "极简现代风格",
    "cyberpunk": "赛博霓虹风格",
}

LIGHTING_MAP = {
    "golden hour": "金色暖光",
    "sunset": "日落暖光",
    "sunrise": "晨曦自然光",
    "soft light": "柔和漫射光",
    "studio": "棚拍商业布光",
    "rim light": "轮廓边缘光",
    "backlight": "逆光氛围",
    "hard light": "高反差硬光",
    "neon": "霓虹氛围光",
    "night": "夜景低照度光影",
}

CAMERA_MAP = {
    "close-up": "近景特写",
    "portrait": "人像构图",
    "macro": "微距特写",
    "wide shot": "广角环境镜头",
    "wide-angle": "广角环境镜头",
    "overhead": "俯拍镜头",
    "top-down": "俯拍镜头",
    "low angle": "低机位仰拍",
    "telephoto": "长焦压缩镜头",
}

MOOD_MAP = {
    "dramatic": "戏剧张力感",
    "epic": "史诗感",
    "moody": "情绪氛围感",
    "calm": "安静克制感",
    "soft": "柔和细腻感",
    "dreamy": "梦幻朦胧感",
    "futuristic": "未来科技感",
    "premium": "高级商业感",
}

SCENE_MAP = {
    "street": "城市街景",
    "city": "城市空间",
    "interior": "室内场景",
    "room": "室内场景",
    "studio": "影棚空间",
    "forest": "自然森林环境",
    "mountain": "山地自然环境",
    "beach": "海边场景",
    "desert": "沙漠场景",
    "product": "产品展示场景",
    "car": "车辆展示场景",
}


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


def load_image(request: dict[str, Any]) -> Image.Image:
    input_path = Path(str(request["inputPath"])).resolve()
    return Image.open(input_path).convert("RGB")


def infer_orientation(width: int, height: int) -> str:
    if width > height:
        return "横向构图"
    if height > width:
        return "竖向构图"
    return "方形构图"


def split_segments(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", str(text or "")).strip(" ,.;")
    if not normalized:
        return []
    parts = re.split(r"\s*,\s*|\s*;\s*|\s+\band\b\s+|\s+\bwith\b\s+", normalized, flags=re.IGNORECASE)
    result: list[str] = []
    seen: set[str] = set()
    for part in parts:
        cleaned = re.sub(r"\s+", " ", part).strip(" ,.;")
        lowered = cleaned.lower()
        if len(cleaned) < 3 or lowered in seen:
            continue
        result.append(cleaned)
        seen.add(lowered)
    return result[:18]


def first_match(text: str, mapping: dict[str, str], default: str) -> str:
    lowered = str(text or "").lower()
    for keyword, value in mapping.items():
        if keyword in lowered:
            return value
    return default


def infer_subject(text: str, segments: list[str]) -> str:
    blockers = tuple(list(STYLE_MAP.keys()) + list(LIGHTING_MAP.keys()) + list(CAMERA_MAP.keys()) + list(MOOD_MAP.keys()))
    for segment in segments:
      lowered = segment.lower()
      if any(token in lowered for token in blockers):
          continue
      if len(segment.split()) <= 10:
          return segment
    lowered = text.lower()
    if any(token in lowered for token in ["person", "woman", "man", "girl", "boy", "face", "portrait", "model"]):
        return "人物主体"
    if any(token in lowered for token in ["car", "vehicle", "supercar", "sedan", "truck"]):
        return "车辆主体"
    if any(token in lowered for token in ["product", "watch", "phone", "bottle", "shoe"]):
        return "产品主体"
    return "核心视觉主体"


def infer_palette(text: str) -> list[str]:
    palette: list[str] = []
    mapping = {
        "red": "红色",
        "orange": "橙色",
        "yellow": "黄色",
        "green": "绿色",
        "cyan": "青色",
        "blue": "蓝色",
        "purple": "紫色",
        "pink": "粉色",
        "black": "黑色",
        "white": "白色",
        "silver": "银色",
        "gold": "金色",
    }
    lowered = text.lower()
    for keyword, value in mapping.items():
        if keyword in lowered and value not in palette:
            palette.append(value)
    return palette[:6]


def build_prompt_zh(subject: str, scene: str, style: str, lighting: str, composition: str, camera: str, mood: str) -> str:
    return (
        f"保持{composition}与主体位置关系不变，以{subject}为核心，场景设定为{scene}，"
        f"整体风格强调{style}，光影采用{lighting}，镜头语言突出{camera}，"
        f"整体氛围维持{mood}，补强材质细节、色彩层次与画面完成度。"
    )


def caption_to_analysis(caption: str, *, engine: str, width: int, height: int, warnings: list[str] | None = None) -> dict[str, Any]:
    text = re.sub(r"\s+", " ", str(caption or "")).strip(" ,.;")
    orientation = infer_orientation(width, height)
    segments = split_segments(text)
    subject = infer_subject(text, segments)
    scene = first_match(text, SCENE_MAP, "场景氛围待补强")
    style = first_match(text, STYLE_MAP, "高完成度视觉风格")
    lighting = first_match(text, LIGHTING_MAP, "自然层次光影")
    camera = first_match(text, CAMERA_MAP, f"{orientation}镜头")
    mood = first_match(text, MOOD_MAP, "统一氛围感")
    composition = f"{orientation}，保持原始主体位置关系"
    keywords = [item for item in [subject, scene, style, lighting, camera, mood, *segments[:6]] if item]
    deduped_keywords: list[str] = []
    seen: set[str] = set()
    for item in keywords:
        lowered = item.lower()
        if lowered in seen:
            continue
        deduped_keywords.append(item)
        seen.add(lowered)
    raw_caption = text
    grounded_summary = f"{subject}，{scene}，{style}，{lighting}，{camera}，整体氛围偏{mood}。"
    # R3：把 Florence-2 真实英文描述并入 summary，避免只返回泛化默认词（高完成度视觉风格等），
    # 让用户看到与素材图实际对应的分析内容。
    if raw_caption:
        grounded_summary = f"{grounded_summary}\nFlorence-2 原始描述：{raw_caption}"
    # 本地 Florence-2 是 caption 模型，无法稳定产出细粒度字段；尽量从原始描述里抽取颜色并入主体，
    # 其余细粒度字段（细节/动作/表情）标注需在线视觉模型补充，避免前端空白。
    palette = infer_palette(text)
    subject_colors = "、".join(palette) if palette else ""
    return {
        "engine": engine,
        "summary": grounded_summary,
        "rawCaption": raw_caption,
        "subject": subject,
        "subjectColors": subject_colors,
        "subjectDetails": f"Florence-2 原始描述中可见：{raw_caption}" if raw_caption else "（需在线视觉模型识别）",
        "action": "（需在线视觉模型识别）",
        "expression": "（需在线视觉模型识别）",
        "scene": scene,
        "style": style,
        "lighting": lighting,
        "composition": composition,
        "camera": camera,
        "mood": mood,
        "keywords": deduped_keywords[:12],
        "palette": palette,
        "promptZh": build_prompt_zh(subject, scene, style, lighting, composition, camera, mood),
        "promptEn": text or ", ".join(deduped_keywords[:8]),
        "warnings": warnings or [],
        "runtime": {
            "wrapperConfigured": True,
            "wrapperCommand": engine,
            "recommendedModels": ["CLIP Interrogator", "Florence-2", "Qwen Vision"],
        },
        "metadata": {
            "width": width,
            "height": height,
            "orientation": orientation,
            "segments": segments[:8],
        },
    }


def extract_json_object(text: str) -> dict[str, Any] | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def normalize_structured_result(raw: dict[str, Any], *, engine: str, width: int, height: int, warnings: list[str] | None = None) -> dict[str, Any]:
    orientation = infer_orientation(width, height)
    subject = str(raw.get("subject") or "核心视觉主体").strip()
    scene = str(raw.get("scene") or "场景氛围待补强").strip()
    style = str(raw.get("style") or "高完成度视觉风格").strip()
    lighting = str(raw.get("lighting") or "自然层次光影").strip()
    camera = str(raw.get("camera") or f"{orientation}镜头").strip()
    mood = str(raw.get("mood") or "统一氛围感").strip()
    composition = str(raw.get("composition") or f"{orientation}，保持原始主体位置关系").strip()
    subject_colors = str(raw.get("subjectColors") or "、".join(infer_palette(" ".join(map(str, raw.get("keywords") or [])))) or "（需在线视觉模型识别）).strip()
    subject_details = str(raw.get("subjectDetails") or "（需在线视觉模型识别）").strip()
    action = str(raw.get("action") or "（需在线视觉模型识别）").strip()
    expression = str(raw.get("expression") or "（需在线视觉模型识别）").strip()
    keywords = raw.get("keywords") if isinstance(raw.get("keywords"), list) else []
    prompt_zh = str(raw.get("promptZh") or build_prompt_zh(subject, scene, style, lighting, composition, camera, mood)).strip()
    prompt_en = str(raw.get("promptEn") or "").strip()
    palette = raw.get("palette") if isinstance(raw.get("palette"), list) else infer_palette(" ".join(map(str, keywords)))
    summary = str(raw.get("summary") or f"{subject}，{scene}，{style}，{lighting}，{camera}，整体氛围偏{mood}。").strip()
    return {
        "engine": engine,
        "summary": summary,
        "subject": subject,
        "scene": scene,
        "style": style,
        "lighting": lighting,
        "composition": composition,
        "camera": camera,
        "subjectColors": subject_colors,
        "subjectDetails": subject_details,
        "action": action,
        "expression": expression,
        "mood": mood,
        "keywords": [str(item).strip() for item in keywords if str(item).strip()][:12],
        "palette": [str(item).strip() for item in palette if str(item).strip()][:6],
        "promptZh": prompt_zh,
        "promptEn": prompt_en,
        "warnings": warnings or [],
        "runtime": {
            "wrapperConfigured": True,
            "wrapperCommand": engine,
            "recommendedModels": ["CLIP Interrogator", "Florence-2", "Qwen Vision"],
        },
        "metadata": {
            "width": width,
            "height": height,
            "orientation": orientation,
        },
    }


def write_result(output_json: Path, payload: dict[str, Any]) -> None:
    output_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
