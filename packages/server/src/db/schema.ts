export type Migration = {
  version: number;
  name: string;
  sql: string;
};

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS servers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  host            TEXT NOT NULL,
  port            INTEGER NOT NULL DEFAULT 22,
  username        TEXT NOT NULL,
  auth_type       TEXT NOT NULL CHECK (auth_type IN ('password', 'key')),
  password_enc    TEXT,
  private_key_enc TEXT,
  passphrase_enc  TEXT,
  host_key_policy TEXT NOT NULL DEFAULT 'tofu',
  host_key_fp     TEXT,
  color           TEXT,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  notes           TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (status IN ('unknown', 'online', 'offline', 'auth_failed', 'error')),
  status_msg      TEXT,
  last_ok_at      INTEGER,
  caps_json       TEXT NOT NULL DEFAULT '{}',
  hw_json         TEXT,
  hw_at           INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_servers_name ON servers(name);
CREATE INDEX IF NOT EXISTS ix_servers_status ON servers(status);

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  local_root        TEXT NOT NULL,
  ignore_extra_json TEXT NOT NULL DEFAULT '[]',
  exec_bit_policy   TEXT NOT NULL DEFAULT 'auto',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_name ON projects(name);

CREATE TABLE IF NOT EXISTS targets (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_id        TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  label            TEXT,
  remote_code_dir  TEXT NOT NULL,
  data_dir         TEXT,
  conda_env        TEXT,
  env_vars_json    TEXT NOT NULL DEFAULT '{}',
  pre_command      TEXT,
  run_command      TEXT NOT NULL,
  gpu_devices      TEXT,
  sync_mode        TEXT NOT NULL DEFAULT 'sftp' CHECK (sync_mode IN ('sftp', 'git')),
  sync_config_json TEXT NOT NULL DEFAULT '{}',
  keep_session     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (project_id, server_id)
);
CREATE INDEX IF NOT EXISTS ix_targets_server ON targets(server_id);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  target_id        TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL,
  server_id        TEXT NOT NULL,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                   ('pending', 'syncing', 'starting', 'running',
                    'exited', 'failed', 'canceled', 'lost',
                    'sync_failed', 'start_failed')),
  launcher         TEXT,
  tmux_session     TEXT,
  remote_pid       INTEGER,
  remote_pgid      INTEGER,
  script_path      TEXT,
  log_path         TEXT,
  exit_path        TEXT,
  rendered_command TEXT NOT NULL,
  script_content   TEXT NOT NULL,
  exit_code        INTEGER,
  error            TEXT,
  sync_run_id      TEXT,
  log_bytes        INTEGER,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER,
  last_seen_at     INTEGER
);
CREATE INDEX IF NOT EXISTS ix_jobs_status_created ON jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_jobs_server_status ON jobs(server_id, status);
CREATE INDEX IF NOT EXISTS ix_jobs_target_created ON jobs(target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  message   TEXT,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_job_events_job ON job_events(job_id, ts);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  target_id   TEXT REFERENCES targets(id) ON DELETE SET NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('sftp', 'git')),
  direction   TEXT NOT NULL CHECK (direction IN
              ('local_to_remote', 'target_to_target', 'remote_to_local')),
  source_json TEXT NOT NULL,
  dest_json   TEXT NOT NULL,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL CHECK (status IN
              ('pending', 'scanning', 'transferring', 'deleting',
               'pushing', 'done', 'failed', 'canceled')),
  stats_json  TEXT,
  plan_json   TEXT,
  output_tail TEXT,
  error       TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sync_target ON sync_runs(target_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_sync_started ON sync_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const JOB_SESSION_WINDOW_SQL = `
ALTER TABLE jobs ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'new';
ALTER TABLE jobs ADD COLUMN window_id TEXT;
ALTER TABLE jobs ADD COLUMN window_name TEXT;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: INIT_SQL },
  { version: 2, name: 'job-session-window', sql: JOB_SESSION_WINDOW_SQL },
];