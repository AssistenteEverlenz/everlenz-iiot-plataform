import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parse } from 'dotenv';
const source = existsSync('.env')
  ? readFileSync('.env', 'utf8')
  : readFileSync('.env.example', 'utf8');
let result = source.replace(/CHANGE_ME/g, () => randomBytes(24).toString('hex'));
if (process.argv.includes('--local')) {
  const values = parse(result);
  if (values.DATABASE_URL) {
    console.log('Existing DATABASE_URL preserved; no database target was changed.');
  } else {
    const local = `postgresql://${encodeURIComponent(values.POSTGRES_USER ?? 'iiot')}:${encodeURIComponent(values.POSTGRES_PASSWORD ?? '')}@127.0.0.1:${values.POSTGRES_PORT ?? 5432}/${encodeURIComponent(values.POSTGRES_DB ?? 'iiot')}?sslmode=disable`;
    result = /^DATABASE_URL=/m.test(result)
      ? result.replace(/^DATABASE_URL=.*$/m, () => `DATABASE_URL=${local}`)
      : result + `\nDATABASE_URL=${local}\n`;
  }
}
writeFileSync('.env', result, { mode: 0o600 });
console.log('.env prepared with random local credentials. Secrets were not printed.');
