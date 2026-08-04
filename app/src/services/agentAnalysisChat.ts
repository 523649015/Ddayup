/**
 * 把 Florence-2（本地免费）视觉分析 / 视频推理的结果整理成一条「助手消息」，
 * 直接返回到智能机器人聊天面板。纯函数，无 DOM 依赖，便于单元测试。
 *
 * 这是修复「上传参考图分析风格 → 结果不回聊天面板 / 卡在正在创建节点」的核心：
 * 之前分析文本只被塞进工作流节点 prompt，用户永远看不到真实分析结果。
 */

export interface ReferenceAnalysisChatInput {
  kind: 'image' | 'video';
  /** 图片分析文本（已整理为「总结；主体；风格；场景；情绪」等可读行） */
  analysisText?: string;
  /** 视频推理文本 */
  reasoningText?: string;
  /** 素材文件名，用于回显 */
  fileName: string;
}

export function formatReferenceAnalysisMessage(input: ReferenceAnalysisChatInput): string {
  const { kind, analysisText, reasoningText, fileName } = input;
  if (kind === 'image') {
    const body = (analysisText && analysisText.trim()) || '已分析图片内容，但未能提取到结构化风格信息。';
    return `🔍 参考图风格分析（Florence-2）\n文件：${fileName}\n\n${body}`;
  }
  const body = (reasoningText && reasoningText.trim()) || '已分析视频内容，但未能提取到结构化推理信息。';
  return `🎬 视频内容分析（Florence-2）\n文件：${fileName}\n\n${body}`;
}
