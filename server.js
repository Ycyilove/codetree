import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

// 工作目录：通过命令行参数传入，默认当前目录
const WORK_DIR = path.resolve(process.argv[2] || process.cwd());

// 忽略的目录/文件
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage'
]);
const IGNORE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.mp4', '.mp3', '.zip', '.tar', '.gz', '.exe', '.dll',
  '.lock', '.log'
]);
const MAX_FILE_SIZE = 1024 * 1024; // 1MB，超过不读取内容

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// 安全校验：防止越权访问工作目录之外
function safeResolve(relPath) {
  const full = path.resolve(WORK_DIR, relPath || '.');
  if (!full.startsWith(WORK_DIR)) throw new Error('Forbidden');
  return full;
}

// 递归扫描文件树
function scanDir(dir, base = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      result.push({
        type: 'dir',
        name: entry.name,
        path: rel,
        children: scanDir(path.join(dir, entry.name), rel)
      });
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (IGNORE_EXTS.has(ext)) continue;
      const stat = fs.statSync(path.join(dir, entry.name));
      result.push({
        type: 'file',
        name: entry.name,
        path: rel,
        size: stat.size
      });
    }
  }
  return result;
}

// 获取文件树
app.get('/api/tree', (req, res) => {
  try {
    const tree = scanDir(WORK_DIR);
    res.json({ root: WORK_DIR, tree });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取单文件内容
app.get('/api/file', (req, res) => {
  try {
    const full = safeResolve(req.query.path);
    const stat = fs.statSync(full);
    if (stat.size > MAX_FILE_SIZE) {
      return res.json({ path: req.query.path, content: '[文件过大，已跳过]', skipped: true });
    }
    const content = fs.readFileSync(full, 'utf-8');
    res.json({ path: req.query.path, content, mtime: stat.mtimeMs });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 批量获取多个文件（POST 传路径数组）
app.post('/api/files', (req, res) => {
  try {
    const { paths } = req.body;
    if (!Array.isArray(paths)) return res.status(400).json({ error: 'paths must be array' });
    const files = paths.map(p => {
      try {
        const full = safeResolve(p);
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_SIZE) {
          return { path: p, content: '[文件过大，已跳过]', mtime: stat.mtimeMs };
        }
        return {
          path: p,
          content: fs.readFileSync(full, 'utf-8'),
          mtime: stat.mtimeMs
        };
      } catch (e) {
        return { path: p, content: `[读取失败: ${e.message}]`, error: true };
      }
    });
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Code Picker 已启动`);
  console.log(`📂 工作目录: ${WORK_DIR}`);
  console.log(`🌐 打开浏览器访问: http://localhost:${PORT}\n`);
});