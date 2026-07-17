import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Loader2, RefreshCcw, Save } from 'lucide-react';
import {
  dispatchConfigSchema,
  fetchDispatchSettings,
  saveDispatchSettings,
  type DispatchConfig,
} from '@/api/dispatchSettings';

const WEIGHT_FIELDS: Array<{ key: keyof DispatchConfig['global']['weights']; label: string }> = [
  { key: 'activation', label: 'Activation' },
  { key: 'preferredModel', label: 'Preferred Model' },
  { key: 'preferredProvider', label: 'Preferred Provider' },
  { key: 'regionMatch', label: 'Region Match' },
  { key: 'regionMismatch', label: 'Region Mismatch' },
  { key: 'cost', label: 'Cost Penalty' },
  { key: 'latency', label: 'Latency Penalty' },
  { key: 'disabled', label: 'Disabled Model' },
];

export default function DispatchSettingsPage() {
  const [loadedConfig, setLoadedConfig] = useState<DispatchConfig | null>(null);
  const [editorConfig, setEditorConfig] = useState<DispatchConfig | null>(null);
  const [rawDraft, setRawDraft] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);

  const validation = useMemo(() => {
    if (!editorConfig) return null;
    return dispatchConfigSchema.safeParse(editorConfig);
  }, [editorConfig]);
  const validationIssues = validation?.success === false ? validation.error.issues : [];
  async function load() {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetchDispatchSettings();
      setLoadedConfig(response.config);
      setEditorConfig(response.config);
      setRawDraft(JSON.stringify(response.config, null, 2));
      setConfigPath(response.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dispatch settings.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function applyStructuredUpdate(nextConfig: DispatchConfig) {
    setEditorConfig(nextConfig);
    setRawDraft(JSON.stringify(nextConfig, null, 2));
    setError(null);
  }

  async function handleSave() {
    if (!editorConfig || !validation?.success) {
      setError('Dispatch strategy has validation errors.');
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await saveDispatchSettings(validation.data);
      setLoadedConfig(response.config);
      setEditorConfig(response.config);
      setRawDraft(JSON.stringify(response.config, null, 2));
      setConfigPath(response.path);
      setMessage('Dispatch strategy saved and hot-reloaded.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save dispatch settings.');
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    if (!loadedConfig) return;
    setEditorConfig(loadedConfig);
    setRawDraft(JSON.stringify(loadedConfig, null, 2));
    setError(null);
    setMessage('Editor reset to the last loaded config.');
  }

  function applyRawDraft() {
    try {
      const parsed = JSON.parse(rawDraft) as DispatchConfig;
      const validated = dispatchConfigSchema.parse(parsed);
      setEditorConfig(validated);
      setRawDraft(JSON.stringify(validated, null, 2));
      setError(null);
      setMessage('Advanced JSON applied to the visual editor.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid dispatch strategy JSON.');
    }
  }

  if (!editorConfig && loading) {
    return <PageShell><div className="text-sm text-[#8b949e]">Loading dispatch settings...</div></PageShell>;
  }

  if (!editorConfig) {
    return <PageShell><div className="text-sm text-red-300">Unable to load dispatch settings.</div></PageShell>;
  }

  return (
    <PageShell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Dispatch Settings</h1>
          <p className="mt-1 text-sm text-[#8b949e]">
            Edit routing policy visually, keep raw JSON available, and save only when schema validation passes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/settings/api-keys" className="rounded-md border border-[#30363d] px-3 py-2 text-sm text-[#c9d1d9] hover:border-[#00d4aa]">
            API Keys
          </Link>
          <Link to="/" className="rounded-md border border-[#30363d] px-3 py-2 text-sm text-[#c9d1d9] hover:border-[#00d4aa]">
            Back To Canvas
          </Link>
        </div>
      </div>

      <div className="rounded-lg border border-[#30363d] bg-[#161b22] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-[#e6edf3]">Config File</div>
            <div className="mt-1 break-all text-xs text-[#8b949e]">{configPath || 'Loading...'}</div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void load()} disabled={loading || saving} className="inline-flex items-center gap-2 rounded-md border border-[#30363d] px-3 py-2 text-sm text-[#c9d1d9] hover:border-[#00d4aa] disabled:cursor-not-allowed disabled:opacity-60">
              <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Reload
            </button>
            <button type="button" onClick={handleReset} disabled={loading || saving || !loadedConfig} className="rounded-md border border-[#30363d] px-3 py-2 text-sm text-[#c9d1d9] hover:border-[#00d4aa] disabled:cursor-not-allowed disabled:opacity-60">
              Reset Draft
            </button>
            <button type="button" onClick={() => void handleSave()} disabled={loading || saving || !validation?.success} className="inline-flex items-center gap-2 rounded-md bg-[#00d4aa] px-4 py-2 text-sm font-medium text-[#0d1117] disabled:cursor-not-allowed disabled:bg-[#30363d] disabled:text-[#8b949e]">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Strategy
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-6">
            <section className="rounded-xl border border-[#2d333b] bg-[#0d1117] p-4">
              <div className="mb-3 text-sm font-semibold text-[#f3f4f6]">Global Weights</div>
              <div className="grid gap-3 md:grid-cols-2">
                {WEIGHT_FIELDS.map((field) => (
                  <label key={field.key} className="space-y-2 text-sm">
                    <span className="text-[#8b949e]">{field.label}</span>
                    <input
                      type="number"
                      value={String(editorConfig.global.weights[field.key])}
                      onChange={(event) => applyStructuredUpdate({
                        ...editorConfig,
                        global: {
                          ...editorConfig.global,
                          weights: {
                            ...editorConfig.global.weights,
                            [field.key]: Number(event.target.value || 0),
                          },
                        },
                      })}
                      className="w-full rounded-md border border-[#30363d] bg-[#161b22] px-3 py-2 text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                    />
                  </label>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-[#2d333b] bg-[#0d1117] p-4">
              <div className="mb-3 text-sm font-semibold text-[#f3f4f6]">Region Preference</div>
              <div className="space-y-4">
                {Object.entries(editorConfig.global.regionPreference).map(([region, preference]) => (
                  <div key={region} className="rounded-lg border border-[#30363d] bg-[#161b22] p-3">
                    <div className="mb-2 text-sm font-medium text-[#e6edf3]">{region}</div>
                    <label className="block space-y-2 text-sm">
                      <span className="text-[#8b949e]">Preferred Providers</span>
                      <input
                        value={preference.preferredProviders.join(', ')}
                        onChange={(event) => applyStructuredUpdate(updateRegionPreference(editorConfig, region, 'preferredProviders', event.target.value))}
                        className="w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                      />
                    </label>
                    <label className="mt-3 block space-y-2 text-sm">
                      <span className="text-[#8b949e]">Secondary Providers</span>
                      <input
                        value={preference.secondaryProviders.join(', ')}
                        onChange={(event) => applyStructuredUpdate(updateRegionPreference(editorConfig, region, 'secondaryProviders', event.target.value))}
                        className="w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                      />
                    </label>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-[#2d333b] bg-[#0d1117] p-4">
              <div className="mb-3 text-sm font-semibold text-[#f3f4f6]">Operation Routing</div>
              <div className="space-y-4">
                {Object.entries(editorConfig.operations).map(([operationKey, operation]) => (
                  <div key={operationKey} className="rounded-lg border border-[#30363d] bg-[#161b22] p-4">
                    <div className="mb-3 text-sm font-medium text-[#e6edf3]">{operationKey}</div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="space-y-2 text-sm md:col-span-2">
                        <span className="text-[#8b949e]">Label</span>
                        <input
                          value={operation.label || ''}
                          onChange={(event) => applyStructuredUpdate(updateOperationField(editorConfig, operationKey, 'label', event.target.value))}
                          className="w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                        />
                      </label>
                      <label className="space-y-2 text-sm md:col-span-2">
                        <span className="text-[#8b949e]">Latest Technique</span>
                        <textarea
                          value={operation.latestTechnique || ''}
                          onChange={(event) => applyStructuredUpdate(updateOperationField(editorConfig, operationKey, 'latestTechnique', event.target.value))}
                          className="min-h-[84px] w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                        />
                      </label>
                      <label className="space-y-2 text-sm">
                        <span className="text-[#8b949e]">Candidates</span>
                        <textarea
                          value={operation.candidates.join(', ')}
                          onChange={(event) => applyStructuredUpdate(updateOperationField(editorConfig, operationKey, 'candidates', csvToList(event.target.value)))}
                          className="min-h-[96px] w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                        />
                      </label>
                      <label className="space-y-2 text-sm">
                        <span className="text-[#8b949e]">Preferred Providers</span>
                        <textarea
                          value={operation.preferredProviders.join(', ')}
                          onChange={(event) => applyStructuredUpdate(updateOperationField(editorConfig, operationKey, 'preferredProviders', csvToList(event.target.value)))}
                          className="min-h-[96px] w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                        />
                      </label>
                      <label className="space-y-2 text-sm md:col-span-2">
                        <span className="text-[#8b949e]">Disabled Models</span>
                        <input
                          value={operation.disabledModels.join(', ')}
                          onChange={(event) => applyStructuredUpdate(updateOperationField(editorConfig, operationKey, 'disabledModels', csvToList(event.target.value)))}
                          className="w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none focus:border-[#00d4aa]"
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="space-y-6">
            <section className="rounded-xl border border-[#2d333b] bg-[#0d1117] p-4">
              <div className="text-sm font-semibold text-[#f3f4f6]">Validation</div>
              <div className="mt-3 text-sm text-[#8b949e]">
                {validation?.success ? 'Schema validation passed. Save is enabled.' : 'Schema validation failed. Fix issues before saving.'}
              </div>
              {validation?.success === false ? (
                <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
                  {validationIssues.map((issue, index) => (
                    <div key={`${issue.path.join('.')}-${index}`}>{issue.path.join('.')} : {issue.message}</div>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="rounded-xl border border-[#2d333b] bg-[#0d1117] p-4">
              <button
                type="button"
                onClick={() => setRawOpen((open) => !open)}
                className="flex w-full items-center justify-between text-left text-sm font-semibold text-[#f3f4f6]"
              >
                <span>Advanced JSON</span>
                <ChevronDown className={`h-4 w-4 transition-transform ${rawOpen ? 'rotate-180' : ''}`} />
              </button>
              {rawOpen ? (
                <div className="mt-4 space-y-3">
                  <textarea
                    value={rawDraft}
                    onChange={(event) => setRawDraft(event.target.value)}
                    data-testid="dispatch-settings-editor"
                    spellCheck={false}
                    className="h-[420px] w-full rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-4 font-mono text-xs leading-6 text-[#dbe6f3] outline-none focus:border-[#00d4aa]"
                  />
                  <button type="button" onClick={applyRawDraft} className="rounded-md border border-[#30363d] px-3 py-2 text-sm text-[#c9d1d9] hover:border-[#00d4aa]">
                    Apply JSON To Form
                  </button>
                </div>
              ) : null}
            </section>
          </div>
        </div>

        {message ? <div className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{message}</div> : null}
        {error ? <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div> : null}
      </div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0d1117] text-[#e6edf3]">
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">{children}</div>
    </div>
  );
}

function csvToList(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function updateRegionPreference(
  config: DispatchConfig,
  region: string,
  key: 'preferredProviders' | 'secondaryProviders',
  rawValue: string,
) {
  return {
    ...config,
    global: {
      ...config.global,
      regionPreference: {
        ...config.global.regionPreference,
        [region]: {
          ...config.global.regionPreference[region],
          [key]: csvToList(rawValue),
        },
      },
    },
  };
}

function updateOperationField<K extends keyof DispatchConfig['operations'][string]>(
  config: DispatchConfig,
  operationKey: string,
  field: K,
  value: DispatchConfig['operations'][string][K],
) {
  return {
    ...config,
    operations: {
      ...config.operations,
      [operationKey]: {
        ...config.operations[operationKey],
        [field]: value,
      },
    },
  };
}
