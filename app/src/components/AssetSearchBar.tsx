/**
 * HMDao 增强搜索栏
 * - 语法高亮 (tag: type: category: -排除 "精确")
 * - 实时搜索建议下拉
 * - 搜索历史
 * - 拼音支持提示
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Search, X, Clock, Tag, Folder, ChevronRight,
  Image as ImageIcon, Video, Music, FileText,
} from 'lucide-react';
import { getSearchSuggestions, parseSearchQuery } from '@/services/assetSearchService';
import type { SearchSuggestion } from '@/services/assetSearchService';
import type { AssetItem } from '@/types/assets';

interface AssetSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: (query: string) => void;
  allItems: AssetItem[];
  placeholder?: string;
  className?: string;
}

const MAX_HISTORY = 20;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem('hmdao_search_history');
    return raw ? (JSON.parse(raw) as string[]).slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(history: string[]) {
  try {
    localStorage.setItem('hmdao_search_history', JSON.stringify(history.slice(0, MAX_HISTORY)));
  } catch { /* ignore */ }
}

export function AssetSearchBar({
  value,
  onChange,
  onSearch,
  allItems,
  placeholder = '搜索素材、标签、来源…',
  className = '',
}: AssetSearchBarProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 解析后的语法高亮
  const parsed = useMemo(() => {
    if (!value.trim()) return null;
    return parseSearchQuery(value);
  }, [value]);

  // 搜索建议
  const suggestions = useMemo<SearchSuggestion[]>(() => {
    if (!value.trim() || value.length < 1) return [];
    return getSearchSuggestions(allItems, value, history, 8);
  }, [value, allItems, history]);

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // 保存到历史
    const newHistory = [trimmed, ...history.filter((h) => h !== trimmed)].slice(0, MAX_HISTORY);
    setHistory(newHistory);
    saveHistory(newHistory);

    onSearch(trimmed);
    setShowDropdown(false);
  }, [value, history, onSearch]);

  const handleSelectSuggestion = useCallback(
    (text: string) => {
      onChange(text);
      const newHistory = [text, ...history.filter((h) => h !== text)].slice(0, MAX_HISTORY);
      setHistory(newHistory);
      saveHistory(newHistory);
      onSearch(text);
      setShowDropdown(false);
    },
    [history, onChange, onSearch],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedSuggestionIndex >= 0 && suggestions[selectedSuggestionIndex]) {
          handleSelectSuggestion(suggestions[selectedSuggestionIndex].text);
        } else {
          handleSubmit();
        }
      } else if (e.key === 'Escape') {
        setShowDropdown(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedSuggestionIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedSuggestionIndex((prev) => Math.max(prev - 1, -1));
      }
    },
    [selectedSuggestionIndex, suggestions, handleSelectSuggestion, handleSubmit],
  );

  const hasGrammarFeatures = parsed && (
    parsed.tags.length > 0 ||
    parsed.categories.length > 0 ||
    parsed.types.length > 0 ||
    parsed.exactPhrases.length > 0 ||
    parsed.excludeTerms.length > 0
  );

  const suggestionIcon = (type: SearchSuggestion['type']) => {
    switch (type) {
      case 'history': return <Clock className="w-3 h-3 text-[#6e7681]" />;
      case 'tag': return <Tag className="w-3 h-3 text-[#00d4aa]" />;
      case 'category': return <Folder className="w-3 h-3 text-[#1a8cff]" />;
      default: return <Search className="w-3 h-3 text-[#6e7681]" />;
    }
  };

  return (
    <div className={`relative ${className}`}>
      {/* 搜索输入框 */}
      <div
        className={`flex items-center gap-2 rounded-xl border transition-all duration-200 bg-[#0d1117] px-3 ${
          isFocused
            ? 'border-[#00d4aa] ring-1 ring-[#00d4aa]/20'
            : 'border-[#30363d] hover:border-[#484f58]'
        } ${hasGrammarFeatures ? 'border-[#1a8cff]/50 ring-1 ring-[#1a8cff]/10' : ''}`}
      >
        <Search className={`w-3.5 h-3.5 shrink-0 ${isFocused ? 'text-[#00d4aa]' : 'text-[#6e7681]'}`} />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setShowDropdown(true);
            setSelectedSuggestionIndex(-1);
          }}
          onFocus={() => {
            setIsFocused(true);
            if (value.trim()) setShowDropdown(true);
          }}
          onBlur={() => setIsFocused(false)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-[#e6edf3] text-xs outline-none py-2 min-w-0 placeholder:text-[#5a5a5c]"
          aria-label="搜索素材"
        />
        {value && (
          <button
            onClick={() => {
              onChange('');
              setShowDropdown(false);
            }}
            className="text-[#6e7681] hover:text-[#c9d1d9] shrink-0 transition-colors"
            aria-label="清除搜索"
          >
            <X className="w-3 h-3" />
          </button>
        )}
        {/* 语法提示按钮 */}
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className={`w-5 h-5 rounded flex items-center justify-center shrink-0 text-[10px] font-mono transition-colors ${
            hasGrammarFeatures
              ? 'bg-[#1a8cff]/20 text-[#1a8cff]'
              : 'bg-[#21262d] text-[#6e7681] hover:text-[#c9d1d9]'
          }`}
          title={`搜索语法：tag:标签 category:分类 type:image|video -排除 "精确短语"`}
        >
          ?
        </button>
      </div>

      {/* 语法提示横幅 */}
      {hasGrammarFeatures && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {parsed.tags.map((tag) => (
            <span key={`tag-${tag}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[#00d4aa]/15 text-[#00d4aa] text-[10px] border border-[#00d4aa]/20">
              <Tag className="w-2.5 h-2.5" />标签:{tag}
            </span>
          ))}
          {parsed.categories.map((cat) => (
            <span key={`cat-${cat}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[#1a8cff]/15 text-[#1a8cff] text-[10px] border border-[#1a8cff]/20">
              <Folder className="w-2.5 h-2.5" />分类:{cat}
            </span>
          ))}
          {parsed.types.map((type) => (
            <span key={`type-${type}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[#f59e0b]/15 text-[#f59e0b] text-[10px] border border-[#f59e0b]/20">
              {type === 'image' ? <ImageIcon className="w-2.5 h-2.5" /> : type === 'video' ? <Video className="w-2.5 h-2.5" /> : type === 'audio' ? <Music className="w-2.5 h-2.5" /> : <FileText className="w-2.5 h-2.5" />}
              {type}
            </span>
          ))}
          {parsed.exactPhrases.map((phrase) => (
            <span key={`exact-${phrase}`} className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-[#f85149]/10 text-[#f85149] text-[10px] border border-[#f85149]/15">
              "{phrase}"
            </span>
          ))}
          {parsed.excludeTerms.map((term) => (
            <span key={`excl-${term}`} className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-[#f85149]/10 text-[#ff9b9b] text-[10px] border border-[#f85149]/15">
              排除:{term}
            </span>
          ))}
        </div>
      )}

      {/* 搜索建议下拉 */}
      {showDropdown && suggestions.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute top-full left-0 right-0 mt-1.5 rounded-xl border border-[#30363d] bg-[#161b22] shadow-2xl overflow-hidden z-50"
        >
          {/* 语法提示 */}
          <div className="px-3 py-1.5 border-b border-[#21262d] flex flex-wrap gap-2 text-[10px] text-[#6e7681]">
            <span className="text-[#00d4aa]">tag:标签</span>
            <span className="text-[#1a8cff]">category:分类</span>
            <span className="text-[#f59e0b]">type:image|video</span>
            <span className="text-[#f85149]">-排除词</span>
            <span>"精确匹配"</span>
          </div>

          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.type}-${suggestion.text}`}
              onClick={() => handleSelectSuggestion(suggestion.text)}
              onMouseEnter={() => setSelectedSuggestionIndex(index)}
              className={`flex items-center gap-2.5 w-full px-3 py-2 text-xs transition-colors ${
                index === selectedSuggestionIndex
                  ? 'bg-[#1a8cff]/10 text-[#e6edf3]'
                  : 'text-[#c9d1d9] hover:bg-[#21262d]'
              }`}
            >
              {suggestionIcon(suggestion.type)}
              <span className="flex-1 text-left truncate">{suggestion.text}</span>
              {suggestion.count > 0 && (
                <span className="text-[10px] text-[#6e7681] shrink-0">{suggestion.count}个</span>
              )}
              <span className="text-[10px] text-[#6e7681] shrink-0">
                {suggestion.type === 'history' ? '历史' : suggestion.type === 'tag' ? '标签' : '分类'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
