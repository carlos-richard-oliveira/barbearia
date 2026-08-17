// security.js
// Camada de segurança contra invasões: bloqueio por tentativas de login e
// cabeçalhos HTTP de proteção básica. Diferente de uma trava feita só no
// navegador (JS do cliente), isso roda no servidor — ninguém consegue
// contornar abrindo o DevTools, porque a checagem nunca chega até o cliente.

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30 * 1000; // 30s de bloqueio após estourar as tentativas
const WINDOW_MS = 10 * 60 * 1000; // tentativas antigas (>10min) não contam mais

// Guarda em memória do processo: { key -> { count, firstAttempt, lockUntil } }
// Em produção com múltiplas instâncias (ex: Vercel serverless), isso reseta
// a cada cold start — para proteção robusta em escala, trocar por Redis
// (o projeto já usa Upstash Redis via db.js, então dá pra reaproveitar).
const attempts = new Map();

function keyFor(role, identifier, req) {
  // Usa o identificador de login (telefone/cpf/etc.) combinado com o IP,
  // para não deixar alguém travar a conta de outra pessoa só de propósito
  // (um ataque conhecido como "account lockout DoS").
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  return role + ':' + String(identifier || '').toLowerCase() + ':' + ip;
}

function checkLocked(role, identifier, req) {
  const key = keyFor(role, identifier, req);
  const rec = attempts.get(key);
  if (!rec) return { locked: false };
  const now = Date.now();
  if (rec.lockUntil && rec.lockUntil > now) {
    return { locked: true, retryAfterSeconds: Math.ceil((rec.lockUntil - now) / 1000) };
  }
  return { locked: false };
}

function recordFailure(role, identifier, req) {
  const key = keyFor(role, identifier, req);
  const now = Date.now();
  let rec = attempts.get(key);
  if (!rec || now - rec.firstAttempt > WINDOW_MS) {
    rec = { count: 0, firstAttempt: now, lockUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockUntil = now + LOCKOUT_MS;
    rec.count = 0;
    rec.firstAttempt = now;
  }
  attempts.set(key, rec);
}

function recordSuccess(role, identifier, req) {
  const key = keyFor(role, identifier, req);
  attempts.delete(key);
}

// Limpeza periódica pra não vazar memória com chaves antigas
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attempts.entries()) {
    if (now - rec.firstAttempt > WINDOW_MS && (!rec.lockUntil || rec.lockUntil < now)) {
      attempts.delete(key);
    }
  }
}, 5 * 60 * 1000).unref?.();

// Middleware de checagem: bloqueia a requisição ANTES de validar a senha,
// se aquele identificador já estiver em lockout.
function loginRateLimit(role, identifierField) {
  return (req, res, next) => {
    const identifier = req.body ? req.body[identifierField] : undefined;
    const status = checkLocked(role, identifier, req);
    if (status.locked) {
      return res.status(429).json({
        error: `Muitas tentativas de login incorretas. Tente novamente em ${status.retryAfterSeconds} segundos.`,
        retryAfterSeconds: status.retryAfterSeconds,
      });
    }
    next();
  };
}

// Cabeçalhos básicos de proteção HTTP (sem precisar instalar o pacote helmet)
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff'); // impede o navegador de "adivinhar" tipo de arquivo
  res.setHeader('X-Frame-Options', 'DENY'); // impede embutir o site num iframe de outro domínio (clickjacking)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
}

module.exports = { checkLocked, recordFailure, recordSuccess, loginRateLimit, securityHeaders };
