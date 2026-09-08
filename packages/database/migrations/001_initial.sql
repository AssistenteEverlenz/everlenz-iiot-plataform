CREATE TABLE tenants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), slug text NOT NULL, name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,slug), UNIQUE(tenant_id,id)
);
CREATE TABLE devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), site_id uuid NOT NULL,
 slug text NOT NULL, name text NOT NULL, manufacturer text NOT NULL, model text NOT NULL, serial_number text, mqtt_identifier text,
 adapter_type text NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,site_id) REFERENCES sites(tenant_id,id), UNIQUE(tenant_id,site_id,slug), UNIQUE(tenant_id,id), UNIQUE(tenant_id,site_id,id)
);
CREATE TABLE tags (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, device_id uuid NOT NULL, key text NOT NULL, name text NOT NULL,
 data_type text NOT NULL CHECK(data_type IN ('number','boolean','string')), unit text, scale_multiplier double precision NOT NULL DEFAULT 1,
 scale_offset double precision NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id), UNIQUE(device_id,key), UNIQUE(tenant_id,device_id,id)
);
CREATE TABLE device_topic_mappings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, device_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('exact','pattern','haiwell')), topic text NOT NULL,
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id), UNIQUE(kind,topic)
);
CREATE TABLE mqtt_messages_raw (
 id bigserial PRIMARY KEY, tenant_id uuid REFERENCES tenants(id), device_id uuid,
 received_at timestamptz NOT NULL DEFAULT now(), topic text NOT NULL, qos smallint NOT NULL CHECK(qos BETWEEN 0 AND 2), retain boolean NOT NULL,
 payload_text text, payload_hex text NOT NULL, parsed_json jsonb, parser_used text,
 processing_status text NOT NULL DEFAULT 'pending' CHECK(processing_status IN ('pending','processed','unrecognized','error')),
 processing_error text, FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id), UNIQUE(tenant_id,device_id,id)
);
CREATE TABLE telemetry_samples (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, site_id uuid NOT NULL, device_id uuid NOT NULL, tag_id uuid NOT NULL,
 timestamp timestamptz NOT NULL, received_at timestamptz NOT NULL, value_number double precision, value_text text, value_boolean boolean, quality text, raw_message_id bigint,
 FOREIGN KEY(tenant_id,site_id,device_id) REFERENCES devices(tenant_id,site_id,id),
 FOREIGN KEY(tenant_id,device_id,tag_id) REFERENCES tags(tenant_id,device_id,id),
 FOREIGN KEY(tenant_id,device_id,raw_message_id) REFERENCES mqtt_messages_raw(tenant_id,device_id,id),
 CHECK(num_nonnulls(value_number,value_text,value_boolean)=1), UNIQUE(raw_message_id,tag_id)
);
CREATE TABLE device_status (
 device_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, last_message_at timestamptz NOT NULL, online boolean NOT NULL DEFAULT true,
 last_topic text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id)
);
CREATE INDEX sites_tenant ON sites(tenant_id);
CREATE INDEX devices_tenant ON devices(tenant_id);
CREATE INDEX tags_tenant ON tags(tenant_id);
CREATE INDEX raw_received ON mqtt_messages_raw(received_at DESC);
CREATE INDEX raw_topic_received ON mqtt_messages_raw(topic,received_at DESC);
CREATE INDEX raw_tenant_received ON mqtt_messages_raw(tenant_id,received_at DESC);
CREATE INDEX raw_status ON mqtt_messages_raw(processing_status,received_at DESC);
CREATE INDEX samples_device_time ON telemetry_samples(device_id,timestamp DESC);
CREATE INDEX samples_tag_time ON telemetry_samples(tag_id,timestamp DESC);
CREATE INDEX samples_tenant_time ON telemetry_samples(tenant_id,timestamp DESC);
CREATE INDEX samples_received ON telemetry_samples(received_at DESC);
