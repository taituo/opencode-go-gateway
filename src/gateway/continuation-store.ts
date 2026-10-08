export interface ContinuationRecord<T = unknown> {
  id: string;
  value: T;
  createdAt: number;
  expiresAt?: number;
  tenantId?: string;
}

export interface ContinuationStore<T = unknown> {
  putContinuation(record: ContinuationRecord<T>): Promise<void>;
  getContinuation(id: string, tenantId?: string): Promise<ContinuationRecord<T> | undefined>;
  deleteContinuation(id: string): Promise<void>;
  pruneContinuations(now?: number): Promise<number>;
}

export class InMemoryContinuationStore<T = unknown> implements ContinuationStore<T> {
  readonly #records = new Map<string, ContinuationRecord<T>>();
  constructor(private readonly maxEntries = 1000) {}

  async putContinuation(record: ContinuationRecord<T>): Promise<void> {
    this.#records.delete(record.id);
    this.#records.set(record.id, structuredClone(record));
    while (this.#records.size > this.maxEntries) {
      const id = this.#records.keys().next().value as string | undefined;
      if (!id) break;
      this.#records.delete(id);
    }
  }

  async getContinuation(id: string, tenantId?: string): Promise<ContinuationRecord<T> | undefined> {
    const record = this.#records.get(id);
    if (!record) return undefined;
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) { this.#records.delete(id); return undefined; }
    if ((tenantId ?? undefined) !== (record.tenantId ?? undefined)) return undefined;
    return structuredClone(record);
  }

  async deleteContinuation(id: string): Promise<void> { this.#records.delete(id); }

  async pruneContinuations(now = Date.now()): Promise<number> {
    let deleted = 0;
    for (const [id, record] of this.#records) {
      if (record.expiresAt !== undefined && record.expiresAt <= now) { this.#records.delete(id); deleted++; }
    }
    return deleted;
  }
}
