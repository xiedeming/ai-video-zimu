# 字幕工坊 / Zimu Studio

Windows AI 双语字幕桌面应用。读取视频或音频，使用本地 Whisper 识别日语/英语，再通过内置 Qwen3、本机 OpenAI 兼容服务或云端 API 翻译为简体中文。媒体始终留在本机；只有选择云端翻译配置时，字幕原文才会发送到用户指定的服务。

## 项目定位

字幕工坊面向需要制作日语、英语中文字幕的创作者与学习者，将媒体导入、识别、翻译、校对和字幕导出放在同一个桌面工作区。

当前为早期开发版本（0.1.x），主要支持 Windows x64。本仓库提供源码，模型和原生工具需单独准备。

## 主要功能

- Electron 安全沙箱、context isolation、严格 CSP、自定义本地媒体协议与校验过的 IPC。
- `.zimu` V2 项目保存、V1 自动迁移、自动恢复、最近项目和原媒体重新关联。
- 模型断点下载、SHA-256、手动导入、暂停、删除和状态反馈。
- FFmpeg 音轨提取/真实波形、Whisper JSON+VAD、Qwen3 本地翻译、OpenAI Chat Completions 兼容 API、CUDA/CPU 回退和任务取消。
- 多翻译配置、项目级选择、连接测试、批次检查点；API Key 使用 Electron `safeStorage` 加密且不写入项目文件。
- 双栏编辑器：时间码、原文/中文、搜索替换、低置信度筛选、分割/合并、撤销/重做、单段/全部重译。
- 双语/中文/原文的 SRT、WebVTT、ASS 导出及导出前校验。

## 批量处理

- 每批最多 100 个文件，支持统一参数和逐项覆盖。
- 任务并发可设为 1 或 2；内置本地翻译模型串行复用。
- 支持暂停、继续、取消和重试；暂停仅阻止新任务启动。
- 多项目切换保留编辑、撤销记录与播放位置。
- 识别完成先保存原文；应用重启后，中断任务等待手动继续并重新执行。

详细说明见 [批量处理与恢复](docs/batch-generation.md)。当前不提供自动压制字幕到视频或批量自动导出。

## 使用流程

1. 导入视频或音频，或通过“批量生成字幕”添加多个文件。
2. 在“AI 引擎”中准备模型并选择翻译服务。
3. 生成字幕，在任务中心查看进度。
4. 配合媒体播放校对文本和时间码，保存 .zimu 项目。
5. 导出双语、中文或原文字幕。

## 开发

需要 Windows x64、Node.js 22+、npm 和 Git。GPU 加速取决于显卡、驱动和原生工具版本，也支持 CPU；实际性能取决于模型、媒体长度和硬件。首次下载模型需要网络和足够磁盘空间。

启动开发界面：

```powershell
git clone https://github.com/xiedeming/ai-video-zimu.git
cd ai-video-zimu
npm ci
npm run dev
```

质量检查：

```powershell
npm run typecheck
npm test
npm run build
```

## 本地推理二进制

开发时应用会先查找 `resources/bin/win32-x64`，再回退到系统 `PATH`。打包前运行：

```powershell
npm run prepare:sidecars
npm run verify:sidecars
```

脚本从 whisper.cpp、llama.cpp 官方 GitHub Release 及 BtbN 的 LGPL FFmpeg 构建下载：

- `ffmpeg.exe`、`ffprobe.exe`
- `whisper-cli.exe` 或 `whisper-cli-cpu.exe`
- `llama-server.exe` 或 `llama-server-cpu.exe`
- 对应 CUDA/运行库 DLL

模型不进入安装包，首次启动从官方 Hugging Face 地址下载到 `%LOCALAPPDATA%\ZimuStudio\models`。语音识别可在项目工作区选择默认的 Whisper Large v3 Turbo（快速）或可选的完整 Whisper Large v3（通用高精度）。

模型下载使用 Electron 网络栈，会继承 Windows 系统代理，并依次尝试 Hugging Face 国内镜像和官方源。也可通过环境变量指定企业镜像或代理：

```powershell
$env:ZIMU_MODEL_ENDPOINT = 'https://your-huggingface-compatible-mirror.example'
$env:ZIMU_PROXY = 'http://127.0.0.1:7890'
npm run dev
```

## 翻译 API

在“AI 引擎 → 翻译服务”中新增 OpenAI 兼容配置，需要填写配置名称、Base URL、模型名称和可选 API Key：

- Ollama 示例：`http://127.0.0.1:11434/v1`
- LM Studio 示例：`http://127.0.0.1:1234/v1`
- 翻译服务支持本机、局域网和远程 HTTP/HTTPS 地址；远程服务通常需要 API Key。

Base URL 应填写到 API 版本路径，应用会追加 `/chat/completions`。API Key 仅以 Windows 加密凭据形式保存在应用数据目录，不会进入 `.zimu` 文件或日志。

## 发布

```powershell
npm run dist
```

生成 NSIS x64 安装包。发布前必须补齐 sidecar 文件并复核 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 默认快捷键

- `Space`：播放/暂停（文本输入未聚焦时）
- `←` / `→`：前后跳转 1 秒
- `Ctrl+S`：保存项目
- `Ctrl+Z` / `Ctrl+Y`：撤销/重做


## 技术架构

| 目录 | 职责 |
| --- | --- |
| src/main/ | Electron 主进程、任务队列、模型与媒体服务 |
| src/preload/ | 类型约束的 IPC 桥接 |
| src/renderer/src/ | React 19、TypeScript、Zustand、Tailwind 界面 |
| src/shared/ | Zod 校验、项目类型与字幕工具 |
| scripts/ | 原生工具下载、校验与验收脚本 |

识别使用 whisper.cpp，内置翻译使用 llama.cpp 与 Qwen3，媒体处理使用 FFmpeg。测试使用 Vitest，构建使用 electron-vite。

## 数据与隐私

语音识别在本机执行。选择远程翻译服务后，相关字幕文本与翻译上下文会发送到配置的服务端。模型和工具下载需要访问下载源。

API Key 通过 Electron safeStorage 加密保存。.zimu 项目包含媒体引用和字幕内容，分享前请自行检查；不要向代码仓库提交个人项目、媒体或密钥。

## 参与贡献

欢迎提交问题反馈、修复和功能改进。开发约定见 [贡献指南](CONTRIBUTING.md)。反馈时请提供系统版本、复现步骤及脱敏信息。

## 开源许可

源码采用 [MIT License](LICENSE)。模型、原生工具和其他依赖适用各自许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
