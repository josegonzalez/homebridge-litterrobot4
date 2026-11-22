/** Runs a task on an interval, one run at a time, with a way to run it sooner. */
export class Poller {
  private timer?: NodeJS.Timeout;
  private extra: NodeJS.Timeout[] = [];
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly intervalMs: number,
    /** Called when the task throws; errors never escape the poller. */
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  /** Runs the task now, then on the interval. */
  start(): Promise<void> {
    this.stopped = false;
    return this.run();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.extra.forEach(clearTimeout);
    this.extra = [];
  }

  /** Runs the task after each of the given delays, in addition to the interval. */
  soon(...delaysMs: number[]): void {
    for (const ms of delaysMs) {
      const t = setTimeout(() => {
        this.extra = this.extra.filter((x) => x !== t);
        void this.run();
      }, ms);
      this.extra.push(t);
    }
  }

  /** Runs the task now, or waits for the run in progress. */
  run(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    this.running ??= (async () => {
      clearTimeout(this.timer);
      try {
        await this.task();
      } catch (err) {
        this.onError(err);
      } finally {
        this.running = undefined;
        if (!this.stopped) {
          this.timer = setTimeout(() => void this.run(), this.intervalMs);
        }
      }
    })();
    return this.running;
  }
}
