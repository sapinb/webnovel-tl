type Task = () => Promise<any>; // Task now just returns a Promise, we don't care about its specific type

export class PromisePool {
    private concurrencyLimit: number;
    private runningTasks: Set<Promise<any>>;
    private taskQueue: Array<Task>; // Queue stores functions that return Promises
    private resolveDrain: (() => void) | null = null;
    private drainPromise: Promise<void> | null = null;

    constructor(concurrencyLimit: number) {
        if (concurrencyLimit <= 0) {
            throw new Error("Concurrency limit must be a positive number.");
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
        const wrappedTaskExecution = async () => {
            try {
                await task(); // Execute the actual task
            } catch (error) {
                // Log the error or handle it as appropriate for fire-and-forget tasks.
                // Since 'add' doesn't return a promise, we must handle errors here.
                console.error("Task in PromisePool failed:", error);
            } finally {
                // This is where the cleanup happens.
                // We remove the promise that was just completed from `runningTasks`.
                this.runningTasks.delete(promiseForWrappedTask);
                this.processQueue(); // Check for new tasks to start
            }
        };

        // This promise represents the execution of the wrappedTaskExecution.
        // It's created immediately when add is called.
        const promiseForWrappedTask = wrappedTaskExecution();

        if (this.runningTasks.size < this.concurrencyLimit) {
            this.startTask(promiseForWrappedTask); // Pass the promise to start tracking
        } else {
            // If the pool is full, add a function to the queue
            // This function, when called, will return the already-created promiseForWrappedTask.
            this.taskQueue.push(() => promiseForWrappedTask);
        }
    }

    // `startTask` expects a Promise, not a function that returns a Promise.
    private startTask(promise: Promise<any>): void {
        this.runningTasks.add(promise);
        // The promise has already been created/started. We just add it to the tracking set.
    }

    private processQueue(): void {
        while (this.runningTasks.size < this.concurrencyLimit && this.taskQueue.length > 0) {
            const nextTaskFunction = this.taskQueue.shift();
            if (nextTaskFunction) {
                // Execute the function from the queue to get the promise, then start tracking it.
                this.startTask(nextTaskFunction());
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
            this.drainPromise = new Promise(resolve => {
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
