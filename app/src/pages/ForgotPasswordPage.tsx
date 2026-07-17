import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { usePublicUILanguage } from '@/i18n/publicUi';
import { emailResetSchema, type EmailResetInput } from '@/schemas/authSchemas';
import { resetPasswordWithEmail } from '@/services/authService';
import { ComplianceNotice } from '@/components/ComplianceNotice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const { language, setLanguage, t } = usePublicUILanguage();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<EmailResetInput>({
    resolver: zodResolver(emailResetSchema),
    defaultValues: { email: '', password: '', confirmPassword: '' },
  });

  const onSubmit = async (data: EmailResetInput) => {
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);
    try {
      const result = await resetPasswordWithEmail(data);
      if (result.success) {
        setSuccess(t('密码已更新，正在返回登录页。', 'Password updated. Returning to sign-in.'));
        window.setTimeout(() => {
          navigate('/login?reset=1', { replace: true });
        }, 700);
      } else {
        setError(result.error || t('重置密码失败，请重试。', 'Password reset failed. Please try again.'));
      }
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
          <p className='text-sm text-slate-400'>
            {t('本地账号密码恢复', 'Local account password recovery')}
          </p>
        </div>

        <Card className='border-slate-800 bg-slate-900/60 backdrop-blur-sm'>
          <CardHeader className='space-y-1'>
            <CardTitle className='text-xl text-white'>{t('重置密码', 'Reset Password')}</CardTitle>
            <CardDescription className='text-slate-400'>
              {t('当前为本地账号模式，不会发送邮件，直接更新该邮箱在本机保存的密码。', 'Local account mode does not send email. It updates the password stored on this device for the email below.')}
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className='space-y-4'>
              {success ? (
                <div className='rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300'>
                  {success}
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
                <Label htmlFor='password' className='text-slate-300'>{t('新密码', 'New password')}</Label>
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
                {errors.password ? <p className='text-xs text-red-400'>{errors.password.message}</p> : null}
              </div>

              <div className='space-y-2'>
                <Label htmlFor='confirmPassword' className='text-slate-300'>{t('确认新密码', 'Confirm new password')}</Label>
                <div className='relative'>
                  <Input
                    id='confirmPassword'
                    type={showConfirm ? 'text' : 'password'}
                    placeholder={t('再次输入新密码', 'Enter the new password again')}
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
                    {t('更新中...', 'Updating...')}
                  </>
                ) : (
                  <>
                    <KeyRound className='mr-2 h-4 w-4' />
                    {t('更新密码', 'Update password')}
                  </>
                )}
              </Button>
            </form>
          </CardContent>

          <CardFooter className='flex flex-col space-y-4'>
            <p className='text-center text-sm text-slate-400'>
              <Link to='/login' className='font-medium text-blue-400 hover:text-blue-300'>
                {t('返回登录', 'Back to sign in')}
              </Link>
            </p>
            <ComplianceNotice mode='login' />
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
