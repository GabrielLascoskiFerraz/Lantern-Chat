import fs from 'node:fs';
import path from 'node:path';
import { EncryptedFields } from './security';

const safeSegment = (value: string): string => value.replace(/[^a-zA-Z0-9-]/g, '_');

export class EncryptedChunkStore {
  constructor(private readonly rootDir: string, private readonly encrypted: EncryptedFields) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  directory(...scope: string[]): string {
    return path.join(this.rootDir, ...scope.map(safeSegment));
  }

  prepare(...scope: string[]): string {
    const directory = this.directory(...scope);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  reset(...scope: string[]): string {
    const directory = this.directory(...scope);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  remove(...scope: string[]): void {
    fs.rmSync(this.directory(...scope), { recursive: true, force: true });
  }

  has(index: number, ...scope: string[]): boolean {
    return fs.existsSync(this.chunkPath(index, scope));
  }

  write(index: number, data: Buffer, ...scope: string[]): void {
    fs.mkdirSync(this.directory(...scope), { recursive: true });
    fs.writeFileSync(this.chunkPath(index, scope), this.encrypted.encryptBytes(data));
  }

  read(index: number, ...scope: string[]): Buffer {
    return this.encrypted.decryptBytes(fs.readFileSync(this.chunkPath(index, scope)));
  }

  async readAsync(index: number, ...scope: string[]): Promise<Buffer> {
    return this.encrypted.decryptBytes(await fs.promises.readFile(this.chunkPath(index, scope)));
  }

  private chunkPath(index: number, scope: string[]): string {
    if (!Number.isInteger(index) || index < 0) throw new Error('Índice de chunk inválido.');
    return path.join(this.directory(...scope), `${index}.bin`);
  }
}
