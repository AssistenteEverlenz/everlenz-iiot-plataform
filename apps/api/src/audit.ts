import type { FastifyRequest } from 'fastify';
import type { Database, SqlExecutor } from '@iiot/database';
import type { Principal } from './auth.js';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Never put secrets here: this row is meant to be readable during an investigation. */
  summary?: Record<string, unknown>;
}

/**
 * Appends one row to the audit trail.
 *
 * Deliberately fail-closed: the error is not swallowed, so a mutation that cannot be
 * recorded does not silently succeed. In practice the only realistic cause is migration
 * 009 not having been applied, and failing loudly makes that impossible to miss.
 *
 * Pass the transaction executor when the caller already has one, so the audit row and
 * the change it describes commit or roll back together.
 */
export async function recordAudit(
  db: Database | SqlExecutor,
  request: FastifyRequest,
  actor: Principal,
  entry: AuditEntry,
) {
  await db.query(
    `INSERT INTO audit_log(
       tenant_id,actor_id,actor_email,actor_role,action,target_type,target_id,summary,ip_address,user_agent
     ) VALUES($1,(SELECT id FROM app_users WHERE id=$2),$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [
      actor.tenantId,
      // Resolved through a subquery so the synthetic principal used when authentication
      // is disabled (tests, local runs) records as NULL instead of breaking the FK.
      actor.id,
      actor.email,
      actor.role,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      JSON.stringify(entry.summary ?? {}),
      request.ip,
      request.headers['user-agent']?.slice(0, 500) ?? null,
    ],
  );
}
