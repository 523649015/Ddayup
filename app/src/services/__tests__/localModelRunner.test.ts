/**
 * Phase 7：本地模型运行器注册表测试
 *
 * 验收点：
 *   1️⃣ 注册后可查询到运行器，hasLocalModelRunner 返回 true。
 *   2️⃣ 注册 null 时移除运行器。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerLocalModelRunner,
  getLocalModelRunner,
  hasLocalModelRunner,
} from '@/services/localModelRunner';

describe('localModelRunner 注册表', () => {
  beforeEach(() => {
    registerLocalModelRunner('real-esrgan-x4', null);
    registerLocalModelRunner('lama-inpaint', null);
    registerLocalModelRunner('imgly-bgremoval', null);
  });

  it('注册后可查询', () => {
    const runner = async () => ({ blob: new Blob(), width: 1, height: 1, engine: 'x' });
    registerLocalModelRunner('real-esrgan-x4', runner);
    expect(hasLocalModelRunner('real-esrgan-x4')).toBe(true);
    expect(getLocalModelRunner('real-esrgan-x4')).toBe(runner);
    expect(getLocalModelRunner('lama-inpaint')).toBeUndefined();
  });

  it('注册 null 时移除运行器', () => {
    const runner = async () => ({ blob: new Blob(), width: 1, height: 1, engine: 'x' });
    registerLocalModelRunner('lama-inpaint', runner);
    expect(hasLocalModelRunner('lama-inpaint')).toBe(true);
    registerLocalModelRunner('lama-inpaint', null);
    expect(hasLocalModelRunner('lama-inpaint')).toBe(false);
  });
});
