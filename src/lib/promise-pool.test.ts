import { PromisePool } from './promise-pool';

// Helper to create a task that resolves after a delay
const createResolvingTask = (id: number | string, delay: number, onStart?: () => void, onEnd?: () => void) => {
  return jest.fn(async () => {
    if (onStart) onStart();
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (onEnd) onEnd();
    // return `Task ${id} completed`;
  });
};

// Helper to create a task that rejects after a delay
const createRejectingTask = (id: number | string, delay: number, onStart?: () => void, onEnd?: () => void) => {
  return jest.fn(async () => {
    if (onStart) onStart();
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (onEnd) onEnd(); // onEnd might still be useful for tracking if it was attempted
    throw new Error(`Task ${id} failed`);
  });
};

describe('PromisePool', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    // Spy on console.error to check if it's called for task failures
    // and suppress it during tests unless explicitly checked.
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore the original console.error
    consoleErrorSpy.mockRestore();
  });

  describe('constructor', () => {
    it('should throw an error if concurrency limit is zero', () => {
      expect(() => new PromisePool(0)).toThrow('Concurrency limit must be a positive number.');
    });

    it('should throw an error if concurrency limit is negative', () => {
      expect(() => new PromisePool(-1)).toThrow('Concurrency limit must be a positive number.');
    });

    it('should initialize with correct default values', () => {
      const pool = new PromisePool(3);
      expect(pool.size).toBe(0);
      expect(pool.queueSize).toBe(0);
    });
  });

  describe('add and drain', () => {
    it('should execute a single task and drain', async () => {
      const pool = new PromisePool(1);
      const task1Mock = createResolvingTask(1, 10);
      pool.add(task1Mock);

      // Task should be called after being added (due to async nature of startTaskExecution)
      await new Promise((resolve) => process.nextTick(resolve)); // Allow microtask queue to process
      expect(task1Mock).toHaveBeenCalledTimes(1);
      expect(pool.size).toBe(1);

      await pool.drain();
      expect(pool.size).toBe(0);
      expect(pool.queueSize).toBe(0);
    });

    it('should execute tasks sequentially if concurrency is 1', async () => {
      const pool = new PromisePool(1);
      const order: number[] = [];
      const task1 = createResolvingTask(1, 30, () => order.push(1));
      const task2 = createResolvingTask(2, 10, () => order.push(2));

      pool.add(task1);
      pool.add(task2);

      await pool.drain();
      // With concurrency 1, task1 must fully complete before task2 starts.
      expect(order).toEqual([1, 2]);
      expect(task1).toHaveBeenCalledTimes(1);
      expect(task2).toHaveBeenCalledTimes(1);
    });

    it('should execute tasks concurrently up to the limit and not exceed it', async () => {
      const concurrencyLimit = 3;
      const pool = new PromisePool(concurrencyLimit);
      let currentlyRunning = 0;
      let maxConcurrencyReached = 0;

      const onTaskStart = () => {
        currentlyRunning++;
        if (currentlyRunning > maxConcurrencyReached) {
          maxConcurrencyReached = currentlyRunning;
        }
      };
      const onTaskEnd = () => {
        currentlyRunning--;
      };

      const numTasks = 10;
      const taskDuration = 50; // ms
      const tasksMocks = [];

      for (let i = 0; i < numTasks; i++) {
        const task = createResolvingTask(i, taskDuration, onTaskStart, onTaskEnd);
        tasksMocks.push(task);
        pool.add(task);
      }

      await pool.drain();

      expect(maxConcurrencyReached).toBe(concurrencyLimit);
      tasksMocks.forEach((task) => expect(task).toHaveBeenCalledTimes(1));
      expect(pool.size).toBe(0);
      expect(pool.queueSize).toBe(0);
      expect(currentlyRunning).toBe(0);
    });

    it('should queue tasks when concurrency limit is reached and process them later in order', async () => {
      const pool = new PromisePool(2);
      const executionLog: string[] = [];
      const taskCompletionOrder: number[] = [];

      const createTaskFn = (id: number, delay: number) => {
        return async () => {
          executionLog.push(`start-${id}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          executionLog.push(`end-${id}`);
          taskCompletionOrder.push(id);
        };
      };

      pool.add(createTaskFn(1, 100)); // Task 1: 100ms
      pool.add(createTaskFn(2, 120)); // Task 2: 120ms
      pool.add(createTaskFn(3, 30)); // Task 3: 30ms (queued)
      pool.add(createTaskFn(4, 40)); // Task 4: 40ms (queued)
      pool.add(createTaskFn(5, 20)); // Task 5: 20ms (queued)

      // Expected timeline with concurrency 2:
      // 0ms: start-1, start-2
      // 100ms: end-1, start-3 (Task 1 finishes, Task 3 starts)
      // 120ms: end-2, start-4 (Task 2 finishes, Task 4 starts)
      // 130ms (100+30): end-3, start-5 (Task 3 finishes, Task 5 starts)
      // 150ms (130+20): end-5 (Task 5 finishes)
      // 160ms (120+40): end-4 (Task 4 finishes)
      // Expected completion order: 1, 2, 3, 5, 4

      await new Promise((r) => setTimeout(r, 10)); // Allow first two tasks to start
      expect(pool.size).toBe(2); // T1, T2 running
      expect(pool.queueSize).toBe(3); // T3, T4, T5 queued

      await pool.drain();

      expect(taskCompletionOrder).toEqual([1, 2, 3, 5, 4]);
      for (let i = 1; i <= 5; i++) {
        expect(executionLog).toContain(`start-${i}`);
        expect(executionLog).toContain(`end-${i}`);
      }
      expect(pool.size).toBe(0);
      expect(pool.queueSize).toBe(0);
    });
  });

  describe('drain method', () => {
    it('should resolve immediately if no tasks are added', async () => {
      const pool = new PromisePool(2);
      await expect(pool.drain()).resolves.toBeUndefined();
    });

    it('should resolve after all tasks are completed', async () => {
      const pool = new PromisePool(2);
      const task1 = createResolvingTask(1, 50);
      const task2 = createResolvingTask(2, 30);
      pool.add(task1);
      pool.add(task2);
      await pool.drain();
      expect(task1).toHaveBeenCalled();
      expect(task2).toHaveBeenCalled();
      expect(pool.size).toBe(0);
    });

    it('should handle multiple calls to drain correctly, returning the same promise', async () => {
      const pool = new PromisePool(1);
      const task1 = createResolvingTask(1, 50);
      pool.add(task1);

      const drainPromise1 = pool.drain();
      const drainPromise2 = pool.drain();
      expect(drainPromise1).toStrictEqual(drainPromise2); // Should be the same promise object

      await Promise.all([drainPromise1, drainPromise2]);
      expect(task1).toHaveBeenCalled();
      expect(pool.size).toBe(0);
    });

    it('should allow adding tasks while drain is pending and wait for them', async () => {
      const pool = new PromisePool(1);
      const task1 = createResolvingTask('T1', 100);
      const task2 = createResolvingTask('T2', 50);

      pool.add(task1);
      const drainPromise = pool.drain(); // Drain starts waiting for task1

      // Add another task *after* drain() was called but before task1 finishes
      await new Promise((r) => setTimeout(r, 10)); // Ensure task1 has started
      expect(pool.size).toBe(1);
      pool.add(task2); // task2 gets queued
      expect(pool.queueSize).toBe(1);

      await drainPromise; // This should wait for both task1 and task2

      expect(task1).toHaveBeenCalled();
      expect(task2).toHaveBeenCalled();
      expect(pool.size).toBe(0);
      expect(pool.queueSize).toBe(0);
    });
  });

  describe('task errors', () => {
    it('should continue processing other tasks if one task fails', async () => {
      const pool = new PromisePool(2);
      const task1Success = createResolvingTask('S1', 20);
      const task2Failure = createRejectingTask('F2', 30);
      const task3Success = createResolvingTask('S3', 10);

      pool.add(task1Success);
      pool.add(task2Failure);
      pool.add(task3Success); // This should run after task1 or task2 slot frees up

      await pool.drain();

      expect(task1Success).toHaveBeenCalled();
      expect(task2Failure).toHaveBeenCalled();
      expect(task3Success).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith('Task in PromisePool failed:', expect.any(Error));
      expect(pool.size).toBe(0);
    });

    it('drain should resolve even if tasks fail', async () => {
      const pool = new PromisePool(1);
      const failingTask = createRejectingTask(1, 10);
      pool.add(failingTask);
      await expect(pool.drain()).resolves.toBeUndefined();
      expect(failingTask).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('size and queueSize getters', () => {
    it('should correctly report size and queueSize during operations', async () => {
      const pool = new PromisePool(2);
      expect(pool.size).toBe(0);
      expect(pool.queueSize).toBe(0);

      // Using non-jest.fn tasks for simplicity in this specific check
      const longTask = () => new Promise<void>((r) => setTimeout(r, 200));

      pool.add(longTask); // Task 1 starts
      expect(pool.size).toBe(1);
      expect(pool.queueSize).toBe(0);

      pool.add(longTask); // Task 2 starts
      expect(pool.size).toBe(2);
      expect(pool.queueSize).toBe(0);

      pool.add(longTask); // Task 3 queued
      expect(pool.size).toBe(2);
      expect(pool.queueSize).toBe(1);

      pool.add(longTask); // Task 4 queued
      expect(pool.size).toBe(2);
      expect(pool.queueSize).toBe(2);

      await pool.drain();
      expect(pool.size).toBe(0);
      expect(pool.queueSize).toBe(0);
    });
  });
});
