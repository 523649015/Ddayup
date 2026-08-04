// P3-11：全局串行安装队列。独立轻量模块，便于单测、避免测试时拉起重型 server。
// 一次只允许一个运行时安装任务真正推进，避免多运行时并行安装抢占磁盘/带宽，
// 同时让集中状态（status/stage/progress）更可控。

let queue = [];
let active = false;
let updateRuntimeInstallJob = () => {};

export function configureRuntimeInstallQueue({ updateRuntimeInstallJob: updateFn } = {}) {
  if (typeof updateFn === 'function') updateRuntimeInstallJob = updateFn;
}

function isJobStillQueued(job) {
  return queue.some((task) => task.job.id === job.id);
}

function getQueueDepth() {
  return queue.length;
}

async function drainManagedRuntimeInstallQueue() {
  if (active) return;
  active = true;
  try {
    while (queue.length) {
      const task = queue.shift();
      task.job._dequeued = true;
      try {
        // eslint-disable-next-line no-await-in-loop
        await task.runInstallFn();
      } catch {
        // 单个任务安装失败不应中断队列，后续任务继续推进（真实调用方 runInstall 也会自行吞错）。
      }
    }
  } finally {
    active = false;
  }
}

function enqueueManagedRuntimeInstall(runInstallFn, job) {
  queue.push({ runInstallFn, job });
  job.stage = 'queued';
  job.message = '安装任务已排队，等待上一个任务完成';
  updateRuntimeInstallJob(job);
  drainManagedRuntimeInstallQueue().catch(() => {});
}

export {
  isJobStillQueued,
  getQueueDepth,
  drainManagedRuntimeInstallQueue,
  enqueueManagedRuntimeInstall,
};
