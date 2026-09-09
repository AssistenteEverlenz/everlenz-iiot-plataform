import { adapters, DeviceResolver } from '@iiot/adapters';
import {
  convertTag,
  decodePayload,
  logger,
  type MqttMessage,
  type Device,
  type TopicMapping,
  type TagConfig,
} from '@iiot/shared';
import type { Database, SqlExecutor } from '@iiot/database';

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

  async finalizeMessage(
    sql: SqlExecutor,
    options: {
      rawId: string;
      device: Device;
      receivedAt: Date;
      topic: string;
      parsedJson: string | null;
      parser: string;
      processingError: string | null;
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
        values.push(value);
        return `$${values.length}::${casts[index]}`;
      });
      return `(${placeholders.join(',')})`;
    });
    await sql.query(
      `WITH finalized_raw AS (
        UPDATE mqtt_messages_raw SET tenant_id=$2,device_id=$3,parsed_json=$4::jsonb,
          processing_status='processed',parser_used=$5,processing_error=$6,processed_at=now()
        WHERE id=$1 RETURNING id
      ), device_seen AS (
        INSERT INTO device_status(device_id,tenant_id,last_message_at,online,last_topic)
        VALUES($3,$2,$7,true,$8)
        ON CONFLICT(device_id) DO UPDATE SET
          last_message_at=GREATEST(device_status.last_message_at,EXCLUDED.last_message_at),
          online=true,last_topic=EXCLUDED.last_topic,updated_at=now()
        RETURNING device_id
      ), inserted AS (
        INSERT INTO telemetry_samples(
          tenant_id,site_id,device_id,tag_id,timestamp,received_at,
          value_number,value_text,value_boolean,quality,raw_message_id
        )
        SELECT sample.* FROM (VALUES ${tuples.join(',')}) AS sample(
          tenant_id,site_id,device_id,tag_id,timestamp,received_at,
          value_number,value_text,value_boolean,quality,raw_message_id
        ) CROSS JOIN finalized_raw
        RETURNING id
      )
      SELECT (SELECT count(*) FROM inserted) inserted,(SELECT count(*) FROM device_seen) device_seen`,
      values,
    );
  }
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

  constructor(
    private db: Database,
    private resolver = new DeviceResolver(),
    private repository = new TelemetryRepository(),
    private log = logger('ingestor'),
    private catalog = new SignalCatalogRepository(),
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
    this.tagCache.set(device.id, { expiresAt: Date.now() + 15_000, tags });
    return tags;
  }
  async ingest(message: MqttMessage) {
    const decoded = decodePayload(message.payload);
    // PostgreSQL text/jsonb cannot contain NUL. Exact bytes always remain available in payload_hex.
    const safeText = decoded.text?.includes('\u0000') ? null : decoded.text;
    const raw = await this.db.query<{ id: string }>(
      'INSERT INTO mqtt_messages_raw(topic,qos,retain,received_at,payload_text,payload_hex) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [message.topic, message.qos, message.retain, message.receivedAt, safeText, decoded.hex],
    );
    const rawId = raw.rows[0].id;
    this.log.info({ event: 'raw_saved', rawId, topic: message.topic });
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
      // Keep this after RAW commit so a poison payload cannot block ingestion retries forever.
      const jsonText = JSON.stringify(decoded.json);
      const safeJson = jsonText.includes('\\u0000') ? null : jsonText;
      if (!device) {
        await this.db.query('UPDATE mqtt_messages_raw SET parsed_json=$2 WHERE id=$1', [
          rawId,
          safeJson,
        ]);
        this.log.warn({ event: 'device_unresolved', rawId, topic: message.topic });
        await this.mark(rawId, 'unrecognized', null, 'No enabled device mapping');
        return { rawId, status: 'unrecognized' };
      }
      const adapter = adapters[device.adapter_type];
      parser = adapter?.name ?? 'UnknownAdapter';
      this.log.info({ event: 'adapter_selected', rawId, deviceId: device.id, adapter: parser });
      if (!adapter || !adapter.canHandle(message)) {
        await this.db.query(
          'UPDATE mqtt_messages_raw SET tenant_id=$2,device_id=$3,parsed_json=$4::jsonb WHERE id=$1',
          [rawId, device.tenant_id, device.id, safeJson],
        );
        await this.mark(rawId, 'unrecognized', parser, 'Payload does not match configured adapter');
        return { rawId, status: 'unrecognized' };
      }
      const tags = await this.configuredTags(device);
      const samples = adapter.parse(message);
      const lastCatalogObservation = this.catalogObservedAt.get(device.id) ?? 0;
      if (Date.now() - lastCatalogObservation >= 10_000) {
        this.catalogObservedAt.set(device.id, Date.now());
        void this.catalog.observe(this.db, device, samples, message.receivedAt).catch(() => {
          this.catalogObservedAt.delete(device.id);
          this.log.warn({ event: 'signal_catalog_update_failed', deviceId: device.id });
        });
      }
      const rows: unknown[][] = [];
      const ignored: string[] = [];
      for (const sample of samples) {
        const tag = tags.find((t) => t.key === sample.key);
        if (!tag) {
          ignored.push(sample.key);
          continue;
        }
        const value = convertTag(sample.value, tag);
        rows.push([
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
          rawId,
        ]);
      }
      if (!rows.length) {
        await this.mark(rawId, 'unrecognized', parser, 'No configured tags in payload');
        return { rawId, status: 'unrecognized' };
      }
      await this.repository.finalizeMessage(this.db, {
        rawId,
        device,
        receivedAt: message.receivedAt,
        topic: message.topic,
        parsedJson: safeJson,
        parser,
        processingError: ignored.length
          ? `Unconfigured tags: ${ignored.join(',').slice(0, 400)}`
          : null,
        rows,
      });
      this.log.info({ event: 'telemetry_saved', rawId, deviceId: device.id, samples: rows.length });
      return {
        rawId,
        status: 'processed',
        deviceId: device.id,
        adapter: parser,
        samples: rows.length,
      };
    } catch (error) {
      this.log.error({ event: 'processing_error', rawId, adapter: parser });
      if (resolvedDevice)
        await this.db.query('UPDATE mqtt_messages_raw SET tenant_id=$2,device_id=$3 WHERE id=$1', [
          rawId,
          resolvedDevice.tenant_id,
          resolvedDevice.id,
        ]);
      await this.mark(
        rawId,
        'error',
        parser,
        error instanceof Error ? error.message.slice(0, 1000) : 'Processing failed',
      );
      return { rawId, status: 'error' };
    }
  }
  private async mark(id: string, status: string, parser: string | null, error: string | null) {
    await this.db.query(
      'UPDATE mqtt_messages_raw SET processing_status=$2,parser_used=$3,processing_error=$4,processed_at=now() WHERE id=$1',
      [id, status, parser, error],
    );
  }
}
