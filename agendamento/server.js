require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');
const gcal = require('./google-calendar');
const whatsapp = require('./whatsapp');
const { onlyDigits, isValidCPF, formatCPF } = require('./cpf');
const security = require('./security');

const app = express();
app.use(cors());
app.use(express.json());
app.use(security.securityHeaders);
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-troque-isso';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Meu Negócio';

// ===== Regras de horário de funcionamento =====
// 0 = domingo, 1 = segunda, 2 = terça, ... 6 = sábado
const OPEN_WEEKDAYS = [2, 3, 4, 5, 6]; // terça a sábado
const OPEN_HOUR = 10; // 10h
const CLOSE_HOUR = 18; // 18h
const START_GRID_MINUTES = 15; // horários de início disponíveis a cada 15 minutos
const DEFAULT_DURATION = 60; // usado como fallback para agendamentos antigos sem duração salva

// ===== Serviços oferecidos =====
const SERVICES = [
  { id: 'corte', name: 'Corte de Cabelo', minutes: 30, price: 60 },
  { id: 'barba', name: 'Barba', minutes: 30, price: 40 },
  { id: 'cabelo_barba', name: 'Cabelo e Barba', minutes: 60, price: 90 },
  { id: 'barboterapia', name: 'Barboterapia', minutes: 60, price: 80 },
  { id: 'terapia_capilar', name: 'Terapia Capilar', minutes: 60, price: 80 },
  { id: 'depilacao_nasal', name: 'Depilação Nasal', minutes: 15, price: 20 },
  { id: 'depilacao_ouvido', name: 'Depilação Ouvido', minutes: 15, price: 20 },
  { id: 'combo_depilacao', name: 'Combo Depilação (Nasal + Ouvido)', minutes: 25, price: 35 },
];

const PAYMENT_METHODS = ['pix', 'debito', 'credito', 'dinheiro'];

function isDateOpen(dateStr) {
  // dateStr no formato YYYY-MM-DD, interpretado em horário local (evita bug de fuso)
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return OPEN_WEEKDAYS.includes(date.getDay());
}

// Gera os horários de início possíveis (grade de 15 em 15 min) para uma
// duração de atendimento específica, garantindo que o serviço termine até o
// fechamento (CLOSE_HOUR).
function generateStartTimes(durationMinutes) {
  const times = [];
  const openMinutes = OPEN_HOUR * 60;
  const closeMinutes = CLOSE_HOUR * 60;
  for (let m = openMinutes; m + durationMinutes <= closeMinutes; m += START_GRID_MINUTES) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    times.push(`${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }
  return times;
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// Verifica se dois intervalos [aStart,aEnd) e [bStart,bEnd) (em minutos) se sobrepõem
function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function resolveServices(serviceIds) {
  if (!Array.isArray(serviceIds) || serviceIds.length === 0) return null;
  const resolved = [];
  for (const id of serviceIds) {
    const service = SERVICES.find((s) => s.id === id);
    if (!service) return null; // id inválido
    resolved.push(service);
  }
  return resolved;
}

// ===== Autenticação do admin =====
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
    next();
  } catch {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
}

// ===== Autenticação do usuário (cliente) =====
async function requireUser(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Faça login para agendar um horário.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'user') return res.status(403).json({ error: 'Login inválido.' });
    const data = await db.load();
    const user = data.users.find((u) => u.id === payload.userId);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado. Faça login novamente.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }
}

// ===== Autenticação do barbeiro =====
async function requireBarber(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Faça login para acessar sua agenda.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'barber') return res.status(403).json({ error: 'Login inválido.' });
    const data = await db.load();
    const barber = data.barbers.find((b) => b.id === payload.barberId);
    if (!barber) return res.status(401).json({ error: 'Barbeiro não encontrado. Faça login novamente.' });
    req.barber = barber;
    next();
  } catch {
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }
}

// ===== Rotas públicas =====

app.get('/api/config', (req, res) => {
  res.json({
    businessName: BUSINESS_NAME,
    openWeekdays: OPEN_WEEKDAYS,
    openHour: OPEN_HOUR,
    closeHour: CLOSE_HOUR,
  });
});

// Lista os serviços disponíveis e suas durações
app.get('/api/services', (req, res) => {
  res.json({ services: SERVICES });
});

// Lista os barbeiros ativos (para o cliente escolher)
app.get('/api/barbers', async (req, res) => {
  const data = await db.load();
  const active = data.barbers
    .filter((b) => b.active !== false)
    .map(({ passwordHash, ...rest }) => rest);
  res.json({ barbers: active });
});

// Retorna os horários de início disponíveis para um dia, barbeiro e duração
// total (soma dos serviços escolhidos) específicos.
app.get('/api/slots', async (req, res) => {
  const { date, barberId, duration } = req.query; // duration em minutos
  if (!date) return res.status(400).json({ error: 'Informe a data (date=YYYY-MM-DD).' });
  if (!barberId) return res.status(400).json({ error: 'Escolha um barbeiro primeiro.' });

  const durationMinutes = parseInt(duration, 10);
  if (!durationMinutes || durationMinutes <= 0) {
    return res.status(400).json({ error: 'Escolha ao menos um serviço primeiro.' });
  }

  if (!isDateOpen(date)) {
    return res.json({ date, open: false, slots: [] });
  }

  const data = await db.load();
  const bookingsOfDay = data.bookings.filter(
    (b) => b.date === date && b.barberId === barberId && b.status !== 'cancelado'
  );

  // Consulta a agenda Google PESSOAL desse barbeiro (se ele tiver conectado a
  // própria conta) por eventos externos que bloqueiam o horário.
  let googleBusy = [];
  try {
    const barberForSlots = data.barbers.find((b) => b.id === barberId);
    if (barberForSlots && barberForSlots.googleRefreshToken) {
      const [y, m, d] = date.split('-').map(Number);
      const dayStart = new Date(y, m - 1, d, 0, 0, 0).toISOString();
      const dayEnd = new Date(y, m - 1, d, 23, 59, 59).toISOString();
      googleBusy = await gcal.getBusyIntervals(barberForSlots.googleRefreshToken, dayStart, dayEnd);
    }
  } catch (err) {
    console.error('Erro ao consultar Google Calendar do barbeiro:', err.message);
  }

  const candidateStarts = generateStartTimes(durationMinutes);
  const slots = candidateStarts.map((time) => {
    const startMin = timeToMinutes(time);
    const endMin = startMin + durationMinutes;

    const blockedByBooking = bookingsOfDay.some((b) => {
      const bStart = timeToMinutes(b.time);
      const bEnd = bStart + (b.duration || DEFAULT_DURATION);
      return intervalsOverlap(startMin, endMin, bStart, bEnd);
    });

    const slotStart = new Date(`${date}T${time}:00`);
    const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);
    const blockedByGoogle = googleBusy.some((busy) => {
      const busyStart = new Date(busy.start);
      const busyEnd = new Date(busy.end);
      return slotStart < busyEnd && slotEnd > busyStart;
    });

    return {
      time,
      available: !blockedByBooking && !blockedByGoogle,
    };
  });

  res.json({ date, open: true, durationMinutes, slots });
});

// ===== Cadastro do cliente (nome + CPF + telefone + senha) =====
// Cada CPF só pode ter um cadastro.
app.post('/api/signup', async (req, res) => {
  const { name, cpf, phone, password } = req.body;

  if (!name || !name.trim() || !cpf || !phone || !password) {
    return res.status(400).json({ error: 'Preencha nome, CPF, telefone e senha.' });
  }

  if (!isValidCPF(cpf)) {
    return res.status(400).json({ error: 'CPF inválido. Confira os números digitados.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
  }

  const cleanCpf = onlyDigits(cpf);
  const cleanPhone = onlyDigits(phone);
  const cleanName = name.trim();

  const data = await db.load();
  const existing = data.users.find((u) => u.cpf === cleanCpf);
  if (existing) {
    return res.status(409).json({ error: 'Já existe um cadastro com esse CPF. Faça login em vez de se cadastrar.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    cpf: cleanCpf,
    name: cleanName,
    phone: cleanPhone,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  await db.save(data);

  const token = jwt.sign({ role: 'user', userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.status(201).json({
    token,
    user: { id: user.id, name: user.name, phone: user.phone, cpf: formatCPF(user.cpf) },
  });
});

// ===== Login do cliente (CPF + senha) =====
app.post('/api/login', security.loginRateLimit('user', 'cpf'), async (req, res) => {
  const { cpf, password } = req.body;

  if (!cpf || !password) {
    return res.status(400).json({ error: 'Preencha CPF e senha.' });
  }

  const cleanCpf = onlyDigits(cpf);
  const data = await db.load();
  const user = data.users.find((u) => u.cpf === cleanCpf);

  if (!user) {
    security.recordFailure('user', cpf, req);
    return res.status(401).json({ error: 'CPF não cadastrado. Clique em "Cadastre-se" para criar sua conta.' });
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash || '');
  if (!validPassword) {
    security.recordFailure('user', cpf, req);
    return res.status(401).json({ error: 'CPF ou senha incorretos.' });
  }

  security.recordSuccess('user', cpf, req);
  const token = jwt.sign({ role: 'user', userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    user: { id: user.id, name: user.name, phone: user.phone, cpf: formatCPF(user.cpf) },
  });
});

// Cria um novo agendamento — exige login, barbeiro e ao menos um serviço
app.post('/api/book', requireUser, async (req, res) => {
  const { date, time, barberId, serviceIds, email, notes } = req.body;
  const { name, phone, cpf } = req.user;

  if (!date || !time || !barberId) {
    return res.status(400).json({ error: 'Escolha um barbeiro, uma data e um horário.' });
  }

  const services = resolveServices(serviceIds);
  if (!services) {
    return res.status(400).json({ error: 'Escolha ao menos um serviço válido.' });
  }
  const durationMinutes = services.reduce((sum, s) => sum + s.minutes, 0);

  const data = await db.load();
  const barber = data.barbers.find((b) => b.id === barberId && b.active !== false);
  if (!barber) {
    return res.status(400).json({ error: 'Barbeiro inválido ou indisponível.' });
  }

  if (!isDateOpen(date)) {
    return res.status(400).json({ error: 'Não atendemos nesse dia (só de terça a sábado).' });
  }

  if (!generateStartTimes(durationMinutes).includes(time)) {
    return res.status(400).json({ error: 'Horário inválido para a duração escolhida. Atendemos das 10h às 18h.' });
  }

  // Não permite marcar em datas/horários passados
  const slotDateTime = new Date(`${date}T${time}:00`);
  if (slotDateTime < new Date()) {
    return res.status(400).json({ error: 'Não é possível agendar em um horário que já passou.' });
  }

  const startMin = timeToMinutes(time);
  const endMin = startMin + durationMinutes;

  const conflict = data.bookings.find((b) => {
    if (b.date !== date || b.barberId !== barberId || b.status === 'cancelado') return false;
    const bStart = timeToMinutes(b.time);
    const bEnd = bStart + (b.duration || DEFAULT_DURATION);
    return intervalsOverlap(startMin, endMin, bStart, bEnd);
  });
  if (conflict) {
    return res.status(409).json({ error: 'Esse horário com esse barbeiro acabou de ser reservado por outra pessoa. Escolha outro.' });
  }

  const alreadyBooked = data.bookings.find(
    (b) => b.userId === req.user.id && b.date === date && b.status !== 'cancelado'
  );
  if (alreadyBooked) {
    return res.status(409).json({ error: `Você já tem um horário marcado nesse dia, às ${alreadyBooked.time}. Peça ao administrador para remarcar se precisar mudar.` });
  }

  // Confere também a agenda Google pessoal do barbeiro antes de confirmar
  if (barber.googleRefreshToken) {
    try {
      const dayStart = new Date(`${date}T00:00:00`).toISOString();
      const dayEnd = new Date(`${date}T23:59:59`).toISOString();
      const busy = await gcal.getBusyIntervals(barber.googleRefreshToken, dayStart, dayEnd);
      const slotEnd = new Date(slotDateTime.getTime() + durationMinutes * 60000);
      const blocked = busy.some((b) => {
        const bs = new Date(b.start);
        const be = new Date(b.end);
        return slotDateTime < be && slotEnd > bs;
      });
      if (blocked) {
        return res.status(409).json({ error: 'Esse horário está indisponível na agenda do barbeiro. Escolha outro.' });
      }
    } catch (err) {
      console.error('Aviso: não foi possível checar o Google Calendar do barbeiro antes de reservar:', err.message);
    }
  }

  const serviceNames = services.map((s) => s.name).join(', ');

  const booking = {
    id: uuidv4(),
    userId: req.user.id,
    date,
    time,
    duration: durationMinutes,
    services,
    barberId: barber.id,
    barberName: barber.name,
    name,
    phone,
    cpf,
    email: email || null,
    notes: notes || null,
    status: 'confirmado',
    googleEventId: null,
    createdAt: new Date().toISOString(),
    price: services.reduce((sum, s) => sum + (s.price || 0), 0),
    paid: false,
  };

  try {
    booking.googleEventId = await gcal.createEvent(barber.googleRefreshToken, {
      date,
      time,
      durationMinutes,
      summary: `${barber.name} — ${name} (${serviceNames})`,
      description: `Barbeiro: ${barber.name}\nServiços: ${serviceNames}\nDuração: ${durationMinutes} min\nCPF: ${formatCPF(cpf)}\nTelefone: ${phone}${email ? `\nE-mail: ${email}` : ''}${notes ? `\nObs: ${notes}` : ''}`,
    });
  } catch (err) {
    console.error('Erro ao criar evento no Google Calendar:', err.message);
  }

  data.bookings.push(booking);
  await db.save(data);

  notifyBarberWhatsapp(barber, `Novo agendamento: ${name} — ${date} às ${time} (${serviceNames}).`);

  res.status(201).json({ message: 'Agendamento confirmado!', booking });
});

// ===== Autenticação do admin =====
app.post('/api/admin/login', security.loginRateLimit('admin', '_admin'), (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    security.recordFailure('admin', '_admin', req);
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  security.recordSuccess('admin', '_admin', req);
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// ===== Rotas exclusivas do admin =====

// Lista todos os agendamentos (para o painel do admin)
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  const data = await db.load();
  const sorted = [...data.bookings]
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
    .map((b) => ({ ...b, cpf: b.cpf ? formatCPF(b.cpf) : null }));
  res.json({ bookings: sorted });
});

// Remarca um agendamento — SOMENTE o admin pode fazer isso
app.put('/api/admin/bookings/:id/reschedule', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { date, time, barberId } = req.body;

  if (!date || !time) {
    return res.status(400).json({ error: 'Informe a nova data e horário.' });
  }
  if (!isDateOpen(date)) {
    return res.status(400).json({ error: 'Esse dia está fora do horário de funcionamento (terça a sábado).' });
  }

  const data = await db.load();
  const booking = data.bookings.find((b) => b.id === id);
  if (!booking) return res.status(404).json({ error: 'Agendamento não encontrado.' });

  const durationMinutes = booking.duration || DEFAULT_DURATION;
  if (!generateStartTimes(durationMinutes).includes(time)) {
    return res.status(400).json({ error: `Horário inválido para a duração do serviço (${durationMinutes} min). Atendemos das 10h às 18h.` });
  }

  let targetBarberId = booking.barberId;
  if (barberId && barberId !== booking.barberId) {
    const newBarber = data.barbers.find((b) => b.id === barberId);
    if (!newBarber) return res.status(400).json({ error: 'Barbeiro inválido.' });
    targetBarberId = newBarber.id;
    booking.barberId = newBarber.id;
    booking.barberName = newBarber.name;
  }

  const startMin = timeToMinutes(time);
  const endMin = startMin + durationMinutes;
  const conflict = data.bookings.find((b) => {
    if (b.id === id || b.date !== date || b.barberId !== targetBarberId || b.status === 'cancelado') return false;
    const bStart = timeToMinutes(b.time);
    const bEnd = bStart + (b.duration || DEFAULT_DURATION);
    return intervalsOverlap(startMin, endMin, bStart, bEnd);
  });
  if (conflict) {
    return res.status(409).json({ error: 'Já existe outro agendamento nesse novo horário.' });
  }

  booking.date = date;
  booking.time = time;

  try {
    const eventBarber = data.barbers.find((b) => b.id === booking.barberId);
    if (booking.googleEventId && eventBarber?.googleRefreshToken) {
      await gcal.updateEvent(eventBarber.googleRefreshToken, booking.googleEventId, { date, time, durationMinutes });
    }
  } catch (err) {
    console.error('Erro ao atualizar evento no Google Calendar:', err.message);
  }

  await db.save(data);
  res.json({ message: 'Agendamento remarcado com sucesso.', booking });
});

// Cancela um agendamento — também restrito ao admin
app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const data = await db.load();
  const booking = data.bookings.find((b) => b.id === id);
  if (!booking) return res.status(404).json({ error: 'Agendamento não encontrado.' });

  booking.status = 'cancelado';

  try {
    const eventBarber = data.barbers.find((b) => b.id === booking.barberId);
    if (booking.googleEventId && eventBarber?.googleRefreshToken) {
      await gcal.deleteEvent(eventBarber.googleRefreshToken, booking.googleEventId);
    }
  } catch (err) {
    console.error('Erro ao cancelar evento no Google Calendar:', err.message);
  }

  await db.save(data);
  res.json({ message: 'Agendamento cancelado.' });
});

// ===== Login do barbeiro (telefone + senha) =====
app.post('/api/barber/login', security.loginRateLimit('barber', 'phone'), async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: 'Preencha telefone e senha.' });
  }

  const cleanPhone = onlyDigits(phone);
  const data = await db.load();
  const barber = data.barbers.find((b) => b.phone === cleanPhone);

  if (!barber || !barber.passwordHash) {
    security.recordFailure('barber', phone, req);
    return res.status(401).json({ error: 'Telefone não cadastrado ou sem login configurado. Fale com o administrador.' });
  }
  if (barber.active === false) {
    return res.status(403).json({ error: 'Seu acesso está desativado. Fale com o administrador.' });
  }

  const validPassword = await bcrypt.compare(password, barber.passwordHash);
  if (!validPassword) {
    security.recordFailure('barber', phone, req);
    return res.status(401).json({ error: 'Telefone ou senha incorretos.' });
  }

  security.recordSuccess('barber', phone, req);
  const token = jwt.sign({ role: 'barber', barberId: barber.id }, JWT_SECRET, { expiresIn: '12h' });
  res.json({
    token,
    barber: { id: barber.id, name: barber.name, specialty: barber.specialty, phone: barber.phone },
  });
});

// Lista os próprios agendamentos do barbeiro logado
app.get('/api/barber/bookings', requireBarber, async (req, res) => {
  const data = await db.load();
  const bookings = data.bookings
    .filter((b) => b.barberId === req.barber.id)
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
    .map((b) => ({ ...b, cpf: b.cpf ? formatCPF(b.cpf) : null }));
  res.json({ bookings });
});

// ===== Cada barbeiro conecta o PRÓPRIO WhatsApp e o PRÓPRIO Google Calendar =====
// (diferente de uma conta única compartilhada pela loja toda)

// Envia uma notificação de WhatsApp pro barbeiro quando ele tem WhatsApp
// conectado. Nunca deixa uma falha de WhatsApp derrubar o agendamento.
async function notifyBarberWhatsapp(barber, text) {
  if (!barber || !barber.whatsappPhone) return;
  try {
    await whatsapp.sendMessage(barber.whatsappPhone, text);
  } catch (err) {
    console.error('Aviso: não foi possível notificar o barbeiro por WhatsApp:', err.message);
  }
}

// Retorna o perfil do barbeiro logado, incluindo status das conexões
app.get('/api/barber/me', requireBarber, (req, res) => {
  const b = req.barber;
  res.json({
    id: b.id,
    name: b.name,
    phone: b.phone,
    whatsappPhone: b.whatsappPhone || null,
    googleConnected: !!b.googleRefreshToken,
    googleEmail: b.googleEmail || null,
  });
});

// Conecta/atualiza o WhatsApp pessoal do barbeiro (usado para notificações)
app.put('/api/barber/whatsapp', requireBarber, async (req, res) => {
  const { phone } = req.body;
  const cleanPhone = onlyDigits(phone);
  if (!cleanPhone || cleanPhone.length < 10) {
    return res.status(400).json({ error: 'Informe um número de WhatsApp válido, com DDD.' });
  }
  const data = await db.load();
  const barber = data.barbers.find((b) => b.id === req.barber.id);
  barber.whatsappPhone = cleanPhone;
  await db.save(data);
  notifyBarberWhatsapp(barber, 'WhatsApp conectado com sucesso! Você receberá avisos de novos agendamentos por aqui.');
  res.json({ message: 'WhatsApp conectado.', whatsappPhone: cleanPhone });
});

// Desconecta o WhatsApp do barbeiro
app.delete('/api/barber/whatsapp', requireBarber, async (req, res) => {
  const data = await db.load();
  const barber = data.barbers.find((b) => b.id === req.barber.id);
  barber.whatsappPhone = null;
  await db.save(data);
  res.json({ message: 'WhatsApp desconectado.' });
});

// Gera a URL do Google para o barbeiro autorizar o acesso à PRÓPRIA agenda.
// Como é um link clicado no navegador (não uma chamada fetch com header),
// o token de login vem como query param em vez de Authorization: Bearer.
app.get('/api/barber/google/connect', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).send('Faça login novamente e tente conectar o Google de novo.');
  let barberId;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'barber') throw new Error('invalid role');
    barberId = payload.barberId;
  } catch {
    return res.status(401).send('Sessão inválida ou expirada. Faça login novamente.');
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('O Google Calendar ainda não foi configurado neste servidor (faltam as credenciais do Google). Fale com o administrador.');
  }
  // O "state" carrega o ID do barbeiro de forma assinada, para o callback
  // saber a quem pertence o token que o Google vai devolver.
  const state = jwt.sign({ barberId }, JWT_SECRET, { expiresIn: '10m' });
  res.redirect(gcal.getAuthUrl(state));
});

// Callback que o Google chama depois que o barbeiro autoriza o acesso
app.get('/api/barber/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`Conexão cancelada ou recusada: ${error}. Pode fechar esta aba e tentar de novo.`);
  }
  let barberId;
  try {
    const payload = jwt.verify(state, JWT_SECRET);
    barberId = payload.barberId;
  } catch {
    return res.status(400).send('Não foi possível validar essa conexão (link expirado). Feche esta aba e tente conectar de novo.');
  }
  try {
    const { refreshToken, email } = await gcal.exchangeCodeForTokens(code);
    const data = await db.load();
    const barber = data.barbers.find((b) => b.id === barberId);
    if (!barber) return res.status(404).send('Barbeiro não encontrado.');
    barber.googleRefreshToken = refreshToken;
    barber.googleEmail = email;
    await db.save(data);
    notifyBarberWhatsapp(barber, `Google Calendar conectado (${email}). Seus agendamentos agora sincronizam automaticamente.`);
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h2>Google Calendar conectado!</h2><p>Pode fechar esta aba e voltar para a sua agenda.</p></body></html>');
  } catch (err) {
    console.error('Erro ao conectar Google Calendar do barbeiro:', err.message);
    res.status(500).send(`Não foi possível concluir a conexão: ${err.message}`);
  }
});

// Desconecta o Google Calendar do barbeiro
app.delete('/api/barber/google', requireBarber, async (req, res) => {
  const data = await db.load();
  const barber = data.barbers.find((b) => b.id === req.barber.id);
  barber.googleRefreshToken = null;
  barber.googleEmail = null;
  await db.save(data);
  res.json({ message: 'Google Calendar desconectado.' });
});

// O barbeiro cria um agendamento para um cliente (ex: cliente que liga ou
// chega sem ter feito login/cadastro no site). Não exige conta de cliente.
app.post('/api/barber/book', requireBarber, async (req, res) => {
  const { date, time, serviceIds, clientName, clientPhone, clientCpf, email, notes } = req.body;

  if (!date || !time || !clientName || !clientName.trim() || !clientPhone) {
    return res.status(400).json({ error: 'Informe data, horário, nome e telefone do cliente.' });
  }

  const services = resolveServices(serviceIds);
  if (!services) {
    return res.status(400).json({ error: 'Escolha ao menos um serviço válido.' });
  }
  const durationMinutes = services.reduce((sum, s) => sum + s.minutes, 0);

  if (!isDateOpen(date)) {
    return res.status(400).json({ error: 'Não atendemos nesse dia (só de terça a sábado).' });
  }
  if (!generateStartTimes(durationMinutes).includes(time)) {
    return res.status(400).json({ error: 'Horário inválido para a duração escolhida. Atendemos das 10h às 18h.' });
  }

  const barber = req.barber;
  const data = await db.load();

  const startMin = timeToMinutes(time);
  const endMin = startMin + durationMinutes;
  const conflict = data.bookings.find((b) => {
    if (b.date !== date || b.barberId !== barber.id || b.status === 'cancelado') return false;
    const bStart = timeToMinutes(b.time);
    const bEnd = bStart + (b.duration || DEFAULT_DURATION);
    return intervalsOverlap(startMin, endMin, bStart, bEnd);
  });
  if (conflict) {
    return res.status(409).json({ error: 'Você já tem outro agendamento nesse horário.' });
  }

  let cleanCpf = null;
  if (clientCpf && clientCpf.trim()) {
    if (!isValidCPF(clientCpf)) {
      return res.status(400).json({ error: 'CPF do cliente inválido. Confira os números, ou deixe em branco.' });
    }
    cleanCpf = onlyDigits(clientCpf);
  }

  const serviceNames = services.map((s) => s.name).join(', ');

  const booking = {
    id: uuidv4(),
    userId: null, // criado pelo barbeiro, cliente pode não ter conta no site
    date,
    time,
    duration: durationMinutes,
    services,
    barberId: barber.id,
    barberName: barber.name,
    name: clientName.trim(),
    phone: onlyDigits(clientPhone),
    cpf: cleanCpf,
    email: email || null,
    notes: notes || null,
    status: 'confirmado',
    createdByBarber: true,
    googleEventId: null,
    createdAt: new Date().toISOString(),
    price: services.reduce((sum, s) => sum + (s.price || 0), 0),
    paid: false,
  };

  try {
    booking.googleEventId = await gcal.createEvent(barber.googleRefreshToken, {
      date,
      time,
      durationMinutes,
      summary: `${barber.name} — ${booking.name} (${serviceNames})`,
      description: `Barbeiro: ${barber.name}\nServiços: ${serviceNames}\nDuração: ${durationMinutes} min\nCliente: ${booking.name}\nTelefone: ${booking.phone}${cleanCpf ? `\nCPF: ${formatCPF(cleanCpf)}` : ''}${notes ? `\nObs: ${notes}` : ''}\n(agendado pelo próprio barbeiro)`,
    });
  } catch (err) {
    console.error('Erro ao criar evento no Google Calendar:', err.message);
  }

  data.bookings.push(booking);
  await db.save(data);

  res.status(201).json({ message: 'Agendamento criado!', booking });
});

// ===== Split payment (fechar conta com divisão loja / máquina / barbeiro) =====

// Calcula a divisão de um valor bruto entre taxa da máquina, comissão da
// loja e o que sobra pro barbeiro, usando as taxas configuradas pelo admin.
function calculateSplit(grossValue, method, settings) {
  const feeMap = {
    pix: settings.feePixPct, debito: settings.feeDebitoPct,
    credito: settings.feeCreditoPct, dinheiro: settings.feeDinheiroPct,
  };
  const feePct = feeMap[method] ?? 0;
  const round2 = (n) => Math.round(n * 100) / 100;

  const machineFee = round2(grossValue * (feePct / 100));
  const net = round2(grossValue - machineFee);
  const storeShare = round2(net * (settings.storeCommissionPct / 100));
  const barberShare = round2(net - storeShare);

  return { machineFee, storeShare, barberShare };
}

// Configurações de split (comissão da loja + taxa de cada método) — só o admin edita
app.get('/api/admin/payment-settings', requireAdmin, async (req, res) => {
  const data = await db.load();
  res.json({ settings: data.paymentSettings });
});

app.put('/api/admin/payment-settings', requireAdmin, async (req, res) => {
  const { storeCommissionPct, feePixPct, feeDebitoPct, feeCreditoPct, feeDinheiroPct } = req.body;
  const nums = { storeCommissionPct, feePixPct, feeDebitoPct, feeCreditoPct, feeDinheiroPct };
  for (const [key, val] of Object.entries(nums)) {
    if (val === undefined) continue;
    if (typeof val !== 'number' || val < 0 || val > 100) {
      return res.status(400).json({ error: `Valor inválido para ${key}. Use um número entre 0 e 100.` });
    }
  }
  const data = await db.load();
  data.paymentSettings = { ...data.paymentSettings, ...Object.fromEntries(Object.entries(nums).filter(([, v]) => v !== undefined)) };
  await db.save(data);
  res.json({ message: 'Configurações de pagamento atualizadas.', settings: data.paymentSettings });
});

// O barbeiro (ou o admin) fecha a conta de um agendamento: escolhe a forma
// de pagamento e o servidor calcula a divisão (taxa da máquina / loja / barbeiro).
async function payBooking(req, res, { restrictToOwnBarber }) {
  const { id } = req.params;
  const { method } = req.body;
  if (!PAYMENT_METHODS.includes(method)) {
    return res.status(400).json({ error: `Forma de pagamento inválida. Use: ${PAYMENT_METHODS.join(', ')}.` });
  }
  const data = await db.load();
  const booking = data.bookings.find((b) => b.id === id);
  if (!booking) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  if (restrictToOwnBarber && booking.barberId !== req.barber.id) {
    return res.status(403).json({ error: 'Esse agendamento não é seu.' });
  }
  if (booking.paid) {
    return res.status(409).json({ error: `Esse agendamento já foi pago via ${booking.paymentMethod}.` });
  }
  if (booking.price === null || booking.price === undefined) {
    return res.status(400).json({ error: 'Esse agendamento não tem valor definido, não é possível fechar a conta.' });
  }

  const { machineFee, storeShare, barberShare } = calculateSplit(booking.price, method, data.paymentSettings);

  booking.paid = true;
  booking.paymentMethod = method;
  booking.machineFee = machineFee;
  booking.storeShare = storeShare;
  booking.barberShare = barberShare;
  booking.paidAt = new Date().toISOString();

  await db.save(data);

  const barber = data.barbers.find((b) => b.id === booking.barberId);
  notifyBarberWhatsapp(
    barber,
    `Pagamento confirmado: ${booking.name} — R$ ${booking.price.toFixed(2)} via ${method}.\nSeu valor líquido: R$ ${barberShare.toFixed(2)}.`
  );

  res.json({ message: 'Pagamento confirmado.', booking });
}

// Barbeiro só pode fechar conta dos PRÓPRIOS agendamentos
app.post('/api/barber/bookings/:id/pay', requireBarber, (req, res) => payBooking(req, res, { restrictToOwnBarber: true }));

// Admin pode fechar conta de qualquer agendamento (ex: fechamento de caixa)
app.post('/api/admin/bookings/:id/pay', requireAdmin, (req, res) => payBooking(req, res, { restrictToOwnBarber: false }));

// Relatório financeiro do PRÓPRIO barbeiro: transações pagas + totais
app.get('/api/barber/payments', requireBarber, async (req, res) => {
  const data = await db.load();
  const paid = data.bookings
    .filter((b) => b.barberId === req.barber.id && b.paid)
    .sort((a, b) => (b.paidAt || '').localeCompare(a.paidAt || ''));
  const totals = paid.reduce(
    (acc, b) => ({
      gross: acc.gross + (b.price || 0),
      machineFee: acc.machineFee + (b.machineFee || 0),
      storeShare: acc.storeShare + (b.storeShare || 0),
      barberShare: acc.barberShare + (b.barberShare || 0),
    }),
    { gross: 0, machineFee: 0, storeShare: 0, barberShare: 0 }
  );
  res.json({ payments: paid, totals });
});

// Relatório financeiro geral (todos os barbeiros) — só o admin vê
app.get('/api/admin/payments', requireAdmin, async (req, res) => {
  const data = await db.load();
  const paid = data.bookings.filter((b) => b.paid).sort((a, b) => (b.paidAt || '').localeCompare(a.paidAt || ''));
  const totals = paid.reduce(
    (acc, b) => ({
      gross: acc.gross + (b.price || 0),
      machineFee: acc.machineFee + (b.machineFee || 0),
      storeShare: acc.storeShare + (b.storeShare || 0),
      barberShare: acc.barberShare + (b.barberShare || 0),
    }),
    { gross: 0, machineFee: 0, storeShare: 0, barberShare: 0 }
  );
  const byBarber = {};
  for (const b of paid) {
    if (!byBarber[b.barberId]) byBarber[b.barberId] = { barberName: b.barberName, gross: 0, barberShare: 0, count: 0 };
    byBarber[b.barberId].gross += b.price || 0;
    byBarber[b.barberId].barberShare += b.barberShare || 0;
    byBarber[b.barberId].count += 1;
  }
  res.json({ payments: paid, totals, byBarber: Object.values(byBarber) });
});


// ===== Gerenciamento de barbeiros (admin) =====

function publicBarber(b) {
  const { passwordHash, ...rest } = b;
  return { ...rest, hasLogin: !!passwordHash };
}

// Lista todos os barbeiros (ativos e inativos) — usado no painel admin
app.get('/api/admin/barbers', requireAdmin, async (req, res) => {
  const data = await db.load();
  res.json({ barbers: data.barbers.map(publicBarber) });
});

// Cadastra um novo barbeiro (com login próprio: telefone + senha)
app.post('/api/admin/barbers', requireAdmin, async (req, res) => {
  const { name, specialty, phone, password } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Informe o nome do barbeiro.' });
  }
  if (!phone || !onlyDigits(phone)) {
    return res.status(400).json({ error: 'Informe o telefone do barbeiro (é usado como login dele).' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Defina uma senha de pelo menos 6 caracteres para o barbeiro acessar a própria agenda.' });
  }

  const data = await db.load();
  const cleanPhone = onlyDigits(phone);
  const phoneTaken = data.barbers.some((b) => b.phone === cleanPhone);
  if (phoneTaken) {
    return res.status(409).json({ error: 'Já existe um barbeiro cadastrado com esse telefone.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const barber = {
    id: uuidv4(),
    name: name.trim(),
    specialty: specialty ? specialty.trim() : null,
    phone: cleanPhone,
    passwordHash,
    active: true,
    createdAt: new Date().toISOString(),
  };
  data.barbers.push(barber);
  await db.save(data);

  res.status(201).json({ message: 'Barbeiro cadastrado.', barber: publicBarber(barber) });
});

// Edita um barbeiro (nome, especialidade, telefone, ativo/inativo, senha)
app.put('/api/admin/barbers/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, specialty, phone, active, password } = req.body;

  const data = await db.load();
  const barber = data.barbers.find((b) => b.id === id);
  if (!barber) return res.status(404).json({ error: 'Barbeiro não encontrado.' });

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
    barber.name = name.trim();
  }
  if (specialty !== undefined) barber.specialty = specialty ? specialty.trim() : null;
  if (phone !== undefined) {
    const cleanPhone = onlyDigits(phone);
    if (!cleanPhone) return res.status(400).json({ error: 'Telefone inválido.' });
    const phoneTaken = data.barbers.some((b) => b.id !== id && b.phone === cleanPhone);
    if (phoneTaken) return res.status(409).json({ error: 'Já existe outro barbeiro com esse telefone.' });
    barber.phone = cleanPhone;
  }
  if (active !== undefined) barber.active = !!active;
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    barber.passwordHash = await bcrypt.hash(password, 10);
  }

  // Mantém o nome já salvo nos agendamentos futuros em sincronia
  data.bookings.forEach((b) => {
    if (b.barberId === id) b.barberName = barber.name;
  });

  await db.save(data);
  res.json({ message: 'Barbeiro atualizado.', barber: publicBarber(barber) });
});

// Remove um barbeiro definitivamente.
// Se ele já tiver agendamentos (histórico), o sistema apenas o desativa em
// vez de apagar, para não perder o vínculo com os agendamentos existentes.
app.delete('/api/admin/barbers/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const data = await db.load();
  const barber = data.barbers.find((b) => b.id === id);
  if (!barber) return res.status(404).json({ error: 'Barbeiro não encontrado.' });

  const hasBookings = data.bookings.some((b) => b.barberId === id);
  if (hasBookings) {
    barber.active = false;
    await db.save(data);
    return res.json({ message: 'Este barbeiro já tem agendamentos no histórico, então foi apenas desativado (não aparece mais para novos agendamentos).' });
  }

  data.barbers = data.barbers.filter((b) => b.id !== id);
  await db.save(data);
  res.json({ message: 'Barbeiro removido.' });
});

// Na Vercel, o app roda como função serverless (não chama .listen).
// Localmente (npm start), sobe um servidor normal na porta configurada.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n✅ ${BUSINESS_NAME} rodando em http://localhost:${PORT}`);
    console.log(`   Painel do admin em http://localhost:${PORT}/admin.html`);
    console.log('   Cada barbeiro conecta seu próprio Google Calendar e WhatsApp em /barber.html\n');
  });
}

module.exports = app;
