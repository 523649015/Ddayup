// P1-10 共享常量收敛：local-post / local-image 运行时常量单点导出。
// 从 hmdao-api.mjs 原样搬移（ESM 单例：Map 缓存与安装任务表跨模块共享同一实例，行为零变更）。
import path from 'node:path';
import { APP_DIR, DATA_DIR } from './server-paths.mjs';

export const LOCAL_IMAGE_ANALYSIS_BACKEND_WRAPPERS = {
  florence2: path.resolve(APP_DIR, 'server', 'local_image_florence2_wrapper.mjs'),
  'qwen35-vl': path.resolve(APP_DIR, 'server', 'local_image_qwen35_vl_wrapper.mjs'),
  'qwen37-vl': path.resolve(APP_DIR, 'server', 'local_image_qwen35_vl_wrapper.mjs'),
};

export const LOCAL_POST_BACKEND_WRAPPERS = {
  'fsr-preview': path.resolve(APP_DIR, 'server', 'local_post_fsr_wrapper.mjs'),
  realbasicvsr: path.resolve(APP_DIR, 'server', 'local_post_realbasicvsr_wrapper.mjs'),
  supir: path.resolve(APP_DIR, 'server', 'local_post_supir_wrapper.mjs'),
  ocio: path.resolve(APP_DIR, 'server', 'local_post_ocio_wrapper.mjs'),
  'ocio-managed': path.resolve(APP_DIR, 'server', 'local_post_ocio_managed_wrapper.mjs'),
  oiio: path.resolve(APP_DIR, 'server', 'local_post_oiio_wrapper.mjs'),
  gmic: path.resolve(APP_DIR, 'server', 'local_post_gmic_wrapper.mjs'),
  depth: path.resolve(APP_DIR, 'server', 'local_post_depth_anything_wrapper.mjs'),
};

export const LOCAL_POST_RUNTIME_GUIDES = {
  ocio: {
    runtimeName: 'OpenColorIO Runtime',
    envPath: 'HMDAO_POST_OCIO_PATH',
    envCommand: 'HMDAO_POST_OCIO_COMMAND',
    docsUrl: 'https://opencolorio.org/',
    downloadUrl: 'https://opencolorio.org/downloads.html',
    installHint: '安装 OpenColorIO 后，把可执行脚本或运行时入口写入 HMDAO_POST_OCIO_PATH；如需自定义启动命令可改为 HMDAO_POST_OCIO_COMMAND',
    successHint: '探测成功后，后期节点里的 OCIO Runtime 状态会切换为"外部 Wrapper 已配置"，生成结果会显示真实 OCIO 链路',
    commonInstallPaths: [
      'C:\\Program Files\\OpenColorIO\\bin\\ocioconvert.exe',
      'C:\\Program Files\\OpenColorIO\\bin\\python.exe',
    ],
    supportsImage: true,
    supportsVideo: true,
  },
  oiio: {
    runtimeName: 'OpenImageIO oiiotool',
    envPath: 'HMDAO_POST_OIIO_PATH',
    envCommand: 'HMDAO_POST_OIIO_COMMAND',
    docsUrl: 'https://openimageio.readthedocs.io/en/latest/oiiotool.html',
    downloadUrl: 'https://github.com/OpenImageIO/oiio/releases',
    installHint: '安装 oiiotool 后，将 oiiotool.exe 路径写入 HMDAO_POST_OIIO_PATH。若需要固定 OCIO Config，可额外设置 HMDAO_POST_OIIO_OCIO_CONFIG 的 OCIO',
    successHint: '探测成功后，后期节点里的 OIIO 严格图片调色会显示"已可接管图片调色"，图片调色会优先走 OIIO + OpenColorIO',
    commonInstallPaths: [
      'C:\\Program Files\\OpenImageIO\\bin\\oiiotool.exe',
      'C:\\Users\\<用户名>\\AppData\\Local\\Programs\\OpenImageIO\\bin\\oiiotool.exe',
    ],
    supportsImage: true,
    supportsVideo: false,
  },
  gmic: {
    runtimeName: 'G\'MIC CLI',
    envPath: 'HMDAO_POST_GMIC_PATH',
    envCommand: 'HMDAO_POST_GMIC_COMMAND',
    docsUrl: 'https://gmic.eu/reference.shtml',
    downloadUrl: 'https://gmic.eu/download.html',
    installHint: '安装 G\'MIC CLI 后，优先将 gmic.exe 路径写入 HMDAO_POST_GMIC_PATH；如需自定义前置命令可改为 HMDAO_POST_GMIC_COMMAND',
    successHint: '探测成功后，后期节点里的 G\'MIC Runtime 状态会切换到"图片真实处理已接入"，Bloom / Grain / 细节修复会优先走 G\'MIC',
    commonInstallPaths: [
      'C:\\Program Files\\G-MIC\\gmic.exe',
      'C:\\Program Files\\GMIC\\gmic.exe',
      'C:\\Users\\<用户名>\\AppData\\Local\\Programs\\GMIC\\gmic.exe',
    ],
    supportsImage: true,
    supportsVideo: false,
  },
  ytdlp: {
    runtimeName: 'yt-dlp（YouTube 直链采集）',
    envPath: 'HMDAO_YT_DLP_PATH',
    envCommand: 'HMDAO_YT_DLP_COMMAND',
    docsUrl: 'https://github.com/yt-dlp/yt-dlp',
    downloadUrl: 'https://github.com/yt-dlp/yt-dlp/releases/latest',
    installHint: 'yt-dlp 是浏览器扩展采集 YouTube/B站/抖音等平台直链所依赖的独立命令行工具。点「一键安装」即可从 GitHub 下载最新版 yt-dlp.exe（自带 Python，无需安装环境），下载后后端 /api/youtube/extract 即可工作。',
    successHint: '探测成功后，扩展侧栏采集 YouTube 视频会直接返回可下载的直链，不再报错「后端返回空直链」。',
    commonInstallPaths: [
      'C:\\Users\\<用户名>\\AppData\\Roaming\\Ddayup\\local-post-runtimes\\ytdlp\\current\\yt-dlp.exe',
    ],
    supportsImage: false,
    supportsVideo: true,
  },
  florence2: {
    runtimeName: 'Florence-2 视觉理解（本地免费）',
    envPath: 'HMDAO_FLORENCE2_PATH',
    envCommand: 'HMDAO_FLORENCE2_COMMAND',
    docsUrl: 'https://huggingface.co/microsoft/Florence-2-large',
    downloadUrl: '',
    installHint: 'Florence-2 是微软开源的视觉理解模型，完全在本机运行，不消耗任何云端 token。点「一键安装」将自动创建 Python 虚拟环境、安装 PyTorch / Transformers，并下载 Florence-2-large 权重（约 2.3GB）。安装成功后，所有图片/视频分析都使用真实模型输出，不再使用弱占位描述。',
    successHint: '探测成功后，图片/视频素材分析会输出真实视觉理解（场景、物体、构图、风格等），智能生成与资产库检索质量显著提升。',
    commonInstallPaths: [
      'C:\\Users\\<用户名>\\AppData\\Roaming\\Ddayup\\local-post-runtimes\\florence2\\backend\\local_image_example_florence2.py',
    ],
    supportsImage: true,
    supportsVideo: false,
  },
  'fsr-preview': {
    runtimeName: 'FSR Preview Wrapper',
    envPath: 'HMDAO_POST_FSR_PATH',
    envCommand: 'HMDAO_POST_FSR_COMMAND',
    docsUrl: 'https://gpuopen.com/fidelityfx-superresolution-1/',
    downloadUrl: '',
    installHint: '优先把可执行运行时入口写入 HMDAO_POST_FSR_PATH；如果已有自定义包装命令，可改写 HMDAO_POST_FSR_COMMAND',
    successHint: '探测成功后，后期节点里的高清 Runtime 状态会显示对应 Wrapper 已配置，预览放大可优先走外部链路',
    commonInstallPaths: [],
    supportsImage: true,
    supportsVideo: true,
  },
  realbasicvsr: {
    runtimeName: 'RealBasicVSR Wrapper',
    envPath: 'HMDAO_POST_REALBASICVSR_PATH',
    envCommand: 'HMDAO_POST_REALBASICVSR_COMMAND',
    docsUrl: 'https://github.com/ckkelvinchan/RealBasicVSR',
    downloadUrl: '',
    installHint: '将 RealBasicVSR 的运行入口写入 HMDAO_POST_REALBASICVSR_PATH，或通过 HMDAO_POST_REALBASICVSR_COMMAND 指向你自己的封装命令',
    successHint: '探测成功后，视频高清增强会优先走 RealBasicVSR Wrapper，结果区会显示真实高清链路',
    commonInstallPaths: [],
    supportsImage: false,
    supportsVideo: true,
  },
  supir: {
    runtimeName: 'SUPIR Wrapper',
    envPath: 'HMDAO_POST_SUPIR_PATH',
    envCommand: 'HMDAO_POST_SUPIR_COMMAND',
    docsUrl: 'https://github.com/Fanghua-Yu/SUPIR',
    downloadUrl: '',
    installHint: '将 SUPIR 运行入口写入 HMDAO_POST_SUPIR_PATH，或改用 HMDAO_POST_SUPIR_COMMAND 挂自定义启动命令',
    successHint: '探测成功后，图片高清增强会优先走 SUPIR Wrapper，结果区会显示真实高清链路',
    commonInstallPaths: [],
    supportsImage: true,
    supportsVideo: false,
  },
};

export const EXECUTABLE_DETECTION_CACHE = new Map();
export const LOCAL_POST_RELEASE_CACHE = new Map();
export const LOCAL_POST_RELEASE_TTL_MS = 1000 * 60 * 30;
export const LOCAL_POST_MANAGED_RUNTIME_DIR = path.join(DATA_DIR, 'local-post-runtimes');
export const LOCAL_POST_MANAGED_RUNTIME_MANIFEST_FILE = path.join(LOCAL_POST_MANAGED_RUNTIME_DIR, 'manifest.json');
export const LOCAL_POST_RUNTIME_INSTALL_JOBS = new Map();
export const LOCAL_POST_RUNTIME_INSTALL_JOBS_BY_KEY = new Map();
export const LOCAL_POST_RUNTIME_INSTALL_MAX_HISTORY = 18;
