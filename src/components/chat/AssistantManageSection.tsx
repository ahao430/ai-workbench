import { useEffect, useState } from 'react'
import { App, Button, Empty, Form, Input, Modal, Popconfirm } from 'antd'
import { errText } from '../../lib/err'
import { assistantRepo, type Assistant } from '../../db/assistants'
import { useChatStore } from '../../stores/chat'

/** 助手管理区块（嵌入聊天「公共配置」弹窗）：助手列表编辑 + 新建；助手=提示词组合器，绑定到会话生效 */
export function AssistantManageSection() {
  const { message } = App.useApp()
  const assistants = useChatStore((s) => s.assistants)
  const refresh = useChatStore((s) => s.refreshAssistants)
  const [editing, setEditing] = useState<Assistant | 'new' | null>(null)

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div>
      <div className="flex max-h-[46vh] flex-col overflow-y-auto">
        {assistants.map((a) => (
          <div
            key={a.id}
            className="flex items-center justify-between border-b border-black/5 py-2 last:border-0 dark:border-white/10"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-lg">{a.emoji}</span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {a.name}
                  {!!a.builtin && <span className="text-[10px] text-gray-400">内置</span>}
                </div>
                <div className="truncate text-xs text-gray-400">{a.description}</div>
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button size="small" onClick={() => setEditing(a)}>
                编辑
              </Button>
              <Popconfirm
                title={`删除助手「${a.name}」？`}
                disabled={!!a.builtin}
                onConfirm={async () => {
                  try {
                    await assistantRepo.remove(a.id)
                    await refresh()
                    message.success('已删除')
                  } catch (e) {
                    message.error(errText(e))
                  }
                }}
              >
                <Button size="small" danger disabled={!!a.builtin}>
                  删除
                </Button>
              </Popconfirm>
            </div>
          </div>
        ))}
        {assistants.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无助手" />}
      </div>
      <div className="mt-3 flex justify-end">
        <Button type="primary" onClick={() => setEditing('new')}>
          新建助手
        </Button>
      </div>

      {editing && (
        <AssistantForm
          assistant={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

function AssistantForm({
  assistant,
  onClose,
  onSaved,
}: {
  assistant: Assistant | null
  onClose: () => void
  onSaved: () => void
}) {
  const { message } = App.useApp()
  const [form] = Form.useForm<{ name: string; emoji: string; description: string; systemPrompt: string }>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    form.setFieldsValue(
      assistant
        ? {
            name: assistant.name,
            emoji: assistant.emoji,
            description: assistant.description,
            systemPrompt: assistant.systemPrompt,
          }
        : { name: '', emoji: '🤖', description: '', systemPrompt: '' },
    )
  }, [assistant, form])

  const save = async (v: { name: string; emoji: string; description: string; systemPrompt: string }) => {
    setSaving(true)
    try {
      if (assistant) {
        await assistantRepo.update({ id: assistant.id, ...v })
      } else {
        await assistantRepo.create({ id: crypto.randomUUID(), model: '', ...v })
      }
      message.success('已保存')
      onSaved()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={assistant ? `编辑助手 · ${assistant.name}` : '新建助手'}
      open
      onCancel={onClose}
      confirmLoading={saving}
      onOk={async () => void (await form.validateFields().then(save))}
      okText="保存"
      cancelText="取消"
      width={560}
    >
      <Form form={form} layout="vertical" className="pt-1">
        <div className="flex gap-3">
          <Form.Item name="emoji" label="图标" rules={[{ required: true, message: '必填' }]} className="w-20">
            <Input maxLength={2} />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]} className="flex-1">
            <Input placeholder="例如 竞品分析" />
          </Form.Item>
        </div>
        <Form.Item name="description" label="描述">
          <Input placeholder="一句话说明用途（显示在列表里）" />
        </Form.Item>
        <Form.Item
          name="systemPrompt"
          label="系统提示词"
          extra="定义助手的角色、风格与输出要求；会话中每条消息都会携带"
        >
          <Input.TextArea autoSize={{ minRows: 5, maxRows: 12 }} placeholder="你是…（角色/风格/输出要求）" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
