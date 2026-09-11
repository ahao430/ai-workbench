import { useEffect, useMemo, useState } from 'react'
import { App, Button, Drawer, Empty, Segmented, Spin, Tag, Tree } from 'antd'
import type { DataNode } from 'antd/es/tree'
import { Copy, FolderOpen } from 'lucide-react'
import Markdown from 'react-markdown'
import { errText } from '../../lib/err'
import { skillApi, type SkillDetail } from '../../api/skills'

/** 把扁平相对路径列表构建为 antd 树 */
function buildTree(files: { path: string; isDir: boolean }[]): DataNode[] {
  const root: DataNode[] = []
  const dirIndex = new Map<string, DataNode>()
  for (const f of files) {
    const parts = f.path.split('/')
    let parent = root
    let acc = ''
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part
      const isLeaf = i === parts.length - 1
      if (isLeaf && !f.isDir) {
        parent.push({ key: acc, title: part, isLeaf: true })
        return
      }
      let node = dirIndex.get(acc)
      if (!node) {
        node = { key: acc, title: part, children: [] }
        dirIndex.set(acc, node)
        parent.push(node)
      }
      parent = node.children!
    })
  }
  return root
}

/** 技能详情抽屉：元信息 + 目录结构 + SKILL.md / README.md / 任意文件预览 */
export default function SkillDetailDrawer({
  target,
  onClose,
}: {
  target: { loc: string; name: string } | null
  onClose: () => void
}) {
  const { message } = App.useApp()
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<string>('skill')
  const [fileText, setFileText] = useState('')
  const [fileLoading, setFileLoading] = useState(false)

  useEffect(() => {
    if (!target) return
    setLoading(true)
    setDetail(null)
    setTab('skill')
    skillApi
      .detail(target.loc, target.name)
      .then(setDetail)
      .catch((e) => {
        message.error(errText(e))
        onClose()
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.loc, target?.name])

  const openFile = async (rel: string) => {
    if (!target) return
    setFileLoading(true)
    try {
      setFileText(await skillApi.readFile(target.loc, target.name, rel))
      setTab(`file:${rel}`)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setFileLoading(false)
    }
  }

  const treeData: DataNode[] = useMemo(() => buildTree(detail?.files ?? []), [detail])

  const currentFile = tab.startsWith('file:') ? tab.slice(5) : ''
  const isMd = currentFile.endsWith('.md')

  return (
    <Drawer
      title={detail ? `技能详情 · ${detail.displayName}` : '技能详情'}
      placement="right"
      width={620}
      open={!!target}
      onClose={onClose}
      extra={
        detail && (
          <Button
            size="small"
            icon={<FolderOpen size={13} />}
            onClick={() => void skillApi.reveal(detail.loc, detail.name)}
          >
            打开目录
          </Button>
        )
      }
    >
      <Spin spinning={loading}>
        {!detail ? (
          <Empty description="加载中…" />
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">{detail.displayName}</span>
                <Tag style={{ marginInlineEnd: 0 }}>{detail.name}</Tag>
                {detail.loc !== 'library' && <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{detail.loc}</Tag>}
              </div>
              <p className="m-0 mt-1 text-xs text-gray-500 dark:text-gray-400">
                {detail.description || '（无描述）'}
              </p>
              <p className="m-0 mt-1 truncate font-mono text-[11px] text-gray-400" title={detail.dir}>
                {detail.dir}
              </p>
            </div>

            <div>
              <div className="mb-1 text-xs text-gray-500">目录结构（{detail.files.length} 项）</div>
              <div className="max-h-44 overflow-y-auto rounded-lg border border-black/5 p-1 dark:border-white/10">
                {treeData.length === 0 ? (
                  <span className="text-xs text-gray-400">（空）</span>
                ) : (
                  <Tree
                    showIcon={false}
                    treeData={treeData}
                    defaultExpandAll
                    selectable
                    onSelect={(keys) => {
                      const k = String(keys[0] ?? '')
                      if (k && !detail.files.find((f) => f.path === k)?.isDir) void openFile(k)
                    }}
                  />
                )}
              </div>
            </div>

            <div>
              <Segmented
                size="small"
                value={tab.startsWith('file:') ? 'file' : tab}
                onChange={(v) => setTab(v as string)}
                options={[
                  { label: 'SKILL.md', value: 'skill', disabled: !detail.skillMd },
                  { label: 'README.md', value: 'readme', disabled: !detail.readmeMd },
                  ...(currentFile ? [{ label: currentFile.split('/').pop()!, value: 'file' }] : []),
                ]}
              />
              <Spin spinning={fileLoading}>
                <div className="mt-2 max-h-[46vh] overflow-y-auto rounded-lg border border-black/5 p-3 dark:border-white/10">
                  {tab === 'skill' && detail.skillMd && (
                    <>
                      <div className="mb-1 flex justify-end">
                        <Button
                          size="small"
                          type="text"
                          icon={<Copy size={12} />}
                          onClick={() => {
                            void navigator.clipboard.writeText(detail.skillMd ?? '')
                            message.success('已复制')
                          }}
                        >
                          复制
                        </Button>
                      </div>
                      <div className="text-xs leading-5"><Markdown>{detail.skillMd}</Markdown></div>
                    </>
                  )}
                  {tab === 'readme' && detail.readmeMd && (
                    <div className="text-xs leading-5"><Markdown>{detail.readmeMd}</Markdown></div>
                  )}
                  {tab.startsWith('file:') && (
                    <>
                      <div className="mb-1 truncate font-mono text-[11px] text-gray-400">{currentFile}</div>
                      {isMd ? (
                        <div className="text-xs leading-5"><Markdown>{fileText}</Markdown></div>
                      ) : (
                        <pre className="m-0 whitespace-pre-wrap break-all font-mono text-xs leading-5">{fileText}</pre>
                      )}
                    </>
                  )}
                  {tab === 'skill' && !detail.skillMd && <Empty description="没有 SKILL.md" />}
                </div>
              </Spin>
            </div>
          </div>
        )}
      </Spin>
    </Drawer>
  )
}
