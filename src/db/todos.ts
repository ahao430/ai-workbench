import { getDb } from '../db'

/** 待办事项：dueAt 为空 = 不设时间（不进月历，只在清单区展示）；00:00 = 只定到天 */
export interface Todo {
  id: string
  title: string
  done: number
  dueAt: number | null
  createdAt: number
  completedAt: number | null
  /** 背景色调色板下标（1..N，创建时随机分配；0 = 不着色，旧数据兜底） */
  color: number
}

function rowToTodo(r: Record<string, unknown>): Todo {
  return {
    id: r.id as string,
    title: r.title as string,
    done: (r.done as number) || 0,
    dueAt: r.due_at == null ? null : Number(r.due_at),
    createdAt: Number(r.created_at),
    completedAt: r.completed_at == null ? null : Number(r.completed_at),
    color: Number(r.color) || 0,
  }
}

export const todoRepo = {
  /** 未完成在前，再按时间（未安排垫底）、创建序排 */
  async list(): Promise<Todo[]> {
    const db = await getDb()
    const rows = await db.select<Record<string, unknown>[]>(
      'SELECT * FROM todos ORDER BY done ASC, (due_at IS NULL), due_at ASC, created_at ASC',
    )
    return rows.map(rowToTodo)
  },
  async create(title: string, dueAt: number | null, color = 0): Promise<void> {
    const db = await getDb()
    await db.execute(
      'INSERT INTO todos (id, title, done, due_at, created_at, completed_at, color) VALUES ($1,$2,0,$3,$4,NULL,$5)',
      [crypto.randomUUID(), title, dueAt, Date.now(), color],
    )
  },
  async setDone(id: string, done: boolean): Promise<void> {
    const db = await getDb()
    await db.execute('UPDATE todos SET done = $2, completed_at = $3 WHERE id = $1', [
      id,
      done ? 1 : 0,
      done ? Date.now() : null,
    ])
  },
  async remove(id: string): Promise<void> {
    const db = await getDb()
    await db.execute('DELETE FROM todos WHERE id = $1', [id])
  },
  /** 批量清空（清单+日程一起）；不可恢复，调用方负责二次确认 */
  async clear(doneOnly = true): Promise<void> {
    const db = await getDb()
    await db.execute(doneOnly ? 'DELETE FROM todos WHERE done = 1' : 'DELETE FROM todos')
  },
}
