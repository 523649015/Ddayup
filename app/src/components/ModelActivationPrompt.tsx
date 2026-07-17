import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Loader2, LogIn, Mail, ShieldCheck, Sparkles, UserPlus, X } from 'lucide-react';
import { useUILanguage } from '@/i18n/ui';
import { signInWithEmail, signUpWithEmail } from '@/services/authService';
import type { GenerationMode } from '@/services/generation';

const MODE_LABELS: Record<GenerationMode, { zh: string; en: string }> = {
  llm: { zh: '文本生成', en: 'Text generation' },
  image: { zh: '图片生成', en: 'Image generation' },
  video: { zh: '视频生成', en: 'Video generation' },
  audio: { zh: '音频生成', en: 'Audio generation' },
};

const CAPABILITY_HINTS: Record<GenerationMode, { zh: string; en: string }> = {
  llm: {
    zh: '如果当前是脚本生成、提示词优化或文本续写，请选择支持 Chat / LLM 的模型，例如 Qwen、DeepSeek、GPT 系列。',
    en: 'For scripting, prompt polishing, or text continuation, choose a Chat / LLM capable model such as Qwen, DeepSeek, or GPT.',
  },
  image: {
    zh: '如果当前要生成或编辑图片，请选择支持图像生成 / 图像编辑的模型，例如 Qwen-Image、FLUX/Kontext、通义万相等。',
    en: 'For image generation or editing, choose an image-capable model such as Qwen-Image, FLUX/Kontext, or Wanx.',
  },
  video: {
    zh: '如果当前要保留参考视频运镜并套用风格参考，请选择支持 V2V / 视频参考的模型或服务。',
    en: 'To preserve reference-video motion while applying a style reference, choose a V2V / video-reference model or service.',
  },
  audio: {
    zh: '如果当前要生成旁白、BGM 或音效，请选择支持音频生成 / 语音合成 / 音频处理的模型或服务。',
    en: 'For voiceover, BGM, or sound effects, choose an audio-capable model or service.',
  },
};

type AuthTab = 'login' | 'register';

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isStrongPassword(password: string) {
  return password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password);
}

export function ModelActivationPrompt({
  open,
  mode,
  provider,
  reason,
  onClose,
}: {
  open: boolean;
  mode: GenerationMode;
  provider: string;
  reason: 'auth' | 'api-key';
  onClose: () => void;
}) {
  const { language, t } = useUILanguage();
  const lang = language === 'en' ? 'en' : 'zh';
  const modeLabel = MODE_LABELS[mode][lang];

  const [authTab, setAuthTab] = useState<AuthTab>('login');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const overlayRef = useRef<HTMLDivElement>(null);

  // 捕获阶段拦截所有鼠标/指针事件，阻止 ReactFlow onPaneClick 抢走输入框焦点
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !open) return;
    const stopAll = (e: Event) => { e.stopPropagation(); };
    overlay.addEventListener('mousedown', stopAll, true);
    overlay.addEventListener('pointerdown', stopAll, true);
    return () => {
      overlay.removeEventListener('mousedown', stopAll, true);
      overlay.removeEventListener('pointerdown', stopAll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSubmitting(false);
    setErrorMessage('');
    setSuccessMessage('');
    setAuthTab('login');
    setLoginPassword('');
    setRegisterPassword('');
    setRegisterConfirmPassword('');
  }, [open]);

  const title = reason === 'auth'
    ? t('登录后继续生成', 'Sign in to continue')
    : t('需要激活匹配能力的 API Key', 'Activate a matching model API key');

  const copy = reason === 'auth'
    ? t(
        `当前正在尝试发起${modeLabel}。请先登录或注册账号，登录成功后即可回到画布继续生成。`,
        `You are about to start ${modeLabel.toLowerCase()}. Sign in or create an account first, then return to the canvas and continue.`,
      )
    : t(
        `当前${modeLabel}尚未激活，或已激活的平台不包含这次操作需要的模型能力。请补充 ${provider} 或兼容平台的 API Key 后再继续。`,
        `The ${modeLabel.toLowerCase()} capability is not active, or the activated provider does not include the required model capability. Add a ${provider} or compatible provider key before continuing.`,
      );

  const hint = CAPABILITY_HINTS[mode][lang];

  const providerLabel = useMemo(() => {
    const normalized = String(provider || '').trim();
    return normalized || t('当前平台', 'Current provider');
  }, [provider, t]);

  async function handleInlineLogin() {
    const email = loginEmail.trim();
    if (!isValidEmail(email)) {
      setErrorMessage(t('请输入有效的邮箱地址。', 'Please enter a valid email address.'));
      return;
    }
    if (!loginPassword.trim()) {
      setErrorMessage(t('请输入密码后再继续。', 'Please enter your password.'));
      return;
    }
    setSubmitting(true);
    setErrorMessage('');
    setSuccessMessage('');
    try {
      const result = await signInWithEmail({ email, password: loginPassword });
      if (result.success) {
        setSuccessMessage(t('登录成功，正在恢复画布权限。', 'Signed in successfully. Restoring canvas access.'));
        window.setTimeout(() => {
          onClose();
        }, 260);
        return;
      }
      setErrorMessage(result.error || t('登录失败，请稍后重试。', 'Sign in failed. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleInlineRegister() {
    const email = registerEmail.trim();
    if (!isValidEmail(email)) {
      setErrorMessage(t('请输入有效的邮箱地址。', 'Please enter a valid email address.'));
      return;
    }
    if (!isStrongPassword(registerPassword)) {
      setErrorMessage(t('密码至少 8 位，并包含大小写字母和数字。', 'Use at least 8 characters with upper/lowercase letters and numbers.'));
      return;
    }
    if (registerPassword !== registerConfirmPassword) {
      setErrorMessage(t('两次输入的密码不一致。', 'The passwords do not match.'));
      return;
    }
    setSubmitting(true);
    setErrorMessage('');
    setSuccessMessage('');
    try {
      const result = await signUpWithEmail({
        email,
        password: registerPassword,
        confirmPassword: registerConfirmPassword,
      });
      if (result.success) {
        setSuccessMessage(t('账号已创建，请立即登录后继续生成。', 'Account created. Sign in now to continue.'));
        setAuthTab('login');
        setLoginEmail(email);
        setLoginPassword('');
        return;
      }
      setErrorMessage(result.error || t('注册失败，请稍后重试。', 'Sign up failed. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="nodrag nowheel nopan fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 px-4"
      data-testid="generation-auth-modal"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-[28px] border border-[#313841] bg-[#11161d] shadow-[0_28px_80px_rgba(0,0,0,0.45)]"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[#27303a] px-5 py-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#00d4aa]/12 text-[#8df4d7]">
            {reason === 'auth' ? <ShieldCheck className="h-5 w-5" /> : <KeyRound className="h-5 w-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-[#f0f6fc]">{title}</h3>
            <p className="mt-0.5 text-xs text-[#8b949e]">
              {modeLabel} / {providerLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-[#8b949e] transition hover:bg-[#1a222b] hover:text-white"
            title={t('关闭', 'Close')}
            data-testid="generation-auth-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <p className="text-sm leading-6 text-[#d1d8e0]">{copy}</p>

          <div className="rounded-2xl border border-[#244943] bg-[#0f2220] px-4 py-3 text-xs leading-6 text-[#c2efe5]">
            <div className="mb-1 flex items-center gap-2 font-medium text-[#ebfffa]">
              <Sparkles className="h-3.5 w-3.5" />
              {t('模型选择建议', 'Model capability hint')}
            </div>
            <div>{hint}</div>
          </div>

          {reason === 'auth' ? (
            <div className="space-y-4">
              <div className="inline-flex rounded-2xl bg-[#1a222b] p-1" data-testid="generation-auth-tabs">
                <button
                  type="button"
                  data-testid="generation-auth-tab-login"
                  onClick={() => {
                    setAuthTab('login');
                    setErrorMessage('');
                    setSuccessMessage('');
                  }}
                  className={`rounded-2xl px-4 py-2 text-sm transition ${
                    authTab === 'login' ? 'bg-[#00d4aa] font-medium text-[#08110e]' : 'text-[#b6c2cd] hover:text-white'
                  }`}
                >
                  登录
                </button>
                <button
                  type="button"
                  data-testid="generation-auth-tab-register"
                  onClick={() => {
                    setAuthTab('register');
                    setErrorMessage('');
                    setSuccessMessage('');
                  }}
                  className={`rounded-2xl px-4 py-2 text-sm transition ${
                    authTab === 'register' ? 'bg-[#00d4aa] font-medium text-[#08110e]' : 'text-[#b6c2cd] hover:text-white'
                  }`}
                >
                  注册
                </button>
              </div>

              {errorMessage ? (
                <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200" data-testid="generation-auth-error">
                  {errorMessage}
                </div>
              ) : null}
              {successMessage ? (
                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200" data-testid="generation-auth-success">
                  {successMessage}
                </div>
              ) : null}

              {authTab === 'login' ? (
                <div className="space-y-3" data-testid="generation-auth-login-form">
                  <label className="block space-y-2">
                    <span className="text-xs text-[#8b949e]">邮箱</span>
                    <div className="flex items-center gap-2 rounded-2xl border border-[#30363d] bg-[#0d1117] px-3 py-3">
                      <Mail className="h-4 w-4 text-[#728191]" />
                      <input
                        value={loginEmail}
                        onChange={(event) => setLoginEmail(event.target.value)}
                        type="email"
                        autoComplete="email"
                        className="w-full bg-transparent text-sm text-white outline-none placeholder:text-[#55606c]"
                        placeholder="name@email.com"
                        data-testid="generation-auth-login-email"
                      />
                    </div>
                  </label>
                  <label className="block space-y-2">
                    <span className="text-xs text-[#8b949e]">密码</span>
                    <div className="rounded-2xl border border-[#30363d] bg-[#0d1117] px-3 py-3">
                      <input
                        value={loginPassword}
                        onChange={(event) => setLoginPassword(event.target.value)}
                        type="password"
                        autoComplete="current-password"
                        className="w-full bg-transparent text-sm text-white outline-none placeholder:text-[#55606c]"
                        placeholder="请输入密码"
                        data-testid="generation-auth-login-password"
                      />
                    </div>
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleInlineLogin()}
                    disabled={submitting}
                    data-testid="generation-auth-login-submit"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#00d4aa] px-4 py-3 text-sm font-semibold text-[#08110e] transition hover:bg-[#19e2ba] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                    登录并继续
                  </button>
                </div>
              ) : (
                <div className="space-y-3" data-testid="generation-auth-register-form">
                  <label className="block space-y-2">
                    <span className="text-xs text-[#8b949e]">邮箱</span>
                    <div className="flex items-center gap-2 rounded-2xl border border-[#30363d] bg-[#0d1117] px-3 py-3">
                      <Mail className="h-4 w-4 text-[#728191]" />
                      <input
                        value={registerEmail}
                        onChange={(event) => setRegisterEmail(event.target.value)}
                        type="email"
                        autoComplete="email"
                        className="w-full bg-transparent text-sm text-white outline-none placeholder:text-[#55606c]"
                        placeholder="name@email.com"
                        data-testid="generation-auth-register-email"
                      />
                    </div>
                  </label>
                  <label className="block space-y-2">
                    <span className="text-xs text-[#8b949e]">密码</span>
                    <div className="rounded-2xl border border-[#30363d] bg-[#0d1117] px-3 py-3">
                      <input
                        value={registerPassword}
                        onChange={(event) => setRegisterPassword(event.target.value)}
                        type="password"
                        autoComplete="new-password"
                        className="w-full bg-transparent text-sm text-white outline-none placeholder:text-[#55606c]"
                        placeholder="至少 8 位，包含大小写字母和数字"
                        data-testid="generation-auth-register-password"
                      />
                    </div>
                  </label>
                  <label className="block space-y-2">
                    <span className="text-xs text-[#8b949e]">确认密码</span>
                    <div className="rounded-2xl border border-[#30363d] bg-[#0d1117] px-3 py-3">
                      <input
                        value={registerConfirmPassword}
                        onChange={(event) => setRegisterConfirmPassword(event.target.value)}
                        type="password"
                        autoComplete="new-password"
                        className="w-full bg-transparent text-sm text-white outline-none placeholder:text-[#55606c]"
                        placeholder="再次输入密码"
                        data-testid="generation-auth-register-confirm"
                      />
                    </div>
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleInlineRegister()}
                    disabled={submitting}
                    data-testid="generation-auth-register-submit"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#00d4aa] px-4 py-3 text-sm font-semibold text-[#08110e] transition hover:bg-[#19e2ba] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                    创建账号
                  </button>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2 pt-1 text-xs text-[#8b949e]">
                <span>{t('也可以使用完整页面进行登录与注册', 'You can also use the full-page auth flow')}</span>
                <Link to="/login" className="rounded-full border border-[#30363d] px-3 py-1.5 text-[#c9d1d9] transition hover:border-[#00d4aa] hover:text-white">
                  登录页
                </Link>
                <Link to="/register" className="rounded-full border border-[#30363d] px-3 py-1.5 text-[#c9d1d9] transition hover:border-[#00d4aa] hover:text-white">
                  注册页
                </Link>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-2xl border border-[#30363d] bg-[#0d1117] px-4 py-3 text-xs leading-6 text-[#96a7b8]">
                {t(
                  '推荐流程：登录账号 -> 进入 API Key 管理 -> 选择匹配能力的平台与模型 -> 验证激活 -> 回到画布继续生成。',
                  'Recommended flow: Sign in -> Open API Keys -> Choose a matching provider and model -> Validate -> Return to the canvas.',
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Link
                  to="/settings/api-keys"
                  className="inline-flex h-10 items-center gap-1.5 rounded-2xl bg-[#00d4aa] px-4 text-sm font-semibold text-[#08110e] transition hover:bg-[#19e2ba]"
                >
                  <KeyRound className="h-4 w-4" />
                  去激活 API Key
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
