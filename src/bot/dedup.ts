export class MessageDedup {
  private seen = new Set<string>();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  isDuplicate(key: string): boolean {
    return this.seen.has(key);
  }

  add(key: string): void {
    this.seen.add(key);
    if (this.seen.size > this.maxSize) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }
  }
}
