import Database from '@tauri-apps/plugin-sql'

let db: Database | null = null

const MIGRATIONS: { sql: string; optional?: boolean }[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '新会话',
    service_json TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    context_reset_id TEXT,
    kb_enabled INTEGER NOT NULL DEFAULT 0,
    kb_entry_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    reasoning TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL DEFAULT '',
    kb_refs TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`,
  },
  { sql: `CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, created_at)` },
  {
    sql: `CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    secret_ref TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS provider_models (
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (provider_id, model_id)
  )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS model_capabilities (
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    image_call_mode TEXT,
    image_enabled INTEGER,
    PRIMARY KEY (provider_id, model_id)
  )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS draw_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '新画图会话',
    provider_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    template TEXT NOT NULL DEFAULT '',
    kb_enabled INTEGER NOT NULL DEFAULT 0,
    kb_entry_ids TEXT NOT NULL DEFAULT '[]',
    web_enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS draws (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    provider_key TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    size TEXT NOT NULL DEFAULT '',
    refs TEXT NOT NULL DEFAULT '[]',
    images TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS assistants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🤖',
    description TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    builtin INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    color INTEGER NOT NULL DEFAULT 0
  )`,
  },
  { sql: `CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_at)` },
  // 旧库增量列（已存在时报错属预期，忽略）
  { sql: `ALTER TABLE chat_sessions ADD COLUMN assistant_id TEXT`, optional: true },
  { sql: `ALTER TABLE providers ADD COLUMN kind TEXT NOT NULL DEFAULT 'openai'`, optional: true },
  { sql: `ALTER TABLE providers ADD COLUMN anthropic_base_url TEXT NOT NULL DEFAULT ''`, optional: true },
  { sql: `ALTER TABLE providers ADD COLUMN quota_type TEXT NOT NULL DEFAULT ''`, optional: true },
  { sql: `ALTER TABLE providers ADD COLUMN show_on_home INTEGER NOT NULL DEFAULT 0`, optional: true },
  { sql: `ALTER TABLE providers ADD COLUMN show_on_tray INTEGER NOT NULL DEFAULT 0`, optional: true },
  { sql: `ALTER TABLE providers ADD COLUMN currency TEXT NOT NULL DEFAULT ''`, optional: true },
  { sql: `ALTER TABLE draws ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`, optional: true },
  { sql: `ALTER TABLE draws ADD COLUMN refs TEXT NOT NULL DEFAULT '[]'`, optional: true },
  { sql: `ALTER TABLE chat_sessions ADD COLUMN kb_enabled INTEGER NOT NULL DEFAULT 0`, optional: true },
  { sql: `ALTER TABLE chat_sessions ADD COLUMN kb_entry_ids TEXT NOT NULL DEFAULT '[]'`, optional: true },
  { sql: `ALTER TABLE chat_messages ADD COLUMN kb_refs TEXT NOT NULL DEFAULT '[]'`, optional: true },
  { sql: `ALTER TABLE draw_sessions ADD COLUMN kb_entry_ids TEXT NOT NULL DEFAULT '[]'`, optional: true },
  { sql: `ALTER TABLE todos ADD COLUMN color INTEGER NOT NULL DEFAULT 0`, optional: true },
]

/** 打开（并初始化）sqlite；单例复用 */
export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load('sqlite:workbench.db')
    for (const m of MIGRATIONS) {
      try {
        await db.execute(m.sql)
      } catch (e) {
        if (!m.optional) throw e
        // optional：列已存在等可忽略错误
      }
    }
  }
  return db
}
