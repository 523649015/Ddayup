import { Suspense, lazy } from 'react';

const TaggingContractVerifyCanvas = lazy(() => import('@/components/TaggingContractVerifyCanvas').then((module) => ({
  default: module.TaggingContractVerifyCanvas,
})));

export function TaggingContractVerifyPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-[#0d1117] text-sm text-[#c8d2dc]">正在载入 tagging-contract 验证画布...</div>}>
      <TaggingContractVerifyCanvas />
    </Suspense>
  );
}

export default TaggingContractVerifyPage;
