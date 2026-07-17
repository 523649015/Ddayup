import argparse
import base64
import importlib.util
import json
import math
from pathlib import Path

import cv2
import numpy as np
from scenedetect import SceneManager, open_video
from scenedetect.detectors import ContentDetector


PERSON_HOG = cv2.HOGDescriptor()
PERSON_HOG.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
FACE_CASCADE = cv2.CascadeClassifier(str(Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"))


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def format_seconds(value: float) -> float:
    return round(max(0.0, float(value)), 3)


def module_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def resolve_scene_engine(requested: str) -> str:
    requested_normalized = (requested or "auto").strip().lower()
    if requested_normalized == "transnetv2" and module_available("transnetv2"):
        return "transnetv2"
    return "scenedetect"


def resolve_semantic_engine(requested: str) -> str:
    requested_normalized = (requested or "auto").strip().lower()
    if requested_normalized == "internvideo" and module_available("internvideo"):
        return "internvideo"
    if requested_normalized == "videollava" and module_available("videollava"):
        return "videollava"
    return "semantic-local"


def read_frame_at(cap: cv2.VideoCapture, frame_index: int):
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(frame_index)))
    ok, frame = cap.read()
    if not ok or frame is None:
        return None
    return frame


def encode_jpeg_base64(frame):
    ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    if not ok:
        return "", "image/jpeg"
    return base64.b64encode(encoded.tobytes()).decode("utf-8"), "image/jpeg"


def dominant_palette(frame, color_count=3):
    small = cv2.resize(frame, (96, 96), interpolation=cv2.INTER_AREA)
    pixels = small.reshape((-1, 3)).astype(np.float32)
    criteria = (
        cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER,
        20,
        1.0,
    )
    _, labels, centers = cv2.kmeans(
        pixels,
        color_count,
        None,
        criteria,
        5,
        cv2.KMEANS_PP_CENTERS,
    )
    counts = np.bincount(labels.flatten(), minlength=color_count)
    sorted_indices = np.argsort(counts)[::-1]
    palette = []
    for index in sorted_indices:
        b, g, r = centers[index]
        palette.append(f"#{int(r):02X}{int(g):02X}{int(b):02X}")
    return palette


def analyze_focus_distribution(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 64, 160).astype(np.float32) / 255.0
    height, width = gray.shape
    center = edges[int(height * 0.2): int(height * 0.8), int(width * 0.2): int(width * 0.8)]
    center_energy = float(np.mean(center)) if center.size else 0.0
    full_energy = float(np.mean(edges)) if edges.size else 0.0
    if full_energy <= 1e-6:
        return 0.5
    return clamp(center_energy / full_energy, 0.0, 2.0)


def analyze_composition(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy)
    height, width = mag.shape
    if float(np.sum(mag)) <= 1e-6:
        return {
            "center_x": 0.5,
            "center_y": 0.5,
            "detail_density": 0.0,
            "focus_ratio": 0.5,
        }
    norm = mag / np.sum(mag)
    xs = np.tile(np.linspace(0.0, 1.0, width, dtype=np.float32), (height, 1))
    ys = np.tile(np.linspace(0.0, 1.0, height, dtype=np.float32).reshape((-1, 1)), (1, width))
    center_x = float(np.sum(norm * xs))
    center_y = float(np.sum(norm * ys))
    detail_density = float(np.mean(mag) / 255.0)
    return {
        "center_x": center_x,
        "center_y": center_y,
        "detail_density": detail_density,
        "focus_ratio": analyze_focus_distribution(frame),
    }


def scene_motion_and_camera(frames):
    if len(frames) < 2:
        return {
            "motion_strength": 0.0,
            "camera_shift_x": 0.0,
            "camera_shift_y": 0.0,
        }
    diffs = []
    shifts = []
    prev_gray = cv2.cvtColor(frames[0], cv2.COLOR_BGR2GRAY)
    for frame in frames[1:]:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        diffs.append(float(np.mean(cv2.absdiff(prev_gray, gray))) / 255.0)
        try:
            shift, _ = cv2.phaseCorrelate(np.float32(prev_gray), np.float32(gray))
            shifts.append(shift)
        except cv2.error:
            shifts.append((0.0, 0.0))
        prev_gray = gray
    mean_shift_x = float(np.mean([item[0] for item in shifts])) if shifts else 0.0
    mean_shift_y = float(np.mean([item[1] for item in shifts])) if shifts else 0.0
    motion_strength = float(np.mean(diffs)) if diffs else 0.0
    return {
        "motion_strength": motion_strength,
        "camera_shift_x": mean_shift_x,
        "camera_shift_y": mean_shift_y,
    }


def frame_statistics(frame):
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    brightness = float(np.mean(gray))
    contrast = float(np.std(gray))
    saturation = float(np.mean(hsv[:, :, 1]))
    b, g, r = cv2.mean(frame)[:3]
    warmth = float(r - b)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return {
        "brightness": brightness,
        "contrast": contrast,
        "saturation": saturation,
        "warmth": warmth,
        "sharpness": sharpness,
    }


def central_crop(frame, scale=0.55):
    height, width = frame.shape[:2]
    crop_w = int(width * scale)
    crop_h = int(height * scale)
    x0 = max(0, (width - crop_w) // 2)
    y0 = max(0, (height - crop_h) // 2)
    return frame[y0:y0 + crop_h, x0:x0 + crop_w]


def detect_people_and_faces(frame):
    resized = frame
    scale = 1.0
    height, width = frame.shape[:2]
    max_width = 640
    if width > max_width:
        scale = max_width / float(width)
        resized = cv2.resize(frame, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    people, _ = PERSON_HOG.detectMultiScale(
        resized,
        winStride=(8, 8),
        padding=(8, 8),
        scale=1.05,
    )
    faces = FACE_CASCADE.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(30, 30))
    return {
        "person_count": int(len(people)),
        "face_count": int(len(faces)),
    }


def classify_scene_type(focus_ratio, detail_density, motion_strength):
    if focus_ratio >= 1.18 and detail_density >= 0.08:
        return "近景"
    if focus_ratio <= 0.88 and motion_strength <= 0.08:
        return "远景"
    return "中景"


def classify_camera_angle(center_y):
    if center_y <= 0.36:
        return "低机位仰拍"
    if center_y >= 0.64:
        return "高机位俯拍"
    return "平视"


def classify_focus_depth(focus_ratio, sharpness):
    if focus_ratio >= 1.24 and sharpness >= 180:
        return "浅景深"
    if focus_ratio <= 0.92 and sharpness >= 140:
        return "深景深"
    return "中景深"


def classify_motion_label(motion_strength):
    if motion_strength >= 0.19:
        return "高速运动"
    if motion_strength >= 0.10:
        return "明显运动"
    if motion_strength >= 0.04:
        return "轻微运动"
    return "静止或极轻微运动"


def classify_camera_motion(shift_x, shift_y):
    abs_x = abs(shift_x)
    abs_y = abs(shift_y)
    magnitude = math.sqrt((shift_x * shift_x) + (shift_y * shift_y))
    if magnitude < 1.2:
        return "固定镜头"
    if abs_x >= abs_y:
        return "镜头右移" if shift_x > 0 else "镜头左移"
    return "镜头下摇" if shift_y > 0 else "镜头上摇"


def describe_lighting(brightness, contrast, warmth, saturation):
    brightness_level = "低照度" if brightness < 78 else "中亮度" if brightness < 148 else "高亮度"
    contrast_level = "高对比" if contrast >= 64 else "柔和对比" if contrast <= 42 else "中等对比"
    color_temp = "暖色光氛围" if warmth >= 12 else "冷色光氛围" if warmth <= -12 else "中性色温"
    saturation_level = "低饱和" if saturation <= 72 else "高饱和" if saturation >= 122 else "自然饱和"
    return f"{brightness_level}、{contrast_level}、{color_temp}、{saturation_level}"


def describe_style(brightness, contrast, saturation, sharpness):
    if saturation >= 130 and contrast >= 58:
        return "高饱和商业海报风格"
    if brightness < 78 and contrast >= 60:
        return "电影感暗调风格"
    if saturation <= 70 and sharpness <= 150:
        return "低饱和纪实氛围"
    if sharpness >= 220 and contrast >= 46:
        return "清晰锐利的产品广告风格"
    return "写实自然影像风格"


def describe_atmosphere(brightness, contrast, saturation, motion_strength):
    if motion_strength >= 0.18 and contrast >= 56:
        return "节奏紧张，速度感强"
    if brightness < 85 and saturation >= 90:
        return "情绪浓郁，氛围偏戏剧化"
    if brightness >= 150 and saturation <= 90:
        return "明快通透，空间感清爽"
    return "氛围稳定，适合延展叙事"


def describe_subject_motion(motion_strength):
    if motion_strength >= 0.18:
        return "主体位移明显，动作连续且节奏快"
    if motion_strength >= 0.08:
        return "主体存在可感知移动，动作节奏中等"
    if motion_strength >= 0.03:
        return "主体动作轻微，更偏姿态变化和视线变化"
    return "主体基本稳定，画面变化主要来自细节和光影"


def describe_camera_motion_detail(camera_motion, shift_x, shift_y):
    if camera_motion == "固定镜头":
        return "镜头整体较稳，更适合作为构图参考或关键帧参考"
    distance = round(math.sqrt((shift_x * shift_x) + (shift_y * shift_y)), 2)
    return f"{camera_motion}，估计全局位移幅度约 {distance}px，适合保留原运镜方向做视频延展"


def describe_composition_detail(comp, scene_type):
    x = comp["center_x"]
    y = comp["center_y"]
    focus_ratio = comp["focus_ratio"]
    if 0.42 <= x <= 0.58 and 0.4 <= y <= 0.6:
        position = "主体重心接近画面中心"
    elif x < 0.42:
        position = "主体重心偏左，右侧留白较多"
    elif x > 0.58:
        position = "主体重心偏右，左侧留白较多"
    elif y < 0.4:
        position = "主体重心偏上，下方和前景留白更明显"
    else:
        position = "主体重心偏下，顶部空间更充裕"
    depth_hint = "视觉焦点集中" if focus_ratio >= 1.18 else "空间层次展开明显" if focus_ratio <= 0.9 else "主体与背景关系平衡"
    return f"{position}，{scene_type}构图，{depth_hint}"


def keywords_from_parts(*parts):
    values = []
    for part in parts:
        if not part:
            continue
        if isinstance(part, (list, tuple)):
            for item in part:
                text = str(item).strip()
                if text and text not in values:
                    values.append(text)
            continue
        text = str(part).strip()
        if text and text not in values:
            values.append(text)
    return values


def infer_subject_count(frame, scene_type, focus_ratio):
    counts = detect_people_and_faces(frame)
    person_count = counts["person_count"]
    face_count = counts["face_count"]
    if person_count <= 0 and face_count <= 0:
        if scene_type == "近景" and focus_ratio > 1.3:
            return 1, person_count, face_count
        return 0, person_count, face_count
    return max(person_count, face_count, 1), person_count, face_count


def infer_costume_trait(frame, palette):
    crop = central_crop(frame, 0.5)
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    saturation = float(np.mean(hsv[:, :, 1]))
    brightness = float(np.mean(hsv[:, :, 2]))
    if saturation >= 135:
        color_tone = "服装或主体配色偏鲜明"
    elif brightness < 72:
        color_tone = "服装或主体色调偏深"
    else:
        color_tone = "服装或主体色调自然"
    palette_hint = palette[0] if palette else ""
    return f"{color_tone}，主色倾向 {palette_hint}" if palette_hint else color_tone


def infer_scene_setting(frame, brightness, saturation):
    height, width = frame.shape[:2]
    top = frame[: max(1, int(height * 0.28)), :]
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    hsv_top = cv2.cvtColor(top, cv2.COLOR_BGR2HSV)
    blue_ratio = float(np.mean((hsv_top[:, :, 0] >= 90) & (hsv_top[:, :, 0] <= 130)))
    green_ratio = float(np.mean((hsv[:, :, 0] >= 35) & (hsv[:, :, 0] <= 85)))
    if blue_ratio >= 0.18 or green_ratio >= 0.22:
        return "偏户外或开放环境，背景空间更开阔"
    if brightness < 82:
        return "偏室内或夜景空间，背景受控且层次集中"
    if saturation >= 120:
        return "偏商业展示或布景化空间，画面装饰感更强"
    return "中性室内或半开放空间，适合承接主体表演与叙事"


def infer_subject_summary(subject_count, scene_type, focus_depth, face_count):
    if subject_count <= 0:
        return "未识别到明确人物主体，镜头更偏环境、物件或场景展示"
    if subject_count == 1:
        face_hint = "可见清晰面部" if face_count >= 1 else "面部信息较弱"
        return f"单角色主体，{scene_type}取景，{focus_depth}呈现，{face_hint}"
    return f"{subject_count} 个角色同框，镜头以群像关系和空间站位为主"


def infer_subject_traits(subject_count, costume_trait, scene_type, face_count):
    if subject_count <= 0:
        return "主体特征更多来自场景材质、色彩和空间氛围"
    role_focus = "角色面部辨识较强" if face_count >= 1 else "角色更多通过姿态和轮廓识别"
    framing = "近距离角色刻画" if scene_type == "近景" else "角色与场景共同构成叙事重心"
    return f"{role_focus}，{costume_trait}，{framing}"


def infer_action_summary(subject_count, motion_label, subject_motion):
    if subject_count <= 0:
        return "以环境状态、镜头调度或物件展示为主，动作信息较弱"
    if "高速运动" in motion_label:
        return f"角色正在执行明显动作或快速位移，{subject_motion}"
    if "明显运动" in motion_label or "轻微运动" in motion_label:
        return f"角色存在可感知动作，{subject_motion}"
    return "角色以站立、停留、观察或轻微姿态变化为主"


def infer_storyboard_purpose(index, scene_count, scene_type, camera_motion):
    if index == 0:
        return "建立角色、场景和故事基调"
    if index == scene_count - 1:
        return "完成情绪收束或保留结尾记忆点"
    if scene_type == "近景":
        return "强化角色状态、情绪细节和关注焦点"
    if camera_motion != "固定镜头":
        return "推进叙事动作或强化镜头节奏"
    return "承接上下镜信息，补足空间关系和动作逻辑"


def infer_lens_suggestion(scene_type, focus_depth):
    if scene_type == "远景":
        return "建议 24-35mm 广角环境镜头，强调空间关系"
    if scene_type == "近景" and focus_depth == "浅景深":
        return "建议 50-85mm 人像镜头，突出主体和背景分离"
    if scene_type == "近景":
        return "建议 50mm 左右标准镜头，兼顾主体细节与环境交代"
    return "建议 35-50mm 标准镜头，平衡主体与场景"


def build_sound_design(motion_strength, atmosphere):
    if motion_strength >= 0.18:
        return "建议保留冲击类 Foley、脚步、机械或物体位移声，并用鼓点强化速度感"
    if "戏剧化" in atmosphere or "情绪浓郁" in atmosphere:
        return "建议保留空间混响与氛围音乐铺底，突出情绪张力"
    if "明快通透" in atmosphere:
        return "建议保留轻快环境声与明亮音乐纹理，强化清爽节奏"
    return "建议保留环境底噪与轻量背景音乐，维持镜头连贯性"


def build_narrative_beat(index, scene_count, atmosphere, motion_label):
    if index == 0:
        return "建立主体、空间和整体风格基调"
    if index == scene_count - 1:
        return "完成段落收束，保留最强视觉记忆点"
    if "高速运动" in motion_label:
        return "推进动作节奏，强化镜头张力与运动连续性"
    if "戏剧化" in atmosphere:
        return "承接情绪，强化光影与氛围层层递进"
    return "承接上一镜信息，补足主体动作与空间关系"


def detect_scenes(video_path, threshold, max_scenes):
    video = open_video(video_path)
    manager = SceneManager()
    manager.add_detector(ContentDetector(threshold=threshold))
    manager.detect_scenes(video)
    scenes = manager.get_scene_list()
    if not scenes:
        return [(0.0, float(video.duration.get_seconds()))]
    cleaned = []
    for scene in scenes[:max_scenes]:
        start = float(scene[0].get_seconds())
        end = float(scene[1].get_seconds())
        if end - start >= 0.08:
            cleaned.append((start, end))
    if not cleaned:
        cleaned.append((0.0, float(video.duration.get_seconds())))
    return cleaned


def build_scene_row(index, scene_count, scene, cap, width, height, fps, sample_fps):
    start_time, end_time = scene
    duration = max(0.08, end_time - start_time)
    midpoint = start_time + (duration * 0.5)
    sample_count = max(2, int(math.ceil(duration * sample_fps)))
    sample_times = np.linspace(start_time, end_time, sample_count, endpoint=False)
    sample_frames = []
    for time_point in sample_times:
        frame_index = int(round(time_point * fps))
        frame = read_frame_at(cap, frame_index)
        if frame is not None:
            sample_frames.append(frame)
    keyframe = read_frame_at(cap, int(round(midpoint * fps)))
    if keyframe is None:
        keyframe = sample_frames[len(sample_frames) // 2] if sample_frames else None
    if keyframe is None:
        raise RuntimeError("无法抽取关键帧")

    stats = frame_statistics(keyframe)
    comp = analyze_composition(keyframe)
    motion = scene_motion_and_camera(sample_frames if len(sample_frames) >= 2 else [keyframe])

    scene_type = classify_scene_type(comp["focus_ratio"], comp["detail_density"], motion["motion_strength"])
    camera_angle = classify_camera_angle(comp["center_y"])
    focus_depth = classify_focus_depth(comp["focus_ratio"], stats["sharpness"])
    motion_label = classify_motion_label(motion["motion_strength"])
    camera_motion = classify_camera_motion(motion["camera_shift_x"], motion["camera_shift_y"])
    lighting_mood = describe_lighting(
        stats["brightness"],
        stats["contrast"],
        stats["warmth"],
        stats["saturation"],
    )
    style_description = describe_style(
        stats["brightness"],
        stats["contrast"],
        stats["saturation"],
        stats["sharpness"],
    )
    atmosphere = describe_atmosphere(
        stats["brightness"],
        stats["contrast"],
        stats["saturation"],
        motion["motion_strength"],
    )
    subject_motion = describe_subject_motion(motion["motion_strength"])
    camera_motion_detail = describe_camera_motion_detail(
        camera_motion,
        motion["camera_shift_x"],
        motion["camera_shift_y"],
    )
    composition_detail = describe_composition_detail(comp, scene_type)
    palette = dominant_palette(keyframe)
    sound_design = build_sound_design(motion["motion_strength"], atmosphere)
    narrative_beat = build_narrative_beat(index, scene_count, atmosphere, motion_label)
    subject_count, person_count, face_count = infer_subject_count(keyframe, scene_type, comp["focus_ratio"])
    costume_trait = infer_costume_trait(keyframe, palette)
    scene_setting = infer_scene_setting(keyframe, stats["brightness"], stats["saturation"])
    subject_summary = infer_subject_summary(subject_count, scene_type, focus_depth, face_count)
    subject_traits = infer_subject_traits(subject_count, costume_trait, scene_type, face_count)
    action_summary = infer_action_summary(subject_count, motion_label, subject_motion)
    storyboard_purpose = infer_storyboard_purpose(index, scene_count, scene_type, camera_motion)
    lens_suggestion = infer_lens_suggestion(scene_type, focus_depth)

    frame_description = (
        f"镜头 {index + 1} 中，主要角色数量约为 {subject_count}。"
        f"主体特征为：{subject_traits}。"
        f"当前动作状态为：{action_summary}。"
        f"场景判断为：{scene_setting}。"
        f"画面风格为 {style_description}，光影呈现 {lighting_mood}，整体氛围为 {atmosphere}。"
        f"构图上，{composition_detail}。"
    )
    camera_prompt = (
        f"{camera_motion}，{camera_angle}，{scene_type}，保持主体站位、原始构图和动作方向稳定，"
        f"重点保留 {subject_summary} 与 {camera_motion_detail}。"
    )
    image_prompt = (
        f"保持原视频构图不变，{scene_type}，{camera_angle}，{focus_depth}，"
        f"{lighting_mood}，{style_description}。"
        f"角色设定：{subject_traits}；动作：{action_summary}；"
        f"场景：{scene_setting}；氛围：{atmosphere}；色板：{', '.join(palette[:3])}。"
    )
    keyframe_prompt = (
        f"关键帧 {index + 1}：保留角色位置、动作方向与镜头语言，"
        f"强化 {lighting_mood}、{style_description} 和 {atmosphere}，并维持 {scene_setting}。"
    )
    keyframe_base64, keyframe_mime = encode_jpeg_base64(keyframe)
    visual_keywords = keywords_from_parts(
        scene_type,
        camera_angle,
        camera_motion,
        focus_depth,
        style_description,
        atmosphere,
        scene_setting,
        palette[:3],
    )
    return {
        "id": f"shot-{index + 1}",
        "shotNumber": index + 1,
        "startTime": format_seconds(start_time),
        "endTime": format_seconds(end_time),
        "duration": format_seconds(duration),
        "frameDescription": frame_description,
        "narrativeBeat": narrative_beat,
        "sceneType": scene_type,
        "cameraAngle": camera_angle,
        "cameraMovement": camera_motion,
        "focusDepth": focus_depth,
        "lighting": lighting_mood,
        "soundDesign": sound_design,
        "cameraPrompt": camera_prompt,
        "imagePrompt": image_prompt,
        "keyframePrompt": keyframe_prompt,
        "keyframeTime": format_seconds(midpoint),
        "visualKeywords": visual_keywords,
        "styleDescription": style_description,
        "lightingMood": lighting_mood,
        "atmosphere": atmosphere,
        "subjectMotion": subject_motion,
        "cameraMotionDetail": camera_motion_detail,
        "compositionDetail": composition_detail,
        "colorPalette": palette,
        "subjectCount": subject_count,
        "subjectSummary": subject_summary,
        "subjectTraits": subject_traits,
        "actionSummary": action_summary,
        "sceneSetting": scene_setting,
        "storyboardPurpose": storyboard_purpose,
        "lensSuggestion": lens_suggestion,
        "keyframeImageBase64": keyframe_base64,
        "keyframeMimeType": keyframe_mime,
        "keyframeWidth": int(width),
        "keyframeHeight": int(height),
        "metrics": {
            "brightness": round(stats["brightness"], 2),
            "contrast": round(stats["contrast"], 2),
            "saturation": round(stats["saturation"], 2),
            "warmth": round(stats["warmth"], 2),
            "sharpness": round(stats["sharpness"], 2),
            "motionStrength": round(motion["motion_strength"], 4),
            "focusRatio": round(comp["focus_ratio"], 4),
            "detailDensity": round(comp["detail_density"], 4),
            "detectedPersonCount": person_count,
            "detectedFaceCount": face_count,
        },
    }


def build_summary(width, height, duration, sample_fps, rows):
    scenes = len(rows)
    dominant_styles = keywords_from_parts([row["styleDescription"] for row in rows[:3]])
    atmospheres = keywords_from_parts([row["atmosphere"] for row in rows[:3]])
    settings = keywords_from_parts([row["sceneSetting"] for row in rows[:3]])
    subject_lines = keywords_from_parts([row["subjectSummary"] for row in rows[:2]])
    return (
        f"视频分辨率为 {width}x{height}，时长 {duration:.2f}s，按 {sample_fps}fps 进行本地抽样。"
        f"共识别 {scenes} 个镜头段。"
        f"主体分析以 {(' / '.join(subject_lines[:2]) or '场景主体展示')} 为主。"
        f"场景多为 {(' / '.join(settings[:2]) or '中性叙事空间')}。"
        f"整体风格偏 {(' / '.join(dominant_styles[:2]) or '写实自然')}，"
        f"氛围主要呈现 {(' / '.join(atmospheres[:2]) or '稳定叙事')}。"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--sample-fps", type=float, default=2.0)
    parser.add_argument("--scene-threshold", type=float, default=24.0)
    parser.add_argument("--max-scenes", type=int, default=12)
    parser.add_argument("--scene-engine", default="auto")
    parser.add_argument("--semantic-engine", default="auto")
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise RuntimeError("无法打开视频文件")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = (frame_count / fps) if fps > 0 else 0.0
    sample_fps = clamp(args.sample_fps, 1.0, 10.0)

    scene_runtime = resolve_scene_engine(args.scene_engine)
    semantic_runtime = resolve_semantic_engine(args.semantic_engine)
    scenes = detect_scenes(args.input, args.scene_threshold, args.max_scenes)
    rows = []
    try:
        for index, scene in enumerate(scenes):
            rows.append(build_scene_row(index, len(scenes), scene, cap, width, height, fps, sample_fps))
    finally:
        cap.release()

    scene_cuts = [format_seconds(scene[1]) for scene in scenes[:-1]]
    summary = build_summary(width, height, duration, sample_fps, rows)
    payload = {
        "width": width,
        "height": height,
        "duration": round(duration, 3),
        "sceneCount": len(rows),
        "sceneCuts": scene_cuts,
        "sampleFps": int(sample_fps) if abs(sample_fps - round(sample_fps)) < 1e-6 else round(sample_fps, 2),
        "summary": summary,
        "suggestedShots": [
            {
                "id": row["id"],
                "time": row["keyframeTime"],
                "label": f"镜头 {row['shotNumber']}",
                "shotSize": row["sceneType"],
                "cameraPrompt": row["cameraPrompt"],
                "imagePrompt": row["imagePrompt"],
                "keyframePrompt": row["keyframePrompt"],
            }
            for row in rows
        ],
        "parseRows": rows,
        "analysisEngine": (
            f"scene:requested={args.scene_engine},resolved={scene_runtime}"
            f"|semantic:requested={args.semantic_engine},resolved={semantic_runtime}"
            f"|runtime:opencv+scenedetect+semantic-local"
        ),
    }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
