// server.js
import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// 忽略规则：与前端保持一致
const IGNORE_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor', 'Pods',
  '.git', '.svn', '.hg',
  'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.output',
  '.cache', '.parcel-cache', '.turbo', '.vite',
  'coverage', '.nyc_output',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.venv', 'venv', '.tox',
  'target', '.gradle', '.dart_tool',
  '.idea', '.vs', 'DerivedData',
]);

const IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
  'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock',
]);

const MAX_DEPTH = 60;                     // 防爆栈
const MAX_ENTRIES = 200000;               // 单次扫描上限
const MAX_FILE_BYTES = 2 * 1024 * 1024;   // 单文件读取上限 2MB

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '20mb' }));

/* ══════════════════════════════════════════════
   路径解析：不限定工作目录（只读，无写入风险）
   ══════════════════════════════════════════════ */
function resolveTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('路径为空');

  // 展开 ~ 为用户主目录
  let p = raw;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }

  return path.resolve(p);
}

/* ══════════════════════════════════════════════
   扫描目录
   ══════════════════════════════════════════════ */
function scanDir(dir, depth = 0, counter = { n: 0 }) {
  if (depth > MAX_DEPTH) return [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const out = [];

  for (const entry of entries) {
    if (counter.n++ > MAX_ENTRIES) break;

    const name = entry.name;
    const full = path.join(dir, name);

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(name)) continue;
      out.push({
        type: 'dir',
        name,
        path: full,
        children: scanDir(full, depth + 1, counter),
      });
    } else if (entry.isFile()) {
      if (IGNORE_FILES.has(name)) continue;
      let size = 0;
      try { size = fs.statSync(full).size; } catch (_) {}
      out.push({ type: 'file', name, path: full, size });
    }
    // 符号链接等其它类型跳过
  }

  return out;
}

/* ══════════════════════════════════════════════
   GET /api/info
   ══════════════════════════════════════════════ */
app.get('/api/info', (req, res) => {
  res.json({
    cwd: process.cwd(),
    home: os.homedir(),
    platform: process.platform,
    port: PORT,
  });
});

/* ══════════════════════════════════════════════
   GET /api/tree?path=xxx
   返回：{ root, name, children }
   ══════════════════════════════════════════════ */
app.get('/api/tree', (req, res) => {
  try {
    const target = resolveTarget(req.query.path);

    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: '目标不是文件夹' });
    }

    const counter = { n: 0 };
    const children = scanDir(target, 0, counter);

    res.json({
      root: target,
      name: path.basename(target) || target,
      children,
      count: counter.n,
    });
  } catch (e) {
    res.status(400).json({ error: e.message || '读取失败' });
  }
});

/* ══════════════════════════════════════════════
   POST /api/files
   body: { root?: string, paths: string[] }
   ══════════════════════════════════════════════ */
app.post('/api/files', async (req, res) => {
  try {
    const { paths } = req.body || {};
    if (!Array.isArray(paths)) {
      return res.status(400).json({ error: 'paths 必须是数组' });
    }

    const results = await Promise.all(paths.map(async (p) => {
      try {
        const full = path.resolve(String(p));
        const stat = await fsp.stat(full);

        if (!stat.isFile()) {
          return { path: p, content: '[不是文件]', error: true };
        }
        if (stat.size > MAX_FILE_BYTES) {
          return {
            path: p,
            content: '[文件过大，已跳过：' + (stat.size / 1048576).toFixed(1) + ' MB]',
            skipped: true,
          };
        }

        const content = await fsp.readFile(full, 'utf-8');
        return { path: p, content, mtime: stat.mtimeMs };
      } catch (e) {
        return { path: p, content: '[读取失败：' + e.message + ']', error: true };
      }
    }));

    res.json({ files: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════
   GET /api/file?path=xxx   （单文件，备用）
   ══════════════════════════════════════════════ */
app.get('/api/file', async (req, res) => {
  try {
    const full = path.resolve(String(req.query.path || ''));
    const stat = await fsp.stat(full);

    if (!stat.isFile()) {
      return res.status(400).json({ error: '不是文件' });
    }
    if (stat.size > MAX_FILE_BYTES) {
      return res.json({
        path: req.query.path,
        content: '[文件过大，已跳过]',
        skipped: true,
      });
    }

    const content = await fsp.readFile(full, 'utf-8');
    res.json({ path: req.query.path, content, mtime: stat.mtimeMs });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════
   启动
   ══════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log('');
  console.log('  codetree 已启动');
  console.log('  ──────────────────────────────────');
  console.log('  服务地址  http://localhost:' + PORT);
  console.log('  当前目录  ' + process.cwd());
  console.log('  用户主目录 ' + os.homedir());
  console.log('');
  console.log('  路径模式支持任意位置（~ 会自动展开为主目录）。');
  console.log('  只读操作，不会写入或修改任何文件。');
  console.log('');
});