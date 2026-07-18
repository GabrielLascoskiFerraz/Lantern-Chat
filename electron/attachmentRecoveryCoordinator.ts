export class AttachmentRecoveryCoordinator {
  private readonly tasks = new Map<string, Promise<void>>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const existing = this.tasks.get(key);
    if (existing) return existing;

    const running = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.tasks.get(key) === running) this.tasks.delete(key);
      });
    this.tasks.set(key, running);
    return running;
  }

  has(key: string): boolean {
    return this.tasks.has(key);
  }

  async wait(key: string): Promise<void> {
    await this.tasks.get(key)?.catch(() => undefined);
  }

  clear(): void {
    this.tasks.clear();
  }
}
