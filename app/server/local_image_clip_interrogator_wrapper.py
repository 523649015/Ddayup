import argparse
import json
import os
import re
from pathlib import Path
from typing import Dict, Iterable, List, Tuple


STYLE_KEYWORDS = {
    "cinematic": "电影感写实风格",
    "film": "电影感写实风格",
    "photography": "写实摄影风格",
    "photo": "写实摄影风格",
    "realistic": "写实摄影风格",
    "anime": "动漫插画风格",
    "illustration": "动漫插画风格",
    "digital art": "数字艺术风格",
    "concept art": "概念设计风格",
    "fashion": "时尚商业风格",
    "editorial": "时尚商业风格",
    "luxury": "高端商业风格",
    "minimal": "极简现代风格",
    "cyberpunk": "赛博霓虹风格",
    "retro": "复古胶片风格",
    "vintage": "复古胶片风格",
}

LIGHTING_KEYWORDS = {
    "golden hour": "金色暖光",
    "sunset": "日落暖光",
    "sunrise": "晨曦自然光",
    "soft light": "柔和漫射光",
    "studio lighting": "棚拍商业布光",
    "rim light": "轮廓边缘光",
    "backlight": "逆光氛围",
    "hard light": "高反差硬光",
    "neon": "霓虹氛围光",
    "night": "夜景低照度光影",
    "volumetric": "体积光氛围",
}

CAMERA_KEYWORDS = {
    "close-up": "近景特写",
    "macro": "微距特写",
    "portrait": "人像构图",
    "wide shot": "广角环境镜头",
    "wide-angle": "广角环境镜头",
    "overhead": "俯拍镜头",
    "top-down": "俯拍镜头",
    "low angle": "低机位仰拍",
    "telephoto": "长焦压缩镜头",
}

MOOD_KEYWORDS = {
    "dramatic": "戏剧张力感",
    "epic": "史诗感",
    "moody": "情绪氛围感",
    "calm": "安静克制感",
    "soft": "柔和细腻感",
    "luxury": "高级商业感",
    "dreamy": "梦幻朦胧感",
    "futuristic": "未来科技感",
}

SCENE_KEYWORDS = {
    "street": "城市街景",
    "city": "城市空间",
    "interior": "室内场景",
    "room": "室内场景",
    "studio": "影棚空间",
    "forest": "自然森林环境",
    "mountain": "山地自然环境",
    "beach": "海边场景",
    "desert": "沙漠场景",
    "car": "车辆展示场景",
    "product": "产品展示场景",
}

PALETTE_KEYWORDS = {
    "red": "红色",
    "orange": "橙色",
    "yellow": "黄色",
    "green": "绿色",
    "cyan": "青色",
    "blue": "蓝色",
    "purple": "紫色",
    "magenta": "洋红",
    "pink": "粉色",
    "black": "黑色",
    "white": "白色",
    "silver": "银色",
    "gold": "金色",
}


def load_payload(path_arg: str | None) -> Dict[str, object]:
    candidate = path_arg or os.environ.get("HMDAO_WRAPPER_PAYLOAD", "").strip()
    if not candidate:
        return {}
    payload_path = Path(candidate)
    if not payload_path.exists():
        return {}
    return json.loads(payload_path.read_text(encoding="utf-8-sig"))


def infer_orientation(width: int, height: int) -> str:
    if width > height:
        return "横向构图"
    if height > width:
        return "竖向构图"
    return "方形构图"


def split_segments(prompt: str) -> List[str]:
    text = re.sub(r"\s+", " ", prompt or "").strip(" ,.;")
    if not text:
      return []
    parts = re.split(r"\s*,\s*|\s*;\s*|\s*\|\s*|\s+\band\b\s+|\s+\bwith\b\s+", text, flags=re.IGNORECASE)
    cleaned = []
    seen = set()
    for part in parts:
        normalized = re.sub(r"\s+", " ", part).strip(" ,.;")
        lowered = normalized.lower()
        if len(normalized) < 3 or lowered in seen:
            continue
        cleaned.append(normalized)
        seen.add(lowered)
    return cleaned[:18]


def first_matching_label(text: str, mapping: Dict[str, str], default: str) -> str:
    lowered = text.lower()
    for keyword, label in mapping.items():
        if keyword in lowered:
            return label
    return default


def collect_palette(text: str) -> List[str]:
    lowered = text.lower()
    result: List[str] = []
    for keyword, label in PALETTE_KEYWORDS.items():
        if keyword in lowered and label not in result:
            result.append(label)
    return result[:6]


def infer_subject(segments: List[str], fallback_text: str) -> str:
    blockers = tuple(
        list(STYLE_KEYWORDS.keys())
        + list(LIGHTING_KEYWORDS.keys())
        + list(CAMERA_KEYWORDS.keys())
        + list(MOOD_KEYWORDS.keys())
    )
    for segment in segments:
        lowered = segment.lower()
        if any(token in lowered for token in blockers):
            continue
        if len(segment.split()) <= 10:
            return segment
    lowered = fallback_text.lower()
    if any(token in lowered for token in ["portrait", "woman", "man", "girl", "boy", "face", "person", "model"]):
        return "人物主体"
    if any(token in lowered for token in ["car", "vehicle", "supercar", "sedan", "truck"]):
        return "车辆主体"
    if any(token in lowered for token in ["product", "watch", "phone", "bottle", "shoe"]):
        return "产品主体"
    if any(token in lowered for token in ["building", "interior", "architecture", "room"]):
        return "建筑或空间主体"
    return "核心视觉主体"


def infer_scene(segments: List[str], prompt: str) -> str:
    for segment in segments:
        label = first_matching_label(segment, SCENE_KEYWORDS, "")
        if label:
            return label
    return first_matching_label(prompt, SCENE_KEYWORDS, "场景氛围待补强")


def infer_style(segments: List[str], prompt: str) -> str:
    for segment in segments:
        label = first_matching_label(segment, STYLE_KEYWORDS, "")
        if label:
            return label
    return first_matching_label(prompt, STYLE_KEYWORDS, "高完成度视觉风格")


def infer_lighting(segments: List[str], prompt: str) -> str:
    for segment in segments:
        label = first_matching_label(segment, LIGHTING_KEYWORDS, "")
        if label:
            return label
    return first_matching_label(prompt, LIGHTING_KEYWORDS, "自然层次光影")


def infer_camera(segments: List[str], prompt: str, orientation: str) -> str:
    for segment in segments:
        label = first_matching_label(segment, CAMERA_KEYWORDS, "")
        if label:
            return label
    return first_matching_label(prompt, CAMERA_KEYWORDS, f"{orientation}镜头")


def infer_mood(segments: List[str], prompt: str) -> str:
    for segment in segments:
        label = first_matching_label(segment, MOOD_KEYWORDS, "")
        if label:
            return label
    return first_matching_label(prompt, MOOD_KEYWORDS, "统一氛围感")


def infer_composition(prompt: str, orientation: str) -> str:
    lowered = prompt.lower()
    if "symmetrical" in lowered or "centered" in lowered:
        return f"{orientation}，中心式构图"
    if "rule of thirds" in lowered or "off-center" in lowered:
        return f"{orientation}，三分法构图"
    if "minimal" in lowered or "negative space" in lowered:
        return f"{orientation}，留白型构图"
    return f"{orientation}，保持原始主体位置关系"


def build_keywords(subject: str, scene: str, style: str, lighting: str, camera: str, mood: str, segments: List[str]) -> List[str]:
    seed = [subject, scene, style, lighting, camera, mood, *segments[:6]]
    unique: List[str] = []
    seen = set()
    for item in seed:
        text = re.sub(r"\s+", " ", str(item or "")).strip(" ,.;")
        key = text.lower()
        if len(text) < 2 or key in seen:
            continue
        unique.append(text)
        seen.add(key)
    return unique[:12]


def build_prompt_zh(subject: str, scene: str, style: str, lighting: str, composition: str, camera: str, mood: str) -> str:
    return (
        f"保持{composition}与主体位置关系不变，以{subject}为核心，场景设定为{scene}，"
        f"整体风格强调{style}，光影采用{lighting}，镜头语言突出{camera}，"
        f"整体氛围维持{mood}，补强材质细节、色彩层次与画面完成度。"
    )


def build_summary(subject: str, scene: str, style: str, lighting: str, camera: str, mood: str) -> str:
    return f"{subject}，{scene}，{style}，{lighting}，{camera}，整体氛围偏{mood}。"


def interrogate_image(image_path: Path, mode: str) -> Tuple[str, List[str]]:
    warnings: List[str] = []
    try:
        from PIL import Image
        from clip_interrogator import Config, Interrogator
    except Exception:
        return "", ["clip_interrogator dependency not found; wrapper returned a deterministic structured fallback."]

    image = Image.open(image_path).convert("RGB")
    config = Config()
    config.quiet = True
    interrogator = Interrogator(config)
    mode_name = (mode or "best").strip().lower()
    if mode_name == "fast" and hasattr(interrogator, "interrogate_fast"):
        return interrogator.interrogate_fast(image), warnings
    if mode_name == "classic" and hasattr(interrogator, "interrogate_classic"):
        return interrogator.interrogate_classic(image), warnings
    return interrogator.interrogate(image), warnings


def build_output(payload: Dict[str, object], prompt: str, warnings: List[str]) -> Dict[str, object]:
    width = int(payload.get("width") or 0)
    height = int(payload.get("height") or 0)
    mode = str(payload.get("mode") or os.environ.get("HMDAO_CLIP_INTERROGATOR_MODE", "best")).strip().lower()
    orientation = infer_orientation(width, height)
    normalized_prompt = re.sub(r"\s+", " ", prompt or "").strip(" ,.;")
    segments = split_segments(normalized_prompt)
    subject = infer_subject(segments, normalized_prompt)
    scene = infer_scene(segments, normalized_prompt)
    style = infer_style(segments, normalized_prompt)
    lighting = infer_lighting(segments, normalized_prompt)
    camera = infer_camera(segments, normalized_prompt, orientation)
    mood = infer_mood(segments, normalized_prompt)
    composition = infer_composition(normalized_prompt, orientation)
    palette = collect_palette(normalized_prompt)
    keywords = build_keywords(subject, scene, style, lighting, camera, mood, segments)
    prompt_en = normalized_prompt or ", ".join(keywords)

    return {
        "engine": f"clip-interrogator:{mode}" if normalized_prompt else "clip-interrogator-fallback",
        "summary": build_summary(subject, scene, style, lighting, camera, mood),
        "subject": subject,
        "scene": scene,
        "style": style,
        "lighting": lighting,
        "composition": composition,
        "camera": camera,
        "mood": mood,
        "keywords": keywords,
        "palette": palette,
        "promptZh": build_prompt_zh(subject, scene, style, lighting, composition, camera, mood),
        "promptEn": prompt_en,
        "warnings": warnings,
        "runtime": {
            "wrapperConfigured": True,
            "wrapperCommand": "clip-interrogator",
            "recommendedModels": ["CLIP Interrogator", "Florence-2", "Qwen2.5-VL"],
        },
        "metadata": {
            "requestedEngine": str(payload.get("engine") or "clip-interrogator"),
            "resolvedEngine": "clip-interrogator",
            "mode": mode,
            "segments": segments[:8],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", default="")
    args = parser.parse_args()
    payload = load_payload(args.payload)

    input_path = Path(str(payload.get("inputPath") or os.environ.get("HMDAO_WRAPPER_INPUT", "")).strip())
    mode = str(payload.get("mode") or os.environ.get("HMDAO_CLIP_INTERROGATOR_MODE", "best")).strip().lower()

    if input_path.exists():
        prompt, warnings = interrogate_image(input_path, mode)
    else:
        prompt, warnings = "", ["input image does not exist; wrapper returned a deterministic structured fallback."]

    output = build_output(payload, prompt, warnings)
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
