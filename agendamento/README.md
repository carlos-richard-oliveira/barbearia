# Sistema de Agendamento com Google Calendar

Site de agendamento de horários. Qualquer pessoa pode marcar um horário livre;
somente o administrador pode remarcar ou cancelar agendamentos.

## Regras já implementadas

- **Área do barbeiro (`/barber.html`):** cada barbeiro tem login próprio
  (telefone + senha, definidos pelo admin ao cadastrá-lo). Nessa página o
  barbeiro só vê e mexe na própria agenda — nunca a de outro barbeiro:
  - Aba **Meus agendamentos**: lista tudo que está marcado com ele (data,
    hora, duração, serviços, cliente, telefone, status).
  - Aba **Agendar cliente**: cria um agendamento em nome de um cliente que
    ligou ou chegou na barbearia sem ter conta no site — só precisa do nome
    e telefone do cliente (CPF é opcional aqui). Usa os mesmos horários e
    regras de duração dos serviços, e respeita a agenda já ocupada dele.
  - O admin também vê esses agendamentos normalmente na aba "Agendamentos"
    do painel principal.
- **Serviços:** o cliente marca um ou mais serviços (checkboxes) e o sistema
  soma a duração de todos automaticamente. Os horários mostrados já
  consideram esse total — por exemplo, Corte (30 min) + Barba (30 min) trava
  1h da agenda a partir do horário escolhido; Depilação Nasal (15 min)
  sozinha só trava 15 min.
  - Corte de Cabelo — 30 min
  - Barba — 30 min
  - Cabelo e Barba — 60 min
  - Barboterapia — 60 min
  - Terapia Capilar — 60 min
  - Depilação Nasal — 15 min
  - Depilação Ouvido — 15 min
  - Combo Depilação (Nasal + Ouvido) — 25 min
  - Os horários de início ficam disponíveis a cada 15 minutos (ex: 10:00,
    10:15, 10:30...), sempre garantindo que o atendimento termine até as 18h.
- **Barbeiros:** o cliente escolhe o barbeiro numa tabela antes de ver os
  horários. Cada barbeiro tem a própria agenda, independente dos outros —
  dois barbeiros podem atender no mesmo horário sem conflito.
- O admin gerencia os barbeiros na aba **Barbeiros** do painel (`/admin.html`):
  adicionar (nome, especialidade, **telefone e senha — usados pelo barbeiro
  para logar em `/barber.html`**), editar (incluindo redefinir a senha),
  ativar/desativar e excluir. Um barbeiro com agendamentos no histórico não é apagado de
  verdade ao excluir — é só desativado, pra não perder o vínculo com
  agendamentos já feitos; ele some da lista de novos agendamentos mas
  continua aparecendo no histórico.
- Atendimento de **terça a sábado**, das **10h às 18h**.
- Cada atendimento dura **1 hora**. Ao marcar 11h, o horário fica travado até 12h
  (o próximo horário disponível é 12h).
- **Cadastro e login do cliente por Nome + CPF + Telefone + Senha:**
  - `POST /api/signup` cria a conta (nome, CPF, telefone, senha — mínimo 6 caracteres).
    A senha é armazenada com hash (bcrypt), nunca em texto puro.
  - `POST /api/login` autentica com **CPF + senha**.
  - O CPF é validado (dígito verificador real, não só formato).
  - **Cada CPF só pode ter um cadastro** — tentar se cadastrar de novo com o
    mesmo CPF é bloqueado.
  - No site, o cliente escolhe entre as abas "Entrar" e "Cadastre-se".
  - O login gera um token que fica salvo no navegador por 30 dias.
  - Um mesmo cliente não consegue ter dois agendamentos no mesmo dia (só o
    admin remarca se precisar).
- **Somente o admin logado** pode remarcar (`PUT /api/admin/bookings/:id/reschedule`)
  ou cancelar (`DELETE /api/admin/bookings/:id`) um agendamento. Login do admin
  continua sendo só por senha (`POST /api/admin/login`), separado do login do cliente.
- Ao marcar, o sistema também confere o Google Calendar em tempo real, então se
  você travar um horário manualmente direto na sua Agenda do Google, ele também
  fica bloqueado no site.

## 1. Instalar e rodar localmente

```bash
npm install
cp .env.example .env
```

Abra o `.env` e troque pelo menos:
- `ADMIN_PASSWORD` — senha do painel admin
- `JWT_SECRET` — qualquer string aleatória grande
- `BUSINESS_NAME` — nome do seu negócio

Depois:
```bash
npm start
```

Acesse:
- Site de agendamento: `http://localhost:3000`
- Painel admin: `http://localhost:3000/admin.html`

Nesse ponto o site já funciona 100% (marcar, impedir conflito de horário,
remarcar/cancelar como admin) **mesmo sem conectar o Google**. A integração com
o Google Calendar é um passo extra opcional, descrito abaixo.

## 2. Conectar com sua conta do Google Calendar

### 2.1 Criar credenciais no Google Cloud

1. Acesse https://console.cloud.google.com/ e crie um projeto (ou use um existente).
2. Vá em **APIs e Serviços → Biblioteca**, procure **Google Calendar API** e ative.
3. Vá em **APIs e Serviços → Tela de consentimento OAuth**:
   - Tipo de usuário: **Externo** (se for só para você, pode deixar em modo "Teste"
     e adicionar seu próprio e-mail como usuário de teste).
4. Vá em **APIs e Serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo de aplicativo: **Aplicativo da Web**.
   - Em "URIs de redirecionamento autorizados", adicione:
     `http://localhost:3000/auth/google/callback`
     (troque pela URL real depois de publicar o site, ex:
     `https://seusite.com/auth/google/callback`)
5. Copie o **Client ID** e o **Client Secret** gerados.

### 2.2 Preencher o `.env`

```
GOOGLE_CLIENT_ID=cole-aqui
GOOGLE_CLIENT_SECRET=cole-aqui
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
GOOGLE_CALENDAR_ID=primary
```

### 2.3 Autorizar sua conta (uma única vez)

```bash
npm run auth
```

O terminal vai mostrar um link. Abra no navegador, faça login com a **conta Google
que tem a agenda que você quer usar**, aceite as permissões, e cole de volta no
terminal o código gerado. O script grava automaticamente `GOOGLE_REFRESH_TOKEN`
no seu `.env`.

Pronto — reinicie o servidor (`npm start`) e a partir daí:
- toda reserva feita no site cria um evento no seu Google Calendar;
- toda remarcação feita pelo admin atualiza o evento no Google Calendar;
- todo cancelamento apaga o evento;
- eventos criados manualmente na sua Agenda do Google também bloqueiam o horário no site.

> Sem esse passo, o site funciona normalmente usando apenas o banco de dados
> interno (`data.json`) — a integração com o Google é 100% opcional.

## 3. Publicar na Vercel

Este projeto já está preparado para rodar na Vercel como função serverless
(pasta `api/`, arquivo `vercel.json`) e usa **Upstash Redis** para guardar os
dados de forma permanente — na Vercel, funções serverless não têm disco
persistente, então o arquivo `data.json` (usado só localmente) não
funcionaria em produção: os dados sumiriam a cada novo deploy.

### 3.1 Suba o projeto para o GitHub

```bash
git init
git add .
git commit -m "Sistema de agendamento"
```
Crie um repositório no GitHub e depois:
```bash
git remote add origin https://github.com/SEU_USUARIO/agenda-app.git
git branch -M main
git push -u origin main
```

### 3.2 Importe o projeto na Vercel

1. Acesse https://vercel.com/new e importe o repositório do GitHub.
2. Mantenha as configurações padrão (a Vercel detecta o `vercel.json` sozinha).
3. Em "Environment Variables", adicione as mesmas variáveis do seu `.env`:
   - `ADMIN_PASSWORD`
   - `JWT_SECRET`
   - `BUSINESS_NAME`
   - (se for usar Google Calendar) `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
     `GOOGLE_REDIRECT_URI`, `GOOGLE_CALENDAR_ID`, `GOOGLE_REFRESH_TOKEN`
4. Clique em **Deploy**.

### 3.3 Ative o banco de dados (Upstash Redis)

Sem esse passo o site funciona, mas os agendamentos e cadastros somem a cada
novo deploy — faça isso antes de divulgar o link:

1. No painel do seu projeto na Vercel, vá em **Storage → Marketplace → Redis**
   (integração **Upstash**).
2. Clique em **Add** / **Create**, escolha o plano gratuito e conecte ao
   projeto.
3. A Vercel injeta automaticamente as variáveis `KV_REST_API_URL` e
   `KV_REST_API_TOKEN` no seu projeto — não precisa copiar nada manualmente.
4. Vá em **Deployments** e clique em **Redeploy** para o app passar a usar o
   banco.

Pronto — o site fica em `https://seu-projeto.vercel.app` e qualquer pessoa
com o link já pode acessar e agendar. O painel admin fica em
`https://seu-projeto.vercel.app/admin.html`.

### 3.4 Se for usar Google Calendar

Atualize `GOOGLE_REDIRECT_URI` nas credenciais OAuth do Google Cloud para
`https://seu-projeto.vercel.app/auth/google/callback` e rode `npm run auth`
localmente (o refresh token gerado é o mesmo, independente de onde o site
está publicado — só cole o valor gerado na variável `GOOGLE_REFRESH_TOKEN`
da Vercel).

## 4. Estrutura do projeto

```
server.js              # backend Express: regras de agendamento e rotas da API
api/index.js            # ponto de entrada da função serverless (Vercel)
vercel.json              # configuração de rotas da Vercel
google-calendar.js      # integração com a API do Google Calendar
google-auth-setup.js    # script de autorização (rodar 1x)
db.js                    # armazenamento: Upstash Redis (produção) ou data.json (local)
cpf.js                    # validação do CPF
public/index.html        # página pública: login, cadastro e agendamento
public/admin.html        # painel do administrador (barbeiros + agendamentos)
public/barber.html       # área do barbeiro: agenda própria + agendar cliente
```

## 5. Segurança

- Troque `ADMIN_PASSWORD` e `JWT_SECRET` antes de publicar — os valores de exemplo
  não são seguros.
- O `.env` nunca deve ser commitado no Git (adicione ao `.gitignore`).
- Para múltiplos administradores ou um login mais robusto (2FA, múltiplos usuários),
  seria necessário evoluir o sistema de autenticação atual, que hoje usa uma
  única senha compartilhada.
