/**
 * 推荐技能：按类型（办公/开发/设计/写作）策展的技能目录。
 * 条目来自精选源仓库中的具体技能，安装复用 repoInstall（浅克隆整仓 + 按名提取），
 * 已安装（技能库同名）自动标记，避免重复装。
 */
import { useMemo, useState } from 'react'
import { App, Button, Empty, Segmented, Tag } from 'antd'
import { CheckCircle2, Download } from 'lucide-react'
import { errText } from '../../lib/err'
import { skillApi } from '../../api/skills'

interface RecSkill {
  /** 仓库内技能目录名（= 安装后的技能名） */
  name: string
  desc: string
  repo: string
  cat: string
}

const REPOS: Record<string, { url: string; label: string }> = {
  anthropics: { url: 'https://github.com/anthropics/skills.git', label: 'Anthropic 官方' },
  superpowers: { url: 'https://github.com/obra/superpowers.git', label: 'Superpowers' },
  baoyu: { url: 'https://github.com/JimLiu/baoyu-skills.git', label: '宝玉技能集' },
}

const CATALOG: RecSkill[] = [
  // ===== 办公 =====
  { name: 'docx', desc: 'Word 文档创建、编辑与内容提取', repo: 'anthropics', cat: '办公' },
  { name: 'pptx', desc: '制作与修改 PowerPoint 演示文稿', repo: 'anthropics', cat: '办公' },
  { name: 'xlsx', desc: 'Excel 表格处理、公式与数据分析', repo: 'anthropics', cat: '办公' },
  { name: 'pdf', desc: 'PDF 文本提取、表单填写与拆分合并', repo: 'anthropics', cat: '办公' },
  { name: 'doc-coauthoring', desc: '文档协同撰写与修订流程', repo: 'anthropics', cat: '办公' },
  { name: 'internal-comms', desc: '公司内部沟通文案（周报/公告等）', repo: 'anthropics', cat: '办公' },
  { name: 'baoyu-translate', desc: '高质量中英互译，保留原文排版', repo: 'baoyu', cat: '办公' },
  { name: 'baoyu-format-markdown', desc: 'Markdown 中文排版整理', repo: 'baoyu', cat: '办公' },
  { name: 'baoyu-url-to-markdown', desc: '网页内容抓取并转为 Markdown', repo: 'baoyu', cat: '办公' },
  { name: 'baoyu-youtube-transcript', desc: '拉取 YouTube 视频字幕转录', repo: 'baoyu', cat: '办公' },
  { name: 'baoyu-post-to-wechat', desc: '发布文章到微信公众号', repo: 'baoyu', cat: '办公' },
  // ===== 开发 =====
  { name: 'test-driven-development', desc: '红-绿-重构的 TDD 全流程约束', repo: 'superpowers', cat: '开发' },
  { name: 'systematic-debugging', desc: '系统化定位根因再修复', repo: 'superpowers', cat: '开发' },
  { name: 'verification-before-completion', desc: '声明完成前先跑验证', repo: 'superpowers', cat: '开发' },
  { name: 'brainstorming', desc: '动手前把需求想清楚', repo: 'superpowers', cat: '开发' },
  { name: 'writing-plans', desc: '产出可执行的实施计划', repo: 'superpowers', cat: '开发' },
  { name: 'executing-plans', desc: '按计划逐项落地开发', repo: 'superpowers', cat: '开发' },
  { name: 'subagent-driven-development', desc: '子代理分工驱动开发', repo: 'superpowers', cat: '开发' },
  { name: 'requesting-code-review', desc: '规范化提交代码评审', repo: 'superpowers', cat: '开发' },
  { name: 'receiving-code-review', desc: '正确消化评审意见', repo: 'superpowers', cat: '开发' },
  { name: 'using-git-worktrees', desc: 'worktree 并行多任务开发', repo: 'superpowers', cat: '开发' },
  { name: 'finishing-a-development-branch', desc: '分支收尾：合并/清理/交付', repo: 'superpowers', cat: '开发' },
  { name: 'writing-skills', desc: '编写高质量的新技能', repo: 'superpowers', cat: '开发' },
  { name: 'mcp-builder', desc: '构建 MCP 服务器的脚手架指导', repo: 'anthropics', cat: '开发' },
  { name: 'webapp-testing', desc: '浏览器自动化测试 Web 应用', repo: 'anthropics', cat: '开发' },
  { name: 'claude-api', desc: 'Claude API / SDK 集成开发', repo: 'anthropics', cat: '开发' },
  { name: 'skill-creator', desc: '为自己创建新技能的标准流程', repo: 'anthropics', cat: '开发' },
  // ===== 设计 =====
  { name: 'canvas-design', desc: '海报 / 视觉图的画布式设计', repo: 'anthropics', cat: '设计' },
  { name: 'frontend-design', desc: '产品级前端界面设计（可用性优先）', repo: 'anthropics', cat: '设计' },
  { name: 'brand-guidelines', desc: '按品牌视觉规范出稿', repo: 'anthropics', cat: '设计' },
  { name: 'theme-factory', desc: '批量生成主题化样式', repo: 'anthropics', cat: '设计' },
  { name: 'algorithmic-art', desc: '生成艺术 / 程序化创作', repo: 'anthropics', cat: '设计' },
  { name: 'web-artifacts-builder', desc: '构建复杂的多文件 Web 产物', repo: 'anthropics', cat: '设计' },
  { name: 'baoyu-cover-image', desc: '为文章生成封面图', repo: 'baoyu', cat: '设计' },
  { name: 'baoyu-infographic', desc: '生成结构化信息图', repo: 'baoyu', cat: '设计' },
  { name: 'baoyu-diagram', desc: '生成讲解型图解', repo: 'baoyu', cat: '设计' },
  { name: 'baoyu-comic', desc: '生成四格 / 条漫式漫画', repo: 'baoyu', cat: '设计' },
  { name: 'baoyu-slide-deck', desc: '生成演示幻灯片', repo: 'baoyu', cat: '设计' },
  { name: 'baoyu-xhs-images', desc: '生成小红书风格图片', repo: 'baoyu', cat: '设计' },
  { name: 'baoyu-image-gen', desc: 'AI 图像生成', repo: 'baoyu', cat: '设计' },
  { name: 'baoyu-article-illustrator', desc: '为长文自动配插图', repo: 'baoyu', cat: '设计' },
]

const CATS = ['全部', '办公', '开发', '设计'] as const

export default function RecommendedPanel({
  installed,
  onInstalled,
}: {
  installed: string[]
  onInstalled: () => void
}) {
  const { message } = App.useApp()
  const [cat, setCat] = useState<string>('全部')
  const [busy, setBusy] = useState<string | null>(null)

  const list = useMemo(() => (cat === '全部' ? CATALOG : CATALOG.filter((s) => s.cat === cat)), [cat])
  const has = (name: string) => installed.includes(name)

  const install = async (s: RecSkill) => {
    setBusy(s.name)
    try {
      await skillApi.repoInstall(REPOS[s.repo].url, [s.name])
      message.success(`已安装 ${s.name}`)
      onInstalled()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <p className="mb-3 text-xs text-gray-400">
        按类型精选的推荐技能，来自上方精选源仓库；点击安装会拉取所在仓库并提取该技能，已安装的自动标记。
      </p>
      <Segmented
        size="small"
        className="mb-3"
        value={cat}
        onChange={(v) => setCat(v as string)}
        options={CATS.map((c) => ({ value: c, label: c === '全部' ? `全部（${CATALOG.length}）` : c }))}
      />
      {list.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该分类暂无推荐" />
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {list.map((s) => {
            const done = has(s.name)
            return (
              <div
                key={s.name}
                className="flex items-start gap-2.5 rounded-lg border border-black/5 bg-white px-3 py-2.5 shadow-sm dark:border-white/10 dark:bg-white/5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    <Tag color="default" style={{ marginInlineEnd: 0 }}>
                      {REPOS[s.repo].label}
                    </Tag>
                  </div>
                  <p className="m-0 mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{s.desc}</p>
                </div>
                {done ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-500">
                    <CheckCircle2 size={13} />
                    已安装
                  </span>
                ) : (
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    icon={<Download size={12} />}
                    loading={busy === s.name}
                    onClick={() => void install(s)}
                  >
                    安装
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
