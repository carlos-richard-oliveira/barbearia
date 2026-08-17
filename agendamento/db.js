// db.js - armazenamento dos dados (agendamentos, clientes e barbeiros)
//
// Prioridade de armazenamento:
// 1. Postgres (Neon) — se DATABASE_URL estiver definida. Este é o banco de
//    dados "de verdade", com tabelas relacionais (barbers, users, bookings).
// 2. Upstash Redis — se KV_REST_API_URL/TOKEN estiverem definidos (fallback
//    antigo, compatível com Vercel serverless sem Postgres configurado).
// 3. Arquivo local data.json — fallback para rodar localmente sem configurar nada.
//
// A interface pública (load/save) continua igual para o resto do server.js
// não precisar mudar: sempre devolve/recebe { bookings: [], users: [], barbers: [] }.

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');
const REDIS_KEY = 'agenda-data';

const USE_POSTGRES = !!process.env.DATABASE_URL;
const USE_REDIS = !USE_POSTGRES && !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

// ---------- Postgres (Neon) ----------
let pgPool = null;
function getPg() {
  if (!pgPool) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pgPool;
}

function rowToBarber(r) {
  return {
    id: r.id, name: r.name, specialty: r.specialty, phone: r.phone,
    passwordHash: r.password_hash, active: r.active, createdAt: r.created_at,
    whatsappPhone: r.whatsapp_phone, googleRefreshToken: r.google_refresh_token, googleEmail: r.google_email,
  };
}
function rowToUser(r) {
  return { id: r.id, cpf: r.cpf, name: r.name, phone: r.phone, passwordHash: r.password_hash, createdAt: r.created_at };
}
function rowToBooking(r) {
  return {
    id: r.id, userId: r.user_id, date: r.date, time: r.time, duration: r.duration,
    services: r.services, barberId: r.barber_id, barberName: r.barber_name,
    name: r.name, phone: r.phone, cpf: r.cpf, email: r.email, notes: r.notes,
    status: r.status, createdByBarber: r.created_by_barber, googleEventId: r.google_event_id,
    createdAt: r.created_at,
    price: r.price !== null && r.price !== undefined ? Number(r.price) : null,
    paid: r.paid, paymentMethod: r.payment_method,
    machineFee: r.machine_fee !== null && r.machine_fee !== undefined ? Number(r.machine_fee) : null,
    storeShare: r.store_share !== null && r.store_share !== undefined ? Number(r.store_share) : null,
    barberShare: r.barber_share !== null && r.barber_share !== undefined ? Number(r.barber_share) : null,
    paidAt: r.paid_at,
  };
}

async function loadPostgres() {
  const pool = getPg();
  const [barbersRes, usersRes, bookingsRes, settingsRes] = await Promise.all([
    pool.query('SELECT * FROM barbers ORDER BY created_at'),
    pool.query('SELECT * FROM users ORDER BY created_at'),
    pool.query(
      `SELECT id, user_id, to_char(date,'YYYY-MM-DD') as date, time, duration, services,
              barber_id, barber_name, name, phone, cpf, email, notes, status,
              created_by_barber, google_event_id, created_at,
              price, paid, payment_method, machine_fee, store_share, barber_share, paid_at
       FROM bookings ORDER BY created_at`
    ),
    pool.query('SELECT * FROM payment_settings WHERE id = 1'),
  ]);
  const s = settingsRes.rows[0] || {};
  return {
    barbers: barbersRes.rows.map(rowToBarber),
    users: usersRes.rows.map(rowToUser),
    bookings: bookingsRes.rows.map(rowToBooking),
    paymentSettings: {
      storeCommissionPct: Number(s.store_commission_pct ?? 30),
      feePixPct: Number(s.fee_pix_pct ?? 0),
      feeDebitoPct: Number(s.fee_debito_pct ?? 1.99),
      feeCreditoPct: Number(s.fee_credito_pct ?? 3.49),
      feeDinheiroPct: Number(s.fee_dinheiro_pct ?? 0),
    },
  };
}

// Estratégia simples e segura: cada save() substitui o conteúdo das tabelas
// pelo estado atual em memória, dentro de uma transação. Para o volume de
// dados de uma barbearia isso é rápido e evita ter que escrever lógica de
// diff/upsert linha a linha.
async function savePostgres(data) {
  const pool = getPg();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM bookings');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM barbers');

    for (const b of data.barbers || []) {
      await client.query(
        `INSERT INTO barbers (id, name, specialty, phone, password_hash, active, created_at, whatsapp_phone, google_refresh_token, google_email)
         VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, now()), $8, $9, $10)`,
        [b.id, b.name, b.specialty || null, b.phone, b.passwordHash, b.active !== false, b.createdAt || null,
         b.whatsappPhone || null, b.googleRefreshToken || null, b.googleEmail || null]
      );
    }
    for (const u of data.users || []) {
      await client.query(
        `INSERT INTO users (id, cpf, name, phone, password_hash, created_at)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6, now()))`,
        [u.id, u.cpf, u.name, u.phone, u.passwordHash, u.createdAt || null]
      );
    }
    for (const bk of data.bookings || []) {
      await client.query(
        `INSERT INTO bookings (id, user_id, date, time, duration, services, barber_id, barber_name,
                                name, phone, cpf, email, notes, status, created_by_barber, google_event_id, created_at,
                                price, paid, payment_method, machine_fee, store_share, barber_share, paid_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, COALESCE($17, now()), $18,$19,$20,$21,$22,$23,$24)`,
        [
          bk.id, bk.userId || null, bk.date, bk.time, bk.duration, JSON.stringify(bk.services || []),
          bk.barberId || null, bk.barberName || null, bk.name, bk.phone, bk.cpf || null, bk.email || null,
          bk.notes || null, bk.status || 'confirmado', !!bk.createdByBarber, bk.googleEventId || null, bk.createdAt || null,
          bk.price ?? null, !!bk.paid, bk.paymentMethod || null, bk.machineFee ?? null, bk.storeShare ?? null, bk.barberShare ?? null, bk.paidAt || null,
        ]
      );
    }
    if (data.paymentSettings) {
      const ps = data.paymentSettings;
      await client.query(
        `UPDATE payment_settings SET store_commission_pct=$1, fee_pix_pct=$2, fee_debito_pct=$3, fee_credito_pct=$4, fee_dinheiro_pct=$5 WHERE id = 1`,
        [ps.storeCommissionPct, ps.feePixPct, ps.feeDebitoPct, ps.feeCreditoPct, ps.feeDinheiroPct]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Upstash Redis (fallback antigo) ----------
let redisClient = null;
function getRedis() {
  if (!redisClient) {
    const { Redis } = require('@upstash/redis');
    redisClient = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
  return redisClient;
}

// ---------- Arquivo local (dev) ----------
const DEFAULT_PAYMENT_SETTINGS = {
  storeCommissionPct: 30, feePixPct: 0, feeDebitoPct: 1.99, feeCreditoPct: 3.49, feeDinheiroPct: 0,
};

function loadLocal() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ bookings: [], users: [], barbers: [], paymentSettings: DEFAULT_PAYMENT_SETTINGS }, null, 2));
  }
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!data.users) data.users = [];
  if (!data.barbers) data.barbers = [];
  if (!data.paymentSettings) data.paymentSettings = { ...DEFAULT_PAYMENT_SETTINGS };
  return data;
}
function saveLocal(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

async function load() {
  if (USE_POSTGRES) return loadPostgres();
  if (USE_REDIS) {
    const data = await getRedis().get(REDIS_KEY);
    if (!data) return { bookings: [], users: [], barbers: [], paymentSettings: { ...DEFAULT_PAYMENT_SETTINGS } };
    if (!data.users) data.users = [];
    if (!data.barbers) data.barbers = [];
    if (!data.paymentSettings) data.paymentSettings = { ...DEFAULT_PAYMENT_SETTINGS };
    return data;
  }
  return loadLocal();
}

async function save(data) {
  if (USE_POSTGRES) return savePostgres(data);
  if (USE_REDIS) {
    await getRedis().set(REDIS_KEY, data);
    return;
  }
  saveLocal(data);
}

module.exports = { load, save };
