declare module "vitest" {
  type MockableFn = {
    mock: {
      calls: unknown[][];
    };
    mockResolvedValue(value: unknown): unknown;
    mockResolvedValueOnce(value: unknown): MockableFn;
    mockRejectedValue(value: unknown): unknown;
    mockRejectedValueOnce(value: unknown): MockableFn;
  };

  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export const vi: {
    spyOn<T extends object, K extends keyof T>(
      obj: T,
      key: K,
    ): MockableFn;
    fn<T extends (...args: never[]) => unknown>(impl?: T): MockableFn;
    restoreAllMocks(): void;
  };
  export const expect: {
    <T = unknown>(value: T): {
      toBe(expected: unknown): void;
      toContain(expected: unknown): void;
      toHaveBeenCalled(): void;
      toHaveBeenCalledWith(...args: unknown[]): void;
      not: {
        toHaveBeenCalled(): void;
      };
    };
    objectContaining<T extends object>(value: T): T;
  };
}

declare module "child_process" {
  export function spawn(
    command: string,
    args?: string[],
    options?: {
      cwd?: string;
      detached?: boolean;
      stdio?: string;
    },
  ): {
    unref(): void;
  };
}

declare module "node:stream" {
  export class PassThrough {
    constructor();
    end(chunk?: string | Buffer): void;
  }
}

declare global {
  type Buffer = Uint8Array;
}