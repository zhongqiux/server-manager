export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '.git/',
  'node_modules/',
  '__pycache__/',
  '*.pyc',
  '*.pyo',
  '.venv/',
  'venv/',
  'env/',
  '.conda/',
  '.ipynb_checkpoints/',
  '.idea/',
  '.vscode/',
  '.DS_Store',
  'Thumbs.db',
  '/data/',
  '*.log',
  '*.tmp',
  '*.swp',
];

export const HARD_IGNORE_PATTERNS: readonly string[] = ['.git/', '.sm-tmp-*'];

export const DEFAULT_BATCH_IGNORES: readonly string[] = [];