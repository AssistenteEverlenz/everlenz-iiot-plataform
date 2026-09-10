import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@iiot/database';
import type { createAccessControl } from './auth.js';
import { recordAudit } from './audit.js';

// Managerial production: which tag plays which role on a device, and the aggregates a
// plant owner reads on the TV board. Everything is computed from telemetry_hourly_rollups
// (already split by product), so a year-to-date answer never scans raw samples.

const TIME_ZONE = 'America/Sao_Paulo';
const uuid = z.uuid();

type Access = ReturnType<typeof createAccessControl>;

interface Roles {
  pallets_tag_id: string | null;
  blocks_tag_id: string | null;
  tons_total_tag_id: string | null;
  rate_tag_id: string | null;
  run_status_tag_id: string | null;
  planned_minutes_per_day: number | null;
  nominal_tons_per_hour: number | null;
}

// Used only while a device has no saved roles, so an existing HMI shows data immediately.
// The first save replaces the guess with an explicit choice.
const roleHints: Array<[keyof Roles, RegExp, 'number' | 'boolean']> = [
  ['pallets_tag_id', /palete|pallet/i, 'number'],
  ['blocks_tag_id', /bloco|block|pe[cç]a/i, 'number'],
  [
    'tons_total_tag_id',
    /^(?!.*(hora|_h$|tph|per_hour)).*(ton|tonelada).*(total|acum|prod)/i,
    'number',
  ],
  ['rate_tag_id', /ton.?hora|tonhora|tph|ton_h|tons_per_hour|production_rate/i, 'number'],
  ['run_status_tag_id', /statuslinha|line_running|linha.*(rodando|status)|running/i, 'boolean'],
];

async function loadRoles(db: Database, tenantId: string, deviceId: string) {
  const [saved, tags] = await Promise.all([
    db.query<Roles>(
      `SELECT pallets_tag_id,blocks_tag_id,tons_total_tag_id,rate_tag_id,run_status_tag_id,
         planned_minutes_per_day,nominal_tons_per_hour
       FROM production_settings WHERE tenant_id=$1 AND device_id=$2`,
      [tenantId, deviceId],
    ),
    db.query<{ id: string; key: string; name: string; data_type: string; unit: string | null }>(
      `SELECT id,key,name,data_type,unit FROM tags
       WHERE tenant_id=$1 AND device_id=$2 AND enabled=true ORDER BY key`,
      [tenantId, deviceId],
    ),
  ]);
  if (saved.rows[0]) return { roles: saved.rows[0], tags: tags.rows, inferred: false };
  const roles: Roles = {
    pallets_tag_id: null,
    blocks_tag_id: null,
    tons_total_tag_id: null,
    rate_tag_id: null,
    run_status_tag_id: null,
    planned_minutes_per_day: null,
    nominal_tons_per_hour: null,
  };
  for (const [role, pattern, type] of roleHints) {
    const match = tags.rows.find((tag) => tag.data_type === type && pattern.test(tag.key));
    if (match) (roles[role] as string | null) = match.id;
  }
  return { roles, tags: tags.rows, inferred: true };
}

function localDate(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function shiftDate(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

type Metric = 'pallets' | 'blocks' | 'tons';
type Series = Map<string, Map<string, number>>; // date -> product -> value

function sumRange(series: Series, from: string, to: string) {
  const byProduct = new Map<string, number>();
  let total = 0;
  for (const [date, products] of series) {
    if (date < from || date > to) continue;
    for (const [product, value] of products) {
      byProduct.set(product, (byProduct.get(product) ?? 0) + value);
      total += value;
    }
  }
  const products = [...byProduct.entries()]
    .map(([product_code, value]) => ({
      product_code,
      value,
      share_percent: total > 0 ? (value / total) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);
  return { total, products };
}

export function registerProductionRoutes(app: FastifyInstance, db: Database, access: Access) {
  app.get('/api/devices/:id/hidden-products', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    return (
      await db.query<{ product_code: string; hidden_at: string }>(
        'SELECT product_code,hidden_at FROM hidden_products WHERE tenant_id=$1 AND device_id=$2 ORDER BY product_code',
        [access.principal(req).tenantId, id],
      )
    ).rows;
  });

  // Hiding keeps every sample: the product only leaves totals and rankings, and restoring
  // brings it back with its full history. Test recipes and discontinued items stop
  // polluting the management view without destroying the audit trail.
  app.post('/api/devices/:id/hidden-products', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const body = z
      .object({ productCode: z.string().trim().min(1).max(120), hidden: z.boolean() })
      .parse(req.body);
    const current = access.principal(req);
    await db.transaction(async (sql) => {
      if (body.hidden)
        await sql.query(
          `INSERT INTO hidden_products(tenant_id,device_id,product_code,hidden_by)
           VALUES($1,$2,$3,(SELECT id FROM app_users WHERE id=$4))
           ON CONFLICT(device_id,product_code) DO NOTHING`,
          [current.tenantId, id, body.productCode, current.id],
        );
      else
        await sql.query(
          'DELETE FROM hidden_products WHERE tenant_id=$1 AND device_id=$2 AND product_code=$3',
          [current.tenantId, id, body.productCode],
        );
      await recordAudit(sql, req, current, {
        action: body.hidden ? 'device.product.hide' : 'device.product.restore',
        targetType: 'device',
        targetId: id,
        summary: { product_code: body.productCode },
      });
    });
    return { product_code: body.productCode, hidden: body.hidden };
  });

  app.get('/api/devices/:id/production-settings', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    return loadRoles(db, access.principal(req).tenantId, id);
  });

  app.patch('/api/devices/:id/production-settings', async (req, reply) => {
    if (!access.requireMaster(req, reply)) return;
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const body = z
      .object({
        palletsTagId: uuid.nullable(),
        blocksTagId: uuid.nullable(),
        tonsTotalTagId: uuid.nullable(),
        rateTagId: uuid.nullable(),
        runStatusTagId: uuid.nullable(),
        plannedMinutesPerDay: z.number().int().min(1).max(1440).nullable(),
        nominalTonsPerHour: z.number().positive().max(100000).nullable(),
      })
      .parse(req.body);
    const current = access.principal(req);
    const tagIds = [
      body.palletsTagId,
      body.blocksTagId,
      body.tonsTotalTagId,
      body.rateTagId,
      body.runStatusTagId,
    ].filter((tag): tag is string => Boolean(tag));
    if (tagIds.length) {
      const owned = await db.query<{ count: number }>(
        'SELECT count(*)::int count FROM tags WHERE tenant_id=$1 AND device_id=$2 AND id=ANY($3::uuid[])',
        [current.tenantId, id, [...new Set(tagIds)]],
      );
      if (owned.rows[0].count !== new Set(tagIds).size)
        return reply.code(400).send({ error: 'Every role must reference a tag of this device' });
    }
    return db.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO production_settings(
           device_id,tenant_id,pallets_tag_id,blocks_tag_id,tons_total_tag_id,rate_tag_id,
           run_status_tag_id,planned_minutes_per_day,nominal_tons_per_hour,updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT(device_id) DO UPDATE SET pallets_tag_id=EXCLUDED.pallets_tag_id,
           blocks_tag_id=EXCLUDED.blocks_tag_id,tons_total_tag_id=EXCLUDED.tons_total_tag_id,
           rate_tag_id=EXCLUDED.rate_tag_id,run_status_tag_id=EXCLUDED.run_status_tag_id,
           planned_minutes_per_day=EXCLUDED.planned_minutes_per_day,
           nominal_tons_per_hour=EXCLUDED.nominal_tons_per_hour,updated_at=now()`,
        [
          id,
          current.tenantId,
          body.palletsTagId,
          body.blocksTagId,
          body.tonsTotalTagId,
          body.rateTagId,
          body.runStatusTagId,
          body.plannedMinutesPerDay,
          body.nominalTonsPerHour,
        ],
      );
      await recordAudit(sql, req, current, {
        action: 'device.production_settings.update',
        targetType: 'device',
        targetId: id,
        summary: body,
      });
      return loadRoles(sql as Database, current.tenantId, id);
    });
  });

  app.get('/api/devices/:id/production-overview', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await access.requireDevice(req, reply, id))) return;
    const tenantId = access.principal(req).tenantId;
    const { roles, tags, inferred } = await loadRoles(db, tenantId, id);

    const today = localDate(new Date());
    const yesterday = shiftDate(today, -1);
    const last7From = shiftDate(today, -6);
    const monthFrom = `${today.slice(0, 7)}-01`;
    const yearFrom = `${today.slice(0, 4)}-01-01`;
    const weekdayFrom = shiftDate(today, -56);
    const queryFrom = [yearFrom, weekdayFrom].sort()[0];

    const counterTags = new Map<string, Metric>();
    if (roles.pallets_tag_id) counterTags.set(roles.pallets_tag_id, 'pallets');
    if (roles.blocks_tag_id) counterTags.set(roles.blocks_tag_id, 'blocks');
    if (roles.tons_total_tag_id) counterTags.set(roles.tons_total_tag_id, 'tons');
    // Without a totaliser, tons are the rate integrated over time: t/h x hours covered.
    const tonsFromRate = !roles.tons_total_tag_id && roles.rate_tag_id ? roles.rate_tag_id : null;
    const tagIds = [...counterTags.keys(), ...(tonsFromRate ? [tonsFromRate] : [])];

    const series: Record<Metric, Series> = {
      pallets: new Map(),
      blocks: new Map(),
      tons: new Map(),
    };
    if (tagIds.length) {
      const rows = await db.query<{
        tag_id: string;
        product_code: string;
        local_day: string;
        delta: number;
        integral: number;
      }>(
        `SELECT tag_id,product_code,
           to_char((bucket AT TIME ZONE '${TIME_ZONE}')::date,'YYYY-MM-DD') AS local_day,
           sum(positive_delta) delta,
           sum(value_sum/sample_count*extract(epoch from (last_at-first_at))/3600) integral
         FROM telemetry_hourly_rollups
         WHERE tenant_id=$1 AND device_id=$2 AND tag_id=ANY($3::uuid[])
           AND bucket >= ($4::date::timestamp AT TIME ZONE '${TIME_ZONE}')
           AND product_code NOT IN (SELECT product_code FROM hidden_products WHERE device_id=$2)
         GROUP BY tag_id,product_code,(bucket AT TIME ZONE '${TIME_ZONE}')::date`,
        [tenantId, id, tagIds, queryFrom],
      );
      for (const row of rows.rows) {
        const metric = counterTags.get(row.tag_id) ?? (row.tag_id === tonsFromRate ? 'tons' : null);
        if (!metric) continue;
        const value = Number(row.tag_id === tonsFromRate ? row.integral : row.delta) || 0;
        const day = series[metric].get(row.local_day) ?? new Map<string, number>();
        day.set(row.product_code, (day.get(row.product_code) ?? 0) + value);
        series[metric].set(row.local_day, day);
      }
    }

    const summarize = (metric: Metric, configured: boolean) => {
      const s = series[metric];
      const dayTotal = (date: string) => sumRange(s, date, date).total;
      const daily = Array.from({ length: 14 }, (_, index) => {
        const date = shiftDate(today, index - 13);
        return { date, total: dayTotal(date), products: Object.fromEntries(s.get(date) ?? []) };
      });
      const last30 = Array.from({ length: 30 }, (_, index) => shiftDate(today, index - 29));
      const bestDate = last30.reduce<string | null>(
        (best, date) => (dayTotal(date) > (best ? dayTotal(best) : 0) ? date : best),
        null,
      );
      // Eight full weeks before today; every calendar day counts, a stopped day is zero.
      const weekdays = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
      for (let offset = 1; offset <= 56; offset += 1) {
        const date = shiftDate(today, -offset);
        const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
        weekdays[weekday].total += dayTotal(date);
        weekdays[weekday].days += 1;
      }
      const last7 = sumRange(s, last7From, today);
      return {
        configured,
        today: sumRange(s, today, today),
        yesterday: sumRange(s, yesterday, yesterday),
        last7,
        month: sumRange(s, monthFrom, today),
        year: sumRange(s, yearFrom, today),
        average_per_day_7d: last7.total / 7,
        best_day_30d: bestDate ? { date: bestDate, total: dayTotal(bestDate) } : null,
        weekday_average: weekdays.map((day, weekday) => ({
          weekday,
          average: day.days ? day.total / day.days : 0,
        })),
        daily,
      };
    };

    const latestNumber = async (tagId: string | null) => {
      if (!tagId) return null;
      const result = await db.query<{
        value_number: number | null;
        value_boolean: boolean | null;
        timestamp: string;
      }>(
        `SELECT value_number,value_boolean,timestamp FROM telemetry_samples
         WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3 ORDER BY timestamp DESC LIMIT 1`,
        [tenantId, id, tagId],
      );
      return result.rows[0] ?? null;
    };
    const [rate, running, status] = await Promise.all([
      latestNumber(roles.rate_tag_id),
      latestNumber(roles.run_status_tag_id),
      db.query<{ last_message_at: string | null }>(
        'SELECT last_message_at FROM device_status WHERE tenant_id=$1 AND device_id=$2',
        [tenantId, id],
      ),
    ]);

    // Running time today from the line-status boolean. A gap longer than five minutes
    // between samples is not credited: missing data must not read as production.
    let runningHoursToday: number | null = null;
    let averageRateWhileRunning: number | null = null;
    if (roles.run_status_tag_id) {
      const result = await db.query<{ seconds: number | null }>(
        `SELECT sum(least(extract(epoch from (next_at-timestamp)),300))
           FILTER (WHERE value_boolean) seconds
         FROM (SELECT timestamp,value_boolean,lead(timestamp) OVER (ORDER BY timestamp) next_at
           FROM telemetry_samples WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3
             AND timestamp >= ($4::date::timestamp AT TIME ZONE '${TIME_ZONE}')) s
         WHERE next_at IS NOT NULL`,
        [tenantId, id, roles.run_status_tag_id, today],
      );
      runningHoursToday = Number(result.rows[0]?.seconds ?? 0) / 3600;
    }
    if (roles.rate_tag_id) {
      const result = await db.query<{ average: number | null }>(
        `SELECT sum(value_sum)/nullif(sum(sample_count),0) average FROM telemetry_hourly_rollups
         WHERE tenant_id=$1 AND device_id=$2 AND tag_id=$3 AND value_sum/sample_count > 0
           AND product_code NOT IN (SELECT product_code FROM hidden_products WHERE device_id=$2)
           AND bucket >= ($4::date::timestamp AT TIME ZONE '${TIME_ZONE}')`,
        [tenantId, id, roles.rate_tag_id, today],
      );
      averageRateWhileRunning =
        result.rows[0]?.average == null ? null : Number(result.rows[0].average);
    }
    const now = new Date();
    const midnight = new Date(`${today}T00:00:00-03:00`);
    const elapsedHours = Math.max(0, (now.getTime() - midnight.getTime()) / 3600000);
    const plannedHours =
      roles.planned_minutes_per_day != null
        ? Math.min(elapsedHours, roles.planned_minutes_per_day / 60)
        : elapsedHours;
    const availability =
      runningHoursToday != null && plannedHours > 0
        ? Math.min(1, runningHoursToday / plannedHours)
        : null;
    const performance =
      averageRateWhileRunning != null && roles.nominal_tons_per_hour
        ? Math.min(1.5, averageRateWhileRunning / roles.nominal_tons_per_hour)
        : null;
    const missing = [
      ...(roles.run_status_tag_id ? [] : ['Variável de linha rodando (StatusLinha)']),
      ...(roles.nominal_tons_per_hour ? [] : ['Taxa nominal da linha (t/h) no cadastro']),
      ...(roles.rate_tag_id ? [] : ['Variável de taxa (t/h)']),
      'Contagem boa e refugo (good_count / reject_count) para a qualidade',
    ];

    const tagName = (tagId: string | null) => tags.find((tag) => tag.id === tagId)?.key ?? null;
    return {
      generated_at: now.toISOString(),
      time_zone: TIME_ZONE,
      today,
      roles: {
        inferred,
        pallets: tagName(roles.pallets_tag_id),
        blocks: tagName(roles.blocks_tag_id),
        tons_total: tagName(roles.tons_total_tag_id),
        rate: tagName(roles.rate_tag_id),
        run_status: tagName(roles.run_status_tag_id),
        tons_source: roles.tons_total_tag_id ? 'counter' : tonsFromRate ? 'rate_integral' : null,
      },
      pallets: summarize('pallets', Boolean(roles.pallets_tag_id)),
      blocks: summarize('blocks', Boolean(roles.blocks_tag_id)),
      tons: summarize('tons', Boolean(roles.tons_total_tag_id || tonsFromRate)),
      current: {
        rate_tph: rate?.value_number ?? null,
        running: running?.value_boolean ?? null,
        last_message_at: status.rows[0]?.last_message_at ?? null,
      },
      oee: {
        availability,
        performance,
        quality: null,
        value: null,
        running_hours_today: runningHoursToday,
        planned_hours_today: plannedHours,
        average_rate_while_running: averageRateWhileRunning,
        missing,
      },
    };
  });
}
