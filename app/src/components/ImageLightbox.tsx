/**
 * Phase 8：图片节点「查看大图」灯箱
 *
 * 用于替代原来的 window.open 大图预览，支持：
 *   - Esc 键关闭
 *   - 点击遮罩关闭
 *   - 点击关闭按钮关闭
 *   - 图片本身点击不冒泡，避免误关
 */
import { useEffect } from 'react';

export interface ImageLightboxProps {
  url: string;
  onClose: () => void;
}

export function ImageLightbox({ url, onClose }: ImageLightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      data-testid="image-lightbox"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        data-testid="image-lightbox-close"
        onClick={onClose}
        className="absolute right-4 top-4 z-[101] flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        aria-label="关闭"
      >
        ×
      </button>
      <img
        src={url}
        alt=""
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
    </div>
  );
}
