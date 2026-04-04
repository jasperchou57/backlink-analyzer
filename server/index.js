const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 21891;

// 数据目录
const DATA_DIR = path.join(require('os').homedir(), 'backlink-analyzer-data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'backlink-analyzer.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

// ─── 初始化表结构 ───
// Backlink Analyzer 使用 KV 存储模式，每条数据以 key-value 形式存储
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT,
    updatedAt TEXT
  );
`);

app.use(cors());
app.use(express.json({ limit: '100mb' }));

// ─── 健康检查 ───
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, dbPath: DB_PATH });
});

// ─── 通用 KV 操作 ───

// 获取值
app.get('/api/kv/:key', (req, res) => {
  const row = db.prepare('SELECT value, updatedAt FROM kv WHERE key = ?').get(req.params.key);
  if (row) {
    try {
      res.json({ value: JSON.parse(row.value), updatedAt: row.updatedAt });
    } catch {
      res.json({ value: row.value, updatedAt: row.updatedAt });
    }
  } else {
    res.json({ value: null, updatedAt: null });
  }
});

// 设置值
app.put('/api/kv/:key', (req, res) => {
  const key = req.params.key;
  const value = JSON.stringify(req.body.value);
  const updatedAt = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO kv (key, value, updatedAt) VALUES (?, ?, ?)').run(key, value, updatedAt);
  res.json({ ok: true });
});

// 删除值
app.delete('/api/kv/:key', (req, res) => {
  db.prepare('DELETE FROM kv WHERE key = ?').run(req.params.key);
  res.json({ ok: true });
});

// 清空所有
app.post('/api/kv/clear', (req, res) => {
  db.exec('DELETE FROM kv');
  res.json({ ok: true });
});

// 列出所有 key
app.get('/api/kv', (req, res) => {
  const rows = db.prepare('SELECT key, updatedAt FROM kv').all();
  res.json(rows);
});

// ─── 批量操作 ───

// 批量获取
app.post('/api/kv/batch-get', (req, res) => {
  const keys = req.body.keys || [];
  const result = {};
  const stmt = db.prepare('SELECT key, value, updatedAt FROM kv WHERE key = ?');
  for (const key of keys) {
    const row = stmt.get(key);
    if (row) {
      try {
        result[key] = { value: JSON.parse(row.value), updatedAt: row.updatedAt };
      } catch {
        result[key] = { value: row.value, updatedAt: row.updatedAt };
      }
    }
  }
  res.json(result);
});

// 批量设置
app.post('/api/kv/batch-set', (req, res) => {
  const entries = req.body.entries || {};
  const stmt = db.prepare('INSERT OR REPLACE INTO kv (key, value, updatedAt) VALUES (?, ?, ?)');
  const updatedAt = new Date().toISOString();
  const batchSet = db.transaction((pairs) => {
    for (const [key, value] of pairs) {
      stmt.run(key, JSON.stringify(value), updatedAt);
    }
  });
  batchSet(Object.entries(entries));
  res.json({ ok: true, count: Object.keys(entries).length });
});

// ─── 启动 ───
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Backlink Server] 运行中 http://127.0.0.1:${PORT}`);
  console.log(`[Backlink Server] 数据库路径: ${DB_PATH}`);
});
