function normalizeSouthAfricanContactNumber(value) {
  const compact = value.replace(/[\s()-]/g, '');

  if (!/^(?:\+27|0)[1-9]\d{8}$/.test(compact)) {
    return null;
  }

  return compact.startsWith('0') ? `+27${compact.slice(1)}` : compact;
}

module.exports = { normalizeSouthAfricanContactNumber };
