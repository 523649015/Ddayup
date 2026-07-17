/**
 * 资产库多窗口/多标签页同步
 *
 * 资产库（含 VLM 分析结果、标签）默认只在各窗口的内存 store 中维护，
 * zustand persist 仅持久化少量偏好字段，因此多个标签页打开同一资产库时，
 * 一个窗口里的 VLM 分析 / 打标结果不会同步到其它窗口，造成“跨窗口不一致”。
 *
 * 这里提供一个轻量广播通道：
 * - 优先使用 BroadcastChannel（同源多窗口实时互通，且不会回声给发送方）。
 * - 不支持时回退到 localStorage 的 storage 事件（同样只在其余标签页触发）。
 *
 * 同步的是“增量补丁”（仅 tags/analysis/smartCategories/prompt），而非整库 state，
 * 既保证 VLM 闭环结果在窗口间一致，也避免整库覆盖导致的并发编辑丢失。
 */
import type { AssetImageAnalysis } from '@/types/assets';

export interface AssetPatch {
  itemId: string;
  tags?: string[];
  smartCategories?: string[];
  analysis?: AssetImageAnalysis;
  prompt?: string;
  updatedAt?: number;
}

const CHANNEL_NAME = 'hmdao-asset-library-sync';
const LS_KEY = 'hmdao-asset-patch';
const senderId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type Listener = (patch: AssetPatch) => void;

let channel: BroadcastChannel | null = null;
let channelReady = false;
let lsListenerAttached = false;
const listeners = new Set<Listener>();

function emit(patch: AssetPatch) {
  listeners.forEach((listener) => {
    try {
      listener(patch);
    } catch {
      /* 单个监听失败不影响其余 */
    }
  });
}

function ensureChannel(): boolean {
  if (typeof window === 'undefined') return false;
  if (channelReady) return channel !== null;
  channelReady = true;

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event: MessageEvent) => {
        const data = event.data as { senderId?: string; payload?: AssetPatch } | null;
        if (data?.senderId === senderId || !data?.payload) return;
        emit(data.payload);
      };
      return true;
    } catch {
      channel = null;
    }
  }

  // 回退：localStorage storage 事件（仅在其它标签页触发，发送方不接收）
  if (!lsListenerAttached) {
    lsListenerAttached = true;
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== LS_KEY || !event.newValue) return;
      try {
        const data = JSON.parse(event.newValue) as { senderId?: string; payload?: AssetPatch };
        if (data.senderId === senderId || !data.payload) return;
        emit(data.payload);
      } catch {
        /* 忽略损坏的负载 */
      }
    });
  }
  return false;
}

/** 发送一次资产补丁（不会回声给当前窗口） */
export function postAssetPatch(patch: AssetPatch): void {
  if (typeof window === 'undefined') return;
  const hasChannel = ensureChannel();
  if (hasChannel && channel) {
    channel.postMessage({ senderId, payload: patch });
    return;
  }
  try {
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify({ senderId, payload: patch, ts: Date.now() }),
    );
  } catch {
    /* 存储不可用时静默 */
  }
}

/** 订阅其它窗口发来的资产补丁，返回取消订阅函数 */
export function onAssetPatch(listener: Listener): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
