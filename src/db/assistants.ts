import { getDb } from './index'

export interface Assistant {
  id: string
  name: string
  emoji: string
  description: string
  systemPrompt: string
  /** 默认模型提示（用户服务里不一定有该模型，仅作选择建议） */
  model: string
  builtin: number
  sort: number
  createdAt: number
}

function rowToAssistant(r: Record<string, unknown>): Assistant {
  return {
    id: r.id as string,
    name: r.name as string,
    emoji: (r.emoji as string) || '🤖',
    description: (r.description as string) || '',
    systemPrompt: (r.system_prompt as string) || '',
    model: (r.model as string) || '',
    builtin: (r.builtin as number) || 0,
    sort: (r.sort as number) || 0,
    createdAt: r.created_at as number,
  }
}

/** 内置助手（首次使用 seed，不可删除；system_prompt 精炼、可编辑） */
const BUILTIN: Omit<Assistant, 'createdAt'>[] = [
  {
    id: 'builtin-writer',
    name: '写作助手',
    emoji: '📝',
    description: '文案、报告、邮件润色',
    systemPrompt:
      '你是资深中文写作助手。写作风格清晰、简洁、结构化；根据用途（邮件/报告/文案）选择合适语气；输出分点或分段，重要结论前置。不确定的信息明确指出，不编造。',
    model: '',
    builtin: 1,
    sort: 1,
  },
  {
    id: 'builtin-excel',
    name: 'Excel 数据分析',
    emoji: '📊',
    description: '表格数据分析与公式',
    systemPrompt:
      '你是数据分析助手。用户描述表格数据或粘贴数据片段时：1) 先说明你的理解与分析思路；2) 给出可直接使用的 Excel 公式（注明放在哪个单元格）；3) 需要统计结论时给出计算方法与解读。默认使用中文函数名场景说明中英兼容。',
    model: '',
    builtin: 1,
    sort: 2,
  },
  {
    id: 'builtin-ppt',
    name: 'PPT 助手',
    emoji: '📑',
    description: '大纲与逐页内容',
    systemPrompt:
      '你是 PPT 结构专家。根据主题输出：1) 一页大纲（封面/目录/内容页/总结，每页一个核心信息）；2) 逐页给出标题、3-5 条要点、可讲的备注。风格务实，避免空话，总页数控制在 15 页内除非用户要求。',
    model: '',
    builtin: 1,
    sort: 3,
  },
  {
    id: 'builtin-frontend',
    name: '前端开发',
    emoji: '💻',
    description: '代码、调试与最佳实践',
    systemPrompt:
      '你是资深前端工程师。回答给出可直接运行的代码（注明文件/位置），遵循现代最佳实践；排查问题时先问关键信息或列出可能原因与验证步骤。默认 TypeScript。',
    model: '',
    builtin: 1,
    sort: 4,
  },
  {
    id: 'builtin-weekly',
    name: '周报助手',
    emoji: '📋',
    description: '汇总工作生成周报',
    systemPrompt:
      '你是周报整理助手。用户给出零散的工作记录时，输出结构化周报：本周完成（按项目/事项分组，结果导向描述）、进行中、风险与需协调、下周计划。语言精炼，用动词开头的结果句式；信息不足处用【待补充】标注而不是编造。',
    model: '',
    builtin: 1,
    sort: 5,
  },
  {
    id: 'builtin-translator',
    name: '翻译助手',
    emoji: '🔍',
    description: '中英互译与润色',
    systemPrompt:
      '你是专业翻译。中译英与英译中都要自然、专业、保留原意；技术术语保留英文原文并在括号内给出翻译；输出译文即可，除非用户要求解释。检测到其他语言时译为中文。',
    model: '',
    builtin: 1,
    sort: 6,
  },
]

export const assistantRepo = {
  async list(): Promise<Assistant[]> {
    const db = await getDb()
    // seed 内置助手（幂等）
    for (const b of BUILTIN) {
      await db
        .execute(
          'INSERT OR IGNORE INTO assistants (id, name, emoji, description, system_prompt, model, builtin, sort, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [b.id, b.name, b.emoji, b.description, b.systemPrompt, b.model, b.builtin, b.sort, Date.now()],
        )
        .catch(() => {})
    }
    const rows = await db.select<Record<string, unknown>[]>('SELECT * FROM assistants ORDER BY sort ASC, created_at ASC')
    return rows.map(rowToAssistant)
  },
  async create(a: Omit<Assistant, 'createdAt' | 'builtin' | 'sort'> & { sort?: number }): Promise<void> {
    const db = await getDb()
    await db.execute(
      'INSERT INTO assistants (id, name, emoji, description, system_prompt, model, builtin, sort, created_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)',
      [a.id, a.name, a.emoji, a.description, a.systemPrompt, a.model, a.sort ?? 100, Date.now()],
    )
  },
  async update(a: Pick<Assistant, 'id' | 'name' | 'emoji' | 'description' | 'systemPrompt'>): Promise<void> {
    const db = await getDb()
    await db.execute('UPDATE assistants SET name = $1, emoji = $2, description = $3, system_prompt = $4 WHERE id = $5', [
      a.name,
      a.emoji,
      a.description,
      a.systemPrompt,
      a.id,
    ])
  },
  async remove(id: string): Promise<void> {
    const db = await getDb()
    await db.execute('DELETE FROM assistants WHERE id = $1 AND builtin = 0', [id])
  },
}
