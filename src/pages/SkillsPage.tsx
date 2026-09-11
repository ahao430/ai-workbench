import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { App, Button, Card, Checkbox, Empty, Input, Modal, Popconfirm, Spin, Tabs, Tag } from 'antd'
import {
  Download,
  Eye,
  FolderOpen,
  GitBranch,
  Globe,
  HardDrive,
  Puzzle,
  RefreshCw,
  Star,
} from 'lucide-react'
import { errText } from '../lib/err'
import { skillApi, type RepoSkill, type Skill, type SkillSource, type SkillTarget, type LocalSkill } from '../api/skills'
import SkillDetailDrawer from '../components/skills/SkillDetailDrawer'
import RecommendedPanel from '../components/skills/RecommendedPanel'

const LOCATION_LABEL: Record<string, string> = {
  library: '技能库',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
}

export default function SkillsPage() {
  const { message, modal } = App.useApp()
  // tab 受 URL 控制（#/skills?tab=xxx）
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab = ['mine', 'local'].includes(tabParam ?? '') ? tabParam! : 'mine'
  const [skills, setSkills] = useState<Skill[]>([])
  const [targets, setTargets] = useState<SkillTarget[]>([])
  const [loading, setLoading] = useState(false)
  const [gitUrl, setGitUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [syncFor, setSyncFor] = useState<Skill | null>(null)
  // 技能详情抽屉（我的技能/本机共用）
  const [detailFor, setDetailFor] = useState<{ loc: string; name: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, t] = await Promise.all([skillApi.list(), skillApi.targets()])
      setSkills(s)
      setTargets(t)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const installGit = async () => {
    if (!gitUrl.trim()) return
    setInstalling(true)
    try {
      const names = await skillApi.installGit(gitUrl.trim())
      message.success(`已安装 ${names.length} 个技能：${names.join('、')}`)
      setGitUrl('')
      await load()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setInstalling(false)
    }
  }

  const installLocal = () => {
    const m = modal.info({
      title: '从本地目录安装',
      content: (
        <LocalInstallForm
          onDone={async (path) => {
            try {
              const names = await skillApi.installLocal(path)
              message.success(`已安装 ${names.length} 个技能：${names.join('、')}`)
              m.destroy()
              await load()
            } catch (e) {
              message.error(errText(e))
            }
          }}
        />
      ),
      footer: null,
    })
  }

  const removeSkill = async (s: Skill) => {
    try {
      await skillApi.remove(s.name)
      message.success('已删除')
      await load()
    } catch (e) {
      message.error(errText(e))
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-10">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="m-0 text-lg font-semibold">技能中心</h2>
        <Button icon={<RefreshCw size={14} />} size="small" onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(k) => setSearchParams(k === 'mine' ? {} : { tab: k }, { replace: true })}
        items={[
          {
            key: 'mine',
            label: `我的技能（${skills.length}）`,
            children: (
              <Spin spinning={loading}>
                <Card size="small" className="mb-4" title={<span className="text-sm">安装技能</span>}>
                  <div className="flex items-center gap-2">
                    <Globe size={15} className="shrink-0 text-gray-400" />
                    <Input
                      placeholder="Git 仓库地址（GitHub 等，技能目录或技能集合仓库）"
                      value={gitUrl}
                      onChange={(e) => setGitUrl(e.target.value)}
                      onPressEnter={() => void installGit()}
                    />
                    <Button type="primary" loading={installing} onClick={() => void installGit()} disabled={!gitUrl.trim()}>
                      安装
                    </Button>
                    <Button icon={<FolderOpen size={14} />} onClick={installLocal}>
                      本地目录
                    </Button>
                  </div>
                  <p className="mb-0 mt-2 text-xs text-gray-400">
                    技能格式：目录 + SKILL.md（frontmatter: name / description）。安装后可分发到各 CLI 的技能目录。
                  </p>
                </Card>

                {skills.length === 0 && !loading && (
                  <Empty
                    image={<Puzzle size={44} strokeWidth={1.4} className="mx-auto text-indigo-300" />}
                    description="还没有技能——从精选源 / Git 仓库安装，让 AI 学会更多工作方法"
                  />
                )}

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {skills.map((s) => (
                    <Card
                      key={s.name}
                      size="small"
                      title={<span className="text-sm">{s.displayName}</span>}
                      extra={
                        <div className="flex gap-1.5">
                          <Button
                            size="small"
                            icon={<Eye size={13} />}
                            onClick={() => setDetailFor({ loc: 'library', name: s.name })}
                          >
                            查看
                          </Button>
                          <Button
                            size="small"
                            icon={<FolderOpen size={13} />}
                            title="在访达中打开"
                            onClick={() => void skillApi.reveal('library', s.name)}
                          />
                          <Button size="small" icon={<Download size={13} />} onClick={() => setSyncFor(s)}>
                            分发
                          </Button>
                          <Popconfirm title={`删除技能「${s.displayName}」？将同时移除各 CLI 中的分发。`} onConfirm={() => void removeSkill(s)}>
                            <Button size="small" danger>
                              删除
                            </Button>
                          </Popconfirm>
                        </div>
                      }
                    >
                      <p className="m-0 line-clamp-2 min-h-10 text-xs text-gray-500 dark:text-gray-400">
                        {s.description || '（无描述）'}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        <Tag style={{ marginInlineEnd: 0 }}>{s.name}</Tag>
                        {s.targets.length === 0 ? (
                          <span className="text-xs text-gray-400">未分发</span>
                        ) : (
                          s.targets.map((t) => (
                            <Tag key={t} color="geekblue" style={{ marginInlineEnd: 0 }}>
                              {targets.find((x) => x.id === t)?.label ?? t}
                            </Tag>
                          ))
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              </Spin>
            ),
          },
          {
            key: 'recommended',
            label: '推荐',
            children: <RecommendedPanel installed={skills.map((s) => s.name)} onInstalled={load} />,
          },
          {
            key: 'sources',
            label: '精选源',
            children: <SourcesPanel onInstalled={load} />,
          },
          {
            key: 'local',
            label: '本机',
            children: <LocalSkillsPanel onChanged={load} />,
          },
        ]}
      />

      <SkillDetailDrawer target={detailFor} onClose={() => setDetailFor(null)} />

      {syncFor && (
        <SyncModal
          skill={syncFor}
          targets={targets}
          onClose={() => setSyncFor(null)}
          onSaved={() => {
            setSyncFor(null)
            void load()
          }}
        />
      )}
    </div>
  )
}

// ===== 精选源 =====

function SourcesPanel({ onInstalled }: { onInstalled: () => void }) {
  const { message } = App.useApp()
  const [sources, setSources] = useState<SkillSource[]>([])
  const [browsing, setBrowsing] = useState<SkillSource | null>(null)

  useEffect(() => {
    skillApi
      .sources()
      .then(setSources)
      .catch((e) => message.error(errText(e)))
  }, [])

  return (
    <div>
      <p className="mb-3 text-xs text-gray-400">
        从精选 Git 仓库浏览并选择安装技能（含 Anthropic 官方文档技能 docx / pptx / xlsx / pdf）；也可输入任意仓库地址浏览。
      </p>
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {sources.map((s) => (
          <Card
            key={s.url}
            size="small"
            title={
              <span className="flex items-center gap-2 text-sm">
                <Star size={14} className="shrink-0 text-amber-400" />
                {s.label}
              </span>
            }
            extra={
              <Button size="small" icon={<GitBranch size={13} />} onClick={() => setBrowsing(s)}>
                浏览技能
              </Button>
            }
          >
            <p className="m-0 text-xs text-gray-500 dark:text-gray-400">{s.desc}</p>
            <span className="mt-1.5 block truncate font-mono text-[11px] text-gray-400" title={s.url}>
              {s.url}
            </span>
          </Card>
        ))}
      </div>
      <CustomRepoBrowse onBrowsing={setBrowsing} />
      {browsing && <RepoBrowseModal source={browsing} onClose={() => setBrowsing(null)} onInstalled={onInstalled} />}
    </div>
  )
}

function CustomRepoBrowse({ onBrowsing }: { onBrowsing: (s: SkillSource) => void }) {
  const [url, setUrl] = useState('')
  return (
    <div className="flex items-center gap-2">
      <Globe size={15} className="shrink-0 text-gray-400" />
      <Input
        placeholder="其他 Git 仓库地址（https://…/.git）"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onPressEnter={() => url.trim() && onBrowsing({ url: url.trim(), label: '自定义仓库', desc: '' })}
      />
      <Button disabled={!url.trim()} onClick={() => onBrowsing({ url: url.trim(), label: '自定义仓库', desc: '' })}>
        浏览
      </Button>
    </div>
  )
}

function RepoBrowseModal({
  source,
  onClose,
  onInstalled,
}: {
  source: SkillSource
  onClose: () => void
  onInstalled: () => void
}) {
  const { message } = App.useApp()
  const [items, setItems] = useState<RepoSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    skillApi
      .repoBrowse(source.url)
      .then((v) => {
        setItems(v)
        setSelected(v.map((x) => x.name))
      })
      .catch((e) => {
        message.error(errText(e))
        onClose()
      })
      .finally(() => setLoading(false))
  }, [source.url])

  const install = async () => {
    if (selected.length === 0) {
      message.warning('请选择要安装的技能')
      return
    }
    setInstalling(true)
    try {
      const names = await skillApi.repoInstall(source.url, selected)
      message.success(`已安装 ${names.length} 个技能：${names.join('、')}`)
      onInstalled()
      onClose()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setInstalling(false)
    }
  }

  const allOn = selected.length === items.length && items.length > 0

  return (
    <Modal
      title={`浏览 · ${source.label}`}
      open
      onCancel={onClose}
      onOk={() => void install()}
      confirmLoading={installing}
      okText={`安装选中（${selected.length}）`}
      cancelText="取消"
      width={620}
    >
      <Spin spinning={loading}>
        <div className="mb-2 flex items-center justify-between">
          <span className="truncate font-mono text-[11px] text-gray-400" title={source.url}>
            {source.url}
          </span>
          <Checkbox
            checked={allOn}
            indeterminate={selected.length > 0 && !allOn}
            onChange={(e) => setSelected(e.target.checked ? items.map((x) => x.name) : [])}
          >
            全选
          </Checkbox>
        </div>
        <div className="max-h-[50vh] overflow-y-auto pr-1">
          {items.map((s) => (
            <div key={s.name} className="mb-1 flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/5">
              <Checkbox
                className="mt-0.5"
                checked={selected.includes(s.name)}
                onChange={(e) => setSelected((x) => (e.target.checked ? [...x, s.name] : x.filter((n) => n !== s.name)))}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm">{s.displayName}</div>
                <p className="m-0 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{s.description || '（无描述）'}</p>
              </div>
            </div>
          ))}
        </div>
      </Spin>
    </Modal>
  )
}

// ===== 本机扫描 =====

function LocalSkillsPanel({ onChanged }: { onChanged: () => void }) {
  const { message } = App.useApp()
  const [items, setItems] = useState<LocalSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [detailFor, setDetailFor] = useState<{ loc: string; name: string } | null>(null)

  const scan = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await skillApi.scanLocal())
    } catch (e) {
      message.error(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void scan()
  }, [scan])

  const importOne = async (s: LocalSkill) => {
    const from = s.locations.find((l) => l !== 'library')
    if (!from) return
    setBusy(s.name)
    try {
      await skillApi.importFrom(from, s.name)
      message.success(`已导入「${s.displayName}」到技能库`)
      await scan()
      onChanged()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="m-0 text-xs text-gray-400">
          扫描应用技能库与各 CLI 的技能目录（~/.claude/skills 等）；未入库的技能可导入统一管理。
        </p>
        <Button size="small" icon={<HardDrive size={13} />} onClick={() => void scan()} loading={loading}>
          重新扫描
        </Button>
      </div>
      <Spin spinning={loading}>
        {items.length === 0 && !loading && <Empty description="本机没有发现技能（目录 + SKILL.md）" />}
        <div className="flex flex-col gap-2">
          {items.map((s) => (
            <div
              key={s.name}
              className="flex items-start justify-between gap-3 rounded-lg border border-black/5 px-3 py-2 dark:border-white/10"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="truncate font-medium">{s.displayName}</span>
                  <span className="shrink-0 truncate font-mono text-[11px] text-gray-400">{s.name}</span>
                </div>
                <p className="m-0 mt-0.5 line-clamp-1 text-xs text-gray-500 dark:text-gray-400">{s.description || '（无描述）'}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.locations.map((l) => (
                    <Tag
                      key={l}
                      color={l === 'library' ? 'green' : 'geekblue'}
                      style={{ marginInlineEnd: 0 }}
                    >
                      {LOCATION_LABEL[l] ?? l}
                    </Tag>
                  ))}
                </div>
              </div>
              <span className="flex shrink-0 items-center gap-1.5">
                {!s.inLibrary && (
                  <Button size="small" icon={<Download size={13} />} loading={busy === s.name} onClick={() => void importOne(s)}>
                    导入库
                  </Button>
                )}
                <Button
                  size="small"
                  icon={<Eye size={13} />}
                  title="查看详情"
                  onClick={() => setDetailFor({ loc: s.locations.find((l) => l !== 'library') ?? 'library', name: s.name })}
                />
                <Button
                  size="small"
                  icon={<FolderOpen size={13} />}
                  title="打开所在目录"
                  onClick={() => void skillApi.reveal(s.locations.find((l) => l !== 'library') ?? 'library', s.name)}
                />
              </span>
            </div>
          ))}
        </div>
      </Spin>
      <SkillDetailDrawer target={detailFor} onClose={() => setDetailFor(null)} />
    </div>
  )
}

function LocalInstallForm({ onDone }: { onDone: (path: string) => void }) {
  const [path, setPath] = useState('')
  return (
    <div className="pt-3">
      <Input placeholder="输入技能目录绝对路径" value={path} onChange={(e) => setPath(e.target.value)} />
      <Button type="primary" className="mt-3" disabled={!path.trim()} onClick={() => onDone(path.trim())}>
        安装
      </Button>
    </div>
  )
}

function SyncModal({
  skill,
  targets,
  onClose,
  onSaved,
}: {
  skill: Skill
  targets: SkillTarget[]
  onClose: () => void
  onSaved: () => void
}) {
  const { message } = App.useApp()
  const [selected, setSelected] = useState<string[]>(skill.targets)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await skillApi.sync(skill.name, selected)
      message.success('分发完成')
      onSaved()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`分发「${skill.displayName}」到 CLI`}
      open
      onCancel={onClose}
      onOk={() => void save()}
      confirmLoading={saving}
      okText="应用分发"
      cancelText="取消"
    >
      <p className="mb-3 text-xs text-gray-400">
        macOS 使用软链接（技能更新实时同步）；Windows 使用复制。目标目录不存在时将自动创建。
      </p>
      {targets.map((t) => (
        <div key={t.id} className="mb-2 flex items-center gap-2">
          <Checkbox
            checked={selected.includes(t.id)}
            onChange={(e) =>
              setSelected((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))
            }
          >
            {t.label}
          </Checkbox>
          <span className="truncate font-mono text-xs text-gray-400" title={t.dir}>
            {t.dir}
          </span>
        </div>
      ))}
    </Modal>
  )
}
