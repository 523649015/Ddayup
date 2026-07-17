export const DEBUG_BRIDGE_STATE_ELEMENT_ID = 'hmdao-debug-bridge-state';

type DebugBridgeRecord = Record<string, unknown>;

type DebugWindow = Window & {
  __HMDAO_DEBUG__?: DebugBridgeRecord;
  __HMDAO_DEBUG_BOOTSTRAP_MARK__?: string;
  __HMDAO_DEBUG_BOOTSTRAP_ERROR__?: string;
  eval?: (script: string) => unknown;
};

type DebugDocument = Document & {
  __HMDAO_DEBUG__?: DebugBridgeRecord;
  __HMDAO_DEBUG_BOOTSTRAP_MARK__?: string;
  __HMDAO_DEBUG_BOOTSTRAP_ERROR__?: string;
};

let debugBridgeStore: DebugBridgeRecord = {};
let debugBridgeBootstrapMark: string | null = null;
let debugBridgeBootstrapError: string | null = null;

function getDebugWindow(): DebugWindow | null {
  if (typeof window === 'undefined') return null;
  return window as DebugWindow;
}

function getDebugDocument(): DebugDocument | null {
  if (typeof document === 'undefined') return null;
  return document as DebugDocument;
}

function tryAssignWindowField<K extends keyof DebugWindow>(key: K, value: DebugWindow[K]) {
  const debugWindow = getDebugWindow();
  if (!debugWindow) return false;
  try {
    if (Object.prototype.hasOwnProperty.call(debugWindow, key) || Object.isExtensible(debugWindow)) {
      debugWindow[key] = value;
      return true;
    }
  } catch {
    // Some browser shells freeze the Window object. Keep the bridge in module state instead.
  }
  return false;
}

function tryInstallWindowPrototypeField<K extends keyof DebugWindow>(
  key: K,
  getter: () => DebugWindow[K],
  setter: (value: DebugWindow[K]) => void,
) {
  const debugWindow = getDebugWindow();
  if (!debugWindow) return false;
  const prototype = Object.getPrototypeOf(debugWindow);
  if (!prototype) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor && descriptor.configurable === false) {
      return false;
    }
    Object.defineProperty(prototype, key, {
      configurable: true,
      enumerable: false,
      get: getter,
      set: setter,
    });
    return true;
  } catch {
    return false;
  }
}

function syncWindowBridge() {
  const assignedDebugBridge = tryAssignWindowField('__HMDAO_DEBUG__', debugBridgeStore);
  if (!assignedDebugBridge) {
    tryInstallWindowPrototypeField(
      '__HMDAO_DEBUG__',
      () => debugBridgeStore,
      (value) => {
        if (value && typeof value === 'object') {
          debugBridgeStore = value;
        }
      },
    );
  }
  const assignedBootstrapMark = tryAssignWindowField('__HMDAO_DEBUG_BOOTSTRAP_MARK__', debugBridgeBootstrapMark ?? undefined);
  if (!assignedBootstrapMark) {
    tryInstallWindowPrototypeField(
      '__HMDAO_DEBUG_BOOTSTRAP_MARK__',
      () => debugBridgeBootstrapMark ?? undefined,
      (value) => {
        debugBridgeBootstrapMark = value == null ? null : String(value);
      },
    );
  }
  const assignedBootstrapError = tryAssignWindowField('__HMDAO_DEBUG_BOOTSTRAP_ERROR__', debugBridgeBootstrapError ?? undefined);
  if (!assignedBootstrapError) {
    tryInstallWindowPrototypeField(
      '__HMDAO_DEBUG_BOOTSTRAP_ERROR__',
      () => debugBridgeBootstrapError ?? undefined,
      (value) => {
        debugBridgeBootstrapError = value == null ? null : String(value);
      },
    );
  }
  const debugWindow = getDebugWindow();
  const debugDocument = getDebugDocument();
  if (debugWindow && debugDocument && typeof debugWindow.eval === 'function') {
    try {
      debugDocument.__HMDAO_DEBUG__ = debugBridgeStore;
      debugDocument.__HMDAO_DEBUG_BOOTSTRAP_MARK__ = debugBridgeBootstrapMark ?? undefined;
      debugDocument.__HMDAO_DEBUG_BOOTSTRAP_ERROR__ = debugBridgeBootstrapError ?? undefined;
      debugWindow.eval(`
        var __HMDAO_DEBUG__ = document.__HMDAO_DEBUG__;
        var __HMDAO_DEBUG_BOOTSTRAP_MARK__ = document.__HMDAO_DEBUG_BOOTSTRAP_MARK__;
        var __HMDAO_DEBUG_BOOTSTRAP_ERROR__ = document.__HMDAO_DEBUG_BOOTSTRAP_ERROR__;
        __HMDAO_DEBUG__ = document.__HMDAO_DEBUG__;
        __HMDAO_DEBUG_BOOTSTRAP_MARK__ = document.__HMDAO_DEBUG_BOOTSTRAP_MARK__;
        __HMDAO_DEBUG_BOOTSTRAP_ERROR__ = document.__HMDAO_DEBUG_BOOTSTRAP_ERROR__;
      `);
    } catch {
      // Some embedded shells only allow the document fallback; keep the module-scoped bridge alive.
    }
  }
}

export function readDebugBridge() {
  const debugWindow = getDebugWindow();
  if (debugWindow) {
    try {
      const windowBridge = debugWindow.__HMDAO_DEBUG__;
      if (windowBridge && typeof windowBridge === 'object') {
        debugBridgeStore = windowBridge;
      }
    } catch {
      // Ignore Window access failures and keep the module-scoped copy alive.
    }
  }
  const debugDocument = getDebugDocument();
  if (debugDocument?.__HMDAO_DEBUG__ && typeof debugDocument.__HMDAO_DEBUG__ === 'object') {
    debugBridgeStore = debugDocument.__HMDAO_DEBUG__;
  }
  return debugBridgeStore;
}

export function replaceDebugBridge(nextBridge: DebugBridgeRecord) {
  debugBridgeStore = { ...nextBridge };
  syncWindowBridge();
  publishDebugBridgeState();
  return debugBridgeStore;
}

export function patchDebugBridge(patch: DebugBridgeRecord) {
  debugBridgeStore = {
    ...readDebugBridge(),
    ...patch,
  };
  syncWindowBridge();
  publishDebugBridgeState();
  return debugBridgeStore;
}

export function readDebugBridgePublicState() {
  const bridge = readDebugBridge();
  return {
    mark: debugBridgeBootstrapMark,
    error: debugBridgeBootstrapError,
    hasDebug: Object.keys(bridge).length > 0,
    debugKeys: Object.keys(bridge).sort(),
    hasCanvasStore: Boolean(bridge.canvasStore),
    hasReadCanvasSnapshot: typeof bridge.readCanvasSnapshot === 'function',
    bridgeAttached: typeof document !== 'undefined'
      ? document.documentElement?.dataset?.hmdaoDebugBridgeAttached || null
      : null,
    bridgeStateElement: typeof document !== 'undefined'
      ? Boolean(document.getElementById(DEBUG_BRIDGE_STATE_ELEMENT_ID))
      : false,
  };
}

export function ensureDebugBridgeStateElement() {
  if (typeof document === 'undefined') return null;
  let element = document.getElementById(DEBUG_BRIDGE_STATE_ELEMENT_ID) as HTMLDivElement | null;
  if (!element) {
    element = document.createElement('div');
    element.id = DEBUG_BRIDGE_STATE_ELEMENT_ID;
    element.hidden = true;
    element.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(element);
  }
  return element;
}

export function publishDebugBridgeState(extraState: Record<string, unknown> = {}) {
  const element = ensureDebugBridgeStateElement();
  if (!element) return null;
  const nextState = {
    ...readDebugBridgePublicState(),
    ...extraState,
  };
  element.dataset.bridgeMark = String(nextState.mark ?? '');
  element.dataset.bridgeError = String(nextState.error ?? '');
  element.dataset.bridgeHasDebug = String(Boolean(nextState.hasDebug));
  element.dataset.bridgeHasCanvasStore = String(Boolean(nextState.hasCanvasStore));
  element.dataset.bridgeHasReadCanvasSnapshot = String(Boolean(nextState.hasReadCanvasSnapshot));
  element.dataset.bridgeStateJson = JSON.stringify(nextState);
  return nextState;
}

export function setDebugBridgeBootstrapState(mark: string | null, error?: string | null) {
  debugBridgeBootstrapMark = mark;
  debugBridgeBootstrapError = error ?? null;
  syncWindowBridge();
  publishDebugBridgeState();
}
