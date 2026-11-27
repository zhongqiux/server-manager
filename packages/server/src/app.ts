import fs from 'node:fs';
import path from 'node:path';
import { getAsset, getRawAsset } from 'node:sea';
import express, { type NextFunction, type Request, type Response } from 'express';
import { APP_VERSION, DEMO_MODE, IS_SEA, WEB_DIST_DIR } from './config.ts';
import { ApiError } from './errors.ts';
import { createLogger } from './logger.ts';
import { serversRouter } from './routes/servers.ts';
import { projectsRouter } from './routes/projects.ts';
import { targetsRouter } from './routes/targets.ts';
import { syncRouter } from './routes/sync.ts';
import { jobsRouter } from './routes/jobs.ts';
import { eventsRouter } from './routes/events.ts';
import { dashboardRouter } from './routes/dashboard.ts';

const log = createLogger('http');

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return ALLOWED_HOSTNAMES.has(hostname);
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function loadSeaWebAssets(): { files: Map<string, Buffer>; index: Buffer } | null {
  try {
    const manifest = JSON.parse(getAsset('web/asset-manifest.json', 'utf8')) as string[];
    const files = new Map<string, Buffer>();
    for (const rel of manifest) {
      files.set(rel, Buffer.from(getRawAsset(`web/${rel}`)));
    }
    const index = files.get('index.html');
    if (!index) {
      log.error('内置 Web 资源缺少 index.html');
      return null;
    }
    log.info('内置 Web 资源已加载', { files: files.size });
    return { files, index };
  } catch (err) {
    log.error('加载内置 Web 资源失败', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function mountWeb(app: express.Express): void {
  if (IS_SEA) {
    const assets = loadSeaWebAssets();
    if (!assets) return;
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(req.path);
      } catch {
        next();
        return;
      }
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const file = assets.files.get(rel);
      if (file) {
        res.setHeader(
          'Content-Type',
          MIME_TYPES[path.extname(rel).toLowerCase()] ?? 'application/octet-stream',
        );
        res.setHeader(
          'Cache-Control',
          rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
        res.end(file);
        return;
      }
      if (path.extname(rel) !== '') {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(assets.index);
    });
    return;
  }

  const hasWebBuild = fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'));
  if (!hasWebBuild) return;
  app.use(express.static(WEB_DIST_DIR, { index: false, etag: true }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    res.sendFile(path.join(WEB_DIST_DIR, 'index.html'));
  });
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isAllowedHost(req.headers.host)) {
      res.status(403).json({
        error: { code: 'FORBIDDEN_HOST', message: '仅允许通过 127.0.0.1 / localhost 访问' },
      });
      return;
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      version: APP_VERSION,
      node: process.version,
      uptime: Math.round(process.uptime()),
      demo: DEMO_MODE,
    });
  });

  app.use('/api/servers', serversRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/targets', targetsRouter);
  app.use('/api/sync', syncRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/dashboard', dashboardRouter);

  app.use('/api', (req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `未知接口 ${req.method} ${req.originalUrl}` },
    });
  });

  mountWeb(app);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      if (err.status >= 500) log.error('接口异常', { code: err.code, message: err.message });
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const isBodyParseError =
      typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed';
    log.error('请求处理异常', { message });
    if (isBodyParseError) {
      res.status(400).json({ error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
      return;
    }
    res.status(500).json({ error: { code: 'INTERNAL', message } });
  });

  return app;
}