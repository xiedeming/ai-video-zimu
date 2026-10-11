# 参与贡献

较大的功能调整请先通过 Issue 说明使用场景和方案。

## 开发和验证

使用 Windows x64、Node.js 22+。运行 `npm ci` 安装依赖，`npm run dev` 启动开发界面。真实识别需要按 README 准备工具和模型。

提交前运行 `npm run build`，执行类型检查、测试与生产构建。修改队列和跨进程交互时，可运行 `npm run test:queue-electron`。实际模型性能需另行验证。

## 代码约定

- TypeScript、两空格、单引号、无分号。
- 保持 main、preload、renderer 边界，IPC 输入使用 Zod 校验。
- 保留 Electron 沙箱、上下文隔离与 CSP。
- 测试放在实现旁，命名为 `*.test.ts`；问题修复增加回归测试。
- Commit 使用 Conventional Commit，例如 `fix: preserve subtitle timing`。

## Pull Request

说明用户影响、实现和验证，关联 Issue；界面变化附截图。不要提交模型、原生二进制、媒体、个人项目、密钥、依赖目录和构建输出。日志与截图请先脱敏。

贡献代码按本项目 MIT 许可证分发；引入第三方代码或依赖时保留其声明并更新 THIRD_PARTY_NOTICES.md。
