import { call } from './ipc'

export interface NoteItem {
  name: string
  title: string
  excerpt: string
  size: number
  updatedAt: number
}

/** 目录树节点：分组或笔记（key 为相对路径） */
export interface NoteNode {
  key: string
  kind: 'group' | 'note'
  title: string
  excerpt: string
  size: number
  updatedAt: number
  children: NoteNode[]
}

export const noteApi = {
  getDir: () => call<string>('note_get_dir'),
  setDir: (path: string) => call<string>('note_set_dir', { path }),
  resetDir: () => call<string>('note_reset_dir'),
  list: () => call<NoteItem[]>('note_list'),
  tree: () => call<NoteNode[]>('note_tree'),
  read: (name: string) => call<string>('note_read', { name }),
  write: (name: string, content: string) => call<void>('note_write', { name, content }),
  /** group = 目标分组相对路径（空 = 根目录） */
  create: (name: string, group?: string) => call<NoteItem>('note_create', { name, group }),
  createGroup: (path: string) => call<void>('note_create_group', { path }),
  /** 拖拽移动：把 from（笔记或分组）移动到 toDir 分组（空 = 根目录） */
  move: (from: string, toDir: string) => call<void>('note_move', { from, toDir }),
  rename: (name: string, newName: string) => call<void>('note_rename', { name, newName }),
  remove: (name: string) => call<void>('note_delete', { name }),
}
