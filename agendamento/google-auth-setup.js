// google-auth-setup.js
// Rode este script UMA VEZ (npm run auth) para autorizar sua conta Google
// e gerar o GOOGLE_REFRESH_TOKEN que deve ser colado no arquivo .env

require('dotenv').config();
const readline = require('readline');
const fs = require('fs');
const { getOAuth2Client } = require('./google-calendar');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

async function main() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.log('❌ Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no arquivo .env antes de continuar.');
    process.exit(1);
  }

  const oAuth2Client = getOAuth2Client();

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\n1) Abra este link no navegador e faça login com a conta Google que terá a agenda:\n');
  console.log(authUrl);
  console.log('\n2) Depois de autorizar, o Google vai te redirecionar (ou mostrar um código).');
  console.log('   Cole aqui o "code" que aparece na URL de redirecionamento:\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Cole o código aqui: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await oAuth2Client.getToken(code.trim());
      console.log('\n✅ Sucesso! Adicione esta linha ao seu arquivo .env:\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);

      // Tenta já escrever/atualizar o .env automaticamente
      const envPath = '.env';
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, 'utf8');
        if (content.includes('GOOGLE_REFRESH_TOKEN=')) {
          content = content.replace(/GOOGLE_REFRESH_TOKEN=.*/g, `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
        } else {
          content += `\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
        }
        fs.writeFileSync(envPath, content);
        console.log('✅ Arquivo .env atualizado automaticamente.');
      }
    } catch (err) {
      console.error('❌ Erro ao obter o token:', err.message);
    }
  });
}

main();
