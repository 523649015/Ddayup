/**
 * HMDao 认证错误映射与解析
 */

export const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: '邮箱或密码错误，请重新输入。',
  invalid_email: '邮箱格式不正确。',
  email_not_confirmed: '邮箱尚未验证，请先完成验证。',
  user_not_found: '该邮箱尚未注册。',
  user_already_exists: '该邮箱已注册，请直接登录。',
  weak_password: '密码强度不足，请使用更复杂的密码。',
  rate_limit: '操作过于频繁，请稍后再试。',
  session_expired: '登录已过期，请重新登录。',
  network_error: '网络连接失败，请检查网络后重试。',
  timeout: '请求超时，请稍后重试。',
  request_timeout: '认证服务响应超时，请稍后重试。',
  service_unreachable: '认证服务未启动或不可达，请先启动本地服务。',
  service_unavailable: '认证服务暂时不可用，请稍后重试。',
  server_error: '服务器异常，请稍后再试。',
  too_many_requests: '请求过于频繁，请稍后再试。',
  email_taken: '该邮箱已被注册。',
  phone_taken: '该手机号已被注册。',
  invalid_code: '验证码错误或已失效。',
  code_expired: '验证码已过期，请重新获取。',
  password_mismatch: '两次输入的密码不一致。',
  validation_error: '输入内容格式不正确。',
  unauthorized: '尚未授权，请先登录。',
  forbidden: '当前账号没有执行此操作的权限。',
  not_found: '请求的资源不存在。',
};

export function parseAuthError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    for (const [key, value] of Object.entries(ERROR_MESSAGES)) {
      if (message.includes(key.toLowerCase())) return value;
    }

    if (message.includes('fetch') || message.includes('network')) return ERROR_MESSAGES.network_error;
    if (message.includes('timeout') || message.includes('abort')) return ERROR_MESSAGES.timeout;

    return error.message;
  }

  return '发生未知错误，请稍后再试。';
}

export function isEmailConfirmationRequired(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes('email_not_confirmed') || message.includes('confirm');
  }
  return false;
}
