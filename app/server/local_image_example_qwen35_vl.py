from __future__ import annotations

import os

from local_image_runtime_examples import (
    caption_to_analysis,
    extract_json_object,
    load_image,
    normalize_structured_result,
    parse_runtime_args,
    write_result,
)


STRUCTURED_PROMPT = (
    "请分析这张图片，并只输出 JSON，不要输出解释文本。"
    "JSON 字段必须包含: summary, subject, scene, style, lighting, composition, camera, mood, keywords, promptZh, promptEn。"
    "要求 promptZh 适合图像生成提示词反推，强调主体一致性、风格、光影、构图和镜头语言。"
)


def run_qwen_structured_analysis(image, model_id: str) -> tuple[dict[str, object] | None, str, list[str]]:
    warnings: list[str] = []
    try:
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor
    except Exception as exc:
        return None, "", [f"Qwen vision dependencies not available: {exc}"]

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
    model = AutoModelForImageTextToText.from_pretrained(model_id, trust_remote_code=True, torch_dtype=dtype).to(device)

    prompt_text = STRUCTURED_PROMPT
    if hasattr(processor, "apply_chat_template"):
        messages = [{
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": STRUCTURED_PROMPT},
            ],
        }]
        prompt_text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

    inputs = processor(text=[prompt_text], images=[image], padding=True, return_tensors="pt")
    prepared = {}
    for key, value in inputs.items():
        if hasattr(value, "to"):
            if getattr(value, "dtype", None) and value.dtype.is_floating_point:
                prepared[key] = value.to(device=device, dtype=dtype)
            else:
                prepared[key] = value.to(device)
        else:
            prepared[key] = value

    generated_ids = model.generate(**prepared, max_new_tokens=384, do_sample=False)
    prompt_token_count = prepared.get("input_ids").shape[1] if "input_ids" in prepared else 0
    trimmed_ids = generated_ids[:, prompt_token_count:] if prompt_token_count else generated_ids
    response_text = processor.batch_decode(trimmed_ids, skip_special_tokens=True)[0].strip()
    return extract_json_object(response_text), response_text, warnings


def main() -> None:
    request, output_json = parse_runtime_args()
    image = load_image(request)
    model_id = str(
        request.get("modelId")
        or os.environ.get("HMDAO_QWEN35_VL_MODEL")
        or os.environ.get("HMDAO_QWEN25_VL_MODEL")
        or "Qwen/Qwen2.5-VL-7B-Instruct"
    )

    structured, response_text, warnings = run_qwen_structured_analysis(image, model_id)

    if structured:
        result = normalize_structured_result(
            structured,
            engine=f"Qwen Vision Example Runtime ({model_id})",
            width=image.width,
            height=image.height,
            warnings=warnings,
        )
    else:
        if not response_text:
            response_text = "cinematic commercial image, clear subject, stable composition, layered lighting"
            warnings.append("Qwen vision runtime returned empty response; used deterministic fallback caption.")
        else:
            warnings.append("Qwen vision runtime did not return valid JSON; fell back to structured caption parsing.")
        result = caption_to_analysis(
            response_text,
            engine=f"Qwen Vision Example Runtime ({model_id})",
            width=image.width,
            height=image.height,
            warnings=warnings,
        )

    result["metadata"] = {
        **(result.get("metadata") or {}),
        "modelId": model_id,
        "promptProtocol": "structured-json",
        "rawPreview": response_text[:800],
    }
    write_result(output_json, result)


if __name__ == "__main__":
    main()
