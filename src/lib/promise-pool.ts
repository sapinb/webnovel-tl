type Task = () => Promise<void>; // Task now just returns a Promise, we don't care about its specific type

export class PromisePool {
  private concurrencyLimit: number;
  private runningTasks: Set<Promise<void>>;
  private taskQueue: Array<Task>; // Queue stores Task functions directly
  private resolveDrain: (() => void) | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(concurrencyLimit: number) {
    if (concurrencyLimit <= 0) {
      throw new Error('Concurrency limit must be a positive number.');
    }
    this.concurrencyLimit = concurrencyLimit;
    this.runningTasks = new Set();
    this.taskQueue = [];
  }

  /**
   * Adds a new promise-based task to the pool.
   * The task will be executed when a slot becomes available.
   * This method does not return a Promise, so you cannot await individual task completion
   * or catch individual task errors directly from the 'add' call.
   * Use .drain() to wait for all tasks in the pool to complete.
   * @param task A function that returns a Promise.
   */
  public add(task: Task): void {
    if (this.runningTasks.size < this.concurrencyLimit) {
      this.startTaskExecution(task);
    } else {
      // If the pool is full, add the task function itself to the queue.
      // It will be executed later by processQueue.
      this.taskQueue.push(task);
    }
  }

  /**
   * Executes a task, manages its lifecycle in the pool, and handles cleanup.
   * The actual task function (which returns a Promise) is invoked here.
   * @param task The task function to execute.
   */
  private startTaskExecution(task: Task): void {
    // This promise variable will hold the promise returned by the executionWrapper.
    // It's declared here so it can be referenced in the finally block of the wrapper.
    // eslint-disable-next-line prefer-const
    let taskWrapperPromise: Promise<void>;

    const executionWrapper = async () => {
      try {
        await task(); // Execute the actual task function
      } catch (error) {
        console.error('Task in PromisePool failed:', error);
      } finally {
        // Remove the wrapper promise from the set of running tasks.
        this.runningTasks.delete(taskWrapperPromise);
        this.processQueue(); // Attempt to process the next task in the queue.
      }
    };

    taskWrapperPromise = executionWrapper(); // Invoke the wrapper, which in turn invokes the task.
    this.runningTasks.add(taskWrapperPromise); // Add the wrapper's promise to the tracking set.
  }

  private processQueue(): void {
    while (this.runningTasks.size < this.concurrencyLimit && this.taskQueue.length > 0) {
      const nextTask = this.taskQueue.shift(); // Get the next Task function from the queue
      if (nextTask) {
        this.startTaskExecution(nextTask); // Execute it
      }
    }

    // If all tasks are done and the queue is empty, resolve the drain promise
    if (this.runningTasks.size === 0 && this.taskQueue.length === 0 && this.resolveDrain) {
      this.resolveDrain();
      this.resolveDrain = null;
      this.drainPromise = null;
    }
  }

  /**
   * Waits for all currently running and queued tasks to complete.
   * @returns A Promise that resolves when all tasks in the pool have finished.
   */
  public async drain(): Promise<void> {
    if (this.runningTasks.size === 0 && this.taskQueue.length === 0) {
      return Promise.resolve(); // Nothing to drain
    }

    if (!this.drainPromise) {
      this.drainPromise = new Promise((resolve) => {
        this.resolveDrain = resolve;
      });
    }
    return this.drainPromise;
  }

  /**
   * Returns the current number of running tasks.
   */
  public get size(): number {
    return this.runningTasks.size;
  }

  /**
   * Returns the current number of tasks in the queue.
   */
  public get queueSize(): number {
    return this.taskQueue.length;
  }
}
