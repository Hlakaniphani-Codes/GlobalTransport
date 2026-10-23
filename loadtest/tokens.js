const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const backendRequire = createRequire(path.join(__dirname, '..', 'backend', 'package.json'));
backendRequire('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });

const testDomain = '@loadtest.example.test';
const outputPath = path.join(__dirname, 'tokens.json');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before generating load-test tokens.`);
  return value;
}

function validateTarget(baseUrl) {
  if (process.env.NODE_ENV === 'production' || process.env.LOADTEST_ALLOW !== 'true') {
    throw new Error('Token generation requires LOADTEST_ALLOW=true and a non-production process.');
  }
  if (!['staging', 'test'].includes(process.env.LOADTEST_ENVIRONMENT)) {
    throw new Error('Set LOADTEST_ENVIRONMENT to staging or test after verifying the target.');
  }
  const target = new URL(baseUrl);
  if (/prod/i.test(target.hostname)) {
    throw new Error('Refusing to generate load-test tokens for a production-looking hostname.');
  }
  return target.origin;
}

function retryDelay(response) {
  const value = response.headers.get('retry-after');
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 60_000 : Math.max(1000, timestamp - Date.now());
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function login(baseUrl, role, email, password) {
  const loginPath = role === 'admins' ? '/api/v1/admin/auth/login' : '/api/v1/auth/login';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}${loginPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 429) {
      await response.arrayBuffer();
      await sleep(retryDelay(response));
      continue;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Login failed for ${role} account with HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = await response.json();
    if (!payload.token) throw new Error(`Login response did not include a token for ${role} account.`);
    return payload.token;
  }
  throw new Error(`Login remained rate limited after retries for ${role} account.`);
}

async function main() {
  const baseUrl = validateTarget(required('LOADTEST_BASE_URL'));
  const password = required('LOADTEST_PASSWORD');
  const passengerCount = Number(process.env.LOADTEST_PASSENGER_TOKEN_COUNT ?? 1000);
  const driverCount = Number(process.env.LOADTEST_DRIVER_TOKEN_COUNT ?? 150);
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 1000
    || !Number.isInteger(driverCount) || driverCount < 1 || driverCount > 150) {
    throw new Error('Token counts must be between 1 and the seeded role counts.');
  }

  const tokens = { passengers: [], drivers: [], admins: [] };
  const loginQueue = [
    ...Array.from({ length: passengerCount }, (_, i) => [
      'passengers',
      `lt.passenger${String(i + 1).padStart(4, '0')}${testDomain}`,
      password,
    ]),
    ...Array.from({ length: driverCount }, (_, i) => [
      'drivers',
      `lt.driver${String(i + 1).padStart(4, '0')}${testDomain}`,
      password,
    ]),
  ];
  let adminCredentials;
  if (process.env.LOADTEST_ADMIN_CREDENTIALS) {
    try {
      adminCredentials = JSON.parse(process.env.LOADTEST_ADMIN_CREDENTIALS);
    } catch {
      throw new Error('LOADTEST_ADMIN_CREDENTIALS must be a JSON array of provisioned staging accounts.');
    }
  } else if (process.env.LOADTEST_ADMIN_EMAIL?.trim() && process.env.LOADTEST_ADMIN_PASSWORD) {
    adminCredentials = [{
      email: process.env.LOADTEST_ADMIN_EMAIL.trim(),
      password: process.env.LOADTEST_ADMIN_PASSWORD,
    }];
  }
  if (!Array.isArray(adminCredentials) || adminCredentials.length === 0
    || adminCredentials.some(({ email, password: accountPassword }) =>
      typeof email !== 'string' || !email.trim() || typeof accountPassword !== 'string' || !accountPassword
    )) {
    throw new Error(
      'Set LOADTEST_ADMIN_CREDENTIALS to provisioned staging accounts or set the singular admin email/password variables.'
    );
  }
  for (const admin of adminCredentials) {
    loginQueue.push(['admins', admin.email.trim(), admin.password]);
  }

  for (let index = 0; index < loginQueue.length; index += 1) {
    const [role, email, accountPassword] = loginQueue[index];
    tokens[role].push(await login(baseUrl, role, email, accountPassword));
    if (index < loginQueue.length - 1) await sleep(3100);
    if ((index + 1) % 50 === 0) {
      process.stdout.write(`Logged in ${index + 1}/${loginQueue.length} load-test accounts.\n`);
    }
  }
  await fs.writeFile(outputPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Wrote role-scoped load-test tokens to ${outputPath}.\n`);
}

main().catch((error) => {
  console.error(`Load-test token generation failed: ${error.message}`);
  process.exitCode = 1;
});
