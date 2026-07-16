import path from 'node:path';
import { importConvertedBackup } from './convertedBackup';

const option = (name: string): string => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
};

try {
  const bundlePath = option('--backup');
  const relayDataDir = option('--relay-data');
  if (!bundlePath || !relayDataDir) {
    throw new Error('Uso: --backup <pasta> --relay-data <pasta>.');
  }
  const result = importConvertedBackup({
    bundlePath: path.resolve(bundlePath),
    relayDataDir: path.resolve(relayDataDir)
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
