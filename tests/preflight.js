const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const strictEnv = process.argv.includes('--strict-env');

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), file), 'utf8'));
}

function checkFile(file) {
  assert(fs.existsSync(path.join(process.cwd(), file)), `${file} missing`);
}

function ok(label, detail) {
  console.log(`ok - ${label}${detail ? `: ${detail}` : ''}`);
}

function warn(label, detail) {
  console.log(`warn - ${label}${detail ? `: ${detail}` : ''}`);
}

checkFile('package.json');
checkFile('vercel.json');
checkFile('schema.sql');
checkFile('index.html');
checkFile('app.js');
checkFile('questions.js');

const pkg = readJson('package.json');
assert(pkg.dependencies && pkg.dependencies.pg, 'pg dependency missing');
assert(pkg.scripts && pkg.scripts.check && pkg.scripts['test:logic'] && pkg.scripts['test:db'], 'expected npm scripts missing');
ok('package scripts');

const vercel = readJson('vercel.json');
assert(vercel.functions && vercel.functions['api/run-test.js'], 'run-test function config missing');
assert(vercel.crons && vercel.crons.some((cron) => cron.path === '/api/cron/sync'), 'combined sync cron missing');
// Hobby plan caps a deployment at 12 serverless functions.
const fnCount = fs.readdirSync(path.join(process.cwd(), 'api'), { recursive: true })
  .filter((f) => String(f).endsWith('.js') && !String(f).replace(/\\/g, '/').includes('_lib/')).length;
assert(fnCount <= 12, `too many serverless functions: ${fnCount} > 12 (Hobby plan cap)`);
ok('vercel config', `${fnCount} functions`);

global.window = global;
require('../questions.js');
const groups = QUESTIONS.reduce((acc, q) => {
  acc[q.group] = (acc[q.group] || 0) + 1;
  return acc;
}, {});
for (const group of ['OpenAI', 'Anthropic', 'Google', 'Sakana', 'Image']) {
  assert(groups[group] > 0, `${group} has no questions`);
}
assert(QUESTIONS.filter((q) => q.group === 'OpenAI').every((q) => q.endpoint_type === 'openai_responses'), 'OpenAI must use Responses endpoint tests');
assert(QUESTIONS.filter((q) => q.group === 'Image').every((q) => q.endpoint_type === 'openai_images'), 'Image must use Images endpoint tests');
ok('question groups', JSON.stringify(groups));

const env = {
  DATABASE_URL: !!process.env.DATABASE_URL,
  SESSION_SECRET: !!(process.env.SESSION_SECRET || process.env.AUTH_SECRET),
  CRON_SECRET: !!process.env.CRON_SECRET
};
if (strictEnv) {
  assert(env.DATABASE_URL, 'DATABASE_URL missing');
  assert(env.SESSION_SECRET, 'SESSION_SECRET or AUTH_SECRET missing');
  ok('strict env', JSON.stringify(env));
} else {
  if (!env.DATABASE_URL) warn('DATABASE_URL missing', 'required on Vercel');
  if (!env.SESSION_SECRET) warn('SESSION_SECRET or AUTH_SECRET missing', 'required on Vercel production');
  if (!env.CRON_SECRET) warn('CRON_SECRET missing', 'optional but recommended for cron endpoint');
}

console.log('preflight complete');
