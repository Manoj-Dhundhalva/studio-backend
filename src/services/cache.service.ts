export class CacheService<K, V> {
  private readonly cache = new Map<K, V>();

  public set(key: K, value: V): void {
    this.cache.set(key, value);
  }

  public get(key: K): V | undefined {
    return this.cache.get(key);
  }

  public has(key: K): boolean {
    return this.cache.has(key);
  }

  public delete(key: K): boolean {
    return this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }

  public entries(): IterableIterator<[K, V]> {
    return this.cache.entries();
  }
}
