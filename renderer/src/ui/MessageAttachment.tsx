import { useEffect, useRef } from 'react';
import { Button, Caption1, ProgressBar, Spinner } from '@fluentui/react-components';
import { Clock20Regular } from '@fluentui/react-icons';
import { MessageRow } from '../api/ipcClient';
import { ipcClient } from '../api/ipcClient';

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
  if (progress?.stage === 'complete' || progressPercent === 100) return { label: 'Anexo disponível', tone: 'done' };
  if (progressPercent !== null) return { label: `Transferindo · ${progressPercent}%`, tone: 'active' };
  if (message.status === 'sent' || message.status === null) return { label: 'Aguardando o Relay', tone: 'neutral' };
  return { label: 'Anexo disponível', tone: 'done' };
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
  const isImageFile = isImageAttachmentName(message.fileName);
  const isStickerFile = isStickerAttachmentName(message.fileName);
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
  }, [message.messageId]);

  useEffect(() => {
    if (message.filePath || !message.fileId || message.status === 'failed') return;
    const sentinel = hydrationSentinelRef.current;
    if (!sentinel) return;

    const requestHydration = () => {
      if (hydrationRequestedRef.current) return;
      hydrationRequestedRef.current = true;
      void ipcClient.getMessagesByIds([message.messageId]).then((rows) => {
        if (!rows.some((row) => row.messageId === message.messageId && row.filePath)) {
          window.setTimeout(() => { hydrationRequestedRef.current = false; }, 2_000);
        }
      }).catch(() => {
        window.setTimeout(() => { hydrationRequestedRef.current = false; }, 2_000);
      });
    };

    if (typeof IntersectionObserver === 'undefined') {
      requestHydration();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        requestHydration();
        observer.disconnect();
      }
    }, { rootMargin: '240px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [message.fileId, message.filePath, message.messageId, message.status]);

  return (
    <>
      <span ref={hydrationSentinelRef} className="attachment-hydration-sentinel" aria-hidden />
      {!isStickerFile && <div className="message-file-title">📎 {message.fileName}</div>}
      {isImageFile && Boolean(message.filePath) && (
        <button
          type="button"
          className={`message-image-preview-btn ${isStickerFile ? 'sticker-preview' : ''} ${previewDataUrl ? 'is-ready' : ''} ${previewVisible ? 'is-media-visible' : ''}`}
          onClick={() => void onOpenFile(message.filePath!)}
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
          {formatBytes(message.fileSize)} · SHA-256 {message.fileSha256?.slice(0, 10)}...
        </div>
      )}
      {progressPercent !== null && !isStickerFile && (
        <div className="message-file-progress-wrap">
          <ProgressBar value={progressPercent / 100} thickness="medium" />
          <div className="message-file-progress">
            Transferência: {progressPercent}% · {formatBytes(transfer?.transferred)} / {formatBytes(transfer?.total)}
          </div>
        </div>
      )}
      {(!isStickerFile || transferStage.tone !== 'done') && (
        <div className={`transfer-stage-pill ${transferStage.tone}`}>{transferStage.label}</div>
      )}
      {message.filePath && message.status !== 'failed' ? (
        isStickerFile ? null : (
          <div className="message-file-actions">
            <Button size="small" onClick={() => void onOpenFile(message.filePath!)}>Abrir</Button>
            <Button size="small" appearance="secondary" onClick={() => void onSaveFileAs(message.filePath!, message.fileName)}>
              Salvar como
            </Button>
          </div>
        )
      ) : message.status === 'failed' ? (
        <div className="inline-status error">
          <Caption1>{outgoing ? 'Não foi possível enviar este anexo.' : 'Não foi possível recuperar este anexo do Relay.'}</Caption1>
        </div>
      ) : message.status === 'delivered' || message.status === 'read' ? (
        <div className="inline-status pending"><Spinner size="tiny" /><Caption1>Recuperando anexo do Relay...</Caption1></div>
      ) : outgoing && (message.status === 'sent' || message.status === null) ? (
        <div className="inline-status pending"><Clock20Regular className="bubble-time-icon pending" /><Caption1>Anexo pendente. Envia quando o Relay confirmar.</Caption1></div>
      ) : (
        <div className="inline-status"><Spinner size="tiny" /><Caption1>Aguardando arquivo completo...</Caption1></div>
      )}
    </>
  );
};
