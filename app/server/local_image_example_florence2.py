from __future__ import annotations

import os
from typing import Any

from local_image_runtime_examples import caption_to_analysis, load_image, parse_runtime_args, write_result


def run_florence_caption(image, model_id: str, task: str) -> tuple[str, list[str]]:
    warnings: list[str] = []
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor
    except Exception as exc:
        return "", [f"Florence-2 dependencies not available: {exc}"]

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(model_id, trust_remote_code=True, torch_dtype=dtype).to(device)

    inputs = processor(text=task, images=image, return_tensors="pt")
    prepared: dict[str, Any] = {}
    for key, value in inputs.items():
        if hasattr(value, "to"):
            if getattr(value, "dtype", None) and value.dtype.is_floating_point:
                prepared[key] = value.to(device=device, dtype=dtype)
            else:
                prepared[key] = value.to(device)
        else:
            prepared[key] = value

    generated_ids = model.generate(
        input_ids=prepared.get("input_ids"),
        pixel_values=prepared.get("pixel_values"),
        attention_mask=prepared.get("attention_mask"),
        max_new_tokens=256,
        num_beams=3,
    )
    generated_text = processor.batch_decode(generated_ids, skip_special_tokens=False)[0]
    if hasattr(processor, "post_process_generation"):
        parsed = processor.post_process_generation(generated_text, task=task, image_size=(image.width, image.height))
        if isinstance(parsed, dict):
            value = parsed.get(task)
            if isinstance(value, str) and value.strip():
                return value.strip(), warnings
    return generated_text.strip(), warnings


def main() -> None:
    request, output_json = parse_runtime_args()
    image = load_image(request)
    model_id = str(request.get("modelId") or os.environ.get("HMDAO_FLORENCE2_MODEL") or "microsoft/Florence-2-large")
    task = str(request.get("florenceTask") or os.environ.get("HMDAO_FLORENCE2_TASK") or "<MORE_DETAILED_CAPTION>")

    caption, warnings = run_florence_caption(image, model_id, task)
    if not caption:
        caption = "high detail commercial image, clear subject, readable composition, stable lighting"
        warnings.append("Florence-2 runtime returned empty caption; used deterministic fallback caption.")

    result = caption_to_analysis(
        caption,
        engine=f"Florence-2 Example Runtime ({model_id})",
        width=image.width,
        height=image.height,
        warnings=warnings,
    )
    result["metadata"] = {
        **(result.get("metadata") or {}),
        "modelId": model_id,
        "task": task,
    }
    write_result(output_json, result)


if __name__ == "__main__":
    main()
