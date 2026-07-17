/**
 * Phase 7：预设模型清单测试（LaMa / @imgly 去背 标注作用节点与用途）
 *
 * 验收点：
 *   1️⃣ PRESET_MODELS 包含 real-esrgan-x4 / lama-inpaint / imgly-bgremoval。
 *   2️⃣ 本地开源模型均标注 node='图片节点'、localOnly=true。
 */

import { describe, it, expect } from 'vitest';
import { PRESET_MODELS } from '@/config/presetModels';

describe('presetModels 本地开源模型标注', () => {
  it('包含 Real-ESRGAN / LaMa / @imgly 去背', () => {
    const ids = PRESET_MODELS.map((m) => m.id);
    expect(ids).toContain('real-esrgan-x4');
    expect(ids).toContain('lama-inpaint');
    expect(ids).toContain('imgly-bgremoval');
  });

  it('本地开源模型均标注作用节点与主要用途', () => {
    const local = PRESET_MODELS.filter((m) => m.localOnly);
    for (const model of local) {
      expect(model.node && model.node.length > 0).toBe(true);
      expect(model.purpose && model.purpose.length > 0).toBe(true);
    }
    const lama = PRESET_MODELS.find((m) => m.id === 'lama-inpaint')!;
    expect(lama.node).toBe('图片节点');
    expect(lama.purpose).toContain('局部编辑');
    const bg = PRESET_MODELS.find((m) => m.id === 'imgly-bgremoval')!;
    expect(bg.node).toBe('图片节点');
    expect(bg.purpose).toContain('去背');
  });
});
