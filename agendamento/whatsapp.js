// whatsapp.js
// Integração com a WhatsApp Business Cloud API (Meta) para o P47 Barbershop.
//
// Requer no .env:
//   WHATSAPP_TOKEN=EAAG...              (token permanente do usuário de sistema)
//   WHATSAPP_PHONE_NUMBER_ID=1234567890 (Phone Number ID, não é o número em si)
//   WHATSAPP_VERIFY_TOKEN=uma-string-secreta-sua
//
// Como plugar no server.js existente:
//   const whatsapp = require('./whatsapp');
//   app.use('/webhook/whatsapp', whatsapp.router);
//
// Depois, no painel da Meta (WhatsApp > Configuração > Webhooks), configure:
//   URL de callback: https://SEU-DOMINIO/webhook/whatsapp
//   Verify token:    o mesmo valor de WHATSAPP_VERIFY_TOKEN
//   Assine o campo:  messages

const express = require('express');
const router = express.Router();

const GRAPH_URL = 'https://graph.facebook.com/v20.0';
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// ---------- 1. Verificação do webhook (GET) ----------
// A Meta chama essa rota uma vez, quando você salva a configuração do webhook,
// para confirmar que o servidor é seu.
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[whatsapp] Webhook verificado com sucesso.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- 2. Recebimento de mensagens (POST) ----------
// A Meta envia um POST toda vez que alguém manda mensagem pro seu número.
router.post('/', express.json(), async (req, res) => {
  // Responde 200 imediatamente — a Meta exige resposta rápida (<20s) ou reenvia o webhook.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (!message) return; // pode ser um evento de status (entregue/lido), ignoramos

    const from = message.from; // número do cliente, formato 5512991234567
    const contactName = value.contacts?.[0]?.profile?.name || 'Cliente';
    const text = message.text?.body?.trim() || '';

    console.log(`[whatsapp] Mensagem de ${contactName} (${from}): ${text}`);

    await handleIncomingMessage({ from, contactName, text });
  } catch (err) {
    console.error('[whatsapp] Erro processando webhook:', err);
  }
});

// ---------- 3. Enviar mensagem de texto ----------
async function sendMessage(to, body) {
  const resp = await fetch(`${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error('[whatsapp] Falha ao enviar mensagem:', data);
  }
  return data;
}

// ---------- 4. Lógica de agendamento via mensagem ----------
// Reaproveita a mesma ideia do bot simulado no app: se a mensagem começar
// com "agendar", tenta extrair serviço/data/hora e criar o compromisso.
// Troque `db` pelas funções reais do seu backend (db.js) para persistir.
// Cada serviço tem uma lista de palavras-chave que o cliente pode digitar.
// Isso evita o bug de "casar por acaso" com a primeira palavra do nome
// (ex: "Cabelo + Barba Padrão" não devia responder a "manicure").
const SERVICES = [
  { id: 'corte', name: 'Cabelo', minutes: 30, price: 60, keywords: ['cabelo', 'corte'] },
  { id: 'barba', name: 'Barba', minutes: 20, price: 40, keywords: ['barba'] },
  { id: 'combo', name: 'Cabelo + Barba Padrão', minutes: 60, price: 120, keywords: ['combo', 'padrao', 'padrão'] },
  { id: 'combo2', name: 'Cabelo + Barba 02', minutes: 60, price: 130, keywords: ['combo 02', 'combo2'] },
  { id: 'visagismo', name: 'Consulta de Visagismo', minutes: 45, price: 150, keywords: ['visagismo', 'visagista', 'consulta'] },
];

function findService(text) {
  return SERVICES.find((s) => s.keywords.some((k) => text.includes(k))) || null;
}

function parseAgendarCommand(text) {
  const t = text.toLowerCase();
  if (!t.startsWith('agendar')) return null;
  const timeMatch = t.match(/(\d{1,2}):(\d{2})/);
  if (!timeMatch) return null;
  const time = `${String(timeMatch[1]).padStart(2, '0')}:${timeMatch[2]}`;
  let date = new Date();
  if (t.includes('amanhã') || t.includes('amanha')) date.setDate(date.getDate() + 1);
  const dateStr = date.toISOString().slice(0, 10);
  const service = findService(t);
  return { service, date: dateStr, time };
}

async function handleIncomingMessage({ from, contactName, text }) {
  const parsed = parseAgendarCommand(text);

  if (!parsed) {
    await sendMessage(
      from,
      'Olá! Para marcar um horário, envie por exemplo:\n"agendar corte amanhã 15:00"'
    );
    return;
  }

  const svc = parsed.service;
  if (!svc) {
    await sendMessage(
      from,
      `Não reconheci o serviço na sua mensagem. Opções: ${SERVICES.map((s) => s.name).join(', ')}.\nExemplo: "agendar barba amanhã 15:00"`
    );
    return;
  }

  // ---- AQUI: troque por chamadas reais ao seu db.js ----
  // Exemplo do que normalmente se faz:
  //   let client = await db.findClientByPhone(from);
  //   if (!client) client = await db.createClient({ name: contactName, phone: from });
  //   const appt = await db.createAppointment({ clientId: client.id, serviceId: svc.id, date: parsed.date, time: parsed.time });
  //   if (googleCalendarConnected) await gcal.createEvent(appt);
  console.log('[whatsapp] Criar agendamento:', { contactName, from, svc: svc.name, ...parsed });

  await sendMessage(
    from,
    `Agendamento confirmado ✅\n${svc.name} — ${parsed.date} às ${parsed.time}\nValor: R$ ${svc.price.toFixed(2).replace('.', ',')}`
  );
}

module.exports = { router, sendMessage, handleIncomingMessage };
