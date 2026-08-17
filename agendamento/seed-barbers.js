// seed-barbers.js
// Popula o banco com os barbeiros do P47 Barbershop, cada um com um PIN de
// acesso (senha curta) já hasheado com bcrypt. Rode uma vez com:
//   node seed-barbers.js
//
// Em produção, troque os telefones pelos números reais de cada barbeiro
// (é o que cada um digita pra entrar) e escolha PINs diferentes — nunca
// deixe todo mundo com "1234" fora de ambiente de teste.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const BARBERS_TO_SEED = [
  { name: 'César', phone: '12990000001', pin: '1234' },
  { name: 'Abner', phone: '12990000002', pin: '1234' },
  { name: 'Gil', phone: '12990000003', pin: '1234' },
  { name: 'Luciano', phone: '12990000004', pin: '1234' },
  { name: 'Rafael', phone: '12990000005', pin: '1234' },
];

(async () => {
  const data = await db.load();
  let added = 0;
  for (const b of BARBERS_TO_SEED) {
    const exists = data.barbers.find((x) => x.phone === b.phone);
    if (exists) continue;
    const passwordHash = await bcrypt.hash(b.pin, 10);
    data.barbers.push({
      id: uuidv4(),
      name: b.name,
      specialty: null,
      phone: b.phone,
      passwordHash,
      active: true,
      createdAt: new Date().toISOString(),
    });
    added++;
  }
  await db.save(data);
  console.log(`✅ ${added} barbeiro(s) adicionado(s). Total agora: ${data.barbers.length}.`);
  console.log('Login de cada um: telefone cadastrado + PIN "1234" (troque em produção).');
})();
