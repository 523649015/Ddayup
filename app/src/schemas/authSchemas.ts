import { z } from 'zod';

const passwordSchema = z
  .string()
  .min(8, '密码至少 8 个字符')
  .regex(/[A-Z]/, '密码至少包含 1 个大写字母')
  .regex(/[a-z]/, '密码至少包含 1 个小写字母')
  .regex(/[0-9]/, '密码至少包含 1 个数字');

function withPasswordConfirmation<T extends z.ZodRawShape>(shape: T) {
  return z.object({
    ...shape,
    password: passwordSchema,
    confirmPassword: z.string().min(1, '请确认密码'),
  }).superRefine((data, ctx) => {
    const values = data as { password: string; confirmPassword: string };
    if (values.password === values.confirmPassword) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '两次输入的密码不一致',
      path: ['confirmPassword'],
    });
  });
}

export const emailLoginSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
  password: z.string().min(1, '请输入密码'),
});

export type EmailLoginInput = z.infer<typeof emailLoginSchema>;

export const emailRegisterSchema = withPasswordConfirmation({
  email: z.string().email('请输入有效的邮箱地址'),
});

export type EmailRegisterInput = z.infer<typeof emailRegisterSchema>;

export const emailResetSchema = withPasswordConfirmation({
  email: z.string().email('请输入有效的邮箱地址'),
});

export type EmailResetInput = z.infer<typeof emailResetSchema>;

export const phoneLoginSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效的手机号'),
  code: z.string().length(6, '验证码为 6 位数字').regex(/^\d{6}$/, '验证码为 6 位数字'),
});

export type PhoneLoginInput = z.infer<typeof phoneLoginSchema>;

export function getPasswordStrength(password: string): { score: number; label: string; color: string } {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 2) return { score, label: '弱', color: '#ef4444' };
  if (score <= 4) return { score, label: '中', color: '#f59e0b' };
  return { score, label: '强', color: '#22c55e' };
}
