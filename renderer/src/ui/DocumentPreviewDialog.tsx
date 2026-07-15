import { ReactNode, useEffect, useState } from 'react';
import {
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Spinner,
  Text
} from '@fluentui/react-components';
import {
  Archive20Regular,
  Dismiss20Regular,
  Document20Regular,
  DocumentPdf20Regular,
  DocumentTable20Regular,
  DocumentText20Regular,
  Eye20Regular,
  SlideText20Regular
} from '@fluentui/react-icons';
import { DocumentPreviewResult, ipcClient } from '../api/ipcClient';

const extensionOf = (fileName: string | null | undefined): string =>
  fileName?.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase() || '';

const PDF_EXTENSIONS = new Set(['pdf']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log', 'ini', 'conf', 'rtf']);
const TABLE_EXTENSIONS = new Set(['xls', 'xlsx', 'ods', 'csv', 'tsv']);
const SLIDE_EXTENSIONS = new Set(['ppt', 'pptx', 'odp']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']);

export const canPreviewDocumentName = (fileName: string | null | undefined): boolean => {
  const extension = extensionOf(fileName);
  return PDF_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension);
};

export const documentExtensionLabel = (fileName: string | null | undefined): string =>
  (extensionOf(fileName) || 'ARQ').toLocaleUpperCase('pt-BR');

export const DocumentTypeIcon = ({ fileName }: { fileName: string | null | undefined }): ReactNode => {
  const extension = extensionOf(fileName);
  if (PDF_EXTENSIONS.has(extension)) return <DocumentPdf20Regular />;
  if (TABLE_EXTENSIONS.has(extension)) return <DocumentTable20Regular />;
  if (SLIDE_EXTENSIONS.has(extension)) return <SlideText20Regular />;
  if (ARCHIVE_EXTENSIONS.has(extension)) return <Archive20Regular />;
  if (TEXT_EXTENSIONS.has(extension) || ['doc', 'docx', 'odt'].includes(extension)) return <DocumentText20Regular />;
  return <Document20Regular />;
};

interface DocumentPreviewDialogProps {
  open: boolean;
  filePath: string | null | undefined;
  fileName: string | null | undefined;
  onClose: () => void;
  onOpenFile: (filePath: string) => Promise<void>;
  onSaveFileAs: (filePath: string, fileName?: string | null) => Promise<void>;
}

export const DocumentPreviewDialog = ({
  open,
  filePath,
  fileName,
  onClose,
  onOpenFile,
  onSaveFileAs
}: DocumentPreviewDialogProps) => {
  const [preview, setPreview] = useState<DocumentPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !filePath) return;
    let cancelled = false;
    setPreview(null); setError(''); setLoading(true);
    void ipcClient.getDocumentPreview(filePath, fileName)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        if (result.kind === 'unsupported') setError(result.reason || 'Prévia indisponível.');
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Não foi possível gerar a prévia.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fileName, filePath, open]);

  return <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
    <DialogSurface className="document-preview-dialog">
      <DialogBody>
        <DialogTitle action={<DialogTrigger action="close" disableButtonEnhancement>
          <Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Fechar prévia" />
        </DialogTrigger>}>
          <span className="document-preview-title"><DocumentTypeIcon fileName={fileName} />{fileName || 'Documento'}</span>
        </DialogTitle>
        <DialogContent className="document-preview-content">
          {loading && <div className="document-preview-state"><Spinner /><Caption1>Preparando prévia…</Caption1></div>}
          {!loading && error && <div className="document-preview-state" role="status">
            <DocumentTypeIcon fileName={fileName} />
            <Text weight="semibold">Prévia indisponível</Text>
            <Caption1>{error}</Caption1>
          </div>}
          {!loading && !error && preview?.kind === 'pdf' && preview.url && (
            <iframe className="document-pdf-preview" src={preview.url} title={`Prévia de ${fileName || 'PDF'}`} />
          )}
          {!loading && !error && preview?.kind === 'text' && (
            <div className="document-text-preview-wrap">
              {preview.truncated && <div className="document-preview-warning">Exibindo somente os primeiros 512 KB.</div>}
              <pre className="document-text-preview">{preview.text}</pre>
            </div>
          )}
        </DialogContent>
        <DialogActions>
          {filePath && <Button appearance="secondary" onClick={() => void onSaveFileAs(filePath, fileName)}>Salvar como</Button>}
          {filePath && <Button appearance="primary" icon={<Eye20Regular />} onClick={() => void onOpenFile(filePath)}>Abrir</Button>}
        </DialogActions>
      </DialogBody>
    </DialogSurface>
  </Dialog>;
};
