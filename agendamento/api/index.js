// api/index.js — ponto de entrada usado pela Vercel.
// A Vercel transforma este arquivo em uma função serverless.
// Todo o app Express (rotas /api/...) mora em ../server.js.
module.exports = require('../server');
