/**
 * HMDao 服务层错误边界 — 异步服务函数崩溃隔离
 *
 * 与 React ErrorBoundary (GlobalErrorBoundary / NodeErrorBoundary) 互补：
 * - React ErrorBoundary 捕获渲染阶段的同步异常
 * - ServiceErrorBoundary 包装异步服务函数，防止 Promise rejection 传播
 *
 * 核心机制：
 * 1. wrapService — 包装单个异步函数，自动 try/catch + 结构化日志
 * 2. CircuitBreaker — 熔断器，连续失败 N 次后拒绝执行，防止雪崩
 * 3. 与 safeFetch 错误分类体系对齐
 */

import { classifyError, logError, type ErrorCategory } from '@/engine/safe-fetch';

// ===== 服务包装结果 =====

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  category: ErrorCategory;
  timestamp: number;
}

// ===== 服务包装选项 =====

export interface ServiceWrapOptions {
  /** 服务名称，用于日志标识 */
  name: string;
  /** 失败时的降级返回值 */
  fallback?: unknown;
  /** 是否在失败时重新抛出（默认 false，吞掉异常） */
  rethrow?: boolean;
  /** 超时时间 (ms)，0 表示不设超时 */
  timeout?: number;
  /** 重试次数 */
  retries?: number;
}

// ===== 熔断器状态 =====

interface CircuitState {
  failures: number;
  lastFailureTime: number;
  open: boolean;
}

// ===== 熔断器配置 =====

export interface CircuitBreakerConfig {
  /** 熔断阈值 — 连续失败次数 */
  threshold: number;
  /** 熔断恢复时间 (ms) — 熔断后多久尝试半开 */
  recoveryMs: number;
  /** 服务名称 */
  name: string;
}

// ===== 全局熔断器注册表 =====

const circuitRegistry = new Map<string, CircuitState>();

/** 获取或创建熔断器状态 */
function getCircuitState(name: string): CircuitState {
  if (!circuitRegistry.has(name)) {
    circuitRegistry.set(name, { failures: 0, lastFailureTime: 0, open: false });
  }
  return circuitRegistry.get(name)!;
}

/** 重置所有熔断器（用于全局重试） */
export function resetAllCircuits(): void {
  circuitRegistry.clear();
}

/** 获取所有熔断器状态（用于调试面板） */
export function getCircuitStates(): Map<string, CircuitState> {
  return new Map(circuitRegistry);
}

// ===== 熔断器类 =====

export class CircuitBreaker {
  private state: CircuitState;
  private config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
    this.state = getCircuitState(config.name);
  }

  /** 检查是否允许执行 */
  canExecute(): boolean {
    if (!this.state.open) return true;

    // 检查是否已过恢复期 → 半开状态
    const elapsed = Date.now() - this.state.lastFailureTime;
    if (elapsed >= this.config.recoveryMs) {
      this.state.open = false;
      this.state.failures = 0;
      console.info(`[HMDao CircuitBreaker] ${this.config.name} 进入半开状态，允许探测请求`);
      return true;
    }

    return false;
  }

  /** 记录成功 */
  recordSuccess(): void {
    this.state.failures = 0;
    this.state.open = false;
  }

  /** 记录失败 */
  recordFailure(): void {
    this.state.failures++;
    this.state.lastFailureTime = Date.now();

    if (this.state.failures >= this.config.threshold && !this.state.open) {
      this.state.open = true;
      console.warn(
        `[HMDao CircuitBreaker] ${this.config.name} 熔断触发！` +
        `连续 ${this.state.failures} 次失败，` +
        `${(this.config.recoveryMs / 1000).toFixed(0)}s 后恢复`
      );
    }
  }

  /** 获取当前状态快照 */
  getState(): Readonly<CircuitState> {
    return { ...this.state };
  }
}

// ===== 核心包装函数 =====

/**
 * 包装异步服务函数，提供统一的错误处理、日志和降级
 *
 * @example
 * const safeGenerate = wrapService(generateImage, {
 *   name: 'ImageGeneration',
 *   fallback: { url: '', status: 'error' },
 *   timeout: 120000,
 * });
 */
export function wrapService<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: ServiceWrapOptions,
): (...args: TArgs) => Promise<ServiceResult<TResult>> {
  const { name, fallback, rethrow = false, timeout = 0, retries = 0 } = options;

  return async (...args: TArgs): Promise<ServiceResult<TResult>> => {
    const startTime = Date.now();
    let lastError: unknown = null;

    const maxAttempts = retries + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        let result: TResult;

        if (timeout > 0) {
          // 带超时的执行
          result = await Promise.race([
            fn(...args),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new DOMException(`${name} 超时 (${timeout}ms)`, 'TimeoutError')), timeout)
            ),
          ]);
        } else {
          result = await fn(...args);
        }

        const duration = Date.now() - startTime;
        if (attempt > 0) {
          console.info(`[HMDao Service] ${name} 第 ${attempt + 1} 次尝试成功 (${duration}ms)`);
        }

        return {
          success: true,
          data: result,
          category: 'network' as ErrorCategory, // 成功时 category 无意义但保持类型完整
          timestamp: Date.now(),
        };
      } catch (err) {
        lastError = err;
        const category = classifyError(err);

        logError(err instanceof Error ? err : new Error(String(err)), {
          module: name,
          function: `attempt_${attempt + 1}`,
          category,
        });

        // 最后一次尝试失败，不再重试
        if (attempt === maxAttempts - 1) {
          break;
        }

        // 指数退避等待后重试
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.warn(`[HMDao Service] ${name} 失败，${delay}ms 后重试 (${attempt + 1}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // 所有尝试均失败
    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    const category = classifyError(lastError);

    console.error(`[HMDao Service] ${name} 全部 ${maxAttempts} 次尝试失败: ${errorMessage}`);

    if (rethrow) {
      throw lastError instanceof Error ? lastError : new Error(errorMessage);
    }

    return {
      success: false,
      data: fallback as TResult | undefined,
      error: errorMessage,
      category,
      timestamp: Date.now(),
    };
  };
}

// ===== 带熔断器的服务包装 =====

/**
 * 包装异步服务函数，附加熔断器保护
 * 连续失败超过阈值后自动熔断，拒绝执行直到恢复期结束
 */
export function wrapServiceWithBreaker<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  serviceOptions: ServiceWrapOptions,
  breakerConfig: CircuitBreakerConfig,
): (...args: TArgs) => Promise<ServiceResult<TResult>> {
  const breaker = new CircuitBreaker(breakerConfig);
  const wrappedFn = wrapService(fn, serviceOptions);

  return async (...args: TArgs): Promise<ServiceResult<TResult>> => {
    if (!breaker.canExecute()) {
      return {
        success: false,
        error: `[熔断] ${breakerConfig.name} 已熔断，请稍后重试`,
        category: 'network',
        timestamp: Date.now(),
      };
    }

    const result = await wrappedFn(...args);

    if (result.success) {
      breaker.recordSuccess();
    } else {
      breaker.recordFailure();
    }

    return result;
  };
}

// ===== 批量服务包装 =====

/**
 * 安全执行多个服务函数，部分失败不影响整体
 * 用于启动时初始化多个服务模块
 */
export async function safeInitAll(
  tasks: Array<{
    name: string;
    fn: () => Promise<unknown>;
    critical?: boolean; // 关键任务失败则整体失败
  }>,
): Promise<{ success: boolean; results: Map<string, ServiceResult<unknown>> }> {
  const results = new Map<string, ServiceResult<unknown>>();
  let overallSuccess = true;

  // 并行执行所有初始化任务
  const promises = tasks.map(async (task) => {
    const wrapped = wrapService(task.fn, { name: task.name });
    const result = await wrapped();
    results.set(task.name, result);

    if (!result.success && task.critical) {
      overallSuccess = false;
      console.error(`[HMDao Init] 关键服务 ${task.name} 初始化失败: ${result.error}`);
    }
  });

  await Promise.allSettled(promises);

  return { success: overallSuccess, results };
}
