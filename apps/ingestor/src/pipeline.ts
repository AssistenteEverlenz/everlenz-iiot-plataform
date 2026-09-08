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
}
export class IngestionPipeline {
  constructor(
    private db: Database,
    private resolver = new DeviceResolver(),
    private repository = new TelemetryRepository(),
    private log = logger('ingestor'),
  ) {}
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
    try {
      const devices = await this.db.query<Device>(
        'SELECT d.*, t.slug tenant_slug, s.slug site_slug FROM devices d JOIN tenants t ON t.id=d.tenant_id JOIN sites s ON s.id=d.site_id',
      );
      const mappings = await this.db.query<TopicMapping>(
        'SELECT device_id,kind,topic FROM device_topic_mappings',
      );
      const device = this.resolver.resolve(message.topic, devices.rows, mappings.rows);
      if (device) {
        // Associate tenant before any JSONB parsing failure; original bytes are already durable.
        await this.db.query('UPDATE mqtt_messages_raw SET tenant_id=$2,device_id=$3 WHERE id=$1', [
          rawId,
          device.tenant_id,
          device.id,
        ]);
      }
      // JSON serialization/JSONB can reject deep nesting or malformed escaped Unicode.
      // Keep this after RAW commit so a poison payload cannot block ingestion retries forever.
      const jsonText = JSON.stringify(decoded.json);
      const safeJson = jsonText.includes('\\u0000') ? null : jsonText;
      await this.db.query('UPDATE mqtt_messages_raw SET parsed_json=$2 WHERE id=$1', [
        rawId,
        safeJson,
      ]);
      if (!device) {
        this.log.warn({ event: 'device_unresolved', rawId, topic: message.topic });
        await this.mark(rawId, 'unrecognized', null, 'No enabled device mapping');
        return { rawId, status: 'unrecognized' };
      }
      await this.db.query(
        `INSERT INTO device_status(device_id,tenant_id,last_message_at,online,last_topic) VALUES($1,$2,$3,true,$4)
        ON CONFLICT(device_id) DO UPDATE SET last_message_at=GREATEST(device_status.last_message_at,EXCLUDED.last_message_at),online=true,last_topic=EXCLUDED.last_topic,updated_at=now()`,
        [device.id, device.tenant_id, message.receivedAt, message.topic],
      );
      const adapter = adapters[device.adapter_type];
      parser = adapter?.name ?? 'UnknownAdapter';
      this.log.info({ event: 'adapter_selected', rawId, deviceId: device.id, adapter: parser });
      if (!adapter || !adapter.canHandle(message)) {
        await this.mark(rawId, 'unrecognized', parser, 'Payload does not match configured adapter');
        return { rawId, status: 'unrecognized' };
      }
      const tags = (
        await this.db.query<TagConfig>(
          'SELECT * FROM tags WHERE tenant_id=$1 AND device_id=$2 AND enabled=true',
          [device.tenant_id, device.id],
        )
      ).rows;
      const samples = adapter.parse(message);
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
      await this.db.transaction(async (sql) => {
        await this.repository.insertBatch(sql, rows);
        await sql.query(
          "UPDATE mqtt_messages_raw SET processing_status='processed',parser_used=$2,processing_error=$3 WHERE id=$1",
          [
            rawId,
            parser,
            ignored.length ? `Unconfigured tags: ${ignored.join(',').slice(0, 400)}` : null,
          ],
        );
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
      'UPDATE mqtt_messages_raw SET processing_status=$2,parser_used=$3,processing_error=$4 WHERE id=$1',
      [id, status, parser, error],
    );
  }
}
