// CAS registry numbers: NNNNNNN-NN-C, where C is a checksum digit.

export function normalizeCas(s) {
  if (!s) return '';
  const d = String(s).replace(/[^0-9]/g, '');
  if (d.length < 5 || d.length > 10) return String(s).trim();
  return `${d.slice(0, -3)}-${d.slice(-3, -1)}-${d.slice(-1)}`;
}

export function isValidCas(s) {
  const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(normalizeCas(s));
  if (!m) return false;
  const body = (m[1] + m[2]).split('').reverse();
  const sum = body.reduce((acc, ch, i) => acc + Number(ch) * (i + 1), 0);
  return sum % 10 === Number(m[3]);
}
