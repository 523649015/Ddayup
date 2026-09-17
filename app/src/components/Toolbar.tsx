import { useCanvasStore } from '@/store/useCanvasStore';
import { useDonationStore } from '@/store/useDonationStore';
import { useCobuildStore } from '@/store/useCobuildStore';
import {
  Settings, Undo2, Redo2, Sun, Moon, Heart, Globe, Menu, Sparkles,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
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
  // 右侧 docked AI 面板开关（G11）：状态由 store 持久化白名单负责跨会话保持。
  const showAIPanel = useCanvasStore((s) => s.showAIPanel);
  const toggleAIPanel = useCanvasStore((s) => s.toggleAIPanel);
  const { language, setLanguage, t } = useUILanguage();
  const { toggleDonationPanel, toggleWorldChannel, showWorldChannel } = useDonationStore();
  const cobuildEntries = useCobuildStore((s) => s.entries);
  const languageToggleTitle = language === 'zh' ? '切换到英文' : 'Switch to Chinese';

  const totalDonations = cobuildEntries.reduce((sum, s) => sum + (s.donation || 0), 0);

  // 顶栏不放任何操作按钮（删除选中走 Del/Backspace + 右键；导入/导出 JSON 在工作流模板面板；
  // 音频分离/视频修复/下载在节点上具备；Agent 占位按钮已去除——市场有更优技术时直接重做）。

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
          <span className="hidden lg:inline">{t('需求共建', 'Co-build')}</span>
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
        <button
          type="button"
          onClick={toggleAIPanel}
          data-testid="toolbar-ai-panel-toggle"
          aria-pressed={showAIPanel}
          className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
            showAIPanel
              ? 'bg-[#00d4aa]/10 text-[#00d4aa] ring-1 ring-[#00d4aa]/40'
              : 'text-[#8b949e] hover:bg-[#21262d] hover:text-white'
          }`}
          title={showAIPanel ? t('收起 AI 面板', 'Hide AI panel') : t('展开 AI 面板', 'Show AI panel')}
        >
          <Sparkles className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
