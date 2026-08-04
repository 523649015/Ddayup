import { startTransition, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  AudioLines,
  Download,
  FolderOpen,
  Pause,
  Play,
  Search,
  SlidersHorizontal,
  Sparkles,
  Video,
  Volume2,
  Wand2,
  Waves,
  X,
} from 'lucide-react';
import { ModelActivationPrompt } from '@/components/ModelActivationPrompt';
import { SourceBadge, relaySourceLabel } from '@/components/SourceBadge';
import { useNodeFloatingPanel } from '@/hooks/useNodeFloatingPanel';
import { useNodeToolLifecycle } from '@/hooks/useNodeToolLifecycle';
import { useUILanguage } from '@/i18n/ui';
import { ensureLocalMediaUrl, isLocalMediaHandle, isTransientBlobUrl, registerLocalMedia } from '@/services/localMediaRegistry';
import { generateAudioLocally, generateAudioRemotely, generateAudioWithFallback, type LocalAudioGenerationPayload, type RemoteAudioGenerationPayload } from '@/services/localAudioGeneration';
import { useAuthStore } from '@/store/useAuthStore';
import { useAssetStore } from '@/store/useAssetStore';
import { useByokRuntimeStore } from '@/store/useByokRuntimeStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { EditableNodeTitle } from './EditableNodeTitle';
import { ErrorDetailBlock, StatusBadge } from './NodeShellShared';

type AudioGenerationMode = 'bgm' | 'sfx' | 'voiceover';
type AudioBackend = 'fallback-local' | 'audioldm2' | 'voxcpm';
type AudioPanelTab = 'prompt' | 'model' | 'tune' | 'result';
type VoiceLibraryTab = 'library' | 'mine' | 'favorite';
type AudioLifecycleTool = 'generate';
type AnyRecord = Record<string, unknown>;

type VoicePreset = {
  value: string;
  label: string;
  hint: string;
  tone: string;
  emotion: string;
  locale: string;
  gender: string;
  favorite?: boolean;
};

/*
const MODE_META: Record<AudioGenerationMode, { label: string; hint: string; model: string; placeholder: string }> = {
  bgm: {
    label: 'BGM',
    hint: '閫傚悎鍏堝揩閫熺敓鎴愬彲鐢ㄧ殑鑳屾櫙闊充箰鑽夌锛屽悗缁彲缁х画鏇挎崲鎴愭洿楂樿川閲忛厤涔愩€?,
    model: 'procedural-bgm-synth',
    placeholder: '杈撳叆 BGM 鎻忚堪锛屼緥濡傦細鏈潵鎰熴€佺ǔ閲嶃€侀€傚悎姹借溅娴锋姤鐨勪綆棰戞皼鍥撮煶涔愩€?,
  },
  sfx: {
    label: '闊虫晥',
    hint: '閫傚悎鎸夐挳闊炽€佽浆鍦洪煶銆佹彁绀洪煶鍜岀煭淇冨啿鍑荤被闊虫晥棰勮銆?,
    model: 'procedural-sfx-synth',
    placeholder: '杈撳叆闊虫晥鎻忚堪锛屼緥濡傦細绉戞妧 UI 寮瑰嚭闊筹紝娓呰剢銆佺煭淇冦€佸甫杞诲井鐢靛瓙鎰熴€?,
  },
  voiceover: {
    label: '鏃佺櫧',
    hint: '閫傚悎鏇磋嚜鐒躲€佹儏缁洿鐪熷疄鐨勪腑鏂囧彛鎾笌鏃佺櫧棰勮銆?,
    model: 'windows-sapi',
    placeholder: '杈撳叆鏃佺櫧鏂囨锛屼緥濡傦細娆㈣繋鏉ュ埌鏂颁骇鍝佸彂甯冪幇鍦猴紝鎺ヤ笅鏉ヤ负浣犱粙缁嶆湰娆¤溅鍨嬬殑涓夊ぇ鍗囩骇銆?,
  },
};

const BACKEND_META: Record<AudioBackend, { label: string; hint: string; supportedModes: AudioGenerationMode[] }> = {
  'fallback-local': {
    label: '鏈湴棰勮閾?,
    hint: '涓嶄緷璧?Key锛岀ǔ瀹氬彲鐢紝浣嗘洿鍋忛瑙堥摼锛屼笉鏄渶缁堥珮淇濈湡鎴愬搧妯″瀷銆?,
    supportedModes: ['bgm', 'sfx', 'voiceover'],
  },
  audioldm2: {
    label: 'AudioLDM 2',
    hint: '鏇撮€傚悎楂樿川閲?BGM 涓庨煶鏁堢敓鎴愩€傝嫢鏈湴鏈厤缃懡浠わ紝浼氳嚜鍔ㄥ洖閫€鍒版湰鍦伴瑙堥摼銆?,
    supportedModes: ['bgm', 'sfx'],
  },
  voxcpm: {
    label: 'VoxCPM',
    hint: '鏇撮€傚悎鐪熷疄鑷劧銆佸甫鎯呯华璇皵鐨勪腑鏂囨梺鐧姐€傝嫢鏈湴鏈厤缃懡浠わ紝浼氳嚜鍔ㄥ洖閫€鍒版湰鍦伴瑙堥摼銆?,
    supportedModes: ['voiceover'],
  },
};

const PANEL_TAB_META: Array<{ id: AudioPanelTab; label: string; icon: typeof Wand2 }> = [
  { id: 'prompt', label: '鏂囨', icon: Wand2 },
  { id: 'model', label: '妯″瀷', icon: Sparkles },
  { id: 'tune', label: '璋冭妭', icon: SlidersHorizontal },
  { id: 'result', label: '缁撴灉', icon: Waves },
];

const VOICE_LIBRARY_META: Array<{ id: VoiceLibraryTab; label: string }> = [
  { id: 'library', label: '闊宠壊搴? },
  { id: 'mine', label: '鎴戠殑闊宠壊' },
  { id: 'favorite', label: '鏀惰棌闊宠壊' },
];

const VOICE_PRESETS: VoicePreset[] = [
  {
    value: 'campus_male',
    label: '闈掑勾澶у鐢熼煶鑹?,
    hint: '闈掓槬鑷劧锛屽彛璇澗寮涳紝閫傚悎鏍″洯銆佸搧鐗屾棩甯稿拰骞磋交鍖栨梺鐧姐€?,
    tone: '鍙ｈ鑷劧',
    emotion: '杞绘澗鐪熻瘹',
    locale: '涓枃(鏅€氳瘽)',
    gender: 'Male',
    favorite: true,
  },
  {
    value: 'soft_girl',
    label: '灏戝コ闊宠壊',
    hint: '杞荤泩娓呴€忥紝鎯呯华缁嗚吇锛岄€傚悎娓呮柊绉嶈崏銆佺敓娲绘柟寮忓拰娓╂煍璁茶堪銆?,
    tone: '姘旀伅鐪熷疄',
    emotion: '娓╂煍娌绘剤',
    locale: '涓枃(鏅€氳瘽)',
    gender: 'Female',
    favorite: true,
  },
  {
    value: 'elegant_female',
    label: '寰″闊宠壊',
    hint: '鎴愮啛鑷俊锛岃姘旂ǔ瀹氾紝閫傚悎楂樼鍝佺墝銆佹椂灏氱墖鍜屼汉鐗╂梺鐧姐€?,
    tone: '璐ㄦ劅鎴愮啛',
    emotion: '鍏嬪埗楂樼骇',
    locale: '涓枃(鏅€氳瘽)',
    gender: 'Female',
  },
  {
    value: 'mature_female',
    label: '鎴愮啛濂虫€ч煶鑹?,
    hint: '鑷劧浜插垏锛岃〃杈剧ǔ鍋ワ紝閫傚悎璁胯皥銆佺邯褰曠墖鍜岃瑙ｅ悜鍙ｆ挱銆?,
    tone: '琛ㄨ揪绋冲仴',
    emotion: '鐪熷疄鍙俊',
    locale: '涓枃(鏅€氳瘽)',
    gender: 'Female',
    favorite: true,
  },
  {
    value: 'sweet_female',
    label: '鐢滅編濂虫€ч煶鑹?,
    hint: '鏄庝寒鏌斿拰锛岃创杩戠湡瀹炵煭瑙嗛鍙ｆ挱锛岄€傚悎缇庡銆佺敓娲诲拰绉嶈崏鍦烘櫙銆?,
    tone: '鐢滆€屼笉鍋?,
    emotion: '娲绘臣浜茶繎',
    locale: '涓枃(鏅€氳瘽)',
    gender: 'Female',
  },
  {
    value: 'youth_male_beta',
    label: '闈掓订闈掑勾闊宠壊 Beta',
    hint: '鐣ュ甫闈掓订鎰燂紝閫傚悎绗竴浜虹О璁茶堪銆佹垚闀跨嚎鍜岃鑹插寲琛ㄨ揪銆?,
    tone: '灏戝勾鎰?,
    emotion: '闈掓订鐪熻瘹',
    locale: '涓枃(鏅€氳瘽)',
    gender: 'Male',
  },
  {
    value: 'documentary_male',
    label: '绾綍鐗囩敺澹?,
    hint: '鍘嬩綆 AI 鎰燂紝閲嶈鍛煎惛鍜屽仠椤匡紝閫傚悎绾綍鐗囥€佺鎶€璇存槑鍜屼笓涓氫粙缁嶃€?,
    tone: '鍘氬疄鑷劧',
    emotion: '娌夌ǔ鍏嬪埗',
    locale: '涓枃(鏅€氳瘽)',
    gender: 'Male',
    favorite: true,
  },
  {
    value: 'warm_story_female',
    label: '娓╂煍鏁呬簨濂冲０',
    hint: '閫傚悎璁叉晠浜嬨€佹儏缁寲鏃佺櫧鍜屽搧鐗屾俯鎯呯墖锛岃拷姹傜湡瀹為櫔浼存劅銆?,
    tone: '濞撳〒閬撴潵',
    emotion: '娓╂煍鍏辨儏',
    locale: '涓枃(鏅€氳瘽)',
    gender: 'Female',
  },
];

*/
/*
const CLEAN_MODE_META: Record<AudioGenerationMode, { label: string; hint: string; model: string; placeholder: string }> = {
  bgm: {
    label: 'BGM',
    hint: '鐢熸垚鍙瑙堢殑鑳屾櫙闊充箰鑽夌锛涘悗缁彲鍒囧埌 AudioLDM 2 鏈湴鍚庣鑾峰緱鏇撮珮璐ㄩ噺鎴愬搧銆?,
    model: 'procedural-bgm-synth',
    placeholder: '杈撳叆 BGM 鎻忚堪锛屼緥濡傦細娓╂殩銆佺鎶€鎰熴€侀€傚悎姹借溅娴锋姤鐭墖鐨勪綆棰戞皼鍥撮煶涔愩€?,
  },
  sfx: {
    label: '闊虫晥',
    hint: '鐢熸垚鎸夐挳闊炽€佽浆鍦洪煶銆佹彁绀洪煶銆佸啿鍑婚煶绛夌煭闊虫晥绱犳潗銆?,
    model: 'procedural-sfx-synth',
    placeholder: '杈撳叆闊虫晥鎻忚堪锛屼緥濡傦細娓呰剢鐨勭鎶€ UI 寮瑰嚭闊筹紝鐭績銆佸共鍑€銆佸甫杞诲井鐢靛瓙鎰熴€?,
  },
  voiceover: {
    label: '鏃佺櫧',
    hint: '鐢熸垚鑷劧甯︽儏缁殑涓枃鏃佺櫧棰勮锛涘悗缁彲鍒囧埌 VoxCPM 鏈湴鍚庣鑾峰緱鏇磋嚜鐒堕煶鑹层€?,
    model: 'windows-sapi',
    placeholder: '杈撳叆鏃佺櫧鏂囨锛屼緥濡傦細娆㈣繋鏉ュ埌鏂板搧鍙戝竷鐜板満锛屾帴涓嬫潵涓轰綘浠嬬粛杩欐杞﹀瀷鐨勪笁澶у崌绾с€?,
  },
};

const CLEAN_BACKEND_META: Record<AudioBackend, { label: string; hint: string; supportedModes: AudioGenerationMode[] }> = {
  'fallback-local': {
    label: '鏈湴棰勮閾?,
    hint: '涓嶄緷璧?API Key锛岀ǔ瀹氬彲鐢紝閫傚悎蹇€熼瑙堬紱璐ㄩ噺鍋忚崏绋匡紝涓嶄唬琛ㄦ渶缁堥珮淇濈湡鎴愬搧銆?,
    supportedModes: ['bgm', 'sfx', 'voiceover'],
  },
  audioldm2: {
    label: 'AudioLDM 2',
    hint: '閫傚悎楂樿川閲?BGM 涓庨煶鏁堢敓鎴愩€傝嫢鏈湴鍛戒护鏈厤缃紝浼氳嚜鍔ㄥ洖閫€鍒版湰鍦伴瑙堥摼銆?,
    supportedModes: ['bgm', 'sfx'],
  },
  voxcpm: {
    label: 'VoxCPM',
    hint: '閫傚悎鐪熷疄鑷劧銆佸甫鎯呯华璇皵鐨勪腑鏂囨梺鐧姐€傝嫢鏈湴鍛戒护鏈厤缃紝浼氳嚜鍔ㄥ洖閫€鍒版湰鍦伴瑙堥摼銆?,
    supportedModes: ['voiceover'],
  },
};

const CLEAN_PANEL_TAB_META: Array<{ id: AudioPanelTab; label: string; icon: typeof Wand2 }> = [
  { id: 'prompt', label: '鏂囨', icon: Wand2 },
  { id: 'model', label: '妯″瀷', icon: Sparkles },
  { id: 'tune', label: '璋冭妭', icon: SlidersHorizontal },
  { id: 'result', label: '缁撴灉', icon: Waves },
];

const CLEAN_VOICE_LIBRARY_META: Array<{ id: VoiceLibraryTab; label: string }> = [
  { id: 'library', label: '闊宠壊搴? },
  { id: 'mine', label: '鎴戠殑闊宠壊' },
  { id: 'favorite', label: '鏀惰棌闊宠壊' },
];

const CLEAN_VOICE_PRESETS: VoicePreset[] = [
  {
    value: 'campus_male',
    label: '闈掑勾澶у鐢熼煶鑹?,
    hint: '闈掓槬鑷劧锛屽彛璇澗寮涳紝閫傚悎鏍″洯銆佸搧鐗屾棩甯稿拰骞磋交鍖栨梺鐧姐€?,
    tone: '鍙ｈ鑷劧',
    emotion: '杞绘澗鐪熻瘹',
    locale: '涓枃鏅€氳瘽',
    gender: '鐢峰０',
    favorite: true,
  },
  {
    value: 'soft_girl',
    label: '灏戝コ闊宠壊',
    hint: '杞荤泩娓呴€忥紝鎯呯华缁嗚吇锛岄€傚悎娓呮柊绉嶈崏銆佺敓娲绘柟寮忓拰娓╂煍璁茶堪銆?,
    tone: '姘旀伅鐪熷疄',
    emotion: '娓╂煍娌绘剤',
    locale: '涓枃鏅€氳瘽',
    gender: '濂冲０',
    favorite: true,
  },
  {
    value: 'documentary_male',
    label: '绾綍鐗囩敺澹?,
    hint: '鍘氬疄鑷劧锛岄噸瑙嗗仠椤垮拰鍛煎惛锛岄€傚悎绾綍鐗囥€佺鎶€璇存槑鍜屼笓涓氫粙缁嶃€?,
    tone: '鍘氬疄鑷劧',
    emotion: '娌夌ǔ鍏嬪埗',
    locale: '涓枃鏅€氳瘽',
    gender: '鐢峰０',
    favorite: true,
  },
  {
    value: 'warm_story_female',
    label: '娓╂煍鏁呬簨濂冲０',
    hint: '閫傚悎璁叉晠浜嬨€佹儏缁寲鏃佺櫧鍜屽搧鐗屾俯鎯呯墖锛岃拷姹傜湡瀹為櫔浼存劅銆?,
    tone: '濞撳〒閬撴潵',
    emotion: '娓╂煍鍏辨儏',
    locale: '涓枃鏅€氳瘽',
    gender: '濂冲０',
  },
];
*/

const CLEAN_MODE_META: Record<AudioGenerationMode, { label: string; hint: string; model: string; placeholder: string }> = {
  bgm: {
    label: 'BGM',
    hint: '\u751f\u6210\u53ef\u9884\u89c8\u7684\u80cc\u666f\u97f3\u4e50\u8349\u7a3f\uff1b\u540e\u7eed\u53ef\u5207\u5230 AudioLDM 2 \u672c\u5730\u540e\u7aef\u83b7\u5f97\u66f4\u9ad8\u8d28\u91cf\u6210\u54c1\u3002',
    model: 'procedural-bgm-synth',
    placeholder: '\u8f93\u5165 BGM \u63cf\u8ff0\uff0c\u4f8b\u5982\uff1a\u6e29\u6696\u3001\u79d1\u6280\u611f\u3001\u9002\u5408\u6c7d\u8f66\u6d77\u62a5\u77ed\u7247\u7684\u4f4e\u9891\u6c1b\u56f4\u97f3\u4e50\u3002',
  },
  sfx: {
    label: '\u97f3\u6548',
    hint: '\u751f\u6210\u6309\u94ae\u97f3\u3001\u8f6c\u573a\u97f3\u3001\u63d0\u793a\u97f3\u3001\u51b2\u51fb\u97f3\u7b49\u77ed\u97f3\u6548\u7d20\u6750\u3002',
    model: 'procedural-sfx-synth',
    placeholder: '\u8f93\u5165\u97f3\u6548\u63cf\u8ff0\uff0c\u4f8b\u5982\uff1a\u6e05\u8106\u7684\u79d1\u6280 UI \u5f39\u51fa\u97f3\uff0c\u77ed\u4fc3\u3001\u5e72\u51c0\u3001\u5e26\u8f7b\u5fae\u7535\u5b50\u611f\u3002',
  },
  voiceover: {
    label: '\u65c1\u767d',
    hint: '\u751f\u6210\u81ea\u7136\u5e26\u60c5\u7eea\u7684\u4e2d\u6587\u65c1\u767d\u9884\u89c8\uff1b\u540e\u7eed\u53ef\u5207\u5230 VoxCPM \u672c\u5730\u540e\u7aef\u83b7\u5f97\u66f4\u81ea\u7136\u97f3\u8272\u3002',
    model: 'windows-sapi',
    placeholder: '\u8f93\u5165\u65c1\u767d\u6587\u6848\uff0c\u4f8b\u5982\uff1a\u6b22\u8fce\u6765\u5230\u65b0\u54c1\u53d1\u5e03\u73b0\u573a\uff0c\u63a5\u4e0b\u6765\u4e3a\u4f60\u4ecb\u7ecd\u8fd9\u6b3e\u8f66\u578b\u7684\u4e09\u5927\u5347\u7ea7\u3002',
  },
};

const CLEAN_BACKEND_META: Record<AudioBackend, { label: string; hint: string; supportedModes: AudioGenerationMode[] }> = {
  'fallback-local': {
    label: '\u672c\u5730\u9884\u89c8\u94fe',
    hint: '\u4e0d\u4f9d\u8d56 API Key\uff0c\u7a33\u5b9a\u53ef\u7528\uff0c\u9002\u5408\u5feb\u901f\u9884\u89c8\uff1b\u8d28\u91cf\u504f\u8349\u7a3f\uff0c\u4e0d\u4ee3\u8868\u6700\u7ec8\u9ad8\u4fdd\u771f\u6210\u54c1\u3002',
    supportedModes: ['bgm', 'sfx', 'voiceover'],
  },
  audioldm2: {
    label: 'AudioLDM 2',
    hint: '\u9002\u5408\u9ad8\u8d28\u91cf BGM \u4e0e\u97f3\u6548\u751f\u6210\u3002\u82e5\u672c\u5730\u547d\u4ee4\u672a\u914d\u7f6e\uff0c\u4f1a\u81ea\u52a8\u56de\u9000\u5230\u672c\u5730\u9884\u89c8\u94fe\u3002',
    supportedModes: ['bgm', 'sfx'],
  },
  voxcpm: {
    label: 'VoxCPM',
    hint: '\u9002\u5408\u771f\u5b9e\u81ea\u7136\u3001\u5e26\u60c5\u7eea\u8bed\u6c14\u7684\u4e2d\u6587\u65c1\u767d\u3002\u82e5\u672c\u5730\u547d\u4ee4\u672a\u914d\u7f6e\uff0c\u4f1a\u81ea\u52a8\u56de\u9000\u5230\u672c\u5730\u9884\u89c8\u94fe\u3002',
    supportedModes: ['voiceover'],
  },
};

const CLEAN_PANEL_TAB_META: Array<{ id: AudioPanelTab; label: string; icon: typeof Wand2 }> = [
  { id: 'prompt', label: '\u6587\u6848', icon: Wand2 },
  { id: 'model', label: '\u6a21\u578b', icon: Sparkles },
  { id: 'tune', label: '\u8c03\u8282', icon: SlidersHorizontal },
  { id: 'result', label: '\u7ed3\u679c', icon: Waves },
];

const CLEAN_VOICE_LIBRARY_META: Array<{ id: VoiceLibraryTab; label: string }> = [
  { id: 'library', label: '\u97f3\u8272\u5e93' },
  { id: 'mine', label: '\u6211\u7684\u97f3\u8272' },
  { id: 'favorite', label: '\u6536\u85cf\u97f3\u8272' },
];

const CLEAN_VOICE_PRESETS: VoicePreset[] = [
  {
    value: 'campus_male',
    label: '\u9752\u5e74\u5927\u5b66\u751f\u97f3\u8272',
    hint: '\u9752\u6625\u81ea\u7136\uff0c\u53e3\u8bed\u677e\u5f1b\uff0c\u9002\u5408\u6821\u56ed\u3001\u54c1\u724c\u65e5\u5e38\u548c\u5e74\u8f7b\u5316\u65c1\u767d\u3002',
    tone: '\u53e3\u8bed\u81ea\u7136',
    emotion: '\u8f7b\u677e\u771f\u8bda',
    locale: '\u4e2d\u6587\u666e\u901a\u8bdd',
    gender: '\u7537\u58f0',
    favorite: true,
  },
  {
    value: 'soft_girl',
    label: '\u5c11\u5973\u97f3\u8272',
    hint: '\u8f7b\u76c8\u6e05\u900f\uff0c\u60c5\u7eea\u7ec6\u817b\uff0c\u9002\u5408\u6e05\u65b0\u79cd\u8349\u3001\u751f\u6d3b\u65b9\u5f0f\u548c\u6e29\u67d4\u8bb2\u8ff0\u3002',
    tone: '\u6c14\u606f\u771f\u5b9e',
    emotion: '\u6e29\u67d4\u6cbb\u6108',
    locale: '\u4e2d\u6587\u666e\u901a\u8bdd',
    gender: '\u5973\u58f0',
    favorite: true,
  },
  {
    value: 'documentary_male',
    label: '\u7eaa\u5f55\u7247\u7537\u58f0',
    hint: '\u539a\u5b9e\u81ea\u7136\uff0c\u91cd\u89c6\u505c\u987f\u548c\u547c\u5438\uff0c\u9002\u5408\u7eaa\u5f55\u7247\u3001\u79d1\u6280\u8bf4\u660e\u548c\u4e13\u4e1a\u4ecb\u7ecd\u3002',
    tone: '\u539a\u5b9e\u81ea\u7136',
    emotion: '\u6c89\u7a33\u514b\u5236',
    locale: '\u4e2d\u6587\u666e\u901a\u8bdd',
    gender: '\u7537\u58f0',
    favorite: true,
  },
  {
    value: 'warm_story_female',
    label: '\u6e29\u67d4\u6545\u4e8b\u5973\u58f0',
    hint: '\u9002\u5408\u8bb2\u6545\u4e8b\u3001\u60c5\u7eea\u5316\u65c1\u767d\u548c\u54c1\u724c\u6e29\u60c5\u7247\uff0c\u8ffd\u6c42\u771f\u5b9e\u966a\u4f34\u611f\u3002',
    tone: '\u5a13\u5a13\u9053\u6765',
    emotion: '\u6e29\u67d4\u5171\u60c5',
    locale: '\u4e2d\u6587\u666e\u901a\u8bdd',
    gender: '\u5973\u58f0',
  },
];

function stopCanvasInteraction(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function stopCanvasClick(event: { preventDefault?: () => void; stopPropagation: () => void }) {
  event.preventDefault?.();
  event.stopPropagation();
}

function formatSeconds(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '未知时长';
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  if (minutes <= 0) return `${seconds.toFixed(value >= 10 ? 0 : 1)}s`;
  return `${minutes}m ${seconds.toFixed(0).padStart(2, '0')}s`;
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'audio-result';
}

function inferPromptLanguage(value: string): 'zh' | 'en' {
  return /[\u4e00-\u9fff]/.test(value) ? 'zh' : 'en';
}

function createGeneratedAudioDescriptor(
  name: string,
  url: string,
  size: number,
  duration: number,
  mode: AudioGenerationMode,
) {
  return {
    name,
    type: 'audio' as const,
    url,
    thumbnail: '',
    folderId: 'root',
    size,
    duration,
    tags: [`audio-${mode}`],
    smartCategories: [CLEAN_MODE_META[mode].label],
    source: 'generate' as const,
  };
}

function nextBackendForMode(mode: AudioGenerationMode, preferredBackend: string): AudioBackend {
  if (preferredBackend in CLEAN_BACKEND_META) {
    const backend = preferredBackend as AudioBackend;
    if (CLEAN_BACKEND_META[backend].supportedModes.includes(mode)) {
      return backend;
    }
    return 'fallback-local';
  }
  // 远程/未知后端 id（火山方舟、百炼等聚合平台的具体模型）原样透传
  return preferredBackend as AudioBackend;
}

function readRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' ? value as AnyRecord : {};
}

function clampDuration(mode: AudioGenerationMode, value: unknown) {
  const min = mode === 'voiceover' ? 1 : 0.5;
  const max = mode === 'voiceover' ? 30 : 20;
  const fallback = 8;
  return Math.max(min, Math.min(max, Number(value) || fallback));
}

function clampUnitRange(value: unknown, fallback: number) {
  return Math.max(0, Math.min(1, Number(value) || fallback));
}

function clampSpeechRate(value: unknown, fallback = 0) {
  return Math.max(-6, Math.min(6, Number(value) || fallback));
}

function panelTabClass(active: boolean) {
  return active
    ? 'border-[#5d827d] bg-[#17312b] text-[#d8fff7] shadow-[0_0_0_1px_rgba(0,212,170,0.12)]'
    : 'border-[#34383d] bg-[#1a1d21] text-[#cfd8e1] hover:border-[#46515d] hover:bg-[#23282d]';
}

function modeButtonClass(active: boolean) {
  return active
    ? 'border-[#00d4aa] bg-[#00d4aa] text-[#07110e] shadow-[0_10px_22px_rgba(0,212,170,0.18)]'
    : 'border-[#34383d] bg-[#1b1f23] text-[#d7dde3] hover:border-[#46515d] hover:bg-[#252a2f] active:scale-[0.99]';
}

function backendButtonClass(active: boolean) {
  return active
    ? 'border-[#476c9b] bg-[#243547] text-[#d8ebff] shadow-[0_8px_18px_rgba(71,108,155,0.18)]'
    : 'border-[#34383d] bg-[#171b1f] text-[#c7d0d9] hover:border-[#46515d] hover:bg-[#20262b] active:scale-[0.99]';
}

function voiceLibraryTabClass(active: boolean) {
  return active
    ? 'bg-[#32353a] text-white'
    : 'text-[#b8c0c9] hover:bg-[#262a2f] hover:text-white';
}

function voiceOptionClass(active: boolean) {
  return active
    ? 'border-[#6f8d88] bg-[#3a3d42]'
    : 'border-[#3a3d42] bg-[#2b2e33] hover:border-[#515a64] hover:bg-[#32363b]';
}

function sliderTrackClass() {
  return 'nodrag nopan nowheel w-full accent-[#00d4aa]';
}

export function AudioNode(props: NodeProps) {
  const { isZh } = useUILanguage();
  const { data, id } = props;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const panelInteractionLockRef = useRef(0);
  const pendingSelectionSyncRef = useRef<number | null>(null);
  const pendingKeepAliveTimeoutsRef = useRef<number[]>([]);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const setSelectionGuard = useCanvasStore((state) => state.setSelectionGuard);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const sourceNodeX = useCanvasStore((state) => state.canvas?.nodes.find((entry) => entry.id === id)?.position.x || 0);
  const sourceNodeY = useCanvasStore((state) => state.canvas?.nodes.find((entry) => entry.id === id)?.position.y || 0);
  const selectedVideoNodeId = useCanvasStore((state) => (
    state.canvas?.nodes.find((entry) => entry.type === 'video' && entry.id !== id && state.selectedNodeIds.includes(entry.id))?.id || null
  ));
  const addAssetItem = useAssetStore((state) => state.addItem);

  const [renderUrl, setRenderUrl] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [promptDraft, setPromptDraft] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [panelTab, setPanelTab] = useState<AudioPanelTab>('prompt');
  const [draftMode, setDraftMode] = useState<AudioGenerationMode>('bgm');
  const [draftBackend, setDraftBackend] = useState<AudioBackend>('fallback-local');
  const [voiceLibraryTab, setVoiceLibraryTab] = useState<VoiceLibraryTab>('library');
  const [voiceSearch, setVoiceSearch] = useState('');
  const [durationDraft, setDurationDraft] = useState(8);
  const [intensityDraft, setIntensityDraft] = useState(0.62);
  const [speechRateDraft, setSpeechRateDraft] = useState(0);
  const [activation, setActivation] = useState<{ mode: 'audio'; provider: string; reason: 'auth' } | null>(null);
  const [instructionsDraft, setInstructionsDraft] = useState('');

  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const params = readRecord(data?.params);
  const firstOutput = outputs[0] && typeof outputs[0] === 'object' ? outputs[0] as AnyRecord : {};
  const outputMeta = readRecord(firstOutput.metadata);
  const audioMeta = readRecord(params.audioMeta);
  const sourceUrl = String(params.sourceUrl || outputs.find((item) => item?.type === 'audio')?.url || '');
  const usesManagedLocalMedia = isLocalMediaHandle(sourceUrl);
  const nodeStatus = (data?.status || 'idle') as 'idle' | 'generating' | 'completed' | 'error';
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const catalogItems = useModelCatalogStore((state) => state.models);
  const fetchCatalog = useModelCatalogStore((state) => state.fetchCatalog);
  const fetchByokRuntime = useByokRuntimeStore((state) => state.fetchRuntime);
  const rawMode = String(params.audioMode || 'bgm');
  const safeMode: AudioGenerationMode = rawMode in CLEAN_MODE_META ? rawMode as AudioGenerationMode : 'bgm';
  const requestedBackendRaw = String(params.audioBackend || audioMeta.requestedBackend || 'fallback-local');
  const resolvedBackendRaw = String(audioMeta.backend || 'fallback-local');
  const isRemoteAudioBackend = (catalogItems || []).some((m) => m.id === requestedBackendRaw && (m.nodeTypes || []).includes('audio'));
  const safeRequestedBackend: AudioBackend = (requestedBackendRaw in CLEAN_BACKEND_META || isRemoteAudioBackend)
    ? (requestedBackendRaw as AudioBackend)
    : 'fallback-local';
  const safeResolvedBackend: AudioBackend = resolvedBackendRaw in CLEAN_BACKEND_META ? resolvedBackendRaw as AudioBackend : 'fallback-local';

  useEffect(() => {
    setDraftMode(safeMode);
  }, [safeMode]);

  useEffect(() => {
    setInstructionsDraft(String(params.audioInstructions || ''));
  }, [params.audioInstructions]);

  useEffect(() => {
    setDraftBackend(nextBackendForMode(draftMode, safeRequestedBackend));
  }, [draftMode, safeRequestedBackend]);

  const uiMode = draftMode;
  const uiRequestedBackend = nextBackendForMode(uiMode, draftBackend);
  const storedDurationValue = clampDuration(uiMode, params.audioDuration || audioMeta.duration || 8);
  const storedIntensityValue = clampUnitRange(params.audioIntensity ?? 0.62, 0.62);
  const storedSpeechRateValue = clampSpeechRate(params.audioSpeechRate ?? 0, 0);
  const voicePreset = String(params.audioVoicePreset || 'soft_girl');
  const format = String(audioMeta.format || outputMeta.format || outputMeta.mimeType || 'audio/wav');
  const sampleRate = Number(audioMeta.sampleRate || outputMeta.sampleRate || 0);
  const channels = Number(audioMeta.channels || outputMeta.channels || 0);
  const engine = String(audioMeta.engine || outputMeta.engine || data?.model || CLEAN_MODE_META[uiMode].model);
  const savedAssetId = String(params.localAudioAssetId || '');
  const backendOptions = (Object.keys(CLEAN_BACKEND_META) as AudioBackend[]).filter((backend) => CLEAN_BACKEND_META[backend].supportedModes.includes(uiMode));
  const invalidLegacyBlob = isTransientBlobUrl(sourceUrl) && !renderUrl;
  const isNodeActive = selectedNodeIds.includes(id);
  const isNodeExclusivelyActive = selectedNodeIds.length === 1 && selectedNodeIds[0] === id;
  const {
    activeKind: activeFloatingPanelKind,
    open: openAudioFloatingPanel,
    close: closeAudioFloatingPanel,
  } = useNodeFloatingPanel<'audio-composer'>(id, syncNodeSelection);
  const isComposerOpen = activeFloatingPanelKind === 'audio-composer';
  const showComposer = isComposerOpen || (isNodeExclusivelyActive && !renderUrl);
  const previewTitle = String(data?.label || '\u97f3\u9891\u8282\u70b9');
  const voicePresetMeta = (() => {
    const local = CLEAN_VOICE_PRESETS.find((item) => item.value === voicePreset);
    if (local) return local;
    for (const m of catalogItems || []) {
      if ((m.nodeTypes || []).includes('audio') && m.audioVoices) {
        const v = m.audioVoices.find((vv) => vv.value === voicePreset);
        if (v) {
          return {
            value: v.value,
            label: v.label,
            hint: `音色编码：${v.value}`,
            tone: v.gender === 'male' ? '男声' : v.gender === 'female' ? '女声' : '',
            emotion: '',
            locale: '多语种',
            gender: v.gender === 'female' ? '女声' : v.gender === 'male' ? '男声' : (v.gender || ''),
            favorite: false,
          } as VoicePreset;
        }
      }
    }
    return CLEAN_VOICE_PRESETS[0];
  })();
  const effectiveDuration = duration || Number(audioMeta.duration || outputMeta.duration || 0);
  const previewDurationLabel = formatSeconds(effectiveDuration || storedDurationValue);
  const previewModeLabel = CLEAN_MODE_META[uiMode].label;
  const compactTitle = renderUrl ? previewTitle : `\u751f\u6210${previewModeLabel}`;
  const emptyReason = invalidLegacyBlob
    ? '\u8fd9\u662f\u5386\u53f2\u753b\u5e03\u4e2d\u7684\u672c\u5730\u97f3\u9891\u7f13\u5b58\uff0c\u6d4f\u89c8\u5668\u91cd\u542f\u540e\u539f\u59cb\u7d20\u6750\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u751f\u6210\u6216\u91cd\u65b0\u4e0a\u4f20\u3002'
    : '\u8f93\u5165\u63d0\u793a\u8bcd\u540e\uff0c\u53ef\u76f4\u63a5\u5728\u5f53\u524d\u97f3\u9891\u8282\u70b9\u751f\u6210 BGM\u3001\u97f3\u6548\u6216\u65c1\u767d\u3002';
  const capabilityAdvice = uiMode === 'voiceover'
    ? '\u60f3\u8981\u66f4\u81ea\u7136\u3001\u5c11 AI \u611f\u3001\u5e26\u60c5\u7eea\u8bed\u6c14\u7684\u4e2d\u6587\u65c1\u767d\uff0c\u4f18\u5148\u5207\u5230 VoxCPM\uff0c\u5e76\u4f7f\u7528\u4e0b\u65b9\u771f\u5b9e\u53e3\u8bed\u5316\u97f3\u8272\u3002'
    : uiMode === 'sfx'
      ? '\u60f3\u8981\u66f4\u50cf\u771f\u5b9e\u7d20\u6750\u5e93\u7684\u9ad8\u8d28\u91cf\u97f3\u6548\uff0c\u4f18\u5148\u5207\u5230 AudioLDM 2\u3002'
      : '\u60f3\u8981\u66f4\u5b8c\u6574\u7684\u7f16\u66f2\u5c42\u6b21\u548c\u6c1b\u56f4\u7ec6\u8282\uff0c\u4f18\u5148\u5207\u5230 AudioLDM 2\u3002';
  const activatedRemoteAudioModels = useMemo(
    () => catalogItems
      .filter((model) => model.nodeTypes.includes('audio') && model.activated)
      .map((model) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        providerId: model.provider,
        provider: model.providerMeta?.name || model.provider,
        price: typeof model.price === 'number' ? `${String(model.currency || 'CNY').toUpperCase()} ${Number(model.price).toFixed(Number(model.price) >= 1 ? 2 : 3)}` : '预算待同步',
        sourceLabel: relaySourceLabel(model.activationRelaySource),
        audioVoices: model.audioVoices || null,
        capabilities: model.capabilities || null,
        supportsInstructions: Boolean(model.capabilities && model.capabilities.supportsInstructions),
      })),
    [catalogItems],
  );

  const selectedRemoteAudioModel = useMemo(
    () => (activatedRemoteAudioModels || []).find((m) => m.id === uiRequestedBackend) || null,
    [activatedRemoteAudioModels, uiRequestedBackend],
  );
  const usingRemoteVoices = Boolean(selectedRemoteAudioModel && selectedRemoteAudioModel.audioVoices && selectedRemoteAudioModel.audioVoices.length);
  const effectiveVoices: VoicePreset[] = useMemo(() => {
    if (usingRemoteVoices) {
      return (selectedRemoteAudioModel?.audioVoices || []).map((v) => ({
        value: v.value,
        label: v.label,
        hint: `音色编码：${v.value}`,
        tone: v.gender === 'male' ? '男声' : v.gender === 'female' ? '女声' : '',
        emotion: '',
        locale: '多语种',
        gender: v.gender === 'female' ? '女声' : v.gender === 'male' ? '男声' : (v.gender || ''),
        favorite: false,
      }));
    }
    return CLEAN_VOICE_PRESETS;
  }, [usingRemoteVoices, selectedRemoteAudioModel]);

  useEffect(() => {
    void fetchCatalog({ nodeType: 'audio', force: true });
  }, [fetchCatalog]);
  useEffect(() => {
    void fetchByokRuntime();
  }, [fetchByokRuntime]);

  const buildAudioLifecycleParams = (tool: AudioLifecycleTool, config: AnyRecord, extra: AnyRecord = {}) => {
    void tool;
    return {
      ...params,
      audioPrompt: String(config.audioPrompt || ''),
      audioMode: String(config.audioMode || uiMode),
      audioDuration: Number(config.audioDuration || 0),
      audioIntensity: Number(config.audioIntensity ?? 0.62),
      audioVoicePreset: String(config.audioVoicePreset || voicePreset),
      audioSpeechRate: Number(config.audioSpeechRate || 0),
      audioBackend: String(config.audioBackend || uiRequestedBackend),
      localAudioAssetId: '',
      audioActionMessage: '',
      ...extra,
    };
  };
  const {
    setGenerating: setAudioToolGeneratingState,
    complete: completeAudioToolState,
    fail: failAudioToolState,
  } = useNodeToolLifecycle<AudioLifecycleTool>({
    nodeId: id,
    updateNodeData,
    buildParams: buildAudioLifecycleParams,
    defaultStagePrefix: 'local-audio-',
  });

  useEffect(() => {
    setPromptDraft(String(data?.prompt || params.audioPrompt || ''));
  }, [data?.prompt, params.audioPrompt]);

  useEffect(() => {
    setDurationDraft(storedDurationValue);
  }, [storedDurationValue]);

  useEffect(() => {
    setIntensityDraft(storedIntensityValue);
  }, [storedIntensityValue]);

  useEffect(() => {
    setSpeechRateDraft(storedSpeechRateValue);
  }, [storedSpeechRateValue]);

  useEffect(() => {
    if (isNodeExclusivelyActive && !sourceUrl && !isComposerOpen) {
      openAudioFloatingPanel('audio-composer');
      return;
    }
    if (!showComposer) {
      clearPendingComposerSync();
      const withinInteractionWindow = Date.now() - panelInteractionLockRef.current < 520;
      if (withinInteractionWindow && isComposerOpen) {
        return;
      }
      setPanelTab('prompt');
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        audio.pause();
      }
    }
  }, [isComposerOpen, isNodeExclusivelyActive, openAudioFloatingPanel, showComposer, sourceUrl]);

  useEffect(() => {
    return () => {
      clearPendingComposerSync();
    };
  }, []);

  useEffect(() => {
    let revoked = false;
    let previousObjectUrl = '';

    async function load() {
      if (!sourceUrl) {
        setRenderUrl('');
        return;
      }
      const resolved = await ensureLocalMediaUrl(sourceUrl);
      if (revoked) {
        if (!usesManagedLocalMedia && resolved && resolved.startsWith('blob:') && resolved !== previousObjectUrl) {
          URL.revokeObjectURL(resolved);
        }
        return;
      }
      previousObjectUrl = resolved;
      setRenderUrl(resolved || '');
    }

    void load();
    return () => {
      revoked = true;
      if (!usesManagedLocalMedia && previousObjectUrl && isTransientBlobUrl(previousObjectUrl)) {
        URL.revokeObjectURL(previousObjectUrl);
      }
    };
  }, [sourceUrl, usesManagedLocalMedia]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const syncTime = () => {
      setCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      setIsPlaying(!audio.paused);
    };

    audio.addEventListener('timeupdate', syncTime);
    audio.addEventListener('loadedmetadata', syncTime);
    audio.addEventListener('play', syncTime);
    audio.addEventListener('pause', syncTime);
    audio.addEventListener('ended', syncTime);

    return () => {
      audio.removeEventListener('timeupdate', syncTime);
      audio.removeEventListener('loadedmetadata', syncTime);
      audio.removeEventListener('play', syncTime);
      audio.removeEventListener('pause', syncTime);
      audio.removeEventListener('ended', syncTime);
    };
  }, [renderUrl]);

  const durationText = useMemo(() => formatSeconds(effectiveDuration), [effectiveDuration]);

  const visibleVoiceOptions = useMemo(() => {
    const keyword = voiceSearch.trim().toLowerCase();
    const baseList = voiceLibraryTab === 'favorite'
      ? effectiveVoices.filter((item) => item.favorite)
      : voiceLibraryTab === 'mine'
        ? effectiveVoices.filter((item) => item.value === voicePreset || item.favorite)
        : effectiveVoices;
    if (!keyword) return baseList;
    return baseList.filter((item) => {
      const haystack = `${item.label} ${item.hint} ${item.tone} ${item.emotion} ${item.locale} ${item.gender}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }, [voiceLibraryTab, voicePreset, voiceSearch]);

  function patchNodeParams(nextPatch: AnyRecord, extraData: AnyRecord = {}) {
    updateNodeData(id, {
      ...extraData,
      params: {
        ...params,
        ...nextPatch,
      },
    });
  }

  function patchNodeParamsTransition(nextPatch: AnyRecord, extraData: AnyRecord = {}) {
    startTransition(() => {
      patchNodeParams(nextPatch, extraData);
    });
  }

  function markPanelInteraction() {
    panelInteractionLockRef.current = Date.now();
    setSelectionGuard(720);
  }

  function stopPanelInteraction(event: { stopPropagation: () => void }) {
    markPanelInteraction();
    stopCanvasInteraction(event);
  }

  function clearPendingComposerSync() {
    if (pendingSelectionSyncRef.current !== null) {
      window.clearTimeout(pendingSelectionSyncRef.current);
      pendingSelectionSyncRef.current = null;
    }
    if (pendingKeepAliveTimeoutsRef.current.length > 0) {
      pendingKeepAliveTimeoutsRef.current.forEach((timerId) => window.clearTimeout(timerId));
      pendingKeepAliveTimeoutsRef.current = [];
    }
  }

  function scheduleNodeSelectionSync() {
    clearPendingComposerSync();
    const syncSelection = () => {
      const store = useCanvasStore.getState();
      const currentIds = Array.isArray(store.selectedNodeIds) ? store.selectedNodeIds : [];
      if (currentIds.length === 1 && currentIds[0] === id) return;
      store.setSelectionGuard?.(720);
      store.setSelectedNodeIds([id]);
    };
    pendingSelectionSyncRef.current = window.setTimeout(() => {
      pendingSelectionSyncRef.current = null;
      syncSelection();
    }, 0);
    pendingKeepAliveTimeoutsRef.current = [
      window.setTimeout(syncSelection, 96),
      window.setTimeout(syncSelection, 220),
    ];
  }

  function scheduleComposerKeepAlive() {
    if (pendingKeepAliveTimeoutsRef.current.length > 0) {
      pendingKeepAliveTimeoutsRef.current.forEach((timerId) => window.clearTimeout(timerId));
      pendingKeepAliveTimeoutsRef.current = [];
    }
    const keepAlive = () => {
      const store = useCanvasStore.getState();
      const currentIds = Array.isArray(store.selectedNodeIds) ? store.selectedNodeIds : [];
      if (currentIds.length > 0 && !currentIds.includes(id)) {
        return;
      }
      store.setSelectionGuard?.(720);
      if (currentIds.length !== 1 || currentIds[0] !== id) {
        store.setSelectedNodeIds([id]);
      }
      store.openFloatingPanel({ nodeId: id, kind: 'audio-composer' });
    };
    pendingKeepAliveTimeoutsRef.current = [
      window.setTimeout(keepAlive, 0),
      window.setTimeout(keepAlive, 72),
      window.setTimeout(keepAlive, 180),
      window.setTimeout(keepAlive, 360),
      window.setTimeout(keepAlive, 640),
    ];
  }

  function syncNodeSelection() {
    if (selectedNodeIds.length === 1 && selectedNodeIds[0] === id) return;
    setSelectedNodeIds([id]);
  }

  function setActionFeedback(message: string) {
    setActionMessage(message);
    patchNodeParamsTransition({ audioActionMessage: message });
  }

  function closeComposer(resetTab = true) {
    clearPendingComposerSync();
    closeAudioFloatingPanel('audio-composer');
    if (resetTab) {
      setPanelTab('prompt');
    }
  }

  function openComposer(nextTab: AudioPanelTab = 'prompt') {
    markPanelInteraction();
    if (!selectedNodeIds.includes(id)) {
      setSelectedNodeIds([id]);
    }
    scheduleNodeSelectionSync();
    scheduleComposerKeepAlive();
    setPanelTab(nextTab);
    openAudioFloatingPanel('audio-composer');
  }

  function handleModeSelect(nextMode: AudioGenerationMode) {
    const keepRemote = (activatedRemoteAudioModels || []).find((m) => m.id === requestedBackendRaw);
    const nextBackend: AudioBackend = keepRemote ? (keepRemote.id as AudioBackend) : nextBackendForMode(nextMode, draftBackend);
    markPanelInteraction();
    scheduleNodeSelectionSync();
    scheduleComposerKeepAlive();
    openAudioFloatingPanel('audio-composer');
    setDraftMode(nextMode);
    setDraftBackend(nextBackend);
    setPanelTab((current) => {
      if (nextMode === 'voiceover') {
        return 'tune';
      }
      if (current === 'result' || current === 'tune' || !renderUrl) {
        return 'prompt';
      }
      return 'prompt';
    });
    patchNodeParamsTransition({
      audioMode: nextMode,
      audioBackend: nextBackend,
      audioDuration: clampDuration(nextMode, storedDurationValue),
    });
  }

  function handleBackendSelect(nextBackend: AudioBackend) {
    markPanelInteraction();
    setDraftBackend(nextBackend);
    const remote = (activatedRemoteAudioModels || []).find((m) => m.id === nextBackend);
    if (remote && remote.audioVoices && remote.audioVoices.length) {
      const firstVoice = remote.audioVoices[0].value;
      const initialInstructions = remote.supportsInstructions ? String(params.audioInstructions || '') : '';
      setInstructionsDraft(initialInstructions);
      patchNodeParamsTransition({ audioBackend: nextBackend, audioVoicePreset: firstVoice, audioInstructions: initialInstructions });
    } else {
      patchNodeParamsTransition({ audioBackend: nextBackend });
    }
  }

  function handleVoicePresetSelect(nextVoicePreset: string) {
    markPanelInteraction();
    patchNodeParamsTransition({ audioVoicePreset: nextVoicePreset });
  }

  function commitDurationDraft(nextValue = durationDraft) {
    markPanelInteraction();
    const clamped = clampDuration(uiMode, nextValue);
    setDurationDraft(clamped);
    patchNodeParamsTransition({ audioDuration: clamped });
  }

  function commitIntensityDraft(nextValue = intensityDraft) {
    markPanelInteraction();
    const clamped = clampUnitRange(nextValue, 0.62);
    setIntensityDraft(clamped);
    patchNodeParamsTransition({ audioIntensity: clamped });
  }

  function commitSpeechRateDraft(nextValue = speechRateDraft) {
    markPanelInteraction();
    const clamped = clampSpeechRate(nextValue, 0);
    setSpeechRateDraft(clamped);
    patchNodeParamsTransition({ audioSpeechRate: clamped });
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !renderUrl) return;
    if (audio.paused) {
      void audio.play();
      return;
    }
    audio.pause();
  }

  function handleSeek(value: number) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(value)) return;
    audio.currentTime = Math.max(0, Math.min(value, duration || audio.duration || value));
    setCurrentTime(audio.currentTime);
  }

  function downloadAudio() {
    if (!renderUrl) return;
    const link = document.createElement('a');
    link.href = renderUrl;
    const extension = format.includes('wav')
      ? 'wav'
      : format.includes('ogg')
        ? 'ogg'
        : format.includes('flac')
          ? 'flac'
          : 'mp3';
    link.download = `${sanitizeFileName(String(data?.label || 'audio-result'))}.${extension}`;
    link.click();
  }

  function saveToAssetLibrary() {
    if (!sourceUrl) return;
    if (savedAssetId) {
      setActionFeedback('\u5f53\u524d\u7ed3\u679c\u5df2\u52a0\u5165\u8d44\u4ea7\u5e93\uff0c\u53ef\u76f4\u63a5\u590d\u7528\u3002');
      return;
    }
    const assetId = addAssetItem(createGeneratedAudioDescriptor(
      String(data?.label || `${CLEAN_MODE_META[uiMode].label} \u7ed3\u679c`),
      sourceUrl,
      Number(outputMeta.size || 0),
      Number(audioMeta.duration || outputMeta.duration || duration || 0),
      uiMode,
    ));
    patchNodeParamsTransition({ localAudioAssetId: assetId });
    setActionFeedback('\u5df2\u52a0\u5165\u8d44\u4ea7\u5e93\uff0c\u53ef\u5728\u56fe\u7247\u3001\u89c6\u9891\u548c\u97f3\u9891\u5de5\u4f5c\u6d41\u4e2d\u7ee7\u7eed\u590d\u7528\u3002');
  }

  function reuseToVideoNode() {
    if (!sourceUrl) return;
    const targetId = selectedVideoNodeId || addNode('video', {
      x: sourceNodeX + 430,
      y: sourceNodeY + 24,
    });
    const targetNode = useCanvasStore.getState().canvas?.nodes.find((node) => node.id === targetId) || null;
    const targetParams = readRecord(targetNode?.data?.params);
    updateNodeData(targetId, {
      label: String(targetNode?.data?.label || '\u89c6\u9891\u8282\u70b9'),
      params: {
        ...targetParams,
        linkedAudioNodeId: id,
        linkedAudioSourceUrl: sourceUrl,
        linkedAudioAssetId: savedAssetId,
        linkedAudioLabel: String(data?.label || `${CLEAN_MODE_META[uiMode].label} \u7ed3\u679c`),
        linkedAudioMode: uiMode,
        linkedAudioDuration: Number(audioMeta.duration || outputMeta.duration || duration || 0),
        linkedAudioEngine: engine,
        linkedAudioBackend: safeResolvedBackend,
        linkedAudioMixMode: uiMode === 'voiceover' ? 'voiceover-dub' : 'bgm-under',
        linkedAudioGain: uiMode === 'voiceover' ? 1.15 : uiMode === 'bgm' ? 0.84 : 1,
        linkedVideoGain: uiMode === 'voiceover' ? 0.3 : uiMode === 'bgm' ? 0.74 : 0.92,
        linkedAudioUpdatedAt: Date.now(),
      },
    });
    setSelectedNodeIds([targetId]);
    setActionFeedback(selectedVideoNodeId ? '\u5df2\u6302\u5230\u5f53\u524d\u9009\u4e2d\u7684\u89c6\u9891\u8282\u70b9\u3002' : '\u5df2\u521b\u5efa\u65b0\u89c6\u9891\u8282\u70b9\uff0c\u5e76\u628a\u5f53\u524d\u97f3\u9891\u6302\u5230\u5b83\u7684\u8349\u7a3f\u53c2\u6570\u4e2d\u3002');
  }

  async function handleGenerate() {
    if (!isAuthenticated()) {
      window.location.href = '/login';
      return;
    }
    const prompt = promptDraft.trim();
    const remoteModel = (activatedRemoteAudioModels || []).find(
      (m) => String(m?.id || '') === String(uiRequestedBackend),
    ) || null;
    const resolvedVoicePreset = remoteModel && remoteModel.audioVoices && remoteModel.audioVoices.length && !remoteModel.audioVoices.some((v) => v.value === voicePreset)
      ? remoteModel.audioVoices[0].value
      : voicePreset;
    const lifecycleConfig = {
      audioPrompt: prompt,
      audioMode: uiMode,
      audioDuration: clampDuration(uiMode, durationDraft),
      audioIntensity: clampUnitRange(intensityDraft, 0.62),
      audioVoicePreset: resolvedVoicePreset,
      audioSpeechRate: clampSpeechRate(speechRateDraft, 0),
      audioInstructions: instructionsDraft,
      audioBackend: remoteModel ? remoteModel.id : uiRequestedBackend,
    } satisfies AnyRecord;
    if (!prompt) {
      failAudioToolState('generate', lifecycleConfig, {
        error: '\u8bf7\u8f93\u5165\u97f3\u9891\u63d0\u793a\u8bcd\u540e\u518d\u751f\u6210\u3002',
        errorCategory: 'validation',
        errorStage: 'audio-input',
        nodeData: {
          prompt: '',
          provider: 'local',
          model: CLEAN_MODE_META[uiMode].model,
        },
      });
      return;
    }

    const resolvedDuration = Number(lifecycleConfig.audioDuration || 0);
    const resolvedIntensity = Number(lifecycleConfig.audioIntensity || 0);
    const resolvedSpeechRate = Number(lifecycleConfig.audioSpeechRate || 0);
    const resolvedEngine = remoteModel ? remoteModel.id : CLEAN_MODE_META[uiMode].model;
    const resolvedProvider = remoteModel ? remoteModel.providerId || 'remote' : 'local';
    const progressMessage = remoteModel ? '远程音频生成中...' : '本地音频生成中...';

    const payload = remoteModel
      ? ({
          model: remoteModel.id,
          provider: remoteModel.providerId,
          mode: uiMode,
          prompt,
          duration: resolvedDuration,
          intensity: resolvedIntensity,
          voicePreset: resolvedVoicePreset,
          speechRate: resolvedSpeechRate,
          language: inferPromptLanguage(prompt),
          instructions: remoteModel.supportsInstructions ? instructionsDraft : '',
        } as RemoteAudioGenerationPayload)
      : ({
          mode: uiMode,
          prompt,
          duration: resolvedDuration,
          intensity: resolvedIntensity,
          voicePreset,
          speechRate: resolvedSpeechRate,
          language: inferPromptLanguage(prompt),
          backend: uiRequestedBackend,
        } as LocalAudioGenerationPayload);

    setAudioToolGeneratingState('generate', lifecycleConfig, {
      progress: {
        progress: 8,
        message: progressMessage,
        stage: remoteModel ? 'remote-audio-generate' : 'local-audio-generate',
      },
      nodeData: {
        prompt,
        error: '',
        provider: resolvedProvider,
        model: resolvedEngine,
      },
      params: {
        lastErrorCategory: '',
        lastErrorStage: '',
      },
    });
    setActionMessage('');

    // 若智能体「免费优先路线」写入了回退链（图片/视频/音频通用），则运行期按优先级回退：
    // 免费额度模型优先，失败则切换到按优先级排列的付费 API 模型。
    const audioChainRaw = (data as unknown as Record<string, unknown>)?.modelFallbackChain;
    const audioChain = Array.isArray(audioChainRaw) && audioChainRaw.length
      ? (audioChainRaw as Array<Record<string, unknown>>)
          .map((c) => ({ provider: String(c.provider || ''), model: String(c.model || ''), isFree: Boolean(c.isFree) }))
          .filter((c) => c.provider && c.model)
      : null;
    const result = remoteModel
      ? await generateAudioWithFallback(
          {
            ...(payload as RemoteAudioGenerationPayload),
            model: audioChain ? audioChain[0].model : (payload as RemoteAudioGenerationPayload).model,
            provider: audioChain ? audioChain[0].provider : (payload as RemoteAudioGenerationPayload).provider,
          },
          audioChain || undefined,
        )
      : await generateAudioLocally(payload as LocalAudioGenerationPayload);
    if (!result.success) {
      failAudioToolState('generate', lifecycleConfig, {
        error: result.error,
        errorCategory: 'render',
        errorStage: remoteModel ? 'remote-audio-generate' : 'local-audio-generate',
        nodeData: {
          prompt,
          provider: resolvedProvider,
          model: resolvedEngine,
        },
      });
      return;
    }

    const persistedOutputUrl = String(result.data.url || '').trim();
    const outputUrl = persistedOutputUrl || (result.data.blob ? registerLocalMedia(result.data.blob) : '');
    if (!outputUrl) {
      failAudioToolState('generate', lifecycleConfig, {
        error: '\u672c\u5730\u97f3\u9891\u751f\u6210\u6210\u529f\uff0c\u4f46\u7ed3\u679c\u5730\u5740\u4e3a\u7a7a\u3002',
        errorCategory: 'render',
        errorStage: 'local-audio-generate-materialize',
      });
      return;
    }
    setRenderUrl(outputUrl);
    const nextLabel = uiMode === 'voiceover'
      ? '\u65c1\u767d\u7ed3\u679c'
      : uiMode === 'sfx'
        ? '\u97f3\u6548\u7ed3\u679c'
        : 'BGM \u7ed3\u679c';

    completeAudioToolState('generate', lifecycleConfig, {
      nodeData: {
        label: String(data?.label || nextLabel),
        prompt,
        provider: resolvedProvider,
        model: result.data.engine,
        outputs: [
          {
            id: `audio-local-${Date.now()}`,
            type: 'audio',
            url: outputUrl,
            metadata: {
              managedUrl: true,
              source: 'local-audio-generate',
              engine: result.data.engine,
              mode: result.data.mode,
              voiceName: result.data.voiceName || '',
              format: result.data.format,
              sampleRate: result.data.sampleRate,
              channels: result.data.channels,
              duration: result.data.duration,
              requestedBackend: result.data.requestedBackend,
              backend: result.data.backend,
              backendLabel: result.data.backendLabel,
              backendAvailable: result.data.backendAvailable,
              fallbackUsed: result.data.fallbackUsed,
              fallbackReason: result.data.fallbackReason || '',
              size: result.data.size,
              mimeType: result.data.mimeType || '',
              sourceAssetId: result.data.assetId || '',
              persistedUrl: persistedOutputUrl,
            },
          },
        ],
      },
      params: {
        sourceUrl: outputUrl,
        sourceAssetId: result.data.assetId || '',
        audioMeta: {
          duration: result.data.duration,
          sampleRate: result.data.sampleRate,
          channels: result.data.channels,
          format: result.data.format,
          engine: result.data.engine,
          voiceName: result.data.voiceName || '',
          requestedBackend: result.data.requestedBackend,
          backend: result.data.backend,
          backendLabel: result.data.backendLabel,
          backendAvailable: result.data.backendAvailable,
          fallbackUsed: result.data.fallbackUsed,
          fallbackReason: result.data.fallbackReason || '',
        },
      },
    });
    setPanelTab('result');
    markPanelInteraction();
    openAudioFloatingPanel('audio-composer');
  }

  return (
    <div className="relative" data-testid={`audio-node-${id}`}>
      <div
        className={`relative w-[188px] rounded-2xl border bg-[#1a1b1d] shadow-[0_14px_40px_rgba(0,0,0,0.28)] transition-all duration-150 ${
          isNodeActive ? 'border-[#d9e1ea] ring-2 ring-[#d9e1ea]/40' : 'border-[#2b2e33]'
        }`}
      >
        <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2.5">
          <EditableNodeTitle nodeId={id} icon={AudioLines} label={data?.label} fallback="音频节点" />
          <StatusBadge status={nodeStatus} />
        </div>

        <div className="px-3 pb-3">
          <button
            type="button"
            data-testid={`audio-center-action-${id}`}
            onPointerDown={stopCanvasInteraction}
            onClick={(event) => {
              stopCanvasClick(event);
              if (renderUrl) {
                togglePlayback();
                return;
              }
              openComposer(uiMode === 'voiceover' ? 'tune' : 'prompt');
            }}
            className="flex h-[118px] w-full flex-col items-center justify-center rounded-2xl border border-[#2e3238] bg-[linear-gradient(180deg,#23262a_0%,#17191c_100%)] text-[#eef3f8] transition hover:border-[#46515d] hover:bg-[linear-gradient(180deg,#272b31_0%,#191c20_100%)] active:scale-[0.99]"
            title={renderUrl ? (isPlaying ? '暂停音频' : '播放音频') : '打开音频生成面板'}
          >
            <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[#2e3440] text-[#f7fafc]">
              {renderUrl ? (
                isPlaying ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />
              ) : (
                <Sparkles className="h-5 w-5" />
              )}
            </span>
            <span className="max-w-full truncate px-2 text-sm font-semibold">{compactTitle}</span>
            <span className="mt-1 px-3 text-center text-[11px] leading-4 text-[#96a2ae]">
              {renderUrl ? `${previewModeLabel} · ${previewDurationLabel}` : '点击生成或编辑当前音频'}
            </span>
          </button>

          <div className="mt-3 space-y-2 rounded-2xl border border-[#2c3035] bg-[#141619] px-3 py-2.5 text-[11px] text-[#cad4de]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#7f8b97]">模式</span>
              <span className="font-medium text-[#f1f5f9]">{previewModeLabel}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#7f8b97]">后端</span>
              <span className="max-w-[96px] truncate font-medium text-[#e4edf6]" title={selectedRemoteAudioModel ? selectedRemoteAudioModel.name : (CLEAN_BACKEND_META[uiRequestedBackend]?.label || uiRequestedBackend)}>
                {selectedRemoteAudioModel ? selectedRemoteAudioModel.name : (CLEAN_BACKEND_META[uiRequestedBackend]?.label || uiRequestedBackend)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#7f8b97]">状态</span>
              <span className="font-medium text-[#a7f3d0]">{renderUrl ? durationText : '待生成'}</span>
            </div>
            {uiMode === 'voiceover' ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-[#7f8b97]">音色</span>
                <span className="max-w-[96px] truncate font-medium text-[#ffe0c2]" title={voicePresetMeta.label}>
                  {voicePresetMeta.label}
                </span>
              </div>
            ) : null}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              data-testid={`audio-editor-toggle-${id}`}
              onPointerDown={stopCanvasInteraction}
              onClick={(event) => {
                stopCanvasClick(event);
                if (showComposer) {
                  closeComposer();
                  return;
                }
                openComposer(renderUrl ? 'result' : uiMode === 'voiceover' ? 'tune' : 'prompt');
              }}
              className={`flex flex-1 items-center justify-center gap-1 rounded-xl border px-3 py-2 text-xs font-medium transition ${
                showComposer
                  ? 'border-[#5d827d] bg-[#17312b] text-[#d8fff7]'
                  : 'border-[#343942] bg-[#1d2025] text-[#dce5ee] hover:bg-[#262a30]'
              }`}
              title={showComposer ? '收起面板' : '打开面板'}
            >
              <Wand2 className="h-3.5 w-3.5" />
              {showComposer ? '收起' : '编辑'}
            </button>
            <button
              type="button"
              data-testid={`audio-download-${id}`}
              onPointerDown={stopCanvasInteraction}
              onClick={downloadAudio}
              disabled={!renderUrl}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#343942] bg-[#1d2025] text-[#dce5ee] transition hover:bg-[#262a30] disabled:cursor-not-allowed disabled:opacity-40"
              title="下载音频"
            >
              <Download className="h-4 w-4" />
            </button>
          </div>
        </div>

        <Handle id="audio-input" type="target" position={Position.Left} className="image-node-handle" style={handleLeft}>
          <span className="text-xs font-bold leading-none text-[#6e7681]">+</span>
        </Handle>
        <Handle id="audio-output" type="source" position={Position.Right} className="image-node-handle" style={handleRight}>
          <span className="text-xs font-bold leading-none text-[#6e7681]">+</span>
        </Handle>
      </div>

      {renderUrl ? (
        <audio
          ref={audioRef}
          src={renderUrl}
          preload="metadata"
          className="hidden"
          data-testid={`audio-element-${id}`}
        />
      ) : null}

      {showComposer ? (
        <div
          className="nodrag nopan nowheel absolute left-1/2 top-full z-30 mt-3 w-[680px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-[24px] border border-[#2f353c] bg-[#17191d] p-4 shadow-[0_22px_60px_rgba(0,0,0,0.42)]"
          onPointerDownCapture={stopPanelInteraction}
          onPointerUpCapture={stopPanelInteraction}
          onMouseDownCapture={stopPanelInteraction}
          onMouseUpCapture={stopPanelInteraction}
          onTouchStartCapture={stopPanelInteraction}
          onPointerDown={stopPanelInteraction}
          onPointerUp={stopPanelInteraction}
          onMouseDown={stopPanelInteraction}
          onMouseUp={stopPanelInteraction}
          onTouchStart={stopPanelInteraction}
          onClick={stopPanelInteraction}
          data-testid={`audio-panel-${id}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[#f4f7fb]">
                {renderUrl ? '音频交互面板' : `生成${previewModeLabel}`}
              </div>
              <div className="mt-1 text-xs leading-5 text-[#91a0ae]">
                {CLEAN_MODE_META[uiMode].hint}
              </div>
            </div>
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={(event) => {
                stopCanvasClick(event);
                closeComposer();
              }}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#343942] bg-[#1d2025] text-[#dce5ee] transition hover:bg-[#262a30]"
              title="关闭面板"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {(Object.keys(CLEAN_MODE_META) as AudioGenerationMode[]).map((item) => (
              <button
                key={item}
                type="button"
                data-testid={`audio-mode-${id}-${item}`}
                data-active={uiMode === item ? 'true' : 'false'}
                aria-pressed={uiMode === item}
                onPointerDown={stopCanvasInteraction}
                onClick={(event) => {
                  stopCanvasClick(event);
                  handleModeSelect(item);
                }}
                className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${modeButtonClass(uiMode === item)}`}
                title={CLEAN_MODE_META[item].hint}
              >
                {CLEAN_MODE_META[item].label}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {CLEAN_PANEL_TAB_META.map((item) => {
              const Icon = item.icon;
              const isActive = panelTab === item.id;
              const disabled = item.id === 'result' && !renderUrl;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`audio-panel-tab-${id}-${item.id}`}
                  data-active={isActive ? 'true' : 'false'}
                  aria-pressed={isActive}
                  onPointerDown={stopCanvasInteraction}
                  onClick={(event) => {
                    stopCanvasClick(event);
                    if (!disabled) {
                      markPanelInteraction();
                      setPanelTab(item.id);
                    }
                  }}
                  disabled={disabled}
                  className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition ${panelTabClass(isActive)} disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              );
            })}
          </div>

          {panelTab === 'prompt' ? (
            <div className="mt-4 space-y-4">
              <textarea
                value={promptDraft}
                data-testid={`audio-prompt-${id}`}
                onPointerDown={stopCanvasInteraction}
                onMouseDown={stopCanvasInteraction}
                onTouchStart={stopCanvasInteraction}
                onChange={(event) => setPromptDraft(event.target.value)}
                placeholder={CLEAN_MODE_META[uiMode].placeholder}
                className="nodrag nopan nowheel min-h-[140px] w-full resize-none rounded-[22px] border border-[#34383d] bg-[#101214] px-4 py-3 text-sm text-[#edf2f7] outline-none transition placeholder:text-[#6b7785] focus:border-[#00d4aa]"
              />
              <div className="rounded-2xl border border-[#2b3136] bg-[#101315] px-3 py-3 text-[11px] leading-5 text-[#9ca9b6]">
                <div className="font-medium text-[#eef3f8]">生成建议</div>
                <div className="mt-1">{CLEAN_MODE_META[uiMode].hint}</div>
                <div className="mt-1">{capabilityAdvice}</div>
              </div>
            </div>
          ) : null}

          {panelTab === 'model' ? (
            <div className="mt-4 space-y-3">
              <section className="rounded-2xl border border-[#2b3136] bg-[#11161a] px-3 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold text-[#eef3f8]">本地生成</div>
                  <SourceBadge label="免费" tone="free" />
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {backendOptions.map((backend) => (
                    <button
                      key={backend}
                      type="button"
                      data-testid={`audio-backend-${id}-${backend}`}
                      onPointerDown={stopCanvasInteraction}
                      onClick={() => handleBackendSelect(backend)}
                      className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition ${backendButtonClass(uiRequestedBackend === backend)}`}
                    >
                      <div className="text-[13px] font-semibold">{CLEAN_BACKEND_META[backend].label}</div>
                      {uiRequestedBackend === backend ? <SourceBadge label="已选" tone="local" /> : null}
                    </button>
                  ))}
                </div>
              </section>

              <section className="rounded-2xl border border-[#2b3136] bg-[#11161a] px-3 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold text-[#eef3f8]">API 聚合</div>
                  {uiRequestedBackend && !backendOptions.includes(uiRequestedBackend) ? (
                    <SourceBadge label="已选" tone="api" />
                  ) : null}
                </div>
                {activatedRemoteAudioModels.length > 0 ? (
                  <select
                    value={backendOptions.includes(uiRequestedBackend) ? '' : uiRequestedBackend}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      if (nextValue) handleBackendSelect(nextValue as AudioBackend);
                    }}
                    className="nodrag nopan w-full rounded-xl border border-[#444] bg-[#1f1f1f] px-3 py-2.5 text-[13px] text-[#e7e7e7] outline-none"
                  >
                    <option value="">选择聚合音频模型</option>
                    {activatedRemoteAudioModels.map((model) => (
                      <option key={model.id} value={model.id}>{model.name}</option>
                    ))}
                  </select>
                ) : (
                  <div className="rounded-xl border border-dashed border-[#2d3236] bg-[#121518] px-3 py-3 text-[11px] leading-5 text-[#8ea0b2]">暂无已激活的聚合音频模型</div>
                )}
              </section>
            </div>
          ) : null}

          {panelTab === 'tune' ? (
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-xs text-[#c9d2db]">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span>{uiMode === 'voiceover' ? '预计时长' : '时长'}</span>
                    <span className="font-medium text-[#8fdcca]">{durationDraft.toFixed(uiMode === 'voiceover' ? 0 : 1)}s</span>
                  </div>
                  <input
                    type="range"
                    min={uiMode === 'voiceover' ? 1 : 0.5}
                    max={uiMode === 'voiceover' ? 30 : 20}
                    step={uiMode === 'voiceover' ? 1 : 0.5}
                    value={durationDraft}
                    onPointerDown={stopCanvasInteraction}
                    onMouseDown={stopCanvasInteraction}
                    onTouchStart={stopCanvasInteraction}
                    onChange={(event) => setDurationDraft(Number(event.target.value))}
                    onPointerUp={() => commitDurationDraft()}
                    onMouseUp={() => commitDurationDraft()}
                    onTouchEnd={() => commitDurationDraft()}
                    onBlur={() => commitDurationDraft()}
                    className={sliderTrackClass()}
                    data-testid={`audio-duration-slider-${id}`}
                  />
                </label>

                {uiMode === 'voiceover' ? (
                  <label className="rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-xs text-[#c9d2db]">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span>语速</span>
                      <span className="font-medium text-[#8fdcca]">{speechRateDraft}</span>
                    </div>
                    <input
                      type="range"
                      min={-6}
                      max={6}
                      step={1}
                      value={speechRateDraft}
                      onPointerDown={stopCanvasInteraction}
                      onMouseDown={stopCanvasInteraction}
                      onTouchStart={stopCanvasInteraction}
                      onChange={(event) => setSpeechRateDraft(Number(event.target.value))}
                      onPointerUp={() => commitSpeechRateDraft()}
                      onMouseUp={() => commitSpeechRateDraft()}
                      onTouchEnd={() => commitSpeechRateDraft()}
                      onBlur={() => commitSpeechRateDraft()}
                      className={sliderTrackClass()}
                      data-testid={`audio-speech-rate-slider-${id}`}
                    />
                  </label>
                ) : (
                  <label className="rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-xs text-[#c9d2db]">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span>强度</span>
                      <span className="font-medium text-[#8fdcca]">{intensityDraft.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={intensityDraft}
                      onPointerDown={stopCanvasInteraction}
                      onMouseDown={stopCanvasInteraction}
                      onTouchStart={stopCanvasInteraction}
                      onChange={(event) => setIntensityDraft(Number(event.target.value))}
                      onPointerUp={() => commitIntensityDraft()}
                      onMouseUp={() => commitIntensityDraft()}
                      onTouchEnd={() => commitIntensityDraft()}
                      onBlur={() => commitIntensityDraft()}
                      className={sliderTrackClass()}
                      data-testid={`audio-intensity-slider-${id}`}
                    />
                  </label>
                )}
              </div>

              {selectedRemoteAudioModel?.supportsInstructions ? (
                <label className="mt-3 block rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-xs text-[#c9d2db]">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span>语气 / 情绪指令（instructions）</span>
                  </div>
                  <textarea
                    value={instructionsDraft}
                    onPointerDown={stopCanvasInteraction}
                    onChange={(event) => setInstructionsDraft(event.target.value)}
                    placeholder="例如：用轻松愉快的语气朗读，语速稍快，带一点俏皮感"
                    rows={3}
                    className="nodrag nopan nowheel w-full resize-none rounded-xl border border-[#34383d] bg-[#0f1214] px-3 py-2 text-[#eef4fb] outline-none placeholder:text-[#677585]"
                    data-testid={`audio-instructions-${id}`}
                  />
                </label>
              ) : null}

              {uiMode === 'voiceover' ? (
                <div className="rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3">
                  {!usingRemoteVoices ? (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap rounded-2xl bg-[#20242a] p-1">
                      {CLEAN_VOICE_LIBRARY_META.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          data-testid={`audio-voice-tab-${id}-${item.id}`}
                          data-active={voiceLibraryTab === item.id ? 'true' : 'false'}
                          aria-pressed={voiceLibraryTab === item.id}
                          onPointerDown={stopCanvasInteraction}
                      onClick={(event) => {
                        stopCanvasClick(event);
                        markPanelInteraction();
                        setVoiceLibraryTab(item.id);
                      }}
                          className={`rounded-xl px-3 py-1.5 text-xs font-medium transition ${voiceLibraryTabClass(voiceLibraryTab === item.id)}`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 rounded-xl border border-[#34383d] bg-[#0f1214] px-3 py-2 text-xs text-[#93a4b4]">
                      <Search className="h-3.5 w-3.5" />
                      <input
                        value={voiceSearch}
                        onPointerDown={stopCanvasInteraction}
                        onMouseDown={stopCanvasInteraction}
                        onTouchStart={stopCanvasInteraction}
                        onChange={(event) => setVoiceSearch(event.target.value)}
                        placeholder="搜索音色库"
                        className="nodrag nopan nowheel w-[160px] bg-transparent text-[#eef4fb] outline-none placeholder:text-[#677585]"
                        data-testid={`audio-voice-search-${id}`}
                      />
                    </div>
                  </div>
                  ) : null}

                  <div className="mt-3 max-h-[320px] space-y-2 overflow-y-auto pr-1">
                    {visibleVoiceOptions.map((item) => {
                      const isActive = voicePreset === item.value;
                      return (
                        <div
                          key={item.value}
                          data-active={isActive ? 'true' : 'false'}
                          className={`rounded-2xl border px-3 py-3 transition ${voiceOptionClass(isActive)}`}
                          data-testid={`audio-voice-option-${id}-${item.value}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-semibold text-[#f4f7fb]">{item.label}</span>
                                {item.favorite ? (
                                  <span className="rounded-full bg-[#2d3d48] px-2 py-0.5 text-[10px] text-[#cce1ff]">收藏</span>
                                ) : null}
                              </div>
                              <div className="mt-1 text-[11px] leading-5 text-[#9faebb]">{item.hint}</div>
                              <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
                                <span className="rounded-full bg-[#2a2d31] px-2 py-0.5 text-[#d9e3ec]">{item.locale}</span>
                                <span className="rounded-full bg-[#2a2d31] px-2 py-0.5 text-[#d9e3ec]">{item.gender}</span>
                                <span className="rounded-full bg-[#233239] px-2 py-0.5 text-[#bceadf]">{item.tone}</span>
                                <span className="rounded-full bg-[#312722] px-2 py-0.5 text-[#ffd9b8]">{item.emotion}</span>
                              </div>
                            </div>
                            <button
                              type="button"
                              onPointerDown={stopCanvasInteraction}
                              onClick={(event) => {
                                stopCanvasClick(event);
                                handleVoicePresetSelect(item.value);
                              }}
                              className={`shrink-0 rounded-full px-4 py-2 text-xs font-semibold transition ${
                                isActive
                                  ? 'bg-[#5a5e65] text-[#ebedf0]'
                                  : 'bg-white text-[#1a1b1d] hover:bg-[#e9edf0] active:scale-[0.99]'
                              }`}
                            >
                              {isActive ? '已选' : '选择'}
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {visibleVoiceOptions.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-[#383d43] px-4 py-6 text-center text-sm text-[#8fa0af]">
                        当前筛选条件下没有可用音色，请换个关键词试试。
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-3 rounded-2xl border border-[#2b3136] bg-[#101315] px-3 py-3 text-[11px] leading-5 text-[#9ca9b6]">
                    <div className="font-medium text-[#eef3f8]">去 AI 感建议</div>
                    <div className="mt-1">优先选择口语自然、带真实呼吸感和停顿的音色，再配合中等语速与更短句的文案，会比纯朗读更像真人。</div>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-xs text-[#c9d2db]">
                  <div className="font-medium text-[#eef4fb]">调节建议</div>
                  <div className="mt-2 text-[11px] leading-5 text-[#93a4b4]">
                    {uiMode === 'bgm'
                      ? 'BGM 建议先用较低强度确定氛围，再逐步提高层次感。'
                      : '音效建议先用中等强度确认质感，再按需要加强冲击力。'}
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {panelTab === 'result' ? (
            <div className="mt-4 space-y-4">
              {renderUrl ? (
                <div className="rounded-2xl border border-[#2d3236] bg-[#111418] px-3 py-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onPointerDown={stopCanvasInteraction}
                      onClick={togglePlayback}
                      className="flex h-10 w-10 items-center justify-center rounded-full bg-[#2c2f35] text-[#f1f5f9] transition hover:bg-[#3b414a]"
                      title={isPlaying ? '暂停音频' : '播放音频'}
                      data-testid={`audio-play-${id}`}
                    >
                      {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-[#f3f7fb]">{previewTitle}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-[#a5b3c1]">
                        <span>{previewModeLabel}</span>
                        <span>{durationText}</span>
                        {sampleRate > 0 ? <span>{sampleRate} Hz</span> : null}
                        {channels > 0 ? <span>{channels} 声道</span> : null}
                        {format ? <span>{format}</span> : null}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <Volume2 className="h-4 w-4 text-[#9aa7b4]" />
                    <input
                      type="range"
                      min={0}
                      max={Math.max(duration || 0, 0.1)}
                      step={0.01}
                      value={Math.min(currentTime, Math.max(duration || 0, 0.1))}
                      onPointerDown={stopCanvasInteraction}
                      onMouseDown={stopCanvasInteraction}
                      onTouchStart={stopCanvasInteraction}
                      onChange={(event) => handleSeek(Number(event.target.value))}
                      className={sliderTrackClass()}
                      aria-label="音频播放进度"
                      data-testid={`audio-progress-${id}`}
                    />
                    <span className="w-24 text-right text-[11px] text-[#b9c4ce]">
                      {`${currentTime.toFixed(1)} / ${Number.isFinite(duration) && duration > 0 ? duration.toFixed(1) : '0.0'}s`}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-[#3d3d3d] bg-[#141619] px-4 py-5 text-sm text-[#98a3ae]">
                  {emptyReason}
                </div>
              )}

              <div className="grid gap-3 md:grid-cols-2">
                <button
                  type="button"
                  data-testid={`audio-save-asset-${id}`}
                  onPointerDown={stopCanvasInteraction}
                  onClick={saveToAssetLibrary}
                  disabled={!renderUrl}
                  className="flex items-center justify-center gap-2 rounded-2xl border border-[#2f6b62] bg-[#10322d] px-4 py-3 text-sm font-medium text-[#b6f1e4] transition hover:bg-[#15403a] disabled:cursor-not-allowed disabled:opacity-40"
                  title="把当前结果加入资产库"
                >
                  <FolderOpen className="h-4 w-4" />
                  {savedAssetId ? '已在资产库' : '加入资产库'}
                </button>

                <button
                  type="button"
                  data-testid={`audio-send-video-${id}`}
                  onPointerDown={stopCanvasInteraction}
                  onClick={reuseToVideoNode}
                  disabled={!renderUrl}
                  className="flex items-center justify-center gap-2 rounded-2xl border border-[#395a8c] bg-[#13233d] px-4 py-3 text-sm font-medium text-[#cce1ff] transition hover:bg-[#193156] disabled:cursor-not-allowed disabled:opacity-40"
                  title="把当前音频挂到视频节点草稿"
                >
                  <Video className="h-4 w-4" />
                  复用到视频节点
                </button>
              </div>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid={`audio-generate-${id}`}
              onPointerDown={stopCanvasInteraction}
              onClick={(event) => {
                stopCanvasClick(event);
                void handleGenerate();
              }}
              disabled={nodeStatus === 'generating'}
              className="flex min-w-[180px] flex-1 items-center justify-center gap-2 rounded-2xl bg-[#00d4aa] px-4 py-3 text-sm font-semibold text-[#07110e] transition hover:bg-[#1ce7bc] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Sparkles className="h-4 w-4" />
              {nodeStatus === 'generating' ? '正在生成音频...' : `生成${previewModeLabel}`}
            </button>
          </div>

          {actionMessage ? (
            <div className="mt-4 rounded-2xl border border-[#244d46] bg-[#0f2622] px-3 py-2.5 text-[11px] text-[#b9efe2]">
              {actionMessage}
            </div>
          ) : null}

          {data?.error ? (
            <div className="mt-4">
              <ErrorDetailBlock category={params.lastErrorCategory} message={data.error} />
            </div>
          ) : null}
        </div>
      ) : null}

      <ModelActivationPrompt
        open={Boolean(activation)}
        mode={activation?.mode || 'audio'}
        provider={activation?.provider || 'DDUp 音频引擎'}
        reason={activation?.reason || 'auth'}
        onClose={() => setActivation(null)}
      />
    </div>
  );
}

const handleLeft: CSSProperties = { left: -9 };
const handleRight: CSSProperties = { right: -9 };

