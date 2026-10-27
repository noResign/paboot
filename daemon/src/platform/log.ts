function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info: (msg: string, ...args: unknown[]): void => {
    console.log(`[${ts()}] INFO  ${msg}`, ...args);
  },
  warn: (msg: string, ...args: unknown[]): void => {
    console.warn(`[${ts()}] WARN  ${msg}`, ...args);
  },
  error: (msg: string, ...args: unknown[]): void => {
    console.error(`[${ts()}] ERROR ${msg}`, ...args);
  },
};
