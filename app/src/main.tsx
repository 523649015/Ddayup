import './index.css';
import {
  ensureDebugBridgeStateElement,
  setDebugBridgeBootstrapState,
} from '@/services/debugBridge';
import { bootstrapTaggingContractVerifyApp } from '@/bootstrap/bootstrapTaggingContractVerifyApp';
import { getActiveHmdaoDemoMode } from '@/utils/demoMode';
import { installPreloadRecovery } from '@/utils/preloadRecovery';

async function bootstrap() {
  ensureDebugBridgeStateElement();
  setDebugBridgeBootstrapState('routing');

  if (getActiveHmdaoDemoMode() === 'tagging-contract') {
    bootstrapTaggingContractVerifyApp();
    return;
  }

  const { bootstrapMainApp } = await import('@/bootstrap/bootstrapMainApp');
  bootstrapMainApp();
}

installPreloadRecovery();

void bootstrap().catch((error) => {
  const message = String(error instanceof Error ? error.message : error || 'unknown-bootstrap-error');
  setDebugBridgeBootstrapState('error', message);
  console.error('[HMDao] Application bootstrap failed.', error);
});
