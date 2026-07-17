bl_info = {
    "name": "HMDao Blender Capture",
    "author": "HMDao",
    "version": (1, 3, 4),
    "blender": (3, 3, 0),
    "location": "View3D > Sidebar > HMDao",
    "description": "Expose Blender camera preview and capture to HMDao canvas.",
    "category": "Render",
}

import base64
import hashlib
import json
import os
import queue
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import traceback

import bpy


HOST = "127.0.0.1"
PORT = 8766
PLUGIN_VERSION = "1.3.5"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
COMMAND_QUEUE = queue.Queue()
SERVER = None
LOG_PATH = os.path.join(tempfile.gettempdir(), "hmdao_blender_capture.log")
REQUEST_PATH = os.path.join(tempfile.gettempdir(), "hmdao_blender_capture.request.json")
STATUS_PATH = os.path.join(tempfile.gettempdir(), "hmdao_blender_capture.status.json")
PREVIEW_WARMUP_SECONDS = 20.0
PREVIEW_WARMUP_FPS = 2
IDLE_REQUEST_POLL_SECONDS = 2.0
IDLE_STARTUP_GRACE_SECONDS = 25.0
VIEWPORT_SOURCE_NAME = "Viewport Perspective"
VIEWPORT_SOURCE_ID = "__hmdao_viewport__"
FFMPEG_ENCODER_CACHE = {}

def _log(message):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n"
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(line)
    except OSError:
        pass


def _read_request_payload():
    try:
        with open(REQUEST_PATH, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else {}
    except OSError:
        return {}
    except Exception as exc:
        _log(f"Failed to parse request file: {exc}")
        return {}


def _remove_request_file():
    try:
        os.remove(REQUEST_PATH)
    except OSError:
        pass


def _write_status_file(service_running=False, note=""):
    payload = {
        "plugin": "hmdao_blender_capture",
        "pluginVersion": PLUGIN_VERSION,
        "enabled": True,
        "serviceRunning": bool(service_running),
        "pid": os.getpid(),
        "heartbeatTs": int(time.time() * 1000),
        "note": str(note or ""),
    }
    try:
        with open(STATUS_PATH, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
    except OSError:
        pass


def _remove_status_file():
    try:
        os.remove(STATUS_PATH)
    except OSError:
        pass


def _ws_accept_key(key):
    digest = hashlib.sha1((key + WS_GUID).encode("utf-8")).digest()
    return base64.b64encode(digest).decode("ascii")


def _encode_frame(text):
    payload = text.encode("utf-8")
    header = bytearray([0x81])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.extend([126, (length >> 8) & 0xFF, length & 0xFF])
    else:
        header.append(127)
        header.extend(struct.pack(">Q", length))
    return bytes(header) + payload


def _camera_objects():
    return [obj for obj in bpy.context.scene.objects if obj.type == "CAMERA"]


def _has_visible_ui_window():
    manager = getattr(bpy.context, "window_manager", None)
    windows = getattr(manager, "windows", None) if manager is not None else None
    return bool(windows)


def _first_view3d_context():
    manager = getattr(bpy.context, "window_manager", None)
    if manager is None:
        return None
    for window in manager.windows:
        screen = getattr(window, "screen", None)
        if screen is None:
            continue
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            region = next((item for item in area.regions if item.type == "WINDOW"), None)
            if region is None:
                continue
            space = getattr(area, "spaces", None)
            space = space.active if space else None
            if space is None or space.type != "VIEW_3D":
                continue
            return {
                "window": window,
                "screen": screen,
                "area": area,
                "region": region,
                "space": space,
            }
    return None


def _has_viewport_fallback():
    return _first_view3d_context() is not None


def _selected_source_name(camera=None):
    if camera is not None:
        return camera.name
    if bpy.context.scene.camera:
        return bpy.context.scene.camera.name
    if _has_viewport_fallback():
        return VIEWPORT_SOURCE_NAME
    return ""


def _camera_list():
    active = bpy.context.scene.camera
    cameras = [
        {
            "name": camera.name,
            "label": camera.name,
            "active": bool(active and active.name == camera.name),
            "engine": "blender",
        }
        for camera in _camera_objects()
    ]
    if not cameras and _has_viewport_fallback():
        cameras.append({
            "name": VIEWPORT_SOURCE_ID,
            "label": VIEWPORT_SOURCE_NAME,
            "active": True,
            "engine": "blender",
        })
    return cameras


def _select_camera(name):
    cameras = _camera_objects()
    if name == VIEWPORT_SOURCE_ID:
        return None
    if name:
        for camera in cameras:
            if camera.name == name:
                bpy.context.scene.camera = camera
                return camera
    if bpy.context.scene.camera:
        return bpy.context.scene.camera
    if cameras:
        bpy.context.scene.camera = cameras[0]
        return cameras[0]
    return None

def _timeline_payload():
    scene = bpy.context.scene
    fps = scene.render.fps / max(1, scene.render.fps_base)
    return {
        "type": "animation_range",
        "start_frame": int(scene.frame_start),
        "end_frame": int(scene.frame_end),
        "current_frame": int(scene.frame_current),
        "fps": round(fps),
    }


def _animation_keys_present(id_block):
    if id_block is None:
        return False
    animation_data = getattr(id_block, "animation_data", None)
    action = getattr(animation_data, "action", None) if animation_data is not None else None
    if action is None:
        return False
    for curve in getattr(action, "fcurves", []) or []:
        keyframe_points = getattr(curve, "keyframe_points", None)
        if keyframe_points and len(keyframe_points) > 0:
            return True
    return False


def _camera_has_key_animation(camera):
    if camera is None:
        return False
    if _animation_keys_present(camera):
        return True
    camera_data = getattr(camera, "data", None)
    return _animation_keys_present(camera_data)


def _set_scene_status(message):
    try:
        for scene in bpy.data.scenes:
            scene.hmdao_capture_status = message
    except Exception:
        pass


def _render_camera_still_to_file(camera_name, width, height, filepath, quality=90, file_format="JPEG"):
    camera = _select_camera(camera_name)
    viewport_context = _first_view3d_context()
    if camera is None and viewport_context is None:
        raise RuntimeError("No Blender camera or viewport is available for HMDao capture.")

    scene = bpy.context.scene
    old_camera = scene.camera
    old_x = scene.render.resolution_x
    old_y = scene.render.resolution_y
    old_percent = scene.render.resolution_percentage
    old_format = scene.render.image_settings.file_format
    old_quality = scene.render.image_settings.quality
    old_path = scene.render.filepath
    old_use_file_extension = scene.render.use_file_extension
    region_3d = None
    old_view_perspective = None

    try:
        if camera is not None:
            scene.camera = camera
        scene.render.resolution_x = int(width)
        scene.render.resolution_y = int(height)
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = file_format
        scene.render.image_settings.quality = int(max(1, min(100, quality)))
        scene.render.use_file_extension = True
        scene.render.filepath = filepath
        if camera is not None:
            if viewport_context is not None:
                region_3d = getattr(viewport_context["space"], "region_3d", None)
                old_view_perspective = getattr(region_3d, "view_perspective", None) if region_3d is not None else None
                if region_3d is not None:
                    region_3d.view_perspective = "CAMERA"
                with bpy.context.temp_override(
                    window=viewport_context["window"],
                    screen=viewport_context["screen"],
                    area=viewport_context["area"],
                    region=viewport_context["region"],
                    space_data=viewport_context["space"],
                ):
                    try:
                        bpy.ops.render.opengl(write_still=True, view_context=True)
                    except Exception:
                        bpy.ops.render.render(write_still=True)
            else:
                try:
                    bpy.ops.render.opengl(write_still=True, view_context=False)
                except Exception:
                    bpy.ops.render.render(write_still=True)
        else:
            with bpy.context.temp_override(
                window=viewport_context["window"],
                screen=viewport_context["screen"],
                area=viewport_context["area"],
                region=viewport_context["region"],
                space_data=viewport_context["space"],
            ):
                bpy.ops.render.opengl(write_still=True, view_context=True)
        return filepath
    finally:
        if region_3d is not None and old_view_perspective is not None:
            try:
                region_3d.view_perspective = old_view_perspective
            except Exception:
                pass
        scene.camera = old_camera
        scene.render.resolution_x = old_x
        scene.render.resolution_y = old_y
        scene.render.resolution_percentage = old_percent
        scene.render.image_settings.file_format = old_format
        scene.render.image_settings.quality = old_quality
        scene.render.use_file_extension = old_use_file_extension
        scene.render.filepath = old_path


def _render_camera_data_url(camera_name, width, height, quality=90, file_format="JPEG"):
    suffix = ".jpg" if file_format == "JPEG" else ".png"
    fd, filepath = tempfile.mkstemp(prefix="hmdao_blender_", suffix=suffix)
    os.close(fd)
    try:
        _render_camera_still_to_file(camera_name, width, height, filepath, quality=quality, file_format=file_format)
        with open(filepath, "rb") as handle:
            encoded = base64.b64encode(handle.read()).decode("ascii")
        mime = "image/jpeg" if file_format == "JPEG" else "image/png"
        return f"data:{mime};base64,{encoded}"
    finally:
        try:
            os.remove(filepath)
        except OSError:
            pass


def _find_rendered_output_file(session_dir, stem, extensions):
    candidates = [os.path.join(session_dir, f"{stem}{suffix}") for suffix in extensions]
    candidates.append(os.path.join(session_dir, stem))
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    try:
        discovered = [
            os.path.join(session_dir, name)
            for name in os.listdir(session_dir)
            if os.path.isfile(os.path.join(session_dir, name))
            and os.path.splitext(name)[1].lower() in extensions
        ]
    except OSError:
        discovered = []
    discovered.sort(key=lambda item: os.path.getmtime(item), reverse=True)
    return discovered[0] if discovered else ""


def _find_ffmpeg_binary():
    candidates = []
    env_value = os.environ.get("HMDAO_FFMPEG_PATH", "").strip()
    if env_value:
        candidates.append(env_value)
    resolved = shutil.which("ffmpeg")
    if resolved:
        candidates.append(resolved)
    candidates.extend([
        os.path.join(os.environ.get("ProgramFiles", ""), "ffmpeg", "bin", "ffmpeg.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "ffmpeg", "bin", "ffmpeg.exe"),
    ])
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return ""


def _probe_ffmpeg_video_encoders(ffmpeg_binary):
    cached = FFMPEG_ENCODER_CACHE.get(ffmpeg_binary)
    if cached is not None:
        return cached
    encoders = set()
    try:
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        completed = subprocess.run(
            [ffmpeg_binary, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            check=False,
            creationflags=creationflags,
        )
        output = f"{completed.stdout or ''}\n{completed.stderr or ''}"
        for line in output.splitlines():
            match = re.match(r"^\s*([VASFSXBD\.]{6})\s+([A-Za-z0-9_]+)\b", line)
            if match and "V" in match.group(1):
                encoders.add(match.group(2))
    except Exception as exc:
        _log(f"Failed to probe ffmpeg encoders: {exc}")
    FFMPEG_ENCODER_CACHE[ffmpeg_binary] = encoders
    return encoders


def _ffmpeg_encode_profiles(ffmpeg_binary):
    available = _probe_ffmpeg_video_encoders(ffmpeg_binary)
    profiles = []

    def _append_profile(name, args):
        if not any(item["name"] == name for item in profiles):
            profiles.append({"name": name, "args": args})

    def _append_h264_profile(name, extra_args=None):
        args = [
            "-c:v", name,
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
        ]
        if extra_args:
            args.extend(extra_args)
        _append_profile(name, args)

    if not available or "libx264" in available:
        _append_h264_profile("libx264", ["-crf", "18"])
    if not available or "libopenh264" in available:
        _append_h264_profile("libopenh264", ["-b:v", "6M", "-maxrate", "8M"])
    if not available or "h264_mf" in available:
        _append_h264_profile("h264_mf", ["-b:v", "6M"])
    if not available or "h264_nvenc" in available:
        _append_h264_profile("h264_nvenc", ["-cq", "19", "-b:v", "0"])
    if not available or "h264_amf" in available:
        _append_h264_profile("h264_amf", ["-quality", "quality", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"])
    if not available or "h264_qsv" in available:
        _append_h264_profile("h264_qsv", ["-global_quality", "20", "-look_ahead", "0"])
    if not available or "mpeg4" in available:
        _append_profile("mpeg4", [
            "-c:v", "mpeg4",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-q:v", "2",
        ])
    if not profiles:
        _append_h264_profile("libx264", ["-crf", "18"])
        _append_h264_profile("libopenh264", ["-b:v", "6M", "-maxrate", "8M"])
        _append_profile("mpeg4", [
            "-c:v", "mpeg4",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-q:v", "2",
        ])
    return profiles


def _condense_ffmpeg_output(output):
    text = str(output or "").strip()
    if not text:
        return ""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return ""
    if len(lines) <= 3:
        return " | ".join(lines)
    return " | ".join(lines[-3:])


def _run_ffmpeg_encode(frames_dir, fps, output_path):
    ffmpeg_binary = _find_ffmpeg_binary()
    if not ffmpeg_binary:
        raise RuntimeError("ffmpeg was not found. Install ffmpeg or set HMDAO_FFMPEG_PATH before recording.")
    frame_pattern = os.path.join(frames_dir, "frame_%04d.png")
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    attempts = []
    for profile in _ffmpeg_encode_profiles(ffmpeg_binary):
        try:
            if os.path.isfile(output_path):
                os.remove(output_path)
        except OSError:
            pass
        command = [
            ffmpeg_binary,
            "-y",
            "-framerate",
            str(max(1, int(fps))),
            "-i",
            frame_pattern,
            *profile["args"],
            output_path,
        ]
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            creationflags=creationflags,
        )
        attempts.append({
            "encoder": profile["name"],
            "returncode": completed.returncode,
            "details": _condense_ffmpeg_output(completed.stderr or completed.stdout),
        })
        if completed.returncode == 0 and os.path.isfile(output_path):
            if profile["name"] != "libx264":
                _log(f"ffmpeg encode succeeded with fallback encoder {profile['name']}.")
            return profile["name"]

    available = sorted(_probe_ffmpeg_video_encoders(ffmpeg_binary))
    attempts_text = "; ".join(
        f"{item['encoder']} rc={item['returncode']}{': ' + item['details'] if item['details'] else ''}"
        for item in attempts
    )
    available_text = ", ".join(available) if available else "unknown"
    raise RuntimeError(
        "Blender rendered the requested PNG frames, but ffmpeg could not package them into MP4. "
        f"Tried encoders: {attempts_text}. Available video encoders: {available_text}."
    )


def _clear_directory_files(directory_path):
    try:
        for name in os.listdir(directory_path):
            file_path = os.path.join(directory_path, name)
            if os.path.isfile(file_path):
                os.remove(file_path)
    except OSError:
        pass


def _render_camera_video_output(camera_name, start_frame, end_frame, fps, width, height, quality=90):
    normalized_start = int(start_frame)
    normalized_end = max(normalized_start, int(end_frame))
    normalized_fps = max(1, int(round(fps)))
    normalized_width = max(1, int(width))
    normalized_height = max(1, int(height))
    session_name = f"capture_{int(time.time() * 1000)}"
    session_dir = os.path.join(tempfile.gettempdir(), "hmdao_blender_recordings", session_name)
    frames_dir = os.path.join(session_dir, "frames")
    os.makedirs(session_dir, exist_ok=True)
    os.makedirs(frames_dir, exist_ok=True)
    requested_output_path = os.path.join(session_dir, "recording.mp4")
    thumbnail_path = os.path.join(session_dir, "thumbnail.jpg")
    camera = _select_camera(camera_name)
    viewport_context = _first_view3d_context()
    if camera is None and viewport_context is None:
        raise RuntimeError("No Blender camera or viewport is available for HMDao recording.")

    scene = bpy.context.scene
    old_camera = scene.camera
    old_frame_start = scene.frame_start
    old_frame_end = scene.frame_end
    old_frame_current = scene.frame_current
    old_fps = scene.render.fps
    old_fps_base = scene.render.fps_base
    old_x = scene.render.resolution_x
    old_y = scene.render.resolution_y
    old_percent = scene.render.resolution_percentage
    old_format = scene.render.image_settings.file_format
    old_path = scene.render.filepath
    old_use_file_extension = scene.render.use_file_extension
    region_3d = None
    old_view_perspective = None

    try:
        if camera is not None:
            scene.camera = camera
        scene.frame_start = normalized_start
        scene.frame_end = normalized_end
        scene.frame_set(normalized_start)
        bpy.context.view_layer.update()
        scene.render.resolution_x = normalized_width
        scene.render.resolution_y = normalized_height
        scene.render.resolution_percentage = 100
        scene.render.fps = normalized_fps
        scene.render.fps_base = 1.0
        scene.render.image_settings.file_format = "PNG"
        scene.render.use_file_extension = True
        scene.render.filepath = os.path.join(frames_dir, "frame_")
        _clear_directory_files(frames_dir)

        _render_camera_still_to_file(
            camera_name,
            normalized_width,
            normalized_height,
            thumbnail_path,
            quality=quality,
            file_format="JPEG",
        )
        scene.frame_set(normalized_start)
        bpy.context.view_layer.update()

        if viewport_context is not None:
            region_3d = getattr(viewport_context["space"], "region_3d", None)
            old_view_perspective = getattr(region_3d, "view_perspective", None) if region_3d is not None else None
            if camera is not None and region_3d is not None:
                region_3d.view_perspective = "CAMERA"
            with bpy.context.temp_override(
                window=viewport_context["window"],
                screen=viewport_context["screen"],
                area=viewport_context["area"],
                region=viewport_context["region"],
                space_data=viewport_context["space"],
            ):
                try:
                    bpy.ops.render.opengl(animation=True, view_context=True)
                except Exception:
                    bpy.ops.render.render(animation=True)
        else:
            try:
                bpy.ops.render.opengl(animation=True, view_context=False)
            except Exception:
                bpy.ops.render.render(animation=True)

        sequence_probe = _find_rendered_output_file(frames_dir, "frame_", [".png"])
        if not sequence_probe:
            raise RuntimeError("Blender did not produce a frame sequence for the requested recording range.")
        encoder_name = _run_ffmpeg_encode(frames_dir, normalized_fps, requested_output_path)
        output_path = requested_output_path
        frame_count = max(1, normalized_end - normalized_start + 1)
        return {
            "file_path": output_path,
            "thumbnail_path": thumbnail_path if os.path.isfile(thumbnail_path) else "",
            "mime_type": "video/mp4",
            "width": normalized_width,
            "height": normalized_height,
            "start_frame": normalized_start,
            "end_frame": normalized_end,
            "fps": normalized_fps,
            "duration_ms": int(round((frame_count / float(normalized_fps)) * 1000.0)),
            "size_bytes": os.path.getsize(output_path),
            "encoder": encoder_name,
        }
    finally:
        if region_3d is not None and old_view_perspective is not None:
            try:
                region_3d.view_perspective = old_view_perspective
            except Exception:
                pass
        scene.camera = old_camera
        scene.frame_start = old_frame_start
        scene.frame_end = old_frame_end
        scene.frame_set(old_frame_current)
        bpy.context.view_layer.update()
        scene.render.fps = old_fps
        scene.render.fps_base = old_fps_base
        scene.render.resolution_x = old_x
        scene.render.resolution_y = old_y
        scene.render.resolution_percentage = old_percent
        scene.render.image_settings.file_format = old_format
        scene.render.filepath = old_path
        scene.render.use_file_extension = old_use_file_extension


def _file_to_data_url(filepath, mime_type):
    with open(filepath, "rb") as handle:
        encoded = base64.b64encode(handle.read()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _create_recording_session(camera_name, start_frame, end_frame, fps, width, height, quality=90):
    scene = bpy.context.scene
    restore_frame = int(scene.frame_current)
    normalized_start = int(start_frame)
    normalized_end = max(normalized_start, int(end_frame))
    normalized_fps = max(1, int(round(fps)))
    normalized_width = max(1, int(width))
    normalized_height = max(1, int(height))
    session_name = f"capture_{int(time.time() * 1000)}"
    session_dir = os.path.join(tempfile.gettempdir(), "hmdao_blender_recordings", session_name)
    frames_dir = os.path.join(session_dir, "frames")
    os.makedirs(session_dir, exist_ok=True)
    os.makedirs(frames_dir, exist_ok=True)
    _clear_directory_files(frames_dir)
    scene.frame_set(normalized_start)
    bpy.context.view_layer.update()
    return {
        "camera_name": camera_name,
        "start_frame": normalized_start,
        "end_frame": normalized_end,
        "current_frame": normalized_start,
        "fps": normalized_fps,
        "width": normalized_width,
        "height": normalized_height,
        "quality": int(max(1, min(100, quality))),
        "status": "rendering",
        "session_dir": session_dir,
        "frames_dir": frames_dir,
        "output_path": os.path.join(session_dir, "recording.mp4"),
        "thumbnail_path": os.path.join(session_dir, "thumbnail.jpg"),
        "frame_index": 1,
        "scene_restore": {
            "frame_current": restore_frame,
        },
    }


def _restore_recording_scene(recording):
    scene = bpy.context.scene
    restore_state = recording.get("scene_restore") or {}
    restore_frame = int(restore_state.get("frame_current", scene.frame_current))
    scene.frame_set(restore_frame)
    bpy.context.view_layer.update()


def _finalize_recording_session(recording):
    sequence_probe = _find_rendered_output_file(recording["frames_dir"], "frame_", [".png"])
    if not sequence_probe:
        raise RuntimeError("Blender did not produce a frame sequence for the requested recording range.")
    encoder_name = _run_ffmpeg_encode(recording["frames_dir"], recording["fps"], recording["output_path"])
    frame_count = max(1, int(recording["end_frame"]) - int(recording["start_frame"]) + 1)
    return {
        "file_path": recording["output_path"],
        "thumbnail_path": recording["thumbnail_path"] if os.path.isfile(recording["thumbnail_path"]) else "",
        "mime_type": "video/mp4",
        "width": int(recording["width"]),
        "height": int(recording["height"]),
        "start_frame": int(recording["start_frame"]),
        "end_frame": int(recording["end_frame"]),
        "fps": int(recording["fps"]),
        "duration_ms": int(round((frame_count / float(max(1, int(recording["fps"])))) * 1000.0)),
        "size_bytes": os.path.getsize(recording["output_path"]),
        "encoder": encoder_name,
    }

class HMDaoClient:
    def __init__(self, sock, address, server):
        self.sock = sock
        self.address = address
        self.server = server
        self.closed = False
        self.preview = None
        self.recording = None
        self.lock = threading.Lock()
        self.buffer = bytearray()

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def close(self):
        self.closed = True
        try:
            self.sock.close()
        except OSError:
            pass
        self.server.remove_client(self)

    def send(self, payload):
        if self.closed:
            return
        try:
            text = json.dumps(payload, ensure_ascii=False)
            with self.lock:
                self.sock.sendall(_encode_frame(text))
        except OSError:
            self.close()

    def _handshake(self):
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("empty handshake")
            data += chunk
            if len(data) > 65536:
                raise ConnectionError("handshake too large")
        header_end = data.index(b"\r\n\r\n")
        self.buffer.extend(data[header_end + 4:])
        header = data.decode("utf-8", "ignore")
        request_line = header.splitlines()[0] if header.splitlines() else ""
        if "upgrade: websocket" not in header.lower():
            body = json.dumps({"success": True, "service": "hmdao-blender-capture", "version": PLUGIN_VERSION}, ensure_ascii=False)
            response = (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: application/json; charset=utf-8\r\n"
                f"Content-Length: {len(body.encode('utf-8'))}\r\n"
                "Connection: close\r\n\r\n"
                f"{body}"
            )
            self.sock.sendall(response.encode("utf-8"))
            raise ConnectionError("non-websocket health request")
        key = ""
        for line in header.splitlines():
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
                break
        if not key:
            raise ConnectionError("missing websocket key")
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {_ws_accept_key(key)}\r\n\r\n"
        )
        self.sock.sendall(response.encode("ascii"))
        _log(f"WebSocket handshake ok from {self.address}: {request_line}")

    def _recv_frame_text(self):
        while len(self.buffer) < 2:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("socket closed")
            self.buffer.extend(chunk)
        first = self.buffer[0]
        second = self.buffer[1]
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        offset = 2
        if length == 126:
            while len(self.buffer) < 4:
                self.buffer.extend(self.sock.recv(4096))
            length = struct.unpack(">H", bytes(self.buffer[2:4]))[0]
            offset = 4
        elif length == 127:
            while len(self.buffer) < 10:
                self.buffer.extend(self.sock.recv(4096))
            length = struct.unpack(">Q", bytes(self.buffer[2:10]))[0]
            offset = 10
        mask = b""
        if masked:
            while len(self.buffer) < offset + 4:
                self.buffer.extend(self.sock.recv(4096))
            mask = bytes(self.buffer[offset:offset + 4])
            offset += 4
        while len(self.buffer) < offset + length:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("socket closed")
            self.buffer.extend(chunk)
        payload = bytearray(self.buffer[offset:offset + length])
        del self.buffer[:offset + length]
        if masked:
            for index in range(length):
                payload[index] ^= mask[index % 4]
        if opcode == 0x8:
            raise ConnectionError("client closed")
        if opcode != 0x1:
            return None
        return payload.decode("utf-8")

    def _run(self):
        try:
            self._handshake()
            self.server.add_client(self)
            while not self.closed:
                text = self._recv_frame_text()
                if not text:
                    continue
                try:
                    payload = json.loads(text)
                except ValueError:
                    self.send({"type": "error", "message": "HMDao Blender could not parse the incoming message."})
                    continue
                COMMAND_QUEUE.put((self, payload))
        except Exception as exc:
            _log(f"Client {self.address} closed: {exc}\n{traceback.format_exc()}")
            self.close()


class HMDaoCaptureServer:
    def __init__(self):
        self.sock = None
        self.thread = None
        self.running = False
        self.clients = set()
        self._last_request_check = 0.0
        self._last_status_write = 0.0
        self._last_error_note = ""
        self._startup_grace_until = time.monotonic() + IDLE_STARTUP_GRACE_SECONDS

    def _service_online(self):
        return bool(self.running and self.sock and self.thread and self.thread.is_alive())

    def _ensure_timer(self, first_interval):
        try:
            if bpy.app.timers.is_registered(self._timer):
                bpy.app.timers.unregister(self._timer)
        except Exception:
            pass
        bpy.app.timers.register(
            self._timer,
            first_interval=max(0.03, float(first_interval)),
            persistent=True,
        )

    def _schedule_idle_polling(self, initial_delay=None):
        delay = IDLE_STARTUP_GRACE_SECONDS if initial_delay is None else max(0.5, float(initial_delay))
        self._startup_grace_until = time.monotonic() + delay
        self._ensure_timer(delay)

    def _stop_timer(self):
        try:
            if bpy.app.timers.is_registered(self._timer):
                bpy.app.timers.unregister(self._timer)
        except Exception:
            pass

    def _close_listener(self):
        sock = self.sock
        self.sock = None
        if sock:
            try:
                sock.close()
            except OSError:
                pass

    def _mark_listener_stopped(self, note, *, unexpected):
        self.running = False
        self._last_error_note = str(note or "")
        self._close_listener()
        status_text = "HMDao capture listener stopped unexpectedly. Please start the HMDao capture service again." if unexpected else "HMDao capture service is stopped."
        _set_scene_status(status_text)
        self._touch_status_file(force=True, note=self._last_error_note or ("service-stopped" if not unexpected else "listener-stopped"))

    def start(self):
        if self._service_online():
            self._ensure_timer(0.03)
            self._touch_status_file()
            return
        if self.running:
            _log("HMDao capture listener was marked running but is no longer healthy. Restarting listener.")
            for client in list(self.clients):
                client.close()
            self.clients.clear()
            self._mark_listener_stopped("listener-restarting", unexpected=False)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((HOST, PORT))
        self.sock.listen(8)
        self.running = True
        self._last_error_note = ""
        _log(f"HMDao Blender Capture {PLUGIN_VERSION} listening on {HOST}:{PORT}")
        _set_scene_status(f"Running: {HOST}:{PORT} / v{PLUGIN_VERSION}")
        self._touch_status_file(force=True, note="service-online")
        self.thread = threading.Thread(target=self._accept_loop, daemon=True)
        self.thread.start()
        self._ensure_timer(0.03)

    def stop(self):
        for client in list(self.clients):
            client.close()
        self.clients.clear()
        self._mark_listener_stopped("service-stopped", unexpected=False)
        self._schedule_idle_polling(IDLE_REQUEST_POLL_SECONDS)

    def add_client(self, client):
        self.clients.add(client)

    def remove_client(self, client):
        self.clients.discard(client)

    def _accept_loop(self):
        while self.running and self.sock:
            try:
                listener = self.sock
                client_sock, address = listener.accept()
                _log(f"Accepted client {address}")
                HMDaoClient(client_sock, address, self).start()
            except OSError as exc:
                if not self.running or self.sock is None:
                    break
                error_code = getattr(exc, "winerror", None) or getattr(exc, "errno", None) or "unknown"
                _log(f"Accept loop stopped unexpectedly: {exc}")
                self._mark_listener_stopped(f"accept-loop-stopped:{error_code}", unexpected=True)
                break

    def _timer(self):
        if not self.running:
            if not _has_visible_ui_window():
                return IDLE_REQUEST_POLL_SECONDS
            remaining_grace = self._startup_grace_until - time.monotonic()
            if remaining_grace > 0:
                return min(IDLE_REQUEST_POLL_SECONDS, max(0.5, remaining_grace))
            self._poll_start_request()
            return IDLE_REQUEST_POLL_SECONDS
        self._touch_status_file()
        self._drain_commands()
        self._advance_recordings()
        self._push_preview_frames()
        return 0.03

    def _touch_status_file(self, force=False, note=""):
        now = time.monotonic()
        if not force and now - self._last_status_write < 1.0:
            return
        self._last_status_write = now
        next_note = str(note or self._last_error_note or "")
        _write_status_file(service_running=self._service_online(), note=next_note)

    def _poll_start_request(self):
        now = time.monotonic()
        if now - self._last_request_check < 0.75:
            return
        self._last_request_check = now
        payload = _read_request_payload()
        if not payload:
            return
        action = str(payload.get("action", "")).strip().lower()
        expires_at = float(payload.get("expiresAt") or 0.0)
        if expires_at and expires_at < time.time():
            _log("Ignored expired HMDao start request.")
            _remove_request_file()
            return
        if action != "start_server":
            _remove_request_file()
            return
        _log("Received HMDao start request from request file.")
        _remove_request_file()
        self.start()

    def _drain_commands(self):
        while True:
            try:
                client, payload = COMMAND_QUEUE.get_nowait()
            except queue.Empty:
                break
            self._handle(client, payload)

    def _push_preview_frames(self):
        now = time.monotonic()
        for client in list(self.clients):
            preview = client.preview
            if not preview:
                continue
            if client.recording:
                continue
            requested_fps = max(1, min(12, int(preview.get("fps", 8))))
            started_at = float(preview.get("started_at") or now)
            if now - started_at < PREVIEW_WARMUP_SECONDS:
                fps = min(requested_fps, PREVIEW_WARMUP_FPS)
            else:
                fps = requested_fps
            if now - preview.get("last", 0) < 1 / fps:
                continue
            preview["last"] = now
            self._send_frame(client, preview)

    def _advance_recordings(self):
        for client in list(self.clients):
            if not client.recording:
                continue
            self._push_recording_frame(client, client.preview or {})

    def _push_recording_frame(self, client, preview):
        recording = client.recording
        if not recording:
            return
        scene = bpy.context.scene
        current = int(recording.get("current_frame", recording.get("start_frame", scene.frame_start)))
        end_frame = int(recording.get("end_frame", current))
        width = int(recording.get("width") or preview.get("w") or preview.get("width") or 1280)
        height = int(recording.get("height") or preview.get("h") or preview.get("height") or 720)
        camera_name = str(recording.get("camera_name") or preview.get("camera_name") or "")
        frame_index = int(recording.get("frame_index", max(1, current - int(recording.get("start_frame", current)) + 1)))
        frame_path = os.path.join(recording["frames_dir"], f"frame_{frame_index:04d}.png")
        try:
            scene.frame_set(current)
            bpy.context.view_layer.update()
            _render_camera_still_to_file(camera_name, width, height, frame_path, quality=95, file_format="PNG")
            if frame_index == 1 and not os.path.isfile(recording["thumbnail_path"]):
                _render_camera_still_to_file(
                    camera_name,
                    width,
                    height,
                    recording["thumbnail_path"],
                    quality=int(recording.get("quality", 90)),
                    file_format="JPEG",
                )
            camera = bpy.context.scene.camera
            client.send({
                "type": "frame",
                "url": _file_to_data_url(frame_path, "image/png"),
                "width": width,
                "height": height,
                "camera_name": _selected_source_name(camera),
                "source": "plugin",
                "latency_ms": 0,
            })
        except Exception as exc:
            _log(f"Blender recording frame capture failed: {exc}\n{traceback.format_exc()}")
            client.recording = None
            _restore_recording_scene(recording)
            _set_scene_status(f"Running: {HOST}:{PORT} / v{PLUGIN_VERSION}")
            client.send({"type": "error", "message": f"Blender recording failed: {exc}"})
            return
        if current >= end_frame:
            client.send({
                "type": "recording_stopped",
                "camera_name": recording.get("camera_name") or _selected_source_name(),
                "start_frame": recording.get("start_frame"),
                "end_frame": recording.get("end_frame"),
                "fps": recording.get("fps"),
                "width": recording.get("width"),
                "height": recording.get("height"),
                "source": "plugin",
            })
            try:
                result = _finalize_recording_session(recording)
                client.send({
                    "type": "recording_done",
                    "camera_name": recording.get("camera_name") or _selected_source_name(),
                    "start_frame": result["start_frame"],
                    "end_frame": result["end_frame"],
                    "fps": result["fps"],
                    "width": result["width"],
                    "height": result["height"],
                    "duration_ms": result["duration_ms"],
                    "size_bytes": result["size_bytes"],
                    "source": "plugin",
                    "asset": {
                        "kind": "video",
                        "mimeType": result["mime_type"],
                        "width": result["width"],
                        "height": result["height"],
                        "durationMs": result["duration_ms"],
                        "sizeBytes": result["size_bytes"],
                        "cameraName": recording.get("camera_name") or _selected_source_name(),
                        "filePath": result["file_path"],
                        "thumbnailUrl": result["thumbnail_path"],
                        "encoder": result.get("encoder", ""),
                    },
                })
                self._send_timeline(client)
            except Exception as exc:
                _log(f"Blender recording finalize failed: {exc}\n{traceback.format_exc()}")
                client.send({"type": "error", "message": f"Blender recording failed: {exc}"})
            finally:
                client.recording = None
                _restore_recording_scene(recording)
                if client.preview:
                    client.preview["last"] = 0
                    client.preview["started_at"] = time.monotonic()
                _set_scene_status(f"Running: {HOST}:{PORT} / v{PLUGIN_VERSION}")
            return
        next_frame = min(end_frame, current + 1)
        scene.frame_set(next_frame)
        bpy.context.view_layer.update()
        recording["current_frame"] = next_frame
        recording["frame_index"] = frame_index + 1

    def _send_cameras(self, client):
        camera = _select_camera(None)
        client.send({
            "type": "camera_list",
            "camera_list": _camera_list(),
            "selected_camera": _selected_source_name(camera),
        })

    def _send_timeline(self, client):
        client.send(_timeline_payload())

    def _send_frame(self, client, options):
        try:
            width = int(options.get("w") or options.get("width") or 1280)
            height = int(options.get("h") or options.get("height") or 720)
            camera_name = str(options.get("camera_name") or "")
            url = _render_camera_data_url(camera_name, width, height, quality=80, file_format="JPEG")
            camera = bpy.context.scene.camera
            client.send({
                "type": "frame",
                "url": url,
                "width": width,
                "height": height,
                "camera_name": _selected_source_name(camera),
                "source": "plugin",
                "latency_ms": 0,
            })
        except Exception as exc:
            client.send({"type": "error", "message": f"Blender capture failed: {exc}"})

    def _handle(self, client, payload):
        message_type = str(payload.get("type", ""))
        if message_type == "connect":
            _select_camera(payload.get("camera_name"))
            client.send({
                "type": "connected",
                "engine": "blender",
                "mode": "real",
                "message": f"HMDao Blender Capture {PLUGIN_VERSION} connected. Preview comes from the active Blender camera or viewport fallback.",
            })
            self._send_cameras(client)
            self._send_timeline(client)
            return
        if message_type == "query_camera":
            self._send_cameras(client)
            return
        if message_type in {"query_animation_range", "timeline", "scene_info"}:
            self._send_timeline(client)
            return
        if message_type == "set_camera":
            _select_camera(payload.get("camera_name"))
            self._send_cameras(client)
            self._send_timeline(client)
            return
        if message_type == "start_preview":
            _select_camera(payload.get("camera_name"))
            client.preview = dict(payload)
            client.preview["last"] = 0
            client.preview["started_at"] = time.monotonic()
            return
        if message_type == "stop_preview":
            client.preview = None
            return
        if message_type == "capture_by_camera":
            self._capture(client, payload)
            return
        if message_type == "start_recording":
            scene = bpy.context.scene
            camera_name = payload.get("camera_name") or _selected_source_name()
            camera = _select_camera(camera_name)
            has_camera_keys = _camera_has_key_animation(camera)
            start_frame_value = payload.get("start_frame")
            if start_frame_value is None or not has_camera_keys:
                start_frame_value = scene.frame_start
            end_frame_value = payload.get("end_frame")
            if end_frame_value is None or not has_camera_keys:
                end_frame_value = scene.frame_end
            start_frame = int(start_frame_value)
            end_frame = int(end_frame_value)
            fps = int(payload.get("fps") or round(bpy.context.scene.render.fps / max(1, bpy.context.scene.render.fps_base)) or 12)
            width = int(payload.get("w") or payload.get("width") or 1280)
            height = int(payload.get("h") or payload.get("height") or 720)
            client.recording = _create_recording_session(
                camera_name,
                start_frame,
                max(start_frame, end_frame),
                fps,
                width,
                height,
                quality=int(payload.get("quality", 95)),
            )
            client.send({
                "type": "recording_started",
                "camera_name": camera_name,
                "start_frame": start_frame,
                "end_frame": max(start_frame, end_frame),
                "fps": fps,
                "source": "plugin",
                "range_mode": "timeline" if not has_camera_keys else "camera-animation",
            })
            _set_scene_status(f"HMDao recording {start_frame}-{max(start_frame, end_frame)} @ {fps}fps")
            return
        if message_type == "stop_recording":
            recording = client.recording or {}
            client.recording = None
            if recording:
                _restore_recording_scene(recording)
            if client.preview:
                client.preview["last"] = 0
                client.preview["started_at"] = time.monotonic()
            _set_scene_status(f"Running: {HOST}:{PORT} / v{PLUGIN_VERSION}")
            client.send({
                "type": "recording_stopped",
                "camera_name": payload.get("camera_name") or _selected_source_name(),
                "source": "plugin",
            })

    def _capture(self, client, payload):
        try:
            width = int(payload.get("w") or payload.get("width") or 1920)
            height = int(payload.get("h") or payload.get("height") or 1080)
            camera_name = str(payload.get("camera_name") or "")
            url = _render_camera_data_url(camera_name, width, height, quality=int(payload.get("quality", 95)), file_format="JPEG")
            camera = bpy.context.scene.camera
            client.send({
                "type": "capture_done",
                "url": url,
                "width": width,
                "height": height,
                "camera_name": _selected_source_name(camera),
                "size_bytes": len(url),
                "source": "plugin",
            })
        except Exception as exc:
            client.send({"type": "error", "message": f"Blender capture failed: {exc}"})


class HMDAO_OT_start_capture(bpy.types.Operator):
    bl_idname = "hmdao.start_capture"
    bl_label = "Start HMDao Capture Service"

    def execute(self, context):
        global SERVER
        if SERVER is None:
            SERVER = HMDaoCaptureServer()
        try:
            SERVER.start()
            context.scene.hmdao_capture_status = f"Running: {HOST}:{PORT} / v{PLUGIN_VERSION}"
            return {"FINISHED"}
        except Exception as exc:
            context.scene.hmdao_capture_status = f"Start failed: {exc}"
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}


class HMDAO_OT_stop_capture(bpy.types.Operator):
    bl_idname = "hmdao.stop_capture"
    bl_label = "Stop HMDao Capture Service"

    def execute(self, context):
        global SERVER
        if SERVER:
            SERVER.stop()
        context.scene.hmdao_capture_status = "Stopped"
        return {"FINISHED"}


class HMDAO_PT_capture_panel(bpy.types.Panel):
    bl_label = "HMDao Blender Capture"
    bl_idname = "HMDAO_PT_capture_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "HMDao"

    def draw(self, context):
        layout = self.layout
        layout.label(text="HMDao Blender Capture")
        layout.label(text="Purpose: send real Blender preview frames to the HMDao canvas.")
        layout.operator("hmdao.start_capture", icon="PLAY")
        layout.operator("hmdao.stop_capture", icon="PAUSE")
        layout.label(text=getattr(context.scene, "hmdao_capture_status", "Not started"))
        layout.label(text=f"Port: {PORT}")
        layout.label(text=f"Plugin version: {PLUGIN_VERSION}")
        layout.label(text=f"Log: {LOG_PATH}")


CLASSES = (
    HMDAO_OT_start_capture,
    HMDAO_OT_stop_capture,
    HMDAO_PT_capture_panel,
)


def register():
    global SERVER
    if not hasattr(bpy.types.Scene, "hmdao_capture_status"):
        bpy.types.Scene.hmdao_capture_status = bpy.props.StringProperty(default="Not started")
    for cls in CLASSES:
        try:
            bpy.utils.register_class(cls)
        except ValueError:
            pass
    if SERVER is None:
        SERVER = HMDaoCaptureServer()
    SERVER._schedule_idle_polling()
    _write_status_file(service_running=False, note="addon-registered")
    _log("Addon registered in low-impact idle mode; waiting for manual start or a delayed connect request check.")


def unregister():
    global SERVER
    if SERVER:
        SERVER.stop()
        SERVER._stop_timer()
        SERVER = None
    _remove_request_file()
    _remove_status_file()
    for cls in reversed(CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass
    if hasattr(bpy.types.Scene, "hmdao_capture_status"):
        del bpy.types.Scene.hmdao_capture_status

