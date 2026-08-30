# 本地推理二进制

只缺少媒体处理工具时运行 `npm run prepare:ffmpeg`；准备全部本地推理程序时运行 `npm run prepare:sidecars`。脚本会从上游发布页下载并分别放入子目录，避免运行库冲突：

- `ffmpeg/ffmpeg.exe`, `ffmpeg/ffprobe.exe` 及 FFmpeg DLL
- `whisper/whisper-cli.exe` 及 whisper.cpp CUDA DLL
- `llama/llama-server.exe` 及 llama.cpp CUDA DLL

开发模式也兼容直接放在 `win32-x64/` 的旧布局和系统 `PATH`。也可设置 `ZIMU_FFMPEG_PATH`、`ZIMU_FFPROBE_PATH` 指向已有程序。缺失时应用会给出明确安装提示，不再尝试启动不存在的裸命令。模型不会打进安装包，由应用首次启动下载。
