export const TEMPLATE_KEYS = [
  'remote_dir',
  'data_dir',
  'project_name',
  'server_name',
  'gpu_devices',
  'job_id',
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export type TemplateVars = Partial<Record<TemplateKey, string | number | null | undefined>>;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(PLACEHOLDER_RE, (_match, raw: string) => {
    if (!(TEMPLATE_KEYS as readonly string[]).includes(raw)) {
      const allowed = TEMPLATE_KEYS.map((key) => `{{${key}}}`).join(' ');
      throw new TemplateError(`未知占位符 {{${raw}}}，可用：${allowed}`);
    }
    const value = vars[raw as TemplateKey];
    return value === null || value === undefined ? '' : String(value);
  });
}

export function listTemplateVars(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const key = match[1];
    if (key) found.add(key);
  }
  return [...found];
}

export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}