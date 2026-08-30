# 字幕工坊 / Zimu Studio

Windows AI 双语字幕桌面应用。读取视频或音频，使用本地 Whisper 识别日语/英语，再通过内置 Qwen3、本机 OpenAI 兼容服务或云端 API 翻译为简体中文。媒体始终留在本机；只有选择云端翻译配置时，字幕原文才会发送到用户指定的服务。

## 已实现

- Electron 安全沙箱、context isolation、严格 CSP、自定义本地媒体协议与校验过的 IPC。
- `.zimu` V2 项目保存、V1 自动迁移、自动恢复、最近项目和原媒体重新关联。
- 模型断点下载、SHA-256、手动导入、暂停、删除和状态反馈。
- FFmpeg 音轨提取/真实波形、Whisper JSON+VAD、Qwen3 本地翻译、OpenAI Chat Completions 兼容 API、CUDA/CPU 回退和任务取消。
- 多翻译配置、项目级选择、连接测试、批次检查点；API Key 使用 Electron `safeStorage` 加密且不写入项目文件。
- 双栏编辑器：时间码、原文/中文、搜索替换、低置信度筛选、分割/合并、撤销/重做、单段/全部重译。
- 双语/中文/原文的 SRT、WebVTT、ASS 导出及导出前校验。

## 开发

需要 Node.js 22+：

```powershell
npm install
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
