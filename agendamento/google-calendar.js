// google-calendar.js
// Cada barbeiro conecta a PRÓPRIA conta Google (não uma conta única da loja).
// Por isso, toda função aqui recebe o refreshToken do barbeiro específico como
// parâmetro, em vez de ler uma única variável de ambiente global como antes.

const { google } = require('googleapis');
require('dotenv').config();

function getOAuth2Client(refreshToken) {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  if (refreshToken) {
    oAuth2Client.setCredentials({ refresh_token: refreshToken });
  }
  return oAuth2Client;
}

function getCalendar(refreshToken) {
  return google.calendar({ version: 'v3', auth: getOAuth2Client(refreshToken) });
}

const CALENDAR_ID = 'primary';

function isGoogleConnected(refreshToken) {
  return !!refreshToken;
}

// ===== Fluxo de conexão (OAuth) =====

// Gera a URL para o barbeiro autorizar o acesso à própria agenda Google.
// O "state" carrega o ID do barbeiro (assinado como JWT em server.js) para
// sabermos, no callback, a quem pertence o token retornado pelo Google.
function getAuthUrl(state) {
  const oAuth2Client = getOAuth2Client();
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline', // necessário para receber um refresh_token
    prompt: 'consent', // força reenvio do refresh_token mesmo se já autorizado antes
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
  });
}

// Troca o "code" que o Google devolve no callback por um refresh_token
// permanente + o e-mail da conta conectada.
async function exchangeCodeForTokens(code) {
  const oAuth2Client = getOAuth2Client();
  const { tokens } = await oAuth2Client.getToken(code);
  if (!tokens.refresh_token) {
    // O Google só devolve refresh_token na PRIMEIRA autorização (ou com
    // prompt=consent forçando reenvio). Se não veio, avisamos com um erro
    // claro em vez de salvar um token incompleto.
    throw new Error('O Google não retornou um refresh_token. Revogue o acesso do app na conta Google e tente conectar de novo.');
  }
  oAuth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
  const { data: userInfo } = await oauth2.userinfo.get();
  return { refreshToken: tokens.refresh_token, email: userInfo.email };
}

// ===== Operações na agenda do barbeiro =====

async function createEvent(refreshToken, { date, time, durationMinutes = 60, summary, description }) {
  if (!isGoogleConnected(refreshToken)) return null;
  const calendar = getCalendar(refreshToken);
  const start = new Date(`${date}T${time}:00`);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const event = {
    summary,
    description,
    start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
    end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
  };
  const res = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });
  return res.data.id;
}

async function updateEvent(refreshToken, eventId, { date, time, durationMinutes = 60 }) {
  if (!isGoogleConnected(refreshToken) || !eventId) return;
  const calendar = getCalendar(refreshToken);
  const start = new Date(`${date}T${time}:00`);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    resource: {
      start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
    },
  });
}

async function deleteEvent(refreshToken, eventId) {
  if (!isGoogleConnected(refreshToken) || !eventId) return;
  const calendar = getCalendar(refreshToken);
  try {
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
  } catch (err) {
    if (err.code !== 404 && err.code !== 410) throw err;
  }
}

async function getBusyIntervals(refreshToken, dateFromISO, dateToISO) {
  if (!isGoogleConnected(refreshToken)) return [];
  const calendar = getCalendar(refreshToken);
  const res = await calendar.freebusy.query({
    resource: { timeMin: dateFromISO, timeMax: dateToISO, timeZone: 'America/Sao_Paulo', items: [{ id: CALENDAR_ID }] },
  });
  return res.data.calendars[CALENDAR_ID]?.busy || [];
}

module.exports = {
  getOAuth2Client, isGoogleConnected, getAuthUrl, exchangeCodeForTokens,
  createEvent, updateEvent, deleteEvent, getBusyIntervals,
};
