import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { v4 as uuidv4 } from 'uuid';

export interface Suggestion {
  id: string;
  title: string;
  description: string;
  author: string;
  avatar: string;
  donation: number; // CNY amount
  likes: number;
  likedBy: Set<string>;
  comments: Comment[];
  tags: string[];
  status: 'pending' | 'in-progress' | 'completed' | 'rejected';
  createdAt: number;
}

export interface Comment {
  id: string;
  author: string;
  content: string;
  createdAt: number;
}

export interface DonationState {
  suggestions: Suggestion[];
  showDonationPanel: boolean;
  showWorldChannel: boolean;
  myDonations: number;
  sortBy: 'likes' | 'newest' | 'highest-donation';
  filterTag: string | null;
  currentUserId: string;

  // Actions
  addSuggestion: (title: string, description: string, author: string, donation: number, tags: string[]) => void;
  toggleLike: (suggestionId: string) => void;
  addComment: (suggestionId: string, author: string, content: string) => void;
  updateStatus: (suggestionId: string, status: Suggestion['status']) => void;
  toggleDonationPanel: () => void;
  toggleWorldChannel: () => void;
  setSortBy: (sort: 'likes' | 'newest' | 'highest-donation') => void;
  setFilterTag: (tag: string | null) => void;

  // Getters
  getSortedSuggestions: () => Suggestion[];
  getTopSuggestions: (count: number) => Suggestion[];
  getMySuggestions: () => Suggestion[];
}

const demoSuggestions: Suggestion[] = [
  {
    id: 's1', title: '增加ComfyUI自定义工作流支持', description: '希望能导入自定义的ComfyUI工作流，支持节点模板保存和复用。目前只有预设工作流，灵活性不够。', author: '0x7aB9...', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=1', donation: 88, likes: 234, likedBy: new Set(), comments: [{ id: 'c1', author: '0x4fE2...', content: '非常需要这个功能！已支持', createdAt: Date.now() - 86400000 }], tags: ['功能请求', 'ComfyUI'], status: 'in-progress', createdAt: Date.now() - 604800000,
  },
  {
    id: 's2', title: '支持实时协作编辑画布', description: '多人同时编辑同一个画布，实时看到其他人的操作和光标位置，类似Figma的协作体验。', author: '0x3cD5...', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=2', donation: 128, likes: 189, likedBy: new Set(), comments: [], tags: ['协作', '实时'], status: 'pending', createdAt: Date.now() - 432000000,
  },
  {
    id: 's3', title: '移动端适配优化', description: '目前移动端体验不太好，希望能支持触屏手势操作、响应式布局，方便在iPad上创作。', author: '0x8eA1...', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=3', donation: 50, likes: 156, likedBy: new Set(), comments: [{ id: 'c2', author: '0x7aB9...', content: 'iPad Pro用户强烈支持', createdAt: Date.now() - 172800000 }], tags: ['移动端', 'iPad'], status: 'pending', createdAt: Date.now() - 345600000,
  },
  {
    id: 's4', title: '增加3D模型预览和编辑', description: '在3D世界节点中支持导入GLB/GLTF模型，可以旋转、缩放、添加材质，并能生成3D动画。', author: '0x1bF3...', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=4', donation: 200, likes: 142, likedBy: new Set(), comments: [], tags: ['3D', '模型'], status: 'in-progress', createdAt: Date.now() - 259200000,
  },
  {
    id: 's5', title: '工作流自动优化建议', description: 'AI分析当前画布工作流，给出优化建议，比如节点合并、并行处理、缓存策略等。', author: '0x5dA2...', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=5', donation: 66, likes: 98, likedBy: new Set(), comments: [], tags: ['AI', '优化'], status: 'completed', createdAt: Date.now() - 518400000,
  },
  {
    id: 's6', title: '增加视频关键帧编辑时间线', description: '类似LTX Director的时间线编辑器，可以在视频节点中逐帧编辑、添加关键帧、调整过渡效果。', author: '0x9cE4...', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=6', donation: 150, likes: 87, likedBy: new Set(), comments: [{ id: 'c3', author: '0x3cD5...', content: '这个 urgently needed', createdAt: Date.now() - 86400000 }], tags: ['视频', '时间线'], status: 'pending', createdAt: Date.now() - 172800000,
  },
  {
    id: 's7', title: '插件市场支持第三方开发者', description: '开放插件API，让开发者可以创建自定义节点类型，并在内置的插件市场中发布和售卖。', author: '0x2aB7...', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=7', donation: 300, likes: 76, likedBy: new Set(), comments: [], tags: ['插件', '开发者'], status: 'pending', createdAt: Date.now() - 129600000,
  },
  {
    id: 's8', title: 'AI Agent自动化画布生成', description: 'Agent可以根据简单的文字描述自动生成完整的多节点画布，包括节点类型选择、参数设置、节点连接。', author: '0x6fD3...', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=8', donation: 100, likes: 201, likedBy: new Set(), comments: [{ id: 'c4', author: '0x8eA1...', content: '这和Agent功能配合起来会很强大', createdAt: Date.now() - 43200000 }], tags: ['Agent', 'AI'], status: 'in-progress', createdAt: Date.now() - 86400000,
  },
];

const currentUserId = 'user_' + Math.random().toString(36).substring(7);

export const useDonationStore = create<DonationState>()(
  immer((set, get) => ({
    suggestions: demoSuggestions,
    showDonationPanel: false,
    showWorldChannel: false,
    myDonations: 0,
    sortBy: 'likes',
    filterTag: null,
    currentUserId,

    addSuggestion: (title, description, author, donation, tags) => {
      set((state) => {
        const newSuggestion: Suggestion = {
          id: uuidv4(),
          title,
          description,
          author,
          avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${Math.random().toString(36).substring(7)}`,
          donation,
          likes: 0,
          likedBy: new Set(),
          comments: [],
          tags,
          status: 'pending',
          createdAt: Date.now(),
        };
        state.suggestions.unshift(newSuggestion);
        state.myDonations += donation;
        state.showDonationPanel = false;
      });
    },

    toggleLike: (suggestionId) => {
      set((state) => {
        const s = state.suggestions.find((i) => i.id === suggestionId);
        if (!s) return;
        if (s.likedBy.has(state.currentUserId)) {
          s.likedBy.delete(state.currentUserId);
          s.likes--;
        } else {
          s.likedBy.add(state.currentUserId);
          s.likes++;
        }
      });
    },

    addComment: (suggestionId, author, content) => {
      set((state) => {
        const s = state.suggestions.find((i) => i.id === suggestionId);
        if (!s) return;
        s.comments.push({ id: uuidv4(), author, content, createdAt: Date.now() });
      });
    },

    updateStatus: (suggestionId, status) => {
      set((state) => {
        const s = state.suggestions.find((i) => i.id === suggestionId);
        if (s) s.status = status;
      });
    },

    toggleDonationPanel: () => {
      set((state) => { state.showDonationPanel = !state.showDonationPanel; });
    },

    toggleWorldChannel: () => {
      set((state) => { state.showWorldChannel = !state.showWorldChannel; });
    },

    setSortBy: (sort) => {
      set((state) => { state.sortBy = sort; });
    },

    setFilterTag: (tag) => {
      set((state) => { state.filterTag = tag; });
    },

    getSortedSuggestions: () => {
      const state = get();
      let items = state.suggestions;
      if (state.filterTag) {
        items = items.filter((i) => i.tags.includes(state.filterTag!));
      }
      const sorted = [...items];
      switch (state.sortBy) {
        case 'likes':
          return sorted.sort((a, b) => b.likes - a.likes);
        case 'newest':
          return sorted.sort((a, b) => b.createdAt - a.createdAt);
        case 'highest-donation':
          return sorted.sort((a, b) => b.donation - a.donation);
        default:
          return sorted;
      }
    },

    getTopSuggestions: (count) => {
      return [...get().suggestions].sort((a, b) => b.likes - a.likes).slice(0, count);
    },

    getMySuggestions: () => {
      return get().suggestions.filter((s) => s.author === get().currentUserId);
    },
  }))
);
