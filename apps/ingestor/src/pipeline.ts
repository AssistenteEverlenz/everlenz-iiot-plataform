import { adapters, DeviceResolver } from '@iiot/adapters';
import { ProductionTracker } from './production-tracker.js';
import {
  convertTag,
  decodePayload,
  env,
  logger,
  type MqttMessage,
  type Device,
  type TopicMapping,
  type TagConfig,
} from '@iiot/shared';
import type { Database, SqlExecutor } from '@iiot/database';

const HOUR_MS = 3_600_000;
/** Half the offline limit: a quiet but connected machine never looks disconnected on a recount. */
const HEARTBEAT_MS = (env.DEVICE_OFFLINE_SECONDS * 1000) / 2;

export class TelemetryRepository {
  // One statement for an entire message. Future workers can combine rows from multiple messages.
  async insertBatch(sql: SqlExecutor, rows: unknown[][]) {
    if (!rows.length) return;
    const values: unknown[] = [];
    const tuples = rows.map(
      (row) =>
        `(${row
          .map((v) => {
            values.push(v);
            return `$${values.length}`;
          })
          .join(',')})`,
    );
    await sql.query(
      `INSERT INTO telemetry_samples(tenant_id,site_id,device_id,tag_id,timestamp,received_at,value_number,value_text,value_boolean,quality,raw_message_id) VALUES ${tuples.join(',')}`,
      values,
    );
  }

  /**
   * Stores one message: the readings that changed (grouped under the message id), the device's
   * last contact and message counter, and, when the raw copy was recorded, its outcome.
   */
  async finalizeMessage(
    sql: SqlExecutor,
    options: {
      messageId: string;
      rawId: string | null;
      device: Device;
      receivedAt: Date;
      topic: string;
      parsedJson: string | null;
      parser: string;
      processingError: string | null;
      productCode: string;
      rows: unknown[][];
    },
  ) {
    const values: unknown[] = [
      options.rawId,
      options.device.tenant_id,
      options.device.id,
      options.parsedJson,
      options.parser,
      options.processingError,
      options.receivedAt,
      options.topic,
      // $9 is read only by the readings insert: with nothing to insert it would go untyped.
      ...(options.rows.length ? [options.productCode] : []),
    ];
    const casts = [
      'uuid',
      'uuid',
      'uuid',
      'uuid',
      'timestamptz',
      'timestamptz',
      'double precision',
      'text',
      'boolean',
      'text',
      'bigint',
    ];
    const tuples = options.rows.map((row) => {
      const placeholders = row.map((value, index) => {
        values.push(index === 10 ? options.messageId : value);
        return `$${values.length}::${casts[index]}`;
      });
      return `(${placeholders.join(',')})`;
    });
    const inserted = tuples.length
      ? `, inserted AS (
        INSERT INTO telemetry_samples(
          tenant_id,site_id,device_id,tag_id,timestamp,received_at,
          value_number,value_text,value_boolean,quality,raw_message_id,product_code
        )
        SELECT sample.*,$9 FROM (VALUES ${tuples.join(',')}) AS sample(
          tenant_id,site_id,device_id,tag_id,timestamp,received_at,
          value_number,value_text,value_boolean,quality,raw_message_id
        )
        RETURNING id
      )`
      : '';
    await sql.query(
      `WITH finalized_raw AS (
        UPDATE mqtt_messages_raw SET tenant_id=$2,device_id=$3,parsed_json=$4::jsonb,
          processing_status='processed',parser_used=$5,processing_error=$6,processed_at=now()
        WHERE id=$1::bigint RETURNING id
      ), device_seen AS (${DEVICE_SEEN_SQL('$3', '$2', '$7', '$8')} RETURNING device_id)${inserted}
      SELECT (SELECT count(*) FROM device_seen) device_seen`,
      values,
    );
  }
}

/**
 * The device's last contact, plus a per-minute message counter (the overview's "mensagens por
 * minuto" now that raw messages are not all stored).
 */
function DEVICE_SEEN_SQL(device: string, tenant: string, at: string, topic: string) {
  return `INSERT INTO device_status(device_id,tenant_id,last_message_at,online,last_topic,minute_bucket,minute_count)
        VALUES(${device},${tenant},${at},true,${topic},date_trunc('minute',now()),1)
        ON CONFLICT(device_id) DO UPDATE SET
          last_message_at=GREATEST(device_status.last_message_at,EXCLUDED.last_message_at),
          online=true,last_topic=EXCLUDED.last_topic,updated_at=now(),
          previous_minute_count=CASE
            WHEN device_status.minute_bucket=EXCLUDED.minute_bucket THEN device_status.previous_minute_count
            WHEN device_status.minute_bucket=EXCLUDED.minute_bucket-interval '1 minute' THEN device_status.minute_count
            ELSE 0 END,
          minute_count=CASE WHEN device_status.minute_bucket=EXCLUDED.minute_bucket
            THEN device_status.minute_count+1 ELSE 1 END,
          minute_bucket=EXCLUDED.minute_bucket`;
}

function inferredType(key: string, value: unknown) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') {
    if (/status|estado|ligado|running|ativo/i.test(key) && /^(?:0|1|true|false)$/i.test(value))
      return 'boolean';
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return 'number';
  }
  return 'string';
}

export class SignalCatalogRepository {
  async observe(
    sql: SqlExecutor,
    device: Device,
    samples: { key: string; value: unknown }[],
    at: Date,
  ) {
    if (!samples.length) return;
    const values: unknown[] = [];
    const tuples = samples.map((sample) => {
      const row = [
        device.tenant_id,
        device.id,
        sample.key,
        inferredType(sample.key, sample.value),
        JSON.stringify(sample.value),
        at,
        at,
      ];
      return `(${row
        .map((value, index) => {
          values.push(value);
          return index === 4 ? `$${values.length}::jsonb` : `$${values.length}`;
        })
        .join(',')})`;
    });
    await sql.query(
      `INSERT INTO device_signal_catalog(tenant_id,device_id,key,inferred_type,sample_value,first_seen_at,last_seen_at)
       VALUES ${tuples.join(',')}
       ON CONFLICT(device_id,key) DO UPDATE SET inferred_type=EXCLUDED.inferred_type,
       sample_value=EXCLUDED.sample_value,last_seen_at=GREATEST(device_signal_catalog.last_seen_at,EXCLUDED.last_seen_at),
       occurrences=device_signal_catalog.occurrences+1,updated_at=now()`,
      values,
    );
  }
}
export class IngestionPipeline {
  private resolutionCache?: { expiresAt: number; devices: Device[]; mappings: TopicMapping[] };
  private tagCache = new Map<string, { expiresAt: number; tags: TagConfig[] }>();
  private catalogObservedAt = new Map<string, number>();
  /** Last stored reading per device and variable: a reading equal to it is not stored again. */
  private lastStored = new Map<string, { value: unknown; product: string; hour: number }>();
  private lastDeviceWrite = new Map<string, number>();
  private problemSavedAt = new Map<string, number>();
  private productionContextCache = new Map<
    string,
    { expiresAt: number; productKey: string | null; fallbackProductCode: string }
  >();

  constructor(
    private db: Database,
    private resolver = new DeviceResolver(),
    private repository = new TelemetryRepository(),
    private log = logger('ingestor'),
    private catalog = new SignalCatalogRepository(),
    private tracker = new ProductionTracker(db, env.DEVICE_OFFLINE_SECONDS),
  ) {}
  private async resolutionConfiguration(force = false) {
    if (!force && this.resolutionCache && this.resolutionCache.expiresAt > Date.now())
      return this.resolutionCache;
    const [devices, mappings] = await Promise.all([
      this.db.query<Device>(
        'SELECT d.*, t.slug tenant_slug, s.slug site_slug FROM devices d JOIN tenants t ON t.id=d.tenant_id JOIN sites s ON s.id=d.site_id',
      ),
      this.db.query<TopicMapping>('SELECT device_id,kind,topic FROM device_topic_mappings'),
    ]);
    this.resolutionCache = {
      expiresAt: Date.now() + 15_000,
      devices: devices.rows,
      mappings: mappings.rows,
    };
    return this.resolutionCache;
  }
  private async configuredTags(device: Device) {
    const cached = this.tagCache.get(device.id);
    if (cached && cached.expiresAt > Date.now()) return cached.tags;
    const tags = (
      await this.db.query<TagConfig>(
        'SELECT * FROM tags WHERE tenant_id=$1 AND device_id=$2 AND enabled=true',
        [device.tenant_id, device.id],
      )
    ).rows;
    this.tagCache.set(device.id, { expiresAt: Date.now() + 5_000, tags });
    return tags;
  }
  private async productionContext(device: Device) {
    const cached = this.productionContextCache.get(device.id);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const result = await this.db.query<{
      product_key: string | null;
      fallback_product_code: string;
    }>(
      `SELECT product_key,fallback_product_code FROM production_context_settings
       WHERE tenant_id=$1 AND device_id=$2`,
      [device.tenant_id, device.id],
    );
    const context = {
      expiresAt: Date.now() + 5000,
      productKey: result.rows[0]?.product_key ?? null,
      fallbackProductCode: result.rows[0]?.fallback_product_code?.trim() || 'ITEM GERAL',
    };
    this.productionContextCache.set(device.id, context);
    return context;
  }
  /**
   * Whether this reading is worth a row: its value (or the running product) changed, it is the
   * first of a new hour (so every hour keeps a value to average and chart), or it is the first
   * time this process sees the variable.
   */
  private changed(deviceId: string, tagId: string, value: unknown, product: string, at: Date) {
    const last = this.lastStored.get(`${deviceId}:${tagId}`);
    return (
      !last ||
      last.value !== value ||
      last.product !== product ||
      last.hour !== Math.floor(at.getTime() / HOUR_MS)
    );
  }

  /** Records the raw copy of a message: always for problems, otherwise only during diagnosis. */
  private async saveRaw(message: MqttMessage, decoded: ReturnType<typeof decodePayload>) {
    // PostgreSQL text/jsonb cannot contain NUL: only then are the exact bytes kept as hex.
    const safeText = decoded.text?.includes('\u0000') ? null : decoded.text;
    const raw = await this.db.query<{ id: string }>(
      'INSERT INTO mqtt_messages_raw(topic,qos,retain,received_at,payload_text,payload_hex) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [
        message.topic,
        message.qos,
        message.retain,
        message.receivedAt,
        safeText,
        safeText == null ? decoded.hex : null,
      ],
    );
    const rawId = raw.rows[0].id;
    this.log.info({ event: 'raw_saved', rawId, topic: message.topic });
    return rawId;
  }

  /** A known device's message that yields nothing: kept once a minute per device, for diagnosis. */
  private keepProblem(deviceId: string, capture: boolean, at: Date) {
    if (capture) return true;
    const last = this.problemSavedAt.get(deviceId);
    if (last != null && Math.abs(at.getTime() - last) < 60_000) return false;
    this.problemSavedAt.set(deviceId, at.getTime());
    return true;
  }

  private async recordProblem(
    message: MqttMessage,
    decoded: ReturnType<typeof decodePayload>,
    device: Device,
    parsedJson: string | null,
    parser: string,
    reason: string,
  ) {
    const rawId = await this.saveRaw(message, decoded);
    await this.db.query(
      'UPDATE mqtt_messages_raw SET tenant_id=$2,device_id=$3,parsed_json=$4::jsonb WHERE id=$1',
      [rawId, device.tenant_id, device.id, parsedJson],
    );
    await this.mark(rawId, 'unrecognized', parser, reason);
    return rawId;
  }

  async ingest(message: MqttMessage) {
    const decoded = decodePayload(message.payload);
    let rawId: string | null = null;
    let parser: string | null = null;
    let resolvedDevice: Device | null = null;
    try {
      let configuration = await this.resolutionConfiguration();
      let device = this.resolver.resolve(
        message.topic,
        configuration.devices,
        configuration.mappings,
      );
      if (!device) {
        configuration = await this.resolutionConfiguration(true);
        device = this.resolver.resolve(
          message.topic,
          configuration.devices,
          configuration.mappings,
        );
      }
      resolvedDevice = device;
      // JSON serialization/JSONB can reject deep nesting or malformed escaped Unicode.
      const jsonText = JSON.stringify(decoded.json);
      const safeJson = jsonText.includes('\\u0000') ? null : jsonText;
      if (!device) {
        // Unknown topics are always recorded: that is how a new HMI is found and registered.
        rawId = await this.saveRaw(message, decoded);
        await this.db.query('UPDATE mqtt_messages_raw SET parsed_json=$2 WHERE id=$1', [
          rawId,
          safeJson,
        ]);
        this.log.warn({ event: 'device_unresolved', rawId, topic: message.topic });
        await this.mark(rawId, 'unrecognized', null, 'No enabled device mapping');
        return { rawId, status: 'unrecognized' };
      }
      const capture =
        device.raw_capture_until != null &&
        new Date(device.raw_capture_until).getTime() > message.receivedAt.getTime();
      const adapter = adapters[device.adapter_type];
      parser = adapter?.name ?? 'UnknownAdapter';
      if (!adapter || !adapter.canHandle(message)) {
        await this.markDeviceSeen(device, message.receivedAt, message.topic);
        if (this.keepProblem(device.id, capture, message.receivedAt))
          rawId = await this.recordProblem(
            message,
            decoded,
            device,
            safeJson,
            parser,
            'Payload does not match configured adapter',
          );
        return { rawId, status: 'unrecognized' };
      }
      const tags = await this.configuredTags(device);
      const samples = adapter.parse(message);
      const context = await this.productionContext(device);
      const payloadProduct = context.productKey
        ? samples.find((sample) => sample.key === context.productKey)?.value
        : null;
      const productCode =
        payloadProduct == null || String(payloadProduct).trim() === ''
          ? context.fallbackProductCode
          : String(payloadProduct).trim().slice(0, 120);
      const lastCatalogObservation = this.catalogObservedAt.get(device.id) ?? 0;
      if (Date.now() - lastCatalogObservation >= 10_000) {
        this.catalogObservedAt.set(device.id, Date.now());
        void this.catalog.observe(this.db, device, samples, message.receivedAt).catch(() => {
          this.catalogObservedAt.delete(device.id);
          this.log.warn({ event: 'signal_catalog_update_failed', deviceId: device.id });
        });
      }
      const rows: unknown[][] = [];
      const kept: Array<{ tagId: string; value: unknown }> = [];
      const ignored: string[] = [];
      let anchor: { row: unknown[]; tagId: string; value: unknown } | null = null;
      for (const sample of samples) {
        const tag = tags.find((t) => t.key === sample.key);
        if (!tag) {
          ignored.push(sample.key);
          continue;
        }
        const value = convertTag(sample.value, tag);
        const row = [
          device.tenant_id,
          device.site_id,
          device.id,
          tag.id,
          sample.timestamp,
          message.receivedAt,
          typeof value === 'number' ? value : null,
          typeof value === 'string' ? value : null,
          typeof value === 'boolean' ? value : null,
          sample.quality ?? 'good',
          null,
        ];
        anchor ??= { row, tagId: tag.id, value };
        // During diagnosis every reading is kept, as it arrived.
        if (capture || this.changed(device.id, tag.id, value, productCode, message.receivedAt)) {
          rows.push(row);
          kept.push({ tagId: tag.id, value });
        }
      }
      if (!anchor) {
        await this.markDeviceSeen(device, message.receivedAt, message.topic);
        if (this.keepProblem(device.id, capture, message.receivedAt))
          rawId = await this.recordProblem(
            message,
            decoded,
            device,
            safeJson,
            parser,
            'No configured tags in payload',
          );
        return { rawId, status: 'unrecognized' };
      }
      // Heartbeat: a machine standing still changes nothing, yet a recount must see that it kept
      // talking (a gap over DEVICE_OFFLINE_SECONDS reads as no communication).
      const lastWrite = this.lastDeviceWrite.get(device.id) ?? 0;
      if (!rows.length && message.receivedAt.getTime() - lastWrite >= HEARTBEAT_MS) {
        rows.push(anchor.row);
        kept.push({ tagId: anchor.tagId, value: anchor.value });
      }
      if (capture) rawId = await this.saveRaw(message, decoded);
      const messageId = rawId ?? (await this.nextMessageId());
      await this.repository.finalizeMessage(this.db, {
        messageId,
        rawId,
        device,
        receivedAt: message.receivedAt,
        topic: message.topic,
        parsedJson: rawId ? safeJson : null,
        parser,
        processingError: ignored.length
          ? `Unconfigured tags: ${ignored.join(',').slice(0, 400)}`
          : null,
        productCode,
        rows,
      });
      // Only once stored: a failed write must not make the next reading look unchanged.
      const hour = Math.floor(message.receivedAt.getTime() / HOUR_MS);
      for (const item of kept)
        this.lastStored.set(`${device.id}:${item.tagId}`, {
          value: item.value,
          product: productCode,
          hour,
        });
      if (rows.length) this.lastDeviceWrite.set(device.id, message.receivedAt.getTime());
      // Shift accounting reads every message, stored or not: it keeps its own state in memory.
      try {
        await this.tracker.observe(device, tags, samples, productCode, message.receivedAt);
      } catch (error) {
        this.log.warn({
          event: 'production_tracking_failed',
          deviceId: device.id,
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        });
      }
      return {
        rawId,
        messageId,
        status: 'processed',
        deviceId: device.id,
        adapter: parser,
        samples: rows.length,
      };
    } catch (error) {
      this.log.error({
        event: 'processing_error',
        rawId,
        adapter: parser,
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      });
      // A message that failed is always kept, so the problem can be looked at.
      try {
        rawId ??= await this.saveRaw(message, decoded);
        if (resolvedDevice)
          await this.db.query(
            'UPDATE mqtt_messages_raw SET tenant_id=$2,device_id=$3 WHERE id=$1',
            [rawId, resolvedDevice.tenant_id, resolvedDevice.id],
          );
        await this.mark(
          rawId,
          'error',
          parser,
          error instanceof Error ? error.message.slice(0, 1000) : 'Processing failed',
        );
      } catch {
        this.log.error({ event: 'raw_error_record_failed', topic: message.topic });
      }
      return { rawId, status: 'error' };
    }
  }
  /** Id for a message whose raw copy is not stored: same sequence, so ids never clash. */
  private async nextMessageId() {
    const result = await this.db.query<{ id: string }>(
      "SELECT nextval('mqtt_messages_raw_id_seq')::text id",
    );
    return result.rows[0].id;
  }
  // A device that talks is online, whether or not its message yields samples: a freshly
  // commissioned HMI has no variables configured yet, and a payload in an unexpected format
  // still proves the link works. Only the message status records why nothing was stored.
  private async markDeviceSeen(device: Device, receivedAt: Date, topic: string) {
    await this.db.query(DEVICE_SEEN_SQL('$1', '$2', '$3', '$4'), [
      device.id,
      device.tenant_id,
      receivedAt,
      topic,
    ]);
  }
  private async mark(id: string, status: string, parser: string | null, error: string | null) {
    await this.db.query(
      'UPDATE mqtt_messages_raw SET processing_status=$2,parser_used=$3,processing_error=$4,processed_at=now() WHERE id=$1',
      [id, status, parser, error],
    );
  }
}
