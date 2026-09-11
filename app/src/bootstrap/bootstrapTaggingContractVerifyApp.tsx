import { StrictMode } from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { TaggingContractVerifyCanvas } from '@/components/TaggingContractVerifyCanvas';
import { setDebugBridgeBootstrapState } from '@/services/debugBridge';
import { useApiKeyStore, isUnusableProviderKeyStatus } from '@/store/useApiKeyStore';

async function bootstrapLocalDemoApiKeys() {
  const apiKeyStore = useApiKeyStore.getState();
  const hasImageAccess = Object.values(apiKeyStore.keys).some((entry) => (
    entry
    && entry.mode === 'image'
    // 任务 AL：invalid 与 expired 同为不可用，避免已失效 key 让引导流误判已有图像权限。
    && !isUnusableProviderKeyStatus(entry.status)
    && (entry.apiKey || entry.metadataOnly)
  ));
  if (hasImageAccess) return;

  await apiKeyStore.setKey({
    provider: 'volcengine',
    maskedKey: '平台代管',
    mode: 'image',
    model: 'doubao-seedream-5-0-lite',
    source: 'platform',
    metadataOnly: true,
  });
  await apiKeyStore.setKey({
    provider: 'openai',
    maskedKey: '平台代管',
    mode: 'image',
    model: 'gpt-image-2',
    source: 'platform',
    metadataOnly: true,
  });
}

export function bootstrapTaggingContractVerifyApp() {
  setDebugBridgeBootstrapState('started');
  ReactDOMClient.createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <TaggingContractVerifyCanvas />
    </StrictMode>,
  );
  queueMicrotask(() => {
    void bootstrapLocalDemoApiKeys();
  });
}
