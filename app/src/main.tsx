import './index.css';
import './utils/themeSync';
import './theme/light-overrides.css';
import {
  ensureDebugBridgeStateElement,
  setDebugBridgeBootstrapState,
} from '@/services/debugBridge';
import { bootstrapTaggingContractVerifyApp } from '@/bootstrap/bootstrapTaggingContractVerifyApp';
import { bootstrapMainApp } from '@/bootstrap/bootstrapMainApp'; // 静态 import：避免 Vite 将整个 App 切到独立 chunk 导致空白页
import { getActiveHmdaoDemoMode } from '@/utils/demoMode';
import { installPreloadRecovery } from '@/utils/preloadRecovery';

async function bootstrap() {
  ensureDebugBridgeStateElement();
  setDebugBridgeBootstrapState('routing');

  if (getActiveHmdaoDemoMode() === 'tagging-contract') {
    bootstrapTaggingContractVerifyApp();
    return;
  }

  bootstrapMainApp();
}

installPreloadRecovery();

// 端到端测试桩：仅 DEV 注入，生产构建会被 tree-shake 剔除（无残留代码）。
if (import.meta.env.DEV) {
  void import('@/testHarness')
    .then((m) => m.installTestHarness())
    .catch(() => {});
}

void bootstrap().catch((error) => {
  const message = String(error instanceof Error ? error.message : error || 'unknown-bootstrap-error');
  setDebugBridgeBootstrapState('error', message);
  console.error('[HMDao] Application bootstrap failed.', error);
});
