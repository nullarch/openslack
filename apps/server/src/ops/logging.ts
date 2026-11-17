import { format } from 'node:util';

/**
 * `LOG_FORMAT=json` turns every log line into one JSON object
 * (`{"time","level","msg"}`) for log collectors. Errors keep their stack.
 */
export function useJsonLogs(): void {
  const write = (level: string, stream: NodeJS.WriteStream) => (...args: unknown[]): void => {
    const error = args.find((arg): arg is Error => arg instanceof Error);
    const line: Record<string, unknown> = { time: new Date().toISOString(), level, msg: format(...args.filter((arg) => arg !== error)).trim() };
    if (error) line.error = { message: error.message, stack: error.stack };
    stream.write(`${JSON.stringify(line)}\n`);
  };
  console.log = write('info', process.stdout);
  console.info = write('info', process.stdout);
  console.warn = write('warn', process.stderr);
  console.error = write('error', process.stderr);
}
