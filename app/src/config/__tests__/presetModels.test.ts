import { PRESET_MODELS } from '@/config/presetModels';

describe('presetModels 本地开源模型标注', () => {
  it('包含 Real-ESRGAN / LaMa / @imgly 去背', () => {
    const ids = PRESET_MODELS.map((m) => m.id);
    expect(ids).toContain('real-esrgan-x4');
    expect(ids).toContain('lama-inpaint');
    expect(ids).toContain('imgly-bgremoval');
  });
});
