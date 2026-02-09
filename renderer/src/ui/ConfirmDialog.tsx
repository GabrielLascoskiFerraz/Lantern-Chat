import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text
} from '@fluentui/react-components';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog = ({
  open,
  title,
  description,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  onConfirm,
  onCancel
}: ConfirmDialogProps) => (
  <Dialog open={open} modalType="alert" onOpenChange={(_, data) => !data.open && onCancel()}>
    <DialogSurface className="confirm-modal">
      <DialogBody>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <Text>{description}</Text>
        </DialogContent>
        <DialogActions>
          <Button appearance="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button appearance="primary" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogActions>
      </DialogBody>
    </DialogSurface>
  </Dialog>
);
