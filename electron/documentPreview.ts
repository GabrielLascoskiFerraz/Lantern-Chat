import fs from 'node:fs';
import path from 'node:path';
import { DocumentPreviewResult } from './types';

const unsupported = (reason: string, mimeType = 'application/octet-stream'): DocumentPreviewResult => ({
  kind: 'unsupported', mimeType, url: null, text: null, truncated: false, reason
});

const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json',
  '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.log': 'text/plain', '.ini': 'text/plain', '.conf': 'text/plain', '.rtf': 'application/rtf'
};

export const createDocumentPreview = async (
  filePath: string,
  fileName?: string | null
): Promise<DocumentPreviewResult> => {
  if (!filePath) return unsupported('Arquivo indisponível.');
  const resolved = path.resolve(filePath);
  try {
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) return unsupported('Arquivo indisponível.');
    const ext = path.extname((fileName || '').trim() || resolved).toLowerCase();
    if (ext === '.pdf') {
      if (stat.size > 20 * 1024 * 1024) {
        return unsupported('Este PDF é grande demais para a prévia. Use Abrir para visualizá-lo.', 'application/pdf');
      }
      const file = await fs.promises.readFile(resolved);
      return {
        kind: 'pdf', mimeType: 'application/pdf',
        url: `data:application/pdf;base64,${file.toString('base64')}`,
        text: null, truncated: false, reason: null
      };
    }
    const mimeType = TEXT_MIME_BY_EXTENSION[ext];
    if (!mimeType) return unsupported('Este formato não possui prévia segura no Lantern.');
    const maxBytes = 512 * 1024;
    const handle = await fs.promises.open(resolved, 'r');
    try {
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) return unsupported('O conteúdo deste arquivo não é texto legível.', mimeType);
      return {
        kind: 'text', mimeType, url: null, text: content.toString('utf8'),
        truncated: stat.size > maxBytes, reason: null
      };
    } finally {
      await handle.close();
    }
  } catch {
    return unsupported('Não foi possível gerar a prévia deste documento.');
  }
};
