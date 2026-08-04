import { lazy, startTransition, Suspense, useEffect, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { RobotElfIcon } from '@/components/RobotElfIcon';

const CanvasBoard = lazy(() => import('@/components/CanvasBoard').then((module) => ({ default: module.CanvasBoard })));

const LAUNCH_SESSION_KEY = 'ddup-launch-complete';
const LAUNCH_SKIP_PARAM = 'skipLaunch';
const LAUNCH_SECONDS = 5;

function shouldBypassLaunchScreen() {
  if (typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  if (url.searchParams.get('hmdao-demo')) return true;
  if (url.searchParams.get(LAUNCH_SKIP_PARAM) === '1') return true;
  try {
    return window.sessionStorage.getItem(LAUNCH_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function LaunchCanvasPage() {
  const navigate = useNavigate();
  const [countdown, setCountdown] = useState(LAUNCH_SECONDS);
  const [exiting, setExiting] = useState(false);
  const [showLaunchScreen, setShowLaunchScreen] = useState(() => !shouldBypassLaunchScreen());

  const launchCopy = useMemo(() => ({
    title: 'DDUp',
    subtitle: '遇见更多志同道合的人',
    detail: '从灵感相遇，到画布共创，把每一次生成、拆解、编排与表达，连接成更顺手的创作现场。',
  }), []);

  useEffect(() => {
    if (!showLaunchScreen) {
      try {
        window.sessionStorage.setItem(LAUNCH_SESSION_KEY, '1');
      } catch {
        // ignore storage failures
      }
      return;
    }

    const tickTimer = window.setInterval(() => {
      setCountdown((current) => Math.max(0, current - 1));
    }, 1000);
    const exitTimer = window.setTimeout(() => {
      triggerEnterCanvas();
    }, LAUNCH_SECONDS * 1000);

    return () => {
      window.clearInterval(tickTimer);
      window.clearTimeout(exitTimer);
    };
  }, [showLaunchScreen]);

  function triggerEnterCanvas() {
    if (!showLaunchScreen || exiting) return;
    setExiting(true);
    try {
      window.sessionStorage.setItem(LAUNCH_SESSION_KEY, '1');
    } catch {
      // ignore storage failures
    }
    window.setTimeout(() => {
      startTransition(() => {
        setShowLaunchScreen(false);
        const url = new URL(window.location.href);
        url.searchParams.set(LAUNCH_SKIP_PARAM, '1');
        navigate(`${url.pathname}${url.search}`, { replace: true });
      });
    }, 340);
  }

  if (!showLaunchScreen) {
    return (
      <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-[#111] text-sm text-[#d6d6d6]">正在载入画布...</div>}>
        <CanvasBoard />
      </Suspense>
    );
  }

  return (
    <div
      data-testid="launch-screen"
      className={`relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0b1016] px-6 transition-all duration-300 ${
        exiting ? 'opacity-0 blur-sm' : 'opacity-100'
      }`}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(0,212,170,0.18),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(255,122,26,0.18),transparent_34%),linear-gradient(160deg,#0b1016_0%,#0f1821_50%,#0b1016_100%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:36px_36px]" />

      <div className="relative z-10 mx-auto flex w-full max-w-[1040px] flex-col items-center gap-10 text-center">
        <div className="space-y-6 animate-[fadeIn_600ms_ease-out]">
          <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-[28px] border border-white/10 bg-white/5 shadow-[0_30px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl">
            <RobotElfIcon size={64} />
          </div>

          <div className="space-y-4">
            <div className="text-[clamp(32px,7vw,72px)] font-semibold tracking-[-0.06em] text-white">
              {launchCopy.title}
            </div>
            <div
              data-testid="launch-copy"
              className="mx-auto max-w-[820px] text-[clamp(24px,4vw,48px)] font-semibold leading-[1.08] tracking-[-0.05em] text-[#f3fbff]"
            >
              <span className="bg-[linear-gradient(90deg,#f7fbff_0%,#9fe8da_42%,#ffd7b4_100%)] bg-clip-text text-transparent">
                {launchCopy.subtitle}
              </span>
            </div>
            <p className="mx-auto max-w-[700px] text-sm leading-7 text-[#9eb0bf] md:text-base">
              {launchCopy.detail}
            </p>
          </div>
        </div>

        <div className="grid w-full max-w-[760px] gap-3 text-left text-xs text-[#b8c4cf] md:grid-cols-3 animate-[fadeIn_820ms_ease-out]">
          <div className="rounded-[24px] border border-white/8 bg-white/[0.04] px-5 py-4 backdrop-blur-sm">
            <div className="text-[11px] uppercase tracking-[0.24em] text-[#77e7d0]">Connect</div>
            <div className="mt-2 text-sm text-[#eef8ff]">把灵感、素材与工作流放进同一张无限画布。</div>
          </div>
          <div className="rounded-[24px] border border-white/8 bg-white/[0.04] px-5 py-4 backdrop-blur-sm">
            <div className="text-[11px] uppercase tracking-[0.24em] text-[#8fd0ff]">Co-create</div>
            <div className="mt-2 text-sm text-[#eef8ff]">在图片、视频、音频与后期间自然切换，不打断创作节奏。</div>
          </div>
          <div className="rounded-[24px] border border-white/8 bg-white/[0.04] px-5 py-4 backdrop-blur-sm">
            <div className="text-[11px] uppercase tracking-[0.24em] text-[#ffcf9b]">Deliver</div>
            <div className="mt-2 text-sm text-[#eef8ff]">把结果沉淀成节点、资产与可复用流程，持续放大表达能力。</div>
          </div>
        </div>

        <div className="flex flex-col items-center gap-3 animate-[fadeIn_980ms_ease-out]">
          <button
            type="button"
            data-testid="launch-enter"
            onClick={triggerEnterCanvas}
            className="inline-flex items-center gap-2 rounded-full bg-[#00d4aa] px-6 py-3 text-sm font-semibold text-[#07110e] shadow-[0_18px_48px_rgba(0,212,170,0.28)] transition hover:bg-[#18e2ba]"
          >
            立即进入主画布
            <ArrowRight className="h-4 w-4" />
          </button>
          <div className="text-xs text-[#8ca0af]" data-testid="launch-countdown">
            {countdown} 秒后自动进入
          </div>
        </div>
      </div>
    </div>
  );
}

export default LaunchCanvasPage;
