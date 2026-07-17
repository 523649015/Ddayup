import { z } from 'zod';

export const dispatchWeightsSchema = z.object({
  activation: z.number().finite(),
  preferredModel: z.number().finite(),
  preferredProvider: z.number().finite(),
  regionMatch: z.number().finite(),
  regionMismatch: z.number().finite(),
  cost: z.number().finite(),
  latency: z.number().finite(),
  disabled: z.number().finite(),
});

export const dispatchRegionPreferenceSchema = z.record(z.string(), z.object({
  preferredProviders: z.array(z.string()).default([]),
  secondaryProviders: z.array(z.string()).default([]),
}));

export const dispatchOperationSchema = z.object({
  label: z.string().optional(),
  latestTechnique: z.string().optional(),
  candidates: z.array(z.string()).default([]),
  preferredProviders: z.array(z.string()).default([]),
  disabledModels: z.array(z.string()).default([]),
}).passthrough();

export const dispatchConfigSchema = z.object({
  version: z.number().int().min(1),
  global: z.object({
    weights: dispatchWeightsSchema,
    regionPreference: dispatchRegionPreferenceSchema,
    disabledModels: z.array(z.string()).default([]),
  }),
  operations: z.record(z.string(), dispatchOperationSchema),
});

export type DispatchConfig = z.infer<typeof dispatchConfigSchema>;

export interface DispatchSettingsResponse {
  success: boolean;
  path: string;
  config: DispatchConfig;
}

export async function fetchDispatchSettings(): Promise<DispatchSettingsResponse> {
  const response = await fetch('/api/settings/dispatch', {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Failed to fetch dispatch settings: HTTP ${response.status}`);
  return response.json() as Promise<DispatchSettingsResponse>;
}

export async function saveDispatchSettings(config: DispatchConfig): Promise<DispatchSettingsResponse> {
  const response = await fetch('/api/settings/dispatch', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ config }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(data?.error?.message || `Failed to save dispatch settings: HTTP ${response.status}`);
  }
  return response.json() as Promise<DispatchSettingsResponse>;
}
