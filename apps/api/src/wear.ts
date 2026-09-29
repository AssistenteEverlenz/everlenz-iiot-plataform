import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import { addDays, plantDate } from '@iiot/shared';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';

/**
 * Wear of the extrusion line (migrations 032 and 033).
 *
 * The line loses rate for two different reasons and the telemetry alone cannot tell them apart.
 * A worn die (boquilha) opens, each brick takes more clay and weighs more, so the same mass flow
 * yields fewer pieces per hour. A worn auger (caracol) simply delivers less mass, and the brick
 * weighs the same. Writing n for pieces per hour, m for the mass of a real brick and Q for the
 * mass the extruder delivers:
 *
 *     n = Q / m        and so        dn/n = dQ/Q - dm/m
 *
 * The drop in rate splits into the auger's share and the die's share. Only m has to come from
 * outside, because the platform's own tonnage is pieces times the recipe's nominal weight and
 * therefore carries no information about a real brick. That is what the manual weighing is for.
 *
 * Everything here is read per recipe and only from stretches where the line produced the whole
 * five minutes: that measures the machine, not the shift.
 */
const uuid = z.uuid();

/** A stretch where the line ran the whole five minutes; below this it measures the operation. */
const FULL_BUCKET_SECONDS = 285;

export function registerWearRoutes(
  app: FastifyInstance,
  db: Database,
  access: ReturnType<typeof createAccessControl>,
) {
  /** May this user write measurements? Masters always; others only when it was granted. */
  async function canLog(request: FastifyRequest, reply: FastifyReply) {
    const current = access.principal(request);
    if (current.role === 'master') return true;
    const row = await db.query<{ can_log_measurements: boolean }>(
      'SELECT can_log_measurements FROM app_users WHERE id=$1 AND tenant_id=$2',
      [current.id, current.tenantId],
    );
    if (row.rows[0]?.can_log_measurements) return true;
    reply.code(403).send({ error: 'Sem permissão para lançar medições' });
    return false;
  }

  /**
   * The recipes this device has actually run, and the one running now. The entry form offers
   * these and never a free text field: a recipe typed by hand creates a phantom product and
   * breaks the grouping that the whole analysis rests on.
   */
  app.get('/api/devices/:id/recipes', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const tenantId = access.principal(req).tenantId;
    const seen = await db.query<{ product_code: string }>(
      `SELECT DISTINCT product_code FROM production_buckets
       WHERE tenant_id=$1 AND device_id=$2 AND product_code IS NOT NULL AND product_code <> ''
       ORDER BY product_code`,
      [tenantId, id],
    );
    const running = await db.query<{ product_code: string | null }>(
      'SELECT product_code FROM production_runtime WHERE tenant_id=$1 AND device_id=$2',
      [tenantId, id],
    );
    return {
      recipes: seen.rows.map((row) => row.product_code),
      running: running.rows[0]?.product_code ?? null,
    };
  });

  app.get('/api/devices/:id/weights', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = z.object({ days: z.coerce.number().int().min(1).max(730).default(180) }).parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const from = addDays(plantDate(new Date()), -(query.days - 1));
    const rows = await db.query<{
      id: string;
      production_date: string;
      product_code: string;
      running_product_code: string | null;
      average_kg: number;
      spread_kg: number | null;
      nominal_kg: number | null;
      pieces: number;
      grams: number[];
      note: string | null;
      full_name: string | null;
      measured_at: Date;
      voided_at: Date | null;
    }>(
      `SELECT w.id::text, w.production_date::text, w.product_code, w.running_product_code,
              w.average_kg, w.spread_kg, w.nominal_kg, w.pieces, w.grams, w.note,
              u.full_name, w.measured_at, w.voided_at
       FROM weight_measurements w
       LEFT JOIN app_users u ON u.id=w.created_by
       WHERE w.tenant_id=$1 AND w.device_id=$2 AND w.production_date >= $3::date
       ORDER BY w.production_date DESC, w.measured_at DESC`,
      [tenantId, id, from],
    );
    return {
      weights: rows.rows.map((row) => ({
        id: row.id,
        date: row.production_date,
        product: row.product_code,
        runningProduct: row.running_product_code,
        averageKg: Number(row.average_kg),
        spreadKg: row.spread_kg == null ? null : Number(row.spread_kg),
        nominalKg: row.nominal_kg == null ? null : Number(row.nominal_kg),
        pieces: row.pieces,
        weights: row.grams,
        note: row.note,
        author: row.full_name,
        measuredAt: new Date(row.measured_at).toISOString(),
        voided: row.voided_at != null,
      })),
    };
  });

  const weightBody = z.object({
    date: z.iso.date().optional(),
    product: z.string().trim().min(1).max(80),
    // Every brick of the sample, in kilograms. Three to five is the useful size: the spread
    // between them shows a die wearing unevenly before the average moves at all.
    weights: z.array(z.number().positive().max(100)).min(1).max(30),
    note: z.string().trim().max(300).optional(),
    replaces: z.string().regex(/^\d+$/).optional(),
  });

  app.post('/api/devices/:id/weights', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    if (!(await canLog(req, reply))) return;
    const body = weightBody.parse(req.body);
    const current = access.principal(req);
    const date = body.date ?? plantDate(new Date());
    const average = body.weights.reduce((sum, value) => sum + value, 0) / body.weights.length;
    const spread =
      body.weights.length > 1
        ? Math.max(...body.weights) - Math.min(...body.weights)
        : null;

    const context = await db.query<{ product_code: string | null; weight_per_unit_kg: number | null }>(
      `SELECT pr.product_code, ps.weight_per_unit_kg
       FROM devices d
       LEFT JOIN production_runtime pr ON pr.device_id=d.id AND pr.tenant_id=d.tenant_id
       LEFT JOIN production_settings ps ON ps.device_id=d.id AND ps.tenant_id=d.tenant_id
       WHERE d.tenant_id=$1 AND d.id=$2`,
      [current.tenantId, id],
    );
    if (!context.rows.length) return reply.code(404).send({ error: 'Device not found' });

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO weight_measurements(tenant_id,device_id,production_date,product_code,
         running_product_code,grams,pieces,average_kg,spread_kg,nominal_kg,note,created_by,replaces_id)
       VALUES($1,$2,$3::date,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,(SELECT id FROM app_users WHERE id=$12),$13)
       RETURNING id::text`,
      [
        current.tenantId,
        id,
        date,
        body.product,
        context.rows[0].product_code,
        JSON.stringify(body.weights),
        body.weights.length,
        average,
        spread,
        context.rows[0].weight_per_unit_kg,
        body.note ?? null,
        current.id,
        body.replaces ?? null,
      ],
    );
    // A correction never erases the original: it is marked and kept, because these numbers back
    // a maintenance decision and must stay auditable.
    if (body.replaces)
      await db.query(
        'UPDATE weight_measurements SET voided_at=now() WHERE id=$1 AND tenant_id=$2 AND device_id=$3',
        [body.replaces, current.tenantId, id],
      );
    await recordAudit(db, req, current, {
      action: 'weight.logged',
      targetType: 'device',
      targetId: id,
      summary: {
        averageKg: Number(average.toFixed(4)),
        pieces: body.weights.length,
        product: body.product,
        corrects: body.replaces ?? null,
      },
    });
    return { id: inserted.rows[0].id, averageKg: average, spreadKg: spread };
  });

  app.get('/api/devices/:id/maintenance', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const tenantId = access.principal(req).tenantId;
    const rows = await db.query<{
      id: string;
      happened_on: string;
      kind: string;
      note: string | null;
      full_name: string | null;
    }>(
      `SELECT m.id::text, m.happened_on::text, m.kind, m.note, u.full_name
       FROM maintenance_events m LEFT JOIN app_users u ON u.id=m.created_by
       WHERE m.tenant_id=$1 AND m.device_id=$2 ORDER BY m.happened_on DESC LIMIT 200`,
      [tenantId, id],
    );
    return {
      events: rows.rows.map((row) => ({
        id: row.id,
        date: row.happened_on,
        kind: row.kind,
        note: row.note,
        author: row.full_name,
      })),
    };
  });

  app.post('/api/devices/:id/maintenance', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    if (!(await canLog(req, reply))) return;
    const body = z
      .object({
        date: z.iso.date(),
        kind: z.enum(['boquilha', 'caracol', 'outro']),
        note: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    const current = access.principal(req);
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO maintenance_events(tenant_id,device_id,happened_on,kind,note,created_by)
       VALUES($1,$2,$3::date,$4,$5,(SELECT id FROM app_users WHERE id=$6)) RETURNING id::text`,
      [current.tenantId, id, body.date, body.kind, body.note ?? null, current.id],
    );
    await recordAudit(db, req, current, {
      action: 'maintenance.logged',
      targetType: 'device',
      targetId: id,
      summary: { kind: body.kind, date: body.date },
    });
    return { id: inserted.rows[0].id };
  });

  /**
   * The two wear indices, per recipe, since the last replacement of each part.
   *
   * Capability is the 95th percentile of pieces per hour over stretches that produced the whole
   * five minutes: the average of a shift measures the operation, its peak measures the machine.
   * Measured against the reference week, the drop in rate is split into the die's share (the
   * brick got heavier) and the auger's share (what is left).
   */
  app.get('/api/devices/:id/wear', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const query = z
      .object({
        product: z.string().trim().min(1).max(80).optional(),
        days: z.coerce.number().int().min(14).max(730).default(180),
      })
      .parse(req.query);
    const tenantId = access.principal(req).tenantId;
    const from = addDays(plantDate(new Date()), -(query.days - 1));

    // The busiest recipe, unless one was asked for: comparing across recipes means nothing.
    let product = query.product ?? null;
    if (!product) {
      const busiest = await db.query<{ product_code: string }>(
        `SELECT product_code FROM production_buckets
         WHERE tenant_id=$1 AND device_id=$2 AND producing_s >= $3 AND product_code <> ''
           AND bucket >= $4::date
         GROUP BY product_code ORDER BY count(*) DESC LIMIT 1`,
        [tenantId, id, FULL_BUCKET_SECONDS, from],
      );
      product = busiest.rows[0]?.product_code ?? null;
    }
    if (!product) return { product: null, weeks: [], events: [], reference: null };

    const weeks = await db.query<{
      semana: string;
      capacidade: string;
      mediana: string;
      baldes: string;
      peso: string | null;
      amostras: string;
    }>(
      `WITH cheios AS (
         SELECT date_trunc('week', b.bucket AT TIME ZONE 'America/Sao_Paulo')::date AS semana,
                b.pieces * 12 AS pecas_hora
         FROM production_buckets b
         WHERE b.tenant_id=$1 AND b.device_id=$2 AND b.product_code=$3
           AND b.producing_s >= $4 AND b.pieces > 0 AND b.bucket >= $5::date
       ), pesos AS (
         SELECT date_trunc('week', production_date)::date AS semana,
                avg(average_kg) AS peso, count(*) AS amostras
         FROM weight_measurements
         WHERE tenant_id=$1 AND device_id=$2 AND product_code=$3
           AND voided_at IS NULL AND production_date >= $5::date
         GROUP BY 1
       )
       SELECT c.semana::text,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY c.pecas_hora)::numeric, 0)::text AS capacidade,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY c.pecas_hora)::numeric, 0)::text AS mediana,
              count(*)::text AS baldes,
              max(round(p.peso::numeric, 4))::text AS peso,
              coalesce(max(p.amostras), 0)::text AS amostras
       FROM cheios c LEFT JOIN pesos p ON p.semana=c.semana
       GROUP BY c.semana
       HAVING count(*) >= 8
       ORDER BY c.semana`,
      [tenantId, id, product, FULL_BUCKET_SECONDS, from],
    );

    const events = await db.query<{ happened_on: string; kind: string; note: string | null }>(
      `SELECT happened_on::text, kind, note FROM maintenance_events
       WHERE tenant_id=$1 AND device_id=$2 AND happened_on >= $3::date
       ORDER BY happened_on`,
      [tenantId, id, from],
    );

    // Everything is read from the last replacement: a part changed resets its own curve.
    const lastOf = (kind: string) =>
      events.rows.filter((row) => row.kind === kind).at(-1)?.happened_on ?? null;
    const dieFrom = lastOf('boquilha');
    const augerFrom = lastOf('caracol');
    const since = [dieFrom, augerFrom].filter(Boolean).sort().at(-1) ?? null;

    const usable = weeks.rows.filter((row) => !since || row.semana >= since);
    const reference = usable[0] ?? null;
    const series = usable.map((row) => {
      const rate = Number(row.capacidade);
      const weight = row.peso == null ? null : Number(row.peso);
      const baseRate = reference ? Number(reference.capacidade) : null;
      const baseWeight = reference?.peso == null ? null : Number(reference.peso);
      // dn/n = dQ/Q - dm/m: the rate's fall is the die's share plus the auger's share.
      const rateDrift = baseRate ? rate / baseRate - 1 : null;
      const weightDrift = baseWeight && weight ? weight / baseWeight - 1 : null;
      return {
        week: row.semana,
        capacity: rate,
        median: Number(row.mediana),
        buckets: Number(row.baldes),
        weightKg: weight,
        samples: Number(row.amostras),
        rateDrift,
        // The die's doing: a heavier brick costs rate even with the auger untouched.
        dieDrift: weightDrift == null ? null : -weightDrift,
        // What the die does not explain is the auger's, and only once a weight exists.
        augerDrift: rateDrift == null || weightDrift == null ? null : rateDrift + weightDrift,
      };
    });

    return {
      product,
      since,
      dieChangedOn: dieFrom,
      augerChangedOn: augerFrom,
      reference: reference
        ? { week: reference.semana, capacity: Number(reference.capacidade), weightKg: reference.peso == null ? null : Number(reference.peso) }
        : null,
      weeks: series,
      events: events.rows.map((row) => ({ date: row.happened_on, kind: row.kind, note: row.note })),
    };
  });
}
