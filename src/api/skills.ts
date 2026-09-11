import { call } from './ipc'

export interface Skill {
  name: string
  description: string
  displayName: string
  targets: string[]
  installedAt: number
}

export interface SkillTarget {
  id: string
  label: string
  dir: string
  exists: boolean
}

/** 本机扫描到的技能（应用库 + 各 CLI 目录） */
export interface LocalSkill {
  name: string
  displayName: string
  description: string
  /** 出现位置：claude / codex / opencode / pi / library */
  locations: string[]
  inLibrary: boolean
  installedAt: number
}

export interface SkillSource {
  url: string
  label: string
  desc: string
}

export interface RepoSkill {
  name: string
  displayName: string
  description: string
}

export interface SkillFileEntry {
  path: string
  isDir: boolean
  size: number
}

export interface SkillDetail {
  name: string
  displayName: string
  description: string
  dir: string
  loc: string
  files: SkillFileEntry[]
  skillMd?: string | null
  readmeMd?: string | null
}

export const skillApi = {
  list: () => call<Skill[]>('skill_list'),
  targets: () => call<SkillTarget[]>('skill_targets'),
  installGit: (url: string) => call<string[]>('skill_install_git', { url }),
  installLocal: (path: string) => call<string[]>('skill_install_local', { path }),
  remove: (name: string) => call<void>('skill_remove', { name }),
  sync: (name: string, targets: string[]) => call<void>('skill_sync', { name, targets }),
  scanLocal: () => call<LocalSkill[]>('skill_scan_local'),
  importFrom: (cli: string, name: string) => call<string[]>('skill_import_from', { cli, name }),
  sources: () => call<SkillSource[]>('skill_sources'),
  /** 技能详情：loc = library 或 cli id */
  detail: (loc: string, name: string) => call<SkillDetail>('skill_detail', { loc, name }),
  readFile: (loc: string, name: string, path: string) =>
    call<string>('skill_read_file', { loc, name, path }),
  /** 在访达中打开技能所在目录，返回路径 */
  reveal: (loc: string, name: string) => call<string>('skill_reveal', { loc, name }),
  repoBrowse: (url: string) => call<RepoSkill[]>('skill_repo_browse', { url }),
  repoInstall: (url: string, names: string[]) => call<string[]>('skill_repo_install', { url, names }),
}
