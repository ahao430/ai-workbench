# AGENTS.md — 代码协作约定

给在本仓库工作的 AI 编码代理（ZCode / Claude Code 等）的工程约定。人肉评审同样适用。

## 常用命令

```bash
npm install                 # 前端依赖
npm run tauri dev           # 开发模式（注意：run tauri 后必须显式带 -- dev）
npm run build               # tsc --noEmit + vite build（提交前必过）
npx tsc --noEmit            # 仅类型检查
cd src-tauri
cargo check                 # Rust 编译检查
cargo test                  # 单元测试（保持全绿，新增模块补测试）
```

- 开发时 `tauri dev` 的 watcher 会自动重编译重启：改 `.rs`/`Cargo.toml` 全量重启，改前端 HMR。
- 验证体系：**tsc 零错误 + cargo test 全过** 是合入底线。

## 架构速览

- **前端** `src/`：React 18 + antd v5 + Tailwind(preflight off) + Zustand + React Router。
  - `pages/` 页面、`components/` 组件（按域分子目录）、`stores/` zustand、`api/` IPC 封装、`db/` sqlite 仓储、`styles/` 全局与 markdown 主题。
  - 所有 Rust 调用走 `src/api/ipc.ts` 的 `call()`；错误统一 `AppError { kind, message }`（camelCase），前端用 `errText()` 取文案。
- **Rust** `src-tauri/src/`：按域分模块（`gateway.rs`、`yunxiao.rs`、`yuque.rs`、`quota.rs`、`tray.rs`、`secrets.rs`、`store.rs` 等），命令注册在 `lib.rs`。
  - 外部 HTTP 一律走 Rust（绕 CORS、密钥不进 WebView）。
  - 配置存 `config.json`（AppConfig，serde camelCase，字段加 `#[serde(default)]` 保兼容）；凭证存 `secrets.db`（0600）。

## 强约束（安全与隐私）

1. **凭证永不落日志**：PAT、会话 Cookie、sk- 令牌只存 secrets.db；调试时可以读取使用，但**绝不打印到日志/终端/错误信息**。
2. **密码不落盘**：账号密码只在内存中转（如语雀 md5 摘要提交）。
3. 不得把私有服务域名/凭证硬编码进代码。
4. 用户数据（聊天/笔记/配置）只存本机；不上传任何远端服务。

## 代码约定

- **模型选择器**：选"供应商 + 模型"一律用现成 Cascader 组件 `src/components/ProviderModelSelect.tsx`（`filter="image"` 只列画图模型），**不要**拆成"服务/模型"两个下拉。
- **serde 注意**：`rename` 会同时改序列化与反序列化键。前端要读的字段用 `alias` 兼容原始键。跨 IPC 边界的字段命名要有单测锁定。
- **zustand**：selector 不得返回新建数组/对象（无限重渲染白屏），逐字段取。
- **antd**：受控组件（Collapse/Steps 等）必须接 `onChange`；Modal 受控必接 `onCancel`。受控 Cascader 的 value 路径数组必须按内容 `useMemo`（rc-cascader 的 useActive 依赖 `values[0]` 引用，每次渲染传新数组会让任何重渲染都把展开列重置回已选路径，表现为"选过一次就切不动父级"）；父级节点写死 `isLeaf:false` 时 loadData 每次点击都触发，已加载的节点不要在里面 setState。
- **zsh**：`echo ===`、裸 `==` 会报错；heredoc 内注意引号嵌套；`$VAR` 后紧跟全角字符要写成 `${VAR}`。
- Rust：新公开类型需要 `Debug`；`tauri` 涉及 cookies()/窗口操作的 command 必须 async（Windows 同步死锁）。
- 中文注释说明"为什么"，不是"是什么"。

## 外部 API 备注（踩过的坑）

- **语雀**：会话 Cookie 调不了 `/api/v2`（401），用内部接口（`/api/mine/books`、`/api/docs?book_id=`、`/api/docs/{slug}?mode=markdown|original`）；内部接口需 Chrome UA；限流 100 次/小时，失败串要缓存防重试。表格正文 = `content.sheet` 的 zlib（每字符一字节）。
- **云效**：基址 `openapi-rdc.aliyuncs.com`，头 `x-yunxiao-token`；workitems:search 的 total 在 `x-total` 响应头；报工 effortRecords 是毫秒时间戳且含他人记录（按 owner 过滤）。「我的项目」没有官方过滤接口——projects:search 的 member/mine 等过滤字段会被静默忽略（仍返回全量），只能逐项目 `GET projects/{id}/members` 判定成员。workitems:search 的人员/类型嵌套对象键是 `id`（不是 identifier），靠 serde alias 兼容；conditions 服务端过滤一律 400，perPage 上限 100。
