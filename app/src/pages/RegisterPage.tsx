import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, UserPlus, Loader2, Check, X } from 'lucide-react';
import { usePublicUILanguage } from '@/i18n/publicUi';
import { emailRegisterSchema, getPasswordStrength, type EmailRegisterInput } from '@/schemas/authSchemas';
import { signUpWithEmail } from '@/services/authService';
import { useAuthStore } from '@/store/useAuthStore';
import { ComplianceNotice } from '@/components/ComplianceNotice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

export default function RegisterPage() {
  const navigate = useNavigate();
  const { language, setLanguage, t } = usePublicUILanguage();
  // ★2026-08-22 修复（侧栏本地记忆）：已登录用户访问 /register 自动跳到首页,
  //   避免重复提示"该邮箱已注册"。
  const hasHydratedR = useAuthStore((s) => s.hasHydrated);
  const isAuthenticatedR = useAuthStore((s) => s.isAuthenticated);
  useEffect(() => {
    if (!hasHydratedR) return;
    if (isAuthenticatedR()) navigate('/?skipLaunch=1', { replace: true });
  }, [hasHydratedR, isAuthenticatedR, navigate]);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyRegistered, setAlreadyRegistered] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<EmailRegisterInput>({
    resolver: zodResolver(emailRegisterSchema),
    defaultValues: { email: '', password: '', confirmPassword: '' },
  });

  const password = watch('password') || '';
  const strength = getPasswordStrength(password);

  const strengthBarColor = (level: number) => {
    if (strength.score >= level * 2) {
      if (strength.score <= 2) return 'bg-red-500';
      if (strength.score <= 4) return 'bg-amber-500';
      return 'bg-green-500';
    }
    return 'bg-slate-700';
  };

  const strengthTextColor = () => {
    if (strength.score <= 2) return 'text-red-400';
    if (strength.score <= 4) return 'text-amber-400';
    return 'text-green-400';
  };

  const passwordChecks = [
    { label: '至少 8 个字符', pass: password.length >= 8 },
    { label: '包含大写字母', pass: /[A-Z]/.test(password) },
    { label: '包含小写字母', pass: /[a-z]/.test(password) },
    { label: '包含数字', pass: /[0-9]/.test(password) },
  ];

  const onSubmit = async (data: EmailRegisterInput) => {
    setError(null);
    setAlreadyRegistered(null);
    setIsSubmitting(true);

    try {
      const result = await signUpWithEmail(data);
      if (result.success) {
        navigate('/login?registered=true', { replace: true });
        return;
      }
      // 邮箱已注册：★2026-08-21 修复——蓝色「该邮箱已注册」提示严格只显示在注册页，
      //   不再跳转到登录页带 reason=already_registered（否则会与登录页的密码错误提示同时出现）。
      //   本地显示提示并提供「去登录」链接，避免用户误以为未注册而重复创建账号。
      if (result.code === 'user_already_exists') {
        setAlreadyRegistered(data.email);
        return;
      }
      setError(result.error || t('注册失败，请重试。', 'Sign up failed. Please try again.'));
    } catch {
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
          <h1 className='text-3xl font-bold tracking-tight text-white'>DDUp</h1>
          <p className='text-sm text-slate-400'>{t('创建您的 AI 创作账号', 'Create your AI creator account')}</p>
        </div>

        <Card className='border-slate-800 bg-slate-900/60 backdrop-blur-sm'>
          <CardHeader className='space-y-1'>
            <CardTitle className='text-xl text-white'>{t('注册', 'Create Account')}</CardTitle>
            <CardDescription className='text-slate-400'>
              {t('填写以下信息创建新账号', 'Fill in the form below to create a new account')}
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className='space-y-4'>
              {alreadyRegistered ? (
                <div className='rounded-md border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-300'>
                  {t('该邮箱已注册，请直接登录。', 'This email is already registered. Please sign in directly.')}{' '}
                  <Link to='/login' state={{ email: alreadyRegistered }} className='font-medium text-blue-200 underline hover:text-blue-100'>
                    {t('去登录', 'Go to sign in')}
                  </Link>
                </div>
              ) : null}

              {error ? (
                <div className='rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400'>
                  {error}
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
                <Label htmlFor='password' className='text-slate-300'>{t('密码', 'Password')}</Label>
                <div className='relative'>
                  <Input
                    id='password'
                    type={showPassword ? 'text' : 'password'}
                    placeholder={t('至少 8 位，包含大小写字母和数字', 'At least 8 characters with upper/lowercase letters and numbers')}
                    autoComplete='new-password'
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

                {password ? (
                  <div className='mt-2 space-y-2'>
                    <div className='flex gap-1'>
                      {[1, 2, 3].map((level) => (
                        <div
                          key={level}
                          className={`h-1 flex-1 rounded-full transition-colors ${strengthBarColor(level)}`}
                        />
                      ))}
                    </div>
                    <p className={`text-xs ${strengthTextColor()}`}>
                      {t('密码强度：', 'Strength: ')}{strength.label}
                    </p>
                    <ul className='space-y-1'>
                      {passwordChecks.map((check) => (
                        <li key={check.label} className='flex items-center gap-1.5 text-xs'>
                          {check.pass ? <Check className='h-3 w-3 text-green-400' /> : <X className='h-3 w-3 text-slate-500' />}
                          <span className={check.pass ? 'text-green-400' : 'text-slate-500'}>{check.label}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {errors.password ? <p className='text-xs text-red-400'>{errors.password.message}</p> : null}
              </div>

              <div className='space-y-2'>
                <Label htmlFor='confirmPassword' className='text-slate-300'>{t('确认密码', 'Confirm Password')}</Label>
                <div className='relative'>
                  <Input
                    id='confirmPassword'
                    type={showConfirm ? 'text' : 'password'}
                    placeholder={t('再次输入密码', 'Enter password again')}
                    autoComplete='new-password'
                    disabled={isSubmitting}
                    className='border-slate-700 bg-slate-800 pr-10 text-white placeholder:text-slate-500'
                    {...register('confirmPassword')}
                  />
                  <button
                    type='button'
                    onClick={() => setShowConfirm((value) => !value)}
                    className='absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-300'
                    tabIndex={-1}
                  >
                    {showConfirm ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                  </button>
                </div>
                {errors.confirmPassword ? <p className='text-xs text-red-400'>{errors.confirmPassword.message}</p> : null}
              </div>

              <Button type='submit' disabled={isSubmitting} className='w-full bg-blue-600 text-white hover:bg-blue-700'>
                {isSubmitting ? (
                  <>
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    {t('注册中...', 'Creating account...')}
                  </>
                ) : (
                  <>
                    <UserPlus className='mr-2 h-4 w-4' />
                    {t('创建账号', 'Create Account')}
                  </>
                )}
              </Button>
            </form>
          </CardContent>

          <CardFooter className='flex flex-col space-y-4'>
            <p className='text-center text-sm text-slate-400'>
              {t('已有账号？', 'Already have an account?')}{' '}
              <Link to='/login' className='font-medium text-blue-400 hover:text-blue-300'>
                {t('立即登录', 'Sign in now')}
              </Link>
            </p>
            <ComplianceNotice mode='register' />
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
