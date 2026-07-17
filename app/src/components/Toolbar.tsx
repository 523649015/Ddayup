import { useCanvasStore } from '@/store/useCanvasStore';
import { useDonationStore } from '@/store/useDonationStore';
import {
  Scissors, Camera, FileSearch, AudioLines, Wand2, Download,
  Settings, Bot, Undo2, Redo2, Sun, Moon, Heart, Globe, Loader2, Menu,
} from 'lucide-react';
import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { extractAudioFromVideo, repairVideo, checkFFmpegSupport } from '@/services/ffmpegPipeline';
import { useUILanguage } from '@/i18n/ui';

interface ToolbarProps {
  isMobile?: boolean;
  onMobileMenuToggle?: () => void;
}

export function Toolbar({ isMobile = false, onMobileMenuToggle }: ToolbarProps) {
  const navigate = useNavigate();
  // ===== Zustand 独立 selector — 避免全量重渲染 =====
  const canvas = useCanvasStore((s) => s.canvas);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const toggleDarkMode = useCanvasStore((s) => s.toggleDarkMode);
  const darkMode = useCanvasStore((s) => s.darkMode);
  const exportCanvas = useCanvasStore((s) => s.exportCanvas);
  const importCanvas = useCanvasStore((s) => s.importCanvas);
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const addNode = useCanvasStore((s) => s.addNode);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const { language, setLanguage, t } = useUILanguage();
  const { toggleDonationPanel, toggleWorldChannel, showWorldChannel, suggestions } = useDonationStore();
  const languageToggleTitle = language === 'zh' ? '切换到英文' : 'Switch to Chinese';

  const totalDonations = suggestions.reduce((sum, s) => sum + s.donation, 0);

  const handleExport = () => {
    const json = exportCanvas();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${canvas?.title || 'canvas'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          importCanvas(reader.result);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const handleDeleteSelected = () => {
    if (selectedNodeIds.length > 0) {
      removeNodes([...selectedNodeIds]);
    }
  };

  const [audioSplitLoading, setAudioSplitLoading] = useState(false);
  const [videoFixLoading, setVideoFixLoading] = useState(false);

  const handleAudioSplit = useCallback(async () => {
    const videoNodes = canvas?.nodes.filter(n => n.type === 'video') || [];
    if (videoNodes.length === 0) {
      alert(t('画布中没有视频节点。请先添加视频节点，再使用音频分离功能。', 'There is no video node on the canvas. Add one before using Audio Split.'));
      return;
    }

    // 预检 FFmpeg.wasm 支持
    const supportCheck = checkFFmpegSupport();
    if (!supportCheck.supported) {
      alert(
        t('FFmpeg.wasm 环境不支持：', 'FFmpeg.wasm is not supported in this environment:')
        + `\n${supportCheck.issues.join('\n')}\n\n`
        + t('请确保：\n1. 使用 HTTPS 或 localhost\n2. 服务器已配置 COOP/COEP 响应头', 'Please make sure:\n1. You are using HTTPS or localhost\n2. The server sends COOP/COEP headers'),
      );
      return;
    }

    setAudioSplitLoading(true);
    try {
      // 取第一个有 outputs 的视频节点
      const targetNode = videoNodes.find(n => n.data.outputs?.[0]?.url) || videoNodes[0];
      const videoUrl = targetNode.data.outputs?.[0]?.url;

      if (!videoUrl) {
        alert(t('选中的视频节点没有可用的视频 URL。请先生成视频或上传视频文件。', 'The selected video node does not have a usable video URL yet. Generate or upload a video first.'));
        return;
      }

      const result = await extractAudioFromVideo(videoUrl, (progress) => {
        console.log(`[音频分离] ${progress.stage} — ${progress.percent}%`);
      });

      if (result.success && result.data) {
        // 自动创建音频节点
        const audioNodeId = addNode('audio', {
          x: targetNode.position.x + 420,
          y: targetNode.position.y,
        });

        // 更新音频节点的 outputs
        updateNodeData(audioNodeId, {
          outputs: [{
            id: `audio-${Date.now()}`,
            type: 'audio' as const,
            url: result.data.url,
            metadata: {
              format: result.data.format,
              duration: result.data.duration,
              size: result.data.size,
              extractedFrom: targetNode.id,
            },
          }],
          status: 'completed' as const,
        });

        console.log(`[音频分离] ✅ 已创建音频节点 ${audioNodeId}，格式 ${result.data.format}，时长 ${result.data.duration.toFixed(1)}s`);
      } else {
        alert(`${t('音频分离失败：', 'Audio split failed: ')}${result.error || t('未知错误', 'Unknown error')}`);
      }
    } catch (err) {
      console.error('[音频分离] 异常:', err);
      alert(`${t('音频分离异常：', 'Audio split error: ')}${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAudioSplitLoading(false);
    }
    // addNode/updateNodeData 来自 Zustand store，引用稳定不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas?.nodes, t]);

  const handleVideoFix = useCallback(async () => {
    const videoNodes = canvas?.nodes.filter(n => n.type === 'video') || [];
    if (videoNodes.length === 0) {
      alert(t('画布中没有视频节点。请先添加视频节点，再使用视频修复功能。', 'There is no video node on the canvas. Add one before using Video Repair.'));
      return;
    }

    const supportCheck = checkFFmpegSupport();
    if (!supportCheck.supported) {
      alert(`${t('FFmpeg.wasm 环境不支持：', 'FFmpeg.wasm is not supported in this environment:')}\n${supportCheck.issues.join('\n')}`);
      return;
    }

    setVideoFixLoading(true);
    try {
      const targetNode = videoNodes.find(n => n.data.outputs?.[0]?.url) || videoNodes[0];
      const videoUrl = targetNode.data.outputs?.[0]?.url;

      if (!videoUrl) {
        alert(t('选中的视频节点没有可用的视频 URL。', 'The selected video node does not have a usable video URL.'));
        return;
      }

      const result = await repairVideo(videoUrl, (progress) => {
        console.log(`[视频修复] ${progress.stage} — ${progress.percent}%`);
      });

      if (result.success && result.data) {
        // 更新原视频节点的 outputs
        updateNodeData(targetNode.id, {
          outputs: [{
            id: `repaired-${Date.now()}`,
            type: 'video' as const,
            url: result.data.url,
            metadata: {
              format: result.data.format,
              width: result.data.width,
              height: result.data.height,
              duration: result.data.duration,
              size: result.data.size,
              repaired: true,
            },
          }],
          status: 'completed' as const,
        });

        console.log(`[视频修复] ✅ 已修复视频节点 ${targetNode.id}，分辨率 ${result.data.width}x${result.data.height}`);
      } else {
        alert(`${t('视频修复失败：', 'Video repair failed: ')}${result.error || t('未知错误', 'Unknown error')}`);
      }
    } catch (err) {
      console.error('[视频修复] 异常:', err);
      alert(`${t('视频修复异常：', 'Video repair error: ')}${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setVideoFixLoading(false);
    }
    // updateNodeData 来自 Zustand store，引用稳定不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas?.nodes, t]);

  const tools = [
    { icon: Scissors, label: t('删除选中', 'Delete'), action: handleDeleteSelected, loading: false },
    { icon: Camera, label: t('导出 JSON', 'Export JSON'), action: handleExport, loading: false },
    { icon: FileSearch, label: t('导入 JSON', 'Import JSON'), action: handleImport, loading: false },
    { icon: audioSplitLoading ? Loader2 : AudioLines, label: t('音频分离', 'Audio Split'), action: handleAudioSplit, loading: audioSplitLoading },
    { icon: videoFixLoading ? Loader2 : Wand2, label: t('视频修复', 'Video Repair'), action: handleVideoFix, loading: videoFixLoading },
    { icon: Download, label: t('下载', 'Download'), action: handleExport, loading: false },
  ];

  return (
    <div className="h-11 bg-[#161b22]/95 backdrop-blur-sm border-b border-[#21262d] flex items-center px-2 sm:px-3 gap-1 shrink-0 z-30">
      {/* 移动端：汉堡菜单按钮 */}
      {isMobile && (
        <button
          type="button"
          onClick={onMobileMenuToggle}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[#8b949e] hover:bg-[#21262d] hover:text-white transition-colors mr-1"
          title={t('菜单', 'Menu')}
        >
          <Menu className="w-4 h-4" />
        </button>
      )}

      {/* Logo */}
      <div className="flex items-center gap-2 mr-2 sm:mr-3">
        <img src="/hmdao-logo.png" alt="DDUp" className="w-6 h-6 sm:w-7 sm:h-7 rounded-md" />
        <span className="text-[#e6edf3] text-xs sm:text-sm font-bold tracking-wide hidden xs:inline">DDUp</span>
      </div>

      {/* Divider */}
      <div className="hidden sm:block w-px h-5 bg-[#30363d] mx-1" />

      {/* History Controls */}
      <div className="hidden sm:flex items-center gap-0.5 mr-2">
        <button type="button" onClick={() => undo()} className="w-8 h-8 rounded-lg flex items-center justify-center text-[#8b949e] hover:bg-[#21262d] hover:text-white transition-colors" title={t('撤销', 'Undo')}>
          <Undo2 className="w-4 h-4" />
        </button>
        <button type="button" onClick={() => redo()} className="w-8 h-8 rounded-lg flex items-center justify-center text-[#8b949e] hover:bg-[#21262d] hover:text-white transition-colors" title={t('重做', 'Redo')}>
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

      {/* Divider */}
      <div className="hidden sm:block w-px h-5 bg-[#30363d] mx-1" />

      {/* Tool Actions — 移动端只显示图标 */}
      <div className="flex items-center gap-0.5 overflow-x-auto">
        {tools.map((tool) => (
          <button
            type="button"
            key={tool.label}
            onClick={tool.action}
            disabled={tool.loading}
            className="h-8 px-2 sm:px-2.5 rounded-lg flex items-center gap-1.5 text-[#8b949e] hover:bg-[#21262d] hover:text-white transition-colors text-xs disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            title={tool.label}
          >
            <tool.icon className={`w-3.5 h-3.5 ${tool.loading ? 'animate-spin' : ''}`} />
            <span className="hidden xl:inline">{tool.label}</span>
          </button>
        ))}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Canvas Info */}
      {canvas && (
        <div className="hidden md:flex items-center gap-2 mr-3">
          <span className="text-[#6e7681] text-xs">{canvas.title}</span>
          {canvas.nodes.length > 0 && (
            <span className="text-[#484f58] text-xs">({canvas.nodes.length} {t('节点', 'nodes')})</span>
          )}
        </div>
      )}

      {/* Donation & World Channel */}
      <div className="hidden sm:flex items-center gap-0.5 mr-2">
        {/* World Channel Toggle */}
        <button
          type="button"
          onClick={toggleWorldChannel}
          className={
            `h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs transition-colors ` +
            (showWorldChannel
              ? 'bg-[#00d4aa]/10 text-[#00d4aa]'
              : 'text-[#8b949e] hover:bg-[#21262d] hover:text-white')
          }
          title={t('世界频道', 'World Channel')}
        >
          <Globe className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">{t('世界频道', 'World')}</span>
        </button>

        {/* Donation Button */}
        <button
          type="button"
          onClick={toggleDonationPanel}
          className="h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs transition-colors text-[#fbbf24] hover:bg-[#fbbf24]/10"
          title={t('需求共建', 'Community Backlog')}
        >
          <Heart className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">{t('打赏', 'Support')}</span>
          {totalDonations > 0 && (
            <span className="text-[#fbbf24] text-[10px]">¥{totalDonations}</span>
          )}
        </button>
      </div>

      {/* Right Actions */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
          className="hidden sm:flex h-8 min-w-12 rounded-lg items-center justify-center px-2 text-xs font-medium text-[#8b949e] hover:bg-[#21262d] hover:text-white transition-colors"
          title={languageToggleTitle}
          data-testid="toolbar-language-toggle"
        >
          {language === 'zh' ? 'EN' : '中文'}
        </button>
        <button type="button" onClick={toggleDarkMode} className="w-8 h-8 rounded-lg flex items-center justify-center text-[#8b949e] hover:bg-[#21262d] hover:text-white transition-colors" title={darkMode ? t('亮色模式', 'Light mode') : t('暗色模式', 'Dark mode')}>
          {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
        <button type="button" onClick={() => navigate('/settings/api-keys')} className="hidden sm:flex h-8 px-2.5 rounded-lg items-center gap-1.5 text-[#8b949e] hover:bg-[#21262d] hover:text-white transition-colors text-xs" title={t('API Key 管理', 'API Keys')}>
          <Settings className="w-3.5 h-3.5" />
          <span className="hidden xl:inline">{t('设置', 'Settings')}</span>
        </button>
        <button type="button" className="hidden sm:flex h-8 px-2.5 rounded-lg items-center gap-1.5 bg-[#00d4aa]/10 text-[#00d4aa] hover:bg-[#00d4aa]/20 transition-colors text-xs font-medium" title={t('加入 Agent', 'Join Agent')}>
          <Bot className="w-3.5 h-3.5" />
          <span className="hidden xl:inline">{t('加入 Agent', 'Join Agent')}</span>
        </button>
      </div>
    </div>
  );
}
