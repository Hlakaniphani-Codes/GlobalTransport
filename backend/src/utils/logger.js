function write(level, message, codeOrFields, additionalFields = {}) {
  const entry = { level, message };
  if (typeof codeOrFields === 'string') {
    entry.code = codeOrFields;
    Object.assign(entry, additionalFields);
  } else if (codeOrFields && typeof codeOrFields === 'object') {
    Object.assign(entry, codeOrFields);
  }
  const output = `${JSON.stringify(entry)}\n`;
  if (level === 'error' || level === 'warn') {
    process.stderr.write(output);
  } else {
    process.stdout.write(output);
  }
}

module.exports = {
  error: (message, codeOrFields, fields) => write('error', message, codeOrFields, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, code) => write('warn', message, code),
};