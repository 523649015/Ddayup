import { StrictMode } from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { TaggingContractVerifyCanvas } from '@/components/TaggingContractVerifyCanvas';
import { setDebugBridgeBootstrapState } from '@/services/debugBridge';

async function bootstrapLocalDemoApiKeys() {
  const { useApiKeyStore } = await import('@/store/useApiKeyStore');
  const apiKeyStore = useApiKeyStore.getState();
  const hasImageAccess = Object.values(apiKeyStore.keys).some((entry) => (
    entry
    && entry.mode === 'image'
    && entry.status !== 'expired'
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
