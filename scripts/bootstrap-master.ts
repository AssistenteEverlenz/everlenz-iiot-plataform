import { database, pool } from '../packages/database/src/index.js';
import { env, hashPassword } from '../packages/shared/src/index.js';

const email = required('IIOT_MASTER_EMAIL').trim().toLowerCase();
const fullName = required('IIOT_MASTER_NAME').trim();
const initialPassword = required('IIOT_MASTER_INITIAL_PASSWORD');

if (initialPassword.length < 12)
  throw new Error('IIOT_MASTER_INITIAL_PASSWORD must have 12 characters');

const existing = await database.query<{ id: string }>(
  'SELECT id FROM app_users WHERE lower(email)=lower($1)',
  [email],
);

if (existing.rows.length) {
  await database.query(
    `UPDATE app_users SET full_name=$2,role='master',status='active',updated_at=now()
     WHERE id=$1`,
    [existing.rows[0].id, fullName],
  );
  process.stdout.write('Master account already exists; password was preserved.\n');
} else {
  const passwordHash = await hashPassword(initialPassword);
  await database.query(
    `INSERT INTO app_users(tenant_id,email,full_name,role,status,password_hash,must_change_password)
     VALUES($1,$2,$3,'master','active',$4,true)`,
    [env.DEV_TENANT_ID, email, fullName, passwordHash],
  );
  process.stdout.write('Master account created with mandatory password change.\n');
}

await pool.end();

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
