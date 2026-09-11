# AI Workbench（AI 工作台）

桌面 AI 工作台（macOS / Windows）：一站式聚合 AI 网关（NewAPI）、聊天、画图、修图、笔记、知识库（语雀/WeKnora）、云效 DevOps 与第三方 AI 供应商。

技术栈：**Tauri 2 + React 18 + TypeScript + antd v5 + Tailwind CSS + Zustand + SQLite（tauri-plugin-sql / rusqlite）**

## 功能概览

- **工作**：Chat（多会话/助手/知识库引用/流式思考）、看板（板块可勾选/排序：AI 服务、云效、语雀、知识库、定时任务、常用入口）、笔记（Markdown + 本地草稿）、Agent（多 CLI 编码会话：pi / Claude Code / Codex / OpenCode，公共项目目录，会话级模型切换，上下文/缓存统计，/compact 压缩，技能与 MCP 全局开关，`/` 唤起技能与内置命令）
- **资源**：Skills 技能中心、MCP、知识库（WeKnora 检索）、语雀（个人/自定义域名多连接，文档阅读器 + 表格渲染 + 导出）、TeamLink
- **服务与工具**：云效（项目/工作项/代码库/MR/流水线/报工）、AI 服务（NewAPI 网关 + 供应商额度）、链接、定时任务（提醒/打开链接/Webhook）、WebDAV 自动备份、系统托盘
- **创作工具**：画图（多模型画廊）、修图（内嵌 Photopea + AI 对话改图，多格式导入导出含 PSD）、流程图（Mermaid/PlantUML/draw.io/Excalidraw/SVG + AI 对话画图）、图表（ECharts/AntV + 数据看板 + AI 画图）、表格（Univer 电子表格 + AI 写表）
- **安全**：所有令牌/会话凭证只存本机密钥库（`secrets.db`，0600），密码不落盘；配置存本地 `config.json`，不上传任何远端

## 安装与使用

### macOS

1. 从 [下载页](https://ahao430.github.io/ai-workbench/) 或 [Releases](https://github.com/ahao430/ai-workbench/releases) 下载 `.dmg`
2. 打开 dmg，将 **AI工作台** 拖入 Applications 文件夹
3. 首次打开若提示「无法打开，因为无法验证开发者」或「应用已损坏」——这是 Gatekeeper 隔离属性所致（未公证的应用常见），终端执行：

   ```bash
   xattr -cr "/Applications/AI工作台.app"
   ```

   然后再次打开即可。也可仅移除隔离属性：`xattr -d com.apple.quarantine "/Applications/AI工作台.app"`

4. 首次启动进入初始化向导：AI 渠道（官方订阅或三方中转站，必需）→ 云效 / 语雀（可选可跳过）→ CLI 配置

### Windows

1. 从 [下载页](https://ahao430.github.io/ai-workbench/) 或 [Releases](https://github.com/ahao430/ai-workbench/releases) 下载 `.exe`
2. 双击安装，安装路径默认 `%LOCALAPPDATA%\AI工作台`
3. 若 SmartScreen 拦截（未签名），点「更多信息 → 仍要运行」
4. 首次启动同 macOS 初始化向导

### 自动更新

应用内「检测升级」（托盘右键菜单 / 应用菜单 / 托盘弹窗）从 GitHub Releases 拉取 `latest.json` 比对版本（地址已内置，设置页只读展示）。更新包经 minisign 签名验证（公钥编译进应用，私钥构建时注入）。

## 开发

```bash
npm install          # 安装前端依赖
npm run tauri dev    # 启动桌面应用（开发模式；注意脚本需显式 -- dev）
npm run build        # 前端类型检查 + 构建
cd src-tauri && cargo check / cargo test   # Rust 侧检查与测试
```

## 打包与发布

本地打包：

```bash
npm run tauri build
```

推 `v*` tag 自动构建三平台（Windows x64 NSIS / macOS arm64 dmg / macOS x64 dmg）发布到 GitHub Releases（latest.json 由工作流自动生成）。下载页 `docs/index.html` 通过 GitHub Pages 静态部署：https://ahao430.github.io/ai-workbench/

## 目录结构

```
src/            前端（pages / components / stores / api / db / styles）
src-tauri/      Rust 核心（gateway / yunxiao / yuque / llm / quota / tray / secrets …）
docs/           下载页（纯静态，GitHub Pages 部署：https://ahao430.github.io/ai-workbench/）
website/        下载页源文件（与 docs/ 同步）
docs/           设计与调研文档
```

变更记录见 [CHANGELOG.md](CHANGELOG.md)。
