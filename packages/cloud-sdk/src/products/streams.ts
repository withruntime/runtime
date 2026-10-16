import type { RequestOptions, Transport } from "../transport.js";
import { recordResources, type RecordResource } from "./queues.js";

/** Private until launch.
 * Kafka clients use kafka.bootstrap and kafka.topic unchanged.
 * Offsets and byte counts use decimal strings so JSON never rounds them. */
export type Stream = RecordResource & {
  partitions: number;
  retentionMs: number;
  retentionBytes: string;
  kafka: { bootstrap: string; topic: string };
};
export type CreateStream = {
  name: string;
  labels?: Record<string, string>;
  partitions?: number;
  retentionMs?: number;
  retentionBytes?: string;
};
export type UpdateStream = Partial<CreateStream>;
/** Text values are UTF-8. Use a Kafka client for arbitrary binary records. */
export type StreamRecord = {
  key?: string | null;
  value: string | null;
  headers?: { key: string; value: string | null }[];
};
export type PublishRecords = { records: StreamRecord[] };
export type ReadStream = { partition: number; maxBytes?: number; waitMs?: number } & (
  { offset: string; time?: never } | { time: number; offset?: never }
);
export type PublishedRecord = { partition: number; offset: string };
export type StreamRead = {
  records: (StreamRecord & PublishedRecord & { time: number })[];
  nextOffset: string;
};

/** Private until launch. Proposed routes only; nothing is registered here. */
export function streams(t: Transport) {
  const path = (id: string) => `/v1/streams/${encodeURIComponent(id)}`;
  return {
    ...recordResources<Stream, CreateStream, UpdateStream>(t, "streams"),
    publish: (id: string, input: PublishRecords, options?: RequestOptions) =>
      t.json<{ records: PublishedRecord[] }>({
        ...options,
        method: "POST",
        path: `${path(id)}:publish`,
        body: input,
      }),
    read: (id: string, input: ReadStream, options?: RequestOptions) =>
      t.json<StreamRead>({ ...options, method: "GET", path: `${path(id)}:read`, query: input }),
    /** Trim returns the resource; follow its state with wait(id). */
    trim: (id: string, input: { partition: number; before: string }, options?: RequestOptions) =>
      t.json<Stream>({ ...options, method: "POST", path: `${path(id)}:trim`, body: input }),
  };
}
