export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ListResponse<T> = {
  items: T[];
};

export type ProjectScanEntry = {
  name: string;
  type: 'file' | 'dir';
  ignored: boolean;
  size: number | null;
};

export type ProjectScanResult = {
  root: string;
  files: number;
  dirs: number;
  bytes: number;
  ignoredEntries: number;
  skippedSymlinks: number;
  truncated: boolean;
  durationMs: number;
  topLevel: ProjectScanEntry[];
};

export type IgnoreSource = 'default' | 'project' | 'target' | 'hard';

export type IgnoreExplainResult = {
  path: string;
  ignored: boolean;
  rule: string | null;
  source: IgnoreSource | null;
};

export type TargetPreview = {
  renderedCommand: string;
  scriptContent: string;
  warnings: string[];
};