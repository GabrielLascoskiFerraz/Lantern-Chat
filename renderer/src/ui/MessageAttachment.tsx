import { useEffect, useRef, useState } from 'react';
import { Button, Caption1, ProgressBar, Spinner } from '@fluentui/react-components';
import { Clock20Regular, Eye20Regular } from '@fluentui/react-icons';
import { MessageRow } from '../api/ipcClient';
import { ipcClient } from '../api/ipcClient';
import {
  canPreviewDocumentName,
  DocumentPreviewDialog,
  documentExtensionLabel,
  DocumentTypeIcon
} from './DocumentPreviewDialog';
import { ImagePreviewDialog } from './ImagePreviewDialog';

export interface AttachmentTransferState {
  transferred: number;
  total: number;
  stage?: 'pending' | 'reconnecting' | 'uploading' | 'downloading' | 'retrying' | 'complete' | 'failed' | string;
  attempt?: number;
  detail?: string | null;
}

interface MessageAttachmentProps {
  message: MessageRow;
  outgoing: boolean;
  previewDataUrl?: string | null;
  previewVisible?: boolean;
  transfer?: AttachmentTransferState;
  onOpenFile: (filePath: string) => Promise<void>;
  onSaveFileAs: (filePath: string, fileName?: string | null) => Promise<void>;
}

const formatBytes = (bytes: number | null | undefined): string => {
  const safe = Number(bytes || 0);
  if (!Number.isFinite(safe) || safe <= 0) return '0 B';
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
  if (safe < 1024 * 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(1)} MB`;
  return `${(safe / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

export const isImageAttachmentName = (name: string | null): boolean =>
  Boolean(name && /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/i.test(name));

export const isStickerAttachmentName = (name: string | null): boolean =>
  Boolean(
    name &&
    /\.gif$/i.test(name) &&
    (name.toLowerCase().includes('lantern-cat-sticker-') ||
      name.toLowerCase().includes('lantern-sticker-'))
  );

const transferStageLabel = (
  message: MessageRow,
  progressPercent: number | null,
  progress?: AttachmentTransferState
): { label: string; tone: 'neutral' | 'active' | 'done' | 'error' } => {
  if (progress?.stage === 'reconnecting') return { label: 'Aguardando reconexão', tone: 'neutral' };
  if (progress?.stage === 'retrying') {
    return { label: `Baixando novamente${progress.attempt ? ` · tentativa ${progress.attempt}` : ''}`, tone: 'active' };
  }
  if (progress?.stage === 'pending') return { label: progress.detail || 'Aguardando o Relay', tone: 'neutral' };
  if (progress?.stage === 'failed') return { label: progress.detail || 'Falha definitiva', tone: 'error' };
  if (progress?.stage === 'complete' || progressPercent === 100) return { label: '', tone: 'done' };
  if (progressPercent !== null) return { label: `Transferindo · ${progressPercent}%`, tone: 'active' };
  if (message.status === 'sent' || message.status === null) return { label: 'Aguardando o Relay', tone: 'neutral' };
  return { label: '', tone: 'done' };
};

export const MessageAttachment = ({
  message,
  outgoing,
  previewDataUrl,
  previewVisible = Boolean(previewDataUrl),
  transfer,
  onOpenFile,
  onSaveFileAs
}: MessageAttachmentProps) => {
  const hydrationSentinelRef = useRef<HTMLSpanElement | null>(null);
  const hydrationRequestedRef = useRef(false);
  const [documentPreviewOpen, setDocumentPreviewOpen] = useState(false);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [manualRetrying, setManualRetrying] = useState(false);
  const [manualRetryError, setManualRetryError] = useState('');
  const isImageFile = isImageAttachmentName(message.fileName);
  const isStickerFile = isStickerAttachmentName(message.fileName);
  const isDocumentFile = !isImageFile && !isStickerFile;
  const progressPercent = transfer && transfer.total > 0
    ? Math.min(100, Math.floor((transfer.transferred / transfer.total) * 100))
    : null;
  const transferInProgress = Boolean(
    transfer && transfer.total > 0 &&
    (transfer.transferred < transfer.total || message.status === 'sent' || message.status === null)
  );
  const previewUnavailable = isImageFile && !previewDataUrl && !transferInProgress &&
    (message.status === 'delivered' || message.status === 'read');
  const transferStage = transferStageLabel(message, progressPercent, transfer);

  useEffect(() => {
    hydrationRequestedRef.current = false;
    setManualRetrying(false);
    setManualRetryError('');
  }, [message.messageId]);

  useEffect(() => {
    if (message.filePath) return;
    hydrationRequestedRef.current = false;
    setDocumentPreviewOpen(false);
    setImagePreviewOpen(false);
  }, [message.filePath]);

  const retryAttachment = async () => {
    if (manualRetrying) return;
    setManualRetrying(true);
    setManualRetryError('');
    try {
      if (outgoing) await ipcClient.retryMessage(message.messageId);
      else await ipcClient.retryAttachment(message.messageId);
    } catch (error) {
      const rawMessage = error instanceof Error
        ? error.message
        : 'Não foi possível tentar o download novamente.';
      setManualRetryError(
        rawMessage.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '')
      );
    } finally {
      setManualRetrying(false);
    }
  };

  useEffect(() => {
    if (message.filePath || !message.fileId || message.status === 'failed') return;
    hydrationRequestedRef.current = false;
    const sentinel = hydrationSentinelRef.current;
    if (!sentinel) return;
    let active = true;
    let visible = typeof IntersectionObserver === 'undefined';
    let retryTimer: number | null = null;

    const scheduleRetry = () => {
      if (!active || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        hydrationRequestedRef.current = false;
        if (visible) requestHydration();
      }, 2_000);
    };

    const requestHydration = () => {
      if (!active || !visible || hydrationRequestedRef.current) return;
      hydrationRequestedRef.current = true;
      void ipcClient.getMessagesByIds([message.messageId]).then((rows) => {
        if (!rows.some((row) => row.messageId === message.messageId && row.filePath)) {
          scheduleRetry();
        }
      }).catch(() => {
        scheduleRetry();
      });
    };

    if (typeof IntersectionObserver === 'undefined') {
      requestHydration();
      return () => {
        active = false;
        if (retryTimer !== null) window.clearTimeout(retryTimer);
      };
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === sentinel);
      visible = Boolean(entry?.isIntersecting);
      if (visible) requestHydration();
    }, { rootMargin: '240px 0px' });
    observer.observe(sentinel);
    return () => {
      active = false;
      observer.disconnect();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [message.fileId, message.filePath, message.messageId, message.status]);

  return (
    <>
      <span ref={hydrationSentinelRef} className="attachment-hydration-sentinel" aria-hidden />
      {!isStickerFile && (isDocumentFile ? (
        <div className="message-document-card">
          <span className="message-document-icon"><DocumentTypeIcon fileName={message.fileName} /><small>{documentExtensionLabel(message.fileName)}</small></span>
          <span className="message-document-copy"><strong>{message.fileName || 'Arquivo'}</strong><small>Documento {documentExtensionLabel(message.fileName)}</small></span>
        </div>
      ) : <div className="message-file-title">📎 {message.fileName}</div>)}
      {isImageFile && Boolean(message.filePath) && (
        <button
          type="button"
          className={`message-image-preview-btn ${isStickerFile ? 'sticker-preview' : ''} ${previewDataUrl ? 'is-ready' : ''} ${previewVisible ? 'is-media-visible' : ''}`}
          onClick={() => setImagePreviewOpen(true)}
          disabled={!previewVisible}
        >
          {previewDataUrl && <img src={previewDataUrl} alt={message.fileName || 'Imagem'} className="message-image-preview" />}
          <div className={`message-image-preview-placeholder ${previewVisible ? 'hidden' : ''}`} aria-hidden>
            {previewUnavailable ? 'Pré-visualização indisponível' : 'Carregando imagem...'}
          </div>
        </button>
      )}
      {!isStickerFile && (
        <div className="message-file-meta">
          {formatBytes(message.fileSize)}
        </div>
      )}
      {progressPercent !== null && transferStage.tone !== 'done' && !isStickerFile && (
        <div className="message-file-progress-wrap">
          <ProgressBar value={progressPercent / 100} thickness="medium" />
          <div className="message-file-progress">
            Transferência: {progressPercent}% · {formatBytes(transfer?.transferred)} / {formatBytes(transfer?.total)}
          </div>
        </div>
      )}
      {transferStage.tone !== 'done' && (
        <div className={`transfer-stage-pill ${transferStage.tone}`}>{transferStage.label}</div>
      )}
      {message.filePath && message.status !== 'failed' ? (
        isStickerFile ? null : (
          <div className="message-file-actions">
            {isImageFile && (
              <Button size="small" appearance="secondary" icon={<Eye20Regular />} disabled={!previewDataUrl} onClick={() => setImagePreviewOpen(true)}>Prévia</Button>
            )}
            {isDocumentFile && canPreviewDocumentName(message.fileName) && (
              <Button size="small" appearance="secondary" icon={<Eye20Regular />} onClick={() => setDocumentPreviewOpen(true)}>Prévia</Button>
            )}
            <Button size="small" onClick={() => void onOpenFile(message.filePath!)}>Abrir</Button>
            <Button size="small" appearance="secondary" onClick={() => void onSaveFileAs(message.filePath!, message.fileName)}>
              Salvar como
            </Button>
          </div>
        )
      ) : message.status === 'failed' ? (
        <div className="attachment-retry-block">
          <div className="inline-status error">
            <Caption1>{outgoing ? 'Não foi possível enviar este anexo.' : 'Não foi possível recuperar este anexo do Relay.'}</Caption1>
          </div>
          <Button
            size="small"
            appearance="secondary"
            disabled={manualRetrying}
            onClick={() => void retryAttachment()}
          >
            {manualRetrying ? <><Spinner size="tiny" /> Tentando novamente...</> : 'Tentar novamente'}
          </Button>
          {manualRetryError && <Caption1 className="attachment-retry-error">{manualRetryError}</Caption1>}
        </div>
      ) : message.status === 'delivered' || message.status === 'read' ? (
        <div className="inline-status pending"><Spinner size="tiny" /><Caption1>Recuperando anexo do Relay...</Caption1></div>
      ) : outgoing && (message.status === 'sent' || message.status === null) ? (
        <div className="inline-status pending"><Clock20Regular className="bubble-time-icon pending" /><Caption1>Anexo pendente. Envia quando o Relay confirmar.</Caption1></div>
      ) : (
        <div className="inline-status"><Spinner size="tiny" /><Caption1>Aguardando arquivo completo...</Caption1></div>
      )}
      <DocumentPreviewDialog
        open={documentPreviewOpen}
        filePath={message.filePath}
        fileName={message.fileName}
        onClose={() => setDocumentPreviewOpen(false)}
        onOpenFile={onOpenFile}
        onSaveFileAs={onSaveFileAs}
      />
      <ImagePreviewDialog
        open={imagePreviewOpen && Boolean(previewDataUrl)}
        src={previewDataUrl}
        filePath={message.filePath}
        fileName={message.fileName}
        onClose={() => setImagePreviewOpen(false)}
        onOpenFile={onOpenFile}
        onSaveFileAs={onSaveFileAs}
        showFileActions={!isStickerFile}
      />
    </>
  );
};
