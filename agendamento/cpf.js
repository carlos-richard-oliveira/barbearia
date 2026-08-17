// cpf.js - validação do dígito verificador de CPF (Brasil)

function onlyDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

function isValidCPF(cpf) {
  const digits = onlyDigits(cpf);
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false; // rejeita 000..., 111..., etc.

  const calcCheckDigit = (base) => {
    let sum = 0;
    let weight = base.length + 1;
    for (let i = 0; i < base.length; i++) {
      sum += parseInt(base[i], 10) * weight;
      weight--;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  const base9 = digits.slice(0, 9);
  const d1 = calcCheckDigit(base9);
  const d2 = calcCheckDigit(base9 + d1);

  return digits === base9 + String(d1) + String(d2);
}

function formatCPF(cpf) {
  const d = onlyDigits(cpf);
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

module.exports = { onlyDigits, isValidCPF, formatCPF };
