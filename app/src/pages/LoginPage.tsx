import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, LogIn, Loader2 } from 'lucide-react';
import { usePublicUILanguage } from '@/i18n/publicUi';
import { emailLoginSchema, type EmailLoginInput } from '@/schemas/authSchemas';
import { signInWithEmail } from '@/services/authService';
import { useAuthStore } from '@/store/useAuthStore';
import { ComplianceNotice } from '@/components/ComplianceNotice';
import { ElfLogo } from '@/components/ElfLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // ★2026-08-22 修复（侧栏本地记忆）：已登录用户访问 /login 自动跳到 from/首页，
  //   避免刷新或被引导到 /login 时误以为"需要重新登录"。
  //   等 useAuthStore.persist 完成水化(hasHydrated)后判断 session 是否有效。
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  useEffect(() => {
    if (!hasHydrated) return;
    if (isAuthenticated()) {
      const from = (location.state as { from?: string } | null)?.from || '/?skipLaunch=1';
      navigate(from, { replace: true });
    }
  }, [hasHydrated, isAuthenticated, location.state, navigate]);
  const [searchParams] = useSearchParams();
  const { language, setLanguage, t } = usePublicUILanguage();
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const successMessage = useMemo(() => {
    if (searchParams.get('reset') === '1') {
      return t('密码已重置，请使用新密码登录。', 'Password reset complete. Sign in with your new password.');
    }
    if (searchParams.get('registered') === 'true') {
      return t('账号创建成功，现在可以直接登录。', 'Account created successfully. You can sign in now.');
    }
    return '';
  }, [searchParams, t]);

  // 预填邮箱：仅从注册页跳转（邮箱已注册）带 email 时填入，但不显示「已注册」提示。
  // ★2026-08-21 修复：蓝色「该邮箱已注册」提示严格只出现在注册页（注册 409 时），
  //   登录页只显示登录相关错误（如密码错误），避免两条提示同时出现。
  const presetEmail = useMemo(() => {
    const state = location.state as { email?: string } | null;
    return state?.email || '';
  }, [location.state]);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<EmailLoginInput>({
    resolver: zodResolver(emailLoginSchema),
    defaultValues: { email: presetEmail, password: '' },
  });

  // 注册页带邮箱跳转时，将预填值写入表单
  useEffect(() => {
    if (presetEmail) setValue('email', presetEmail, { shouldValidate: false });
  }, [presetEmail, setValue]);

  const serviceErrorHint = useMemo(() => {
    if (!['service_unreachable', 'service_unavailable', 'request_timeout', 'server_error'].includes(errorCode)) {
      return '';
    }
    return t(
      '当前更像是本地认证/API 服务未启动或尚未就绪，而不是账号密码错误。请先确认 `npm run dev:full` 已启动，并检查 127.0.0.1:8792 是否可访问。',
      'This looks like a local auth/API service issue rather than bad credentials. Start `npm run dev:full` first and confirm 127.0.0.1:8792 is reachable.',
    );
  }, [errorCode, t]);

  const onSubmit = async (data: EmailLoginInput) => {
    setError(null);
    setErrorCode('');
    setIsSubmitting(true);
    try {
      const result = await signInWithEmail(data);
      if (result.success) {
        const next = (location.state as { from?: string } | null)?.from || '/?skipLaunch=1';
        navigate(next, { replace: true });
      } else {
        setErrorCode(String(result.code || ''));
        setError(result.error || t('登录失败，请重试。', 'Sign in failed. Please try again.'));
      }
    } catch {
      setErrorCode('network_error');
      setError(t('网络连接失败，请检查网络后重试。', 'Network error. Please check your connection and try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className='flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4'>
      <div className='w-full max-w-md space-y-6'>
        <div className='flex justify-end'>
          <button
            type='button'
            onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
            className='rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-slate-500'
          >
            {language === 'zh' ? 'EN' : '中文'}
          </button>
        </div>

        <div className='space-y-2 text-center'>
          <div className='flex items-center justify-center gap-3'>
            <ElfLogo size={52} />
            <h1 className='text-3xl font-bold tracking-tight text-white'>DDUp</h1>
          </div>
          <p className='text-sm text-slate-400'>
            {t('AI 驱动的无限创作画布', 'An AI-powered infinite canvas for creation')}
          </p>
        </div>

        <Card className='border-slate-800 bg-slate-900/60 backdrop-blur-sm'>
          <CardHeader className='space-y-1'>
            <CardTitle className='text-xl text-white'>{t('登录', 'Sign In')}</CardTitle>
            <CardDescription className='text-slate-400'>
              {t('使用邮箱和密码登录您的账号', 'Use your email and password to sign in')}
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className='space-y-4'>
              {successMessage ? (
                <div className='rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300'>
                  {successMessage}
                </div>
              ) : null}

              {error ? (
                <div className='rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400'>
                  {error}
                </div>
              ) : null}

              {serviceErrorHint ? (
                <div className='rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-200'>
                  {serviceErrorHint}
                </div>
              ) : null}

              <div className='space-y-2'>
                <Label htmlFor='email' className='text-slate-300'>{t('邮箱', 'Email')}</Label>
                <Input
                  id='email'
                  type='email'
                  placeholder='your@email.com'
                  autoComplete='email'
                  disabled={isSubmitting}
                  className='border-slate-700 bg-slate-800 text-white placeholder:text-slate-500'
                  {...register('email')}
                />
                {errors.email ? <p className='text-xs text-red-400'>{errors.email.message}</p> : null}
              </div>

              <div className='space-y-2'>
                <div className='flex items-center justify-between'>
                  <Label htmlFor='password' className='text-slate-300'>{t('密码', 'Password')}</Label>
                  <Link to='/forgot-password' className='text-xs text-blue-400 hover:text-blue-300'>
                    {t('忘记密码？', 'Forgot password?')}
                  </Link>
                </div>
                <div className='relative'>
                  <Input
                    id='password'
                    type={showPassword ? 'text' : 'password'}
                    placeholder={t('请输入密码', 'Enter password')}
                    autoComplete='current-password'
                    disabled={isSubmitting}
                    className='border-slate-700 bg-slate-800 pr-10 text-white placeholder:text-slate-500'
                    {...register('password')}
                  />
                  <button
                    type='button'
                    onClick={() => setShowPassword((value) => !value)}
                    className='absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-300'
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                  </button>
                </div>
                {errors.password ? <p className='text-xs text-red-400'>{errors.password.message}</p> : null}
              </div>

              <Button type='submit' disabled={isSubmitting} className='w-full bg-blue-600 text-white hover:bg-blue-700'>
                {isSubmitting ? (
                  <>
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    {t('登录中...', 'Signing in...')}
                  </>
                ) : (
                  <>
                    <LogIn className='mr-2 h-4 w-4' />
                    {t('登录', 'Sign In')}
                  </>
                )}
              </Button>
            </form>
          </CardContent>

          <CardFooter className='flex flex-col space-y-4'>
            <p className='text-center text-sm text-slate-400'>
              {t('还没有账号？', "Don't have an account?")}{' '}
              <Link to='/register' className='font-medium text-blue-400 hover:text-blue-300'>
                {t('立即注册', 'Create one now')}
              </Link>
            </p>
            <ComplianceNotice mode='login' />
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
