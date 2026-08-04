// apimart 异步任务结果归一化与状态/错误提取（从 hmdao-api.mjs 抽取，纯函数、零状态依赖）
// 依赖：extractFirstString(str-utils) / compactObject(object-utils) / extractApimartTaskId(apimart-payload-utils)
import { extractFirstString } from './str-utils.mjs';
import { compactObject } from './object-utils.mjs';
import { extractApimartTaskId } from './apimart-payload-utils.mjs';

// 将 apimart 异步任务响应归一为统一结果结构（图片/视频/通用数据）。
function buildApimartTaskResultPayload(taskPayload = {}, submitPayload = null) {
  const task = taskPayload?.task && typeof taskPayload.task === 'object' ? taskPayload.task : {};
  const taskData = taskPayload?.data && typeof taskPayload.data === 'object' && !Array.isArray(taskPayload.data) ? taskPayload.data : {};
  const result = task?.result && typeof task.result === 'object' ? task.result : {};
  const response = task?.response && typeof task.response === 'object' ? task.response : {};
  const taskDataResult = taskData?.result && typeof taskData.result === 'object' ? taskData.result : {};
  const taskDataImages = Array.isArray(taskDataResult?.images)
    ? taskDataResult.images.flatMap((item) => {
        const urls = Array.isArray(item?.url) ? item.url : [item?.url];
        return urls
          .map((value) => extractFirstString(value))
          .filter(Boolean)
          .map((url) => ({ url }));
      })
    : [];
  const taskDataVideos = Array.isArray(taskDataResult?.videos)
    ? taskDataResult.videos.flatMap((item) => {
        const urls = Array.isArray(item?.url) ? item.url : [item?.url];
        return urls
          .map((value) => extractFirstString(value))
          .filter(Boolean)
          .map((url) => ({ url }));
      })
    : [];
  const mergedData = Array.isArray(result?.data)
    ? result.data
    : Array.isArray(response?.data)
      ? response.data
      : taskDataImages.length > 0
        ? taskDataImages
        : taskDataVideos.length > 0
          ? taskDataVideos
          : Array.isArray(taskPayload?.data)
            ? taskPayload.data
            : undefined;
  const mergedVideoResults = Array.isArray(result?.results?.videos)
    ? result.results.videos
    : Array.isArray(response?.results?.videos)
      ? response.results.videos
      : taskDataVideos.length > 0
        ? taskDataVideos
        : undefined;
  const mergedOutput = Array.isArray(result?.output)
    ? result.output
    : Array.isArray(response?.output)
      ? response.output
      : undefined;
  return compactObject({
    ...(submitPayload && typeof submitPayload === 'object' ? { submit: submitPayload } : {}),
    task_id: extractApimartTaskId(taskPayload) || extractApimartTaskId(submitPayload || {}),
    status: task?.status || taskData?.status || taskPayload?.status,
    ...response,
    ...result,
    ...taskDataResult,
    data: mergedData,
    output: mergedOutput,
    results: mergedVideoResults ? { videos: mergedVideoResults } : undefined,
  });
}

// 从多种 apimart 任务响应形态中提取统一的 status 文本。
function apimartTaskStatusValue(taskPayload = {}) {
  return (
    taskPayload?.task?.status
    || taskPayload?.data?.status
    || taskPayload?.status
    || taskPayload?.data?.[0]?.status
    || taskPayload?.result?.status
    || taskPayload?.response?.status
    || ''
  );
}

// 提取 apimart 异步任务失败原因，逐级回退到状态/任务 ID 兜底描述。
function extractApimartAsyncFailureMessage(taskPayload = {}, fallback = 'Generation failed upstream.') {
  const parts = [
    extractFirstString(taskPayload?.task?.error?.message),
    extractFirstString(taskPayload?.task?.error_message),
    extractFirstString(taskPayload?.task?.reason),
    extractFirstString(taskPayload?.task?.message),
    extractFirstString(taskPayload?.error?.message),
    extractFirstString(taskPayload?.error_message),
    extractFirstString(taskPayload?.reason),
    extractFirstString(taskPayload?.message),
    extractFirstString(taskPayload?.data?.message),
    extractFirstString(taskPayload?.data?.reason),
    extractFirstString(taskPayload?.result?.message),
    extractFirstString(taskPayload?.response?.message),
  ].filter(Boolean);
  if (parts.length > 0) return parts[0];
  const status = String(apimartTaskStatusValue(taskPayload) || '').trim();
  const taskId = extractApimartTaskId(taskPayload);
  const detail = [status ? `status=${status}` : '', taskId ? `task_id=${taskId}` : ''].filter(Boolean).join(', ');
  return detail ? `${fallback} (${detail})` : fallback;
}

export {
  buildApimartTaskResultPayload,
  apimartTaskStatusValue,
  extractApimartAsyncFailureMessage,
};
