'use strict';

/**
 * Демонстрационное веб-приложение для лабораторной работы №3.
 *
 * Особенности реализации (см. README.md за подробностями):
 *  - Приложение НЕ занимается TLS/SSL — работает только по HTTP.
 *    Терминация TLS выполняется на уровне Nginx/Apache.
 *  - Все данные (заметки) хранятся во внешней БД PostgreSQL, общей
 *    для всех backend-узлов — падение одного узла приложения не
 *    приводит к потере доступа к данным.
 *  - Пользовательские сессии хранятся во внешнем Redis (а не в
 *    памяти процесса и не в локальных файлах) — сессия остаётся
 *    рабочей независимо от того, какой backend-узел обработает
 *    следующий запрос.
 *  - Каждый ответ содержит однозначную информацию о том, каким
 *    именно backend-узлом он был сформирован (hostname, INSTANCE_ID,
 *    PID, порт) — см. /api/info и подвал главной страницы.
 *  - Есть асинхронный эндпоинт-демонстрация /api/async-task,
 *    имитирующий обращение к внешнему сервису.
 */

const express = require('express');
const session = require('express-session');
// В connect-redis v7+ при использовании CommonJS (require) класс
// экспортируется как `default`, а не как именованный экспорт.
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');
const { Pool } = require('pg');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3000;
const INSTANCE_ID = process.env.INSTANCE_ID || os.hostname();
const HOSTNAME = os.hostname();
const PID = process.pid;

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://lab3:lab3pass@postgres:5432/lab3db';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // приложение находится за реверс-прокси

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// -----------------------------------------------------------------
// Внешнее хранилище №1: PostgreSQL — общие данные приложения.
// Пул подключений с ретраями: если одна из БД-реплик/сама БД
// временно недоступна, приложение не падает, а отдаёт понятную
// ошибку 503 и продолжает пытаться переподключиться на следующий
// запрос (важно — состояние не хранится локально на узле).
// -----------------------------------------------------------------
const pgPool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pgPool.on('error', (err) => {
  // Ошибки простаивающих клиентов пула не должны ронять процесс
  console.error('[postgres] unexpected pool error:', err.message);
});

async function ensureSchema() {
  const ddl = `
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_by_node VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
  await pgPool.query(ddl);
}

// Пытаемся создать схему при старте, но не блокируем запуск сервера,
// если БД временно недоступна — попробуем ещё раз при первом запросе.
ensureSchema().catch((err) =>
  console.error('[postgres] schema init failed (will retry lazily):', err.message)
);

// -----------------------------------------------------------------
// Внешнее хранилище №2: Redis — хранилище сессий.
// Явно НЕ используем MemoryStore и НЕ пишем сессии на диск ноды.
// -----------------------------------------------------------------
const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('[redis] client error:', err.message));

let redisReady = false;
redisClient
  .connect()
  .then(() => {
    redisReady = true;
    console.log('[redis] connected');
  })
  .catch((err) => console.error('[redis] initial connect failed:', err.message));

app.use(
  session({
    store: new RedisStore({ client: redisClient, prefix: 'lab3:sess:' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: 1000 * 60 * 30, // 30 минут
      httpOnly: true,
      // secure: true не выставляем — TLS терминируется на прокси,
      // а не в самом приложении (см. ограничение №3 задания).
      sameSite: 'lax',
    },
  })
);

// Счётчик визитов сессии + узел, который принял сессию первым —
// наглядно показывает, что сессия "переживает" переключение
// между backend-узлами балансировщиком.
app.use((req, res, next) => {
  if (!req.session.firstSeenNode) {
    req.session.firstSeenNode = INSTANCE_ID;
    req.session.visits = 0;
  }
  req.session.visits += 1;
  next();
});

// -----------------------------------------------------------------
// Вспомогательное: сведения об узле, обработавшем запрос
// -----------------------------------------------------------------
function nodeInfo(req) {
  return {
    instance_id: INSTANCE_ID,
    hostname: HOSTNAME,
    pid: PID,
    port: Number(PORT),
    server_time: new Date().toISOString(),
    request_id: req.headers['x-request-id'] || null,
    client_ip: req.ip,
    forwarded_for: req.headers['x-forwarded-for'] || null,
  };
}

// -----------------------------------------------------------------
// Маршруты
// -----------------------------------------------------------------

// Главная страница — HTML с явным указанием узла, сессии и заметок
app.get('/', async (req, res) => {
  let notes = [];
  let dbError = null;
  try {
    const result = await pgPool.query(
      'SELECT id, text, created_by_node, created_at FROM notes ORDER BY id DESC LIMIT 20'
    );
    notes = result.rows;
  } catch (err) {
    dbError = 'Хранилище PostgreSQL временно недоступно: ' + err.message;
  }

  res.render('index', {
    node: nodeInfo(req),
    session: {
      id: req.sessionID,
      visits: req.session.visits,
      firstSeenNode: req.session.firstSeenNode,
    },
    notes,
    dbError,
  });
});

// Добавление заметки в общее хранилище PostgreSQL
app.post('/notes', async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.redirect('/');
  try {
    await pgPool.query(
      'INSERT INTO notes (text, created_by_node) VALUES ($1, $2)',
      [text, INSTANCE_ID]
    );
  } catch (err) {
    console.error('[postgres] insert failed:', err.message);
    // При недоступности БД просто пытаемся пересоздать схему на будущее
    ensureSchema().catch(() => {});
  }
  res.redirect('/');
});

// JSON API: список заметок
app.get('/api/notes', async (req, res) => {
  try {
    const result = await pgPool.query(
      'SELECT id, text, created_by_node, created_at FROM notes ORDER BY id DESC LIMIT 100'
    );
    res.json({ node: nodeInfo(req), notes: result.rows });
  } catch (err) {
    res.status(503).json({
      node: nodeInfo(req),
      error: 'database_unavailable',
      message: err.message,
    });
  }
});

// JSON API: однозначная информация об узле, обработавшем запрос
app.get('/api/info', (req, res) => {
  res.json(nodeInfo(req));
});

// Health-check для балансировщика (L7 healthcheck в Nginx/Apache)
app.get('/api/health', async (req, res) => {
  const health = {
    node: INSTANCE_ID,
    status: 'ok',
    checks: { postgres: 'unknown', redis: 'unknown' },
  };

  try {
    await pgPool.query('SELECT 1');
    health.checks.postgres = 'ok';
  } catch (err) {
    health.checks.postgres = 'fail';
    health.status = 'degraded';
  }

  health.checks.redis = redisClient.isReady ? 'ok' : 'fail';
  if (!redisClient.isReady) health.status = 'degraded';

  const httpCode = health.status === 'ok' ? 200 : 503;
  res.status(httpCode).json(health);
});

// Демонстрация асинхронной обработки запроса (например, имитация
// обращения к внешнему сервису/очереди с задержкой)
app.get('/api/async-task', async (req, res) => {
  const start = Date.now();
  const delayMs = Math.floor(200 + Math.random() * 800);

  const simulateExternalCall = () =>
    new Promise((resolve) => setTimeout(() => resolve({ ok: true }), delayMs));

  try {
    const result = await simulateExternalCall();
    res.json({
      node: nodeInfo(req),
      task_result: result,
      duration_ms: Date.now() - start,
    });
  } catch (err) {
    res.status(500).json({ node: nodeInfo(req), error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[${INSTANCE_ID}] server listening on port ${PORT} (pid ${PID})`);
});
