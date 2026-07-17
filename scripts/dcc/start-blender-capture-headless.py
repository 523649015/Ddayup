import sys
import tempfile
import time
import traceback

import bpy


LOG_PATH = tempfile.gettempdir() + "\\hmdao_blender_headless_runtime.log"


def log(message):
    text = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n"
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(text)


def ensure_camera():
    scene = bpy.context.scene
    if scene.camera:
        return scene.camera
    for obj in scene.objects:
      if obj.type == "CAMERA":
        scene.camera = obj
        return obj
    bpy.ops.object.camera_add(location=(7.0, -7.0, 5.0), rotation=(1.1, 0.0, 0.8))
    scene.camera = bpy.context.active_object
    return scene.camera


def main():
    addon_module = "hmdao_blender_capture"
    log("starting headless blender capture runtime")
    bpy.ops.preferences.addon_enable(module=addon_module)
    log("addon enabled")
    ensure_camera()
    log(f"active camera={bpy.context.scene.camera.name if bpy.context.scene.camera else 'none'}")
    module = sys.modules.get(addon_module)
    if module is None:
        module = __import__(addon_module)
    log("addon module imported")
    if getattr(module, "SERVER", None) is None:
        module.SERVER = module.HMDaoCaptureServer()
    if not module.SERVER.running:
        module.SERVER.start()
    log(f"service ready on 127.0.0.1:{module.PORT}")
    print(f"[HMDao Blender Headless] service ready on 127.0.0.1:{module.PORT}", flush=True)

    if bpy.app.background:
        log("running in background mode; entering manual service loop")
        while True:
            module.SERVER._drain_commands()
            module.SERVER._push_preview_frames()
            time.sleep(0.03)
    else:
        log("running in GUI mode; service loop delegated to Blender timers")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        log(f"fatal error: {exc}\n{traceback.format_exc()}")
        raise
