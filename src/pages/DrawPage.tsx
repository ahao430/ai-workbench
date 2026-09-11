import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Badge, Button, Drawer, Empty, Image, Input, InputNumber, Modal, Pagination, Popover, Segmented, Select, Spin, Switch, Tag, Tooltip } from 'antd'
import { BookOpen, Copy, Globe, ImagePlus, LayoutTemplate, Settings2, SlidersHorizontal, Sparkles, Wand2, X } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { errText } from '../lib/err'
import { drawSaveRef, editImage, fetchPromptCases, generateImage, listModels, llmComplete, type PromptCase } from '../api/chat'
import { kbApi, type KbState } from '../api/kb'
import { parseKbEntryIds } from '../db/chats'
import { capabilityRepo } from '../db/providers'
import { useDrawStore } from '../stores/draw'
import { useAiServices, type AiService } from '../hooks/useAiServices'
import { resolveCapability, autoCapability, type AutoCapability } from '../lib/capability'
import ProviderModelSelect, { type CascadeValue } from '../components/ProviderModelSelect'
import { isTauri } from '../api/ipc'

const SIZES = ['auto', '1024x1024', '1792x1024', '1024x1792', '1280x720', '720x1280']

/** 画图会话页：会话/草稿/生成状态在全局 store——切菜单不丢，回来继续 */
export default function DrawPage() {
  const { message } = App.useApp()
  // 全局保留的状态
  const init = useDrawStore((s) => s.init)
  const sessions = useDrawStore((s) => s.sessions)
  const currentId = useDrawStore((s) => s.currentId)
  const historyMap = useDrawStore((s) => s.history)
  const drafts = useDrawStore((s) => s.drafts)
  const size = useDrawStore((s) => s.size)
  const count = useDrawStore((s) => s.count)
  const generating = useDrawStore((s) => s.generating)
  const patchSession = useDrawStore((s) => s.patchSession)
  const setSessionKb = useDrawStore((s) => s.setSessionKb)
  const setDraft = useDrawStore((s) => s.setDraft)
  const setParam = useDrawStore((s) => s.setParam)
  const setGenerating = useDrawStore((s) => s.setGenerating)
  const recordDraw = useDrawStore((s) => s.recordDraw)

  const current = sessions.find((x) => x.id === currentId) ?? null
  // 会话级知识库：开关 + 多选（存会话行；entryIds 空 = 全部已启用条目）
  const kbEntryIds = useMemo(() => (current ? parseKbEntryIds(current) : []), [current])
  const [kbState, setKbState] = useState<KbState>({ apis: [], entries: [] })
  useEffect(() => {
    if (!isTauri) return
    void kbApi
      .getConfig()
      .then(setKbState)
      .catch(() => {})
  }, [])
  const kbOptions = kbState.apis
    .map((api) => ({
      label: api.name,
      title: api.name,
      options: kbState.entries
        .filter((e) => e.apiId === api.id)
        .map((e) => ({ value: e.id, label: e.enabled ? e.name : `${e.name}（停用）` })),
    }))
    .filter((g) => g.options.length > 0)
  const draft = currentId ? (drafts[currentId] ?? { prompt: '', refs: [] }) : { prompt: '', refs: [] }
  const prompt = draft.prompt
  const refs = draft.refs

  // 公共配置：画图模型 + 文本模型（两组独立联动，可为不同供应商；localStorage 持久化）
  const { services } = useAiServices()
  const loadSel = (k: string): CascadeValue => {
    try {
      return { serviceKey: null, model: null, ...(JSON.parse(localStorage.getItem(k) ?? '{}') as Partial<CascadeValue>) }
    } catch {
      return { serviceKey: null, model: null }
    }
  }
  const [imageSel, setImageSel] = useState<CascadeValue>(() => loadSel('aw-draw-image'))
  const [textSel, setTextSel] = useState<CascadeValue>(() => loadSel('aw-draw-text'))
  const saveSel = (k: string, v: CascadeValue) => localStorage.setItem(k, JSON.stringify(v))
  // 生效的画图服务：会话覆盖 → 公共画图配置
  const activeImageKey = current?.providerKey || imageSel.serviceKey
  const activeImageSvc: AiService | null = services.find((x) => x.key === activeImageKey) ?? null
  const activeImageModel = current?.model || imageSel.model
  const textSvc: AiService | null = services.find((x) => x.key === textSel.serviceKey) ?? null
  const [manageOpen, setManageOpen] = useState(false)
  const [cfgOpen, setCfgOpen] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [templateDraft, setTemplateDraft] = useState('')
  // 图生图：编辑某张历史图（images/edits）
  const [editFor, setEditFor] = useState<{ path: string; prompt: string; size: string } | null>(null)
  // 图片预览：查看大图 + 提示词
  const [preview, setPreview] = useState<{ path: string; draw: (typeof history)[number] } | null>(null)
  // 提示词模板抽屉
  const [promptOpen, setPromptOpen] = useState(false)
  const [cases, setCases] = useState<PromptCase[]>([])
  const [casesLoading, setCasesLoading] = useState(false)
  const [casePage, setCasePage] = useState(0)
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!isTauri) return
    void init()
  }, [init])

  // 会话级画图模型联动（覆盖公共配置；providerKey + model 都写会话）
  const model = activeImageModel
  const [callMode, setCallMode] = useState<'images' | 'chat'>('images')
  useEffect(() => {
    if (!activeImageKey || !model) return
    let alive = true
    void resolveCapability(activeImageKey, model, capabilityRepo.get).then((cap) => {
      if (alive) setCallMode(cap.isImage ? cap.callMode : 'images')
    })
    return () => {
      alive = false
    }
  }, [activeImageKey, model])

  /** 知识库检索注入提示词 */
  const buildPrompt = useCallback(
    async (template: string, promptText: string, kbOn: boolean, entryIds: string[]): Promise<string> => {
      const base = template.trim() ? `${template.trim()}\n\n${promptText.trim()}` : promptText.trim()
      if (!kbOn) return base
      try {
        const chunks = await kbApi.search(promptText.trim(), 3, entryIds.length ? entryIds : undefined)
        if (chunks.length) {
          const refText = chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n---\n')
          return `${base}\n\n参考资料：\n${refText}`
        }
      } catch {
        message.warning('知识库检索失败，已按原始提示词生成')
      }
      return base
    },
    [message],
  )

  const addRefFiles = async (files: FileList | null) => {
    if (!files?.length || !currentId) return
    for (const f of Array.from(files).slice(0, 8 - refs.length)) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result))
          r.onerror = () => reject(r.error)
          r.readAsDataURL(f)
        })
        const path = await drawSaveRef(dataUrl)
        setDraft(currentId, { refs: [...refs, path] })
      } catch (e) {
        message.error(errText(e))
      }
    }
  }

  /** 优化提示词：走公共文本模型配置（可与画图模型不同供应商） */
  const optimizePrompt = async () => {
    if (!textSvc || !textSel.model) {
      message.warning('请先在「公共配置」中选择文本模型')
      return
    }
    if (!prompt.trim()) return
    setOptimizing(true)
    try {
      const better = await llmComplete({
        spec: textSvc.spec,
        model: textSel.model,
        system:
          '你是画图提示词专家。把用户的简短描述扩写为高质量图像生成提示词：补充主体细节、风格、构图、光线与画质词。只输出优化后的提示词本身，不要解释。',
        prompt: prompt.trim(),
        temperature: 0.7,
      })
      if (better.trim() && currentId) setDraft(currentId, { prompt: better.trim() })
    } catch (e) {
      message.error(errText(e))
    } finally {
      setOptimizing(false)
    }
  }

  const generate = async () => {
    if (!activeImageSvc || !model) {
      message.warning('请先选择画图模型（公共配置或会话级，可在「管理能力」手动标记）')
      return
    }
    if (!prompt.trim() || !current || !currentId) return
    setGenerating(true)
    try {
      const base = await buildPrompt(current.template, prompt, current.kbEnabled === 1, kbEntryIds)
      const finalPrompt = current.webEnabled === 1 ? `${base}\n\n（要求：结合最新网络信息创作）` : base
      const paths = await generateImage({
        spec: activeImageSvc.spec,
        model,
        prompt: finalPrompt,
        size,
        n: count,
        callMode,
        refs,
      })
      await recordDraw({
        id: crypto.randomUUID(),
        sessionId: currentId,
        providerKey: activeImageKey ?? '',
        model,
        prompt: prompt.trim(),
        size,
        refs: JSON.stringify(refs),
        images: JSON.stringify(paths),
      })
      message.success('生成完成')
    } catch (e) {
      message.error(errText(e))
    } finally {
      setGenerating(false)
    }
  }

  const history = currentId ? (historyMap[currentId] ?? []) : []
  const imageCards = useMemo(
    () =>
      [...history].reverse().flatMap((d) => {
        let paths: string[] = []
        try {
          paths = JSON.parse(d.images) as string[]
        } catch {
          /* ignore */
        }
        return paths.map((p) => ({ key: `${d.id}-${p}`, draw: d, path: p }))
      }),
    [history],
  )

  if (!isTauri) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty description="画图功能需在桌面应用内使用" />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* 画廊 + 参数 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 公共配置入口：按钮 + 当前摘要，点击弹窗配置 */}
        <div className="flex items-center gap-2 border-b border-black/5 px-4 py-1.5 dark:border-white/10">
          <Button size="small" icon={<SlidersHorizontal size={13} />} onClick={() => setCfgOpen(true)}>
            公共配置
          </Button>
          <span className="truncate text-xs text-gray-400">
            画图 {activeImageSvc?.label ?? '未选'}{activeImageModel ? ` · ${activeImageModel}` : ''}
            {'　'}文本 {textSvc?.label ?? '未选'}{textSel.model ? ` · ${textSel.model}` : ''}
          </span>
          <div className="flex-1" />
          {generating && <span className="text-xs text-indigo-500">生成中…</span>}
        </div>

        {/* 会话参数行（选中会话后才显示） */}
        {current ? (
        <>
        <div className="flex flex-wrap items-center gap-3 border-b border-black/5 px-4 py-2 dark:border-white/10">
          <ProviderModelSelect
            value={{ serviceKey: current?.providerKey || null, model: current?.model || null }}
            onChange={({ serviceKey: k, model: m }) => {
              if (!current) return
              void patchSession(current.id, { providerKey: k ?? '', model: m ?? '' })
            }}
            filter="image"
            placeholder="会话画图模型（默认用公共配置）"
            style={{ minWidth: 300 }}
          />
          <Select
            size="small"
            style={{ width: 110 }}
            value={size}
            onChange={(v) => setParam({ size: v })}
            options={SIZES.map((s) => ({ value: s, label: s }))}
          />
          <InputNumber size="small" min={1} max={4} value={count} onChange={(v) => setParam({ count: v ?? 1 })} />
          <Popover
            trigger="click"
            placement="bottomLeft"
            content={
              <div className="flex w-80 flex-col gap-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-gray-500">本会话启用知识库检索</span>
                  <Switch
                    size="small"
                    checked={current?.kbEnabled === 1}
                    onChange={(v) => currentId && void setSessionKb(currentId, v, kbEntryIds)}
                  />
                </div>
                {current?.kbEnabled === 1 && (
                  <>
                    <Select
                      mode="multiple"
                      allowClear
                      size="small"
                      placeholder="全部已启用的知识库"
                      value={kbEntryIds}
                      onChange={(ids) => currentId && void setSessionKb(currentId, true, ids)}
                      options={kbOptions}
                      maxTagCount="responsive"
                    />
                    <p className="m-0 text-[10px] leading-4 text-gray-400">
                      不选 = 检索全部已启用条目；选择后仅检索勾选的知识库。选项保存在本会话。
                    </p>
                  </>
                )}
                {kbState.entries.length === 0 && (
                  <p className="m-0 text-[10px] leading-4 text-gray-400">
                    还没有可用知识库，请先到「知识库」页添加连接并拉取知识库。
                  </p>
                )}
              </div>
            }
          >
            <Badge count={kbEntryIds.length} size="small" offset={[-4, 4]}>
              <Tooltip title={current?.kbEnabled === 1 ? '知识库：开（点击配置检索范围）' : '知识库：关（点击开启）'}>
                <Button size="small" type={current?.kbEnabled === 1 ? 'primary' : 'text'} icon={<BookOpen size={14} />} />
              </Tooltip>
            </Badge>
          </Popover>
          <span className="flex items-center gap-1 text-xs text-gray-500" title="提示词附加时效性要求（需模型支持联网）">
            <Globe size={13} /> 联网
            <Switch
              size="small"
              checked={current?.webEnabled === 1}
              onChange={(v) => current && void patchSession(current.id, { webEnabled: v ? 1 : 0 })}
            />
          </span>
          <div className="flex-1" />
          <Button
            size="small"
            icon={<Settings2 size={13} />}
            onClick={() => {
              setTemplateDraft(current?.template ?? '')
              setTemplateOpen(true)
            }}
            disabled={!current}
          >
            模板{current?.template ? ' · 已设' : ''}
          </Button>
          <Button
            size="small"
            icon={<LayoutTemplate size={13} />}
            onClick={() => {
              setPromptOpen(true)
              if (cases.length === 0 && !casesLoading) {
                setCasesLoading(true)
                fetchPromptCases()
                  .then(setCases)
                  .catch((e) => message.error(errText(e)))
                  .finally(() => setCasesLoading(false))
              }
            }}
          >
            提示词模板
          </Button>
        </div>

        {/* 提示词 + 参考图 */}
        <div className="border-b border-black/5 px-4 py-3 dark:border-white/10">
          <div className="flex flex-col gap-2">
            <Input.TextArea
              value={prompt}
              onChange={(e) => currentId && setDraft(currentId, { prompt: e.target.value })}
              placeholder="描述想生成的画面…（可在右侧「模板」配置风格模板）"
              autoSize={{ minRows: 2, maxRows: 6 }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="small"
                icon={<ImagePlus size={13} />}
                onClick={() => fileInput.current?.click()}
                disabled={refs.length >= 8}
              >
                参考图（{refs.length}/8）
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  void addRefFiles(e.target.files)
                  e.target.value = ''
                }}
              />
              {refs.map((p) => (
                <div key={p} className="group relative">
                  <img src={convertFileSrc(p)} className="h-12 w-12 rounded-md object-cover" />
                  <button
                    type="button"
                    className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-gray-800 text-white group-hover:flex"
                    onClick={() => currentId && setDraft(currentId, { refs: refs.filter((r) => r !== p) })}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
              <div className="flex-1" />
              <Tooltip title={textSel.model ? `用文本模型 ${textSel.model} 优化（公共配置中可换）` : '先在公共配置中选择文本模型'}>
                <Button size="small" loading={optimizing} disabled={!prompt.trim() || !textSel.model} onClick={() => void optimizePrompt()}>
                  ✨ 优化提示词{textSel.model ? '' : '（未配文本模型）'}
                </Button>
              </Tooltip>
              <Button
                type="primary"
                size="small"
                icon={<Sparkles size={13} />}
                loading={generating}
                onClick={() => void generate()}
                disabled={!prompt.trim()}
              >
                生成
              </Button>
            </div>
          </div>
        </div>
        </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="画图服务加载中…" />
          </div>
        )}
        {/* 画廊 */}
        <div className="flex-1 overflow-y-auto p-4">
          {imageCards.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Empty
                image={<Sparkles size={44} strokeWidth={1.4} className="mx-auto text-indigo-300" />}
                description={generating ? '生成中…' : '还没有作品，输入提示词开始创作'}
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {imageCards.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="group relative overflow-hidden rounded-xl border border-black/5 bg-white dark:border-white/10 dark:bg-[#1f1f27]"
                  onClick={() => setPreview({ path: c.path, draw: c.draw })}
                  title="点击查看大图与提示词"
                >
                  <img
                    src={convertFileSrc(c.path)}
                    alt={c.draw.prompt}
                    className="aspect-square w-full object-cover transition-transform group-hover:scale-[1.03]"
                  />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5 text-left text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                    {c.draw.prompt}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 图生图编辑 */}
      {editFor && (
        <EditImageModal
          source={editFor}
          serviceSpec={activeImageSvc?.spec ?? null}
          model={model ?? ''}
          callMode={callMode}
          onClose={() => setEditFor(null)}
          onDone={async (newPrompt, paths) => {
            if (currentId) {
              await recordDraw({
                id: crypto.randomUUID(),
                sessionId: currentId,
                providerKey: activeImageKey ?? '',
                model: model ?? '',
                prompt: newPrompt,
                size: editFor.size,
                refs: JSON.stringify([editFor.path]),
                images: JSON.stringify(paths),
              })
            }
            setEditFor(null)
            message.success('图生图完成')
          }}
        />
      )}

      {/* 模板（原会话设置，仅模板） */}
      <Modal
        title="提示词模板"
        open={templateOpen}
        footer={null}
        onCancel={() => setTemplateOpen(false)}
      >
        <div className="flex flex-col gap-3 pt-2">
          <Input.TextArea
            value={templateDraft}
            onChange={(e) => setTemplateDraft(e.target.value)}
            placeholder={'例如：扁平插画风，品牌主色 #3B5BFD，简洁留白。'}
            autoSize={{ minRows: 3, maxRows: 8 }}
          />
          <p className="m-0 text-xs text-gray-400">生成时模板在前、提示词在后拼接。</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setTemplateOpen(false)}>关闭</Button>
            <Button
              type="primary"
              onClick={() => {
                if (!current) return
                void patchSession(current.id, { template: templateDraft })
                setTemplateOpen(false)
              }}
            >
              保存
            </Button>
          </div>
        </div>
      </Modal>

      {/* 图片预览：大图 + 提示词 */}
      <Modal
        title="作品详情"
        open={!!preview}
        footer={null}
        width={720}
        onCancel={() => setPreview(null)}
      >
        {preview && (
          <div className="flex flex-col gap-3 pt-1">
            <Image src={convertFileSrc(preview.path)} alt={preview.draw.prompt} className="rounded-lg" />
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-xs text-gray-500">提示词</span>
                <Button
                  size="small"
                  type="text"
                  icon={<Copy size={12} />}
                  onClick={() => {
                    void navigator.clipboard.writeText(preview.draw.prompt)
                    message.success('提示词已复制')
                  }}
                >
                  复制
                </Button>
              </div>
              <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/5 p-2.5 text-xs leading-5 text-gray-600 dark:bg-white/5 dark:text-gray-300">
                {preview.draw.prompt || '（无提示词）'}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag style={{ marginInlineEnd: 0 }}>{preview.draw.model}</Tag>
              {preview.draw.size && <Tag style={{ marginInlineEnd: 0 }}>{preview.draw.size}</Tag>}
              <span className="text-[11px] text-gray-400">
                {new Date(preview.draw.createdAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
              <div className="flex-1" />
              <Button
                size="small"
                icon={<Wand2 size={12} />}
                onClick={() => {
                  setEditFor({ path: preview.path, prompt: preview.draw.prompt, size: preview.draw.size })
                  setPreview(null)
                }}
              >
                图生图
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* 提示词模板抽屉（社区案例） */}
      <Drawer
        title="提示词模板 · 社区案例"
        placement="right"
        width={520}
        open={promptOpen}
        onClose={() => setPromptOpen(false)}
      >
        <Spin spinning={casesLoading}>
          {cases.length === 0 && !casesLoading && <Empty description="暂无模板（网络不可用时可稍后重试）" />}
          <div className="flex flex-col gap-3">
            {cases.slice(casePage * 8, casePage * 8 + 8).map((c, i) => (
              <div key={`${i}-${c.title}`} className="overflow-hidden rounded-xl border border-black/5 dark:border-white/10">
                <img src={c.imageUrl} alt={c.title} className="max-h-56 w-full object-cover" loading="lazy" />
                <div className="p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{c.title}</span>
                    {c.author && <Tag style={{ marginInlineEnd: 0 }}>@{c.author}</Tag>}
                  </div>
                  <div className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/5 p-2 text-xs leading-5 text-gray-600 dark:bg-white/5 dark:text-gray-300">
                    {c.prompt}
                  </div>
                  <div className="mt-2 flex justify-end gap-2">
                    <Button
                      size="small"
                      icon={<Copy size={12} />}
                      onClick={() => {
                        void navigator.clipboard.writeText(c.prompt)
                        message.success('已复制提示词')
                      }}
                    >
                      复制
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      onClick={() => {
                        if (currentId) setDraft(currentId, { prompt: c.prompt })
                        setPromptOpen(false)
                        message.success('已填入提示词')
                      }}
                    >
                      用此提示词
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {cases.length > 8 && (
            <div className="mt-4 flex justify-center">
              <Pagination
                size="small"
                current={casePage + 1}
                pageSize={8}
                total={cases.length}
                showSizeChanger={false}
                onChange={(p) => setCasePage(p - 1)}
              />
            </div>
          )}
        </Spin>
      </Drawer>

      {/* 公共配置弹窗（画图/文本模型） */}
      <Modal
        title="公共配置 · 画图与文本模型"
        open={cfgOpen}
        footer={<Button onClick={() => setCfgOpen(false)}>关闭</Button>}
        onCancel={() => setCfgOpen(false)}
      >
        <div className="flex flex-col gap-3 py-1">
          <div>
            <div className="mb-1 text-xs text-gray-500">画图模型（生成用）</div>
            <ProviderModelSelect
              value={imageSel}
              onChange={(v) => {
                setImageSel(v)
                saveSel('aw-draw-image', v)
              }}
              filter="image"
              placeholder="选择画图模型"
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-gray-500">文本模型（优化提示词用，可与画图不同供应商）</div>
            <div className="flex items-center gap-2">
              <ProviderModelSelect
                value={textSel}
                onChange={(v) => {
                  setTextSel(v)
                  saveSel('aw-draw-text', v)
                }}
                filter="text"
                placeholder="优化提示词用"
              />
              <Button size="small" icon={<Settings2 size={13} />} onClick={() => setManageOpen(true)}>
                管理能力
              </Button>
            </div>
          </div>
          <p className="m-0 text-xs text-gray-400">单个会话可在会话参数行覆盖画图模型。</p>
        </div>
      </Modal>

      {/* 能力管理 */}
      <Modal
        title="模型画图能力（自动识别 + 手动覆盖）"
        open={manageOpen}
        footer={null}
        width={640}
        onCancel={() => setManageOpen(false)}
      >
        <CapabilityManager serviceKey={activeImageKey} />
      </Modal>
    </div>
  )
}

/** 能力管理列表：自行拉取所选服务的模型并渲染行 */
function CapabilityManager({ serviceKey }: { serviceKey: string | null }) {
  const [models, setModels] = useState<string[] | null>(null)
  const { services } = useAiServices()
  const svc = services.find((x) => x.key === serviceKey) ?? null
  useEffect(() => {
    if (!svc) {
      setModels(null)
      return
    }
    let alive = true
    void listModels(svc.spec)
      .then((ids) => {
        if (alive) setModels(ids)
      })
      .catch(() => setModels([]))
    return () => {
      alive = false
    }
  }, [svc?.key])
  return (
    <div className="max-h-[60vh] overflow-y-auto">
      <p className="mb-2 text-xs text-gray-400">
        「自动」按模型名识别；可强制标记为画图模型（images / 对话生图）或排除。仅影响
        {svc?.label ?? '当前服务'}。
      </p>
      {models === null && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="模型加载中…" />}
      {models !== null && models.length === 0 && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模型" />
      )}
      {models?.map((id) => (
        <CapabilityRow key={id} serviceKey={serviceKey} modelId={id} auto={autoCapability(id)} />
      ))}
    </div>
  )
}

function CapabilityRow({ serviceKey, modelId, auto }: { serviceKey: string | null; modelId: string; auto: AutoCapability }) {
  const [value, setValue] = useState<string>(() =>
    auto.isImage ? (auto.callMode === 'chat' ? 'chat' : 'images') : 'off',
  )

  useEffect(() => {
    if (!serviceKey) return
    void capabilityRepo.get(serviceKey, modelId).then((o) => {
      if (o?.imageCallMode) setValue(o.imageCallMode)
      else if (o?.imageEnabled === false) setValue('off')
    })
  }, [serviceKey, modelId])

  const onChange = async (v: string) => {
    setValue(v)
    if (!serviceKey) return
    if (v === 'auto') {
      const a = autoCapability(modelId)
      await capabilityRepo.setImage(serviceKey, modelId, null, null)
      void a
    } else if (v === 'off') {
      await capabilityRepo.setImage(serviceKey, modelId, null, false)
    } else {
      await capabilityRepo.setImage(serviceKey, modelId, v as 'images' | 'chat', true)
    }
  }

  return (
    <div className="flex items-center justify-between border-b border-black/5 py-2 last:border-0 dark:border-white/10">
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={modelId}>
        {modelId}
      </span>
      <Segmented
        size="small"
        value={value}
        onChange={(v) => void onChange(v as string)}
        options={[
          { label: '自动', value: 'auto' },
          { label: '画图·images', value: 'images' },
          { label: '对话生图', value: 'chat' },
          { label: '非画图', value: 'off' },
        ]}
      />
    </div>
  )
}

/** 图生图编辑弹窗：原图 + 新提示词 → /v1/images/edits 重绘 */
function EditImageModal({
  source,
  serviceSpec,
  model,
  callMode,
  onClose,
  onDone,
}: {
  source: { path: string; prompt: string; size: string }
  serviceSpec: Record<string, unknown> | null
  model: string
  callMode: 'images' | 'chat'
  onClose: () => void
  onDone: (prompt: string, paths: string[]) => Promise<void>
}) {
  const { message } = App.useApp()
  const [prompt, setPrompt] = useState(source.prompt)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (!serviceSpec || !model) {
      message.warning('请先选择画图模型（公共配置或会话级）')
      return
    }
    if (!prompt.trim()) return
    if (callMode === 'chat') {
      message.warning('对话式生图模型不支持 images/edits；请改用提示词区「参考图」方式')
      return
    }
    setBusy(true)
    try {
      const paths = await editImage({
        spec: serviceSpec,
        model,
        prompt: prompt.trim(),
        image: source.path,
        size: source.size || undefined,
        n: 1,
      })
      await onDone(prompt.trim(), paths)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="图生图编辑"
      open
      onCancel={busy ? undefined : onClose}
      onOk={() => void run()}
      confirmLoading={busy}
      okText="重绘"
      cancelText="取消"
      width={520}
      maskClosable={!busy}
    >
      <div className="flex flex-col gap-3 pt-2">
        <div className="flex justify-center rounded-lg border border-black/5 bg-black/5 p-2 dark:border-white/10 dark:bg-white/5">
          <img src={convertFileSrc(source.path)} alt="原图" className="max-h-64 rounded-md object-contain" />
        </div>
        <div>
          <div className="mb-1 text-xs text-gray-500">重绘提示词</div>
          <Input.TextArea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述要修改的内容，如：把背景换成日落海滩"
            autoSize={{ minRows: 2, maxRows: 5 }}
          />
        </div>
        <p className="m-0 text-[11px] text-gray-400">
          走 /v1/images/edits 接口（原图 + 提示词重绘），需要画图模型支持编辑能力（gpt-image 系列等）。
        </p>
      </div>
    </Modal>
  )
}
