import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Spinner
} from '@fluentui/react-components';
import {
  Dismiss20Regular,
  ImageMultiple20Regular,
  Save20Regular
} from '@fluentui/react-icons';

export interface AlbumGalleryItem {
  id: string;
  fileName: string | null;
  previewDataUrl?: string | null;
  previewVisible?: boolean;
}

interface AlbumGalleryDialogProps {
  open: boolean;
  items: AlbumGalleryItem[];
  readyCount: number;
  saving: boolean;
  onClose: () => void;
  onSelect: (index: number) => void;
  onSaveAll: () => Promise<void>;
}

export const AlbumGalleryDialog = ({
  open,
  items,
  readyCount,
  saving,
  onClose,
  onSelect,
  onSaveAll
}: AlbumGalleryDialogProps) => (
  <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
    <DialogSurface className="album-gallery-dialog">
      <DialogBody>
        <DialogTitle
          action={(
            <DialogTrigger action="close" disableButtonEnhancement>
              <Button
                appearance="subtle"
                icon={<Dismiss20Regular />}
                aria-label="Fechar galeria do álbum"
              />
            </DialogTrigger>
          )}
        >
          <span className="album-gallery-title">
            <ImageMultiple20Regular aria-hidden />
            <span>Álbum</span>
            <span className="album-gallery-count">{items.length} fotos</span>
          </span>
        </DialogTitle>

        <DialogContent className="album-gallery-content">
          <div className="album-gallery-grid" aria-label={`Álbum com ${items.length} fotos`}>
            {items.map((item, index) => {
              const available = Boolean(item.previewDataUrl && item.previewVisible);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="album-gallery-item"
                  disabled={!available}
                  onClick={() => onSelect(index)}
                  aria-label={available
                    ? `Abrir foto ${index + 1} de ${items.length}`
                    : `Foto ${index + 1} de ${items.length} sendo carregada`}
                >
                  {available ? (
                    <img
                      src={item.previewDataUrl!}
                      alt={item.fileName || `Foto ${index + 1}`}
                    />
                  ) : (
                    <span className="album-gallery-loading">
                      <Spinner size="small" />
                      <span>Carregando</span>
                    </span>
                  )}
                  <span className="album-gallery-index">{index + 1}</span>
                </button>
              );
            })}
          </div>
        </DialogContent>

        <DialogActions className="album-gallery-actions">
          <span className="album-gallery-status">
            {readyCount === items.length
              ? `${items.length} fotos disponíveis`
              : `Preparando ${readyCount} de ${items.length}`}
          </span>
          <Button
            appearance="secondary"
            icon={<Save20Regular />}
            disabled={saving || readyCount !== items.length}
            onClick={() => void onSaveAll()}
          >
            {saving ? 'Salvando…' : 'Salvar todas'}
          </Button>
          <Button appearance="primary" onClick={onClose}>Fechar</Button>
        </DialogActions>
      </DialogBody>
    </DialogSurface>
  </Dialog>
);
