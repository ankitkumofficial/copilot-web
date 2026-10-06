export class SerialTaskQueue {
  private pending: Promise<void> = Promise.resolve();

  public enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.pending.then(task);
    this.pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  public async flush(): Promise<void> {
    await this.pending;
  }
}
