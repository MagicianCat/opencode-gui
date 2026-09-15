export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly onError: (error: unknown) => void) {}
  enqueue(task: () => Promise<void>): void { this.tail = this.tail.then(task).catch(error => { this.onError(error); }); }
  idle(): Promise<void> { return this.tail; }
}
