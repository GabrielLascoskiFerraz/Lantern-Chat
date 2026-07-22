import { useEffect, useState } from 'react';
import { Button, Input } from '@fluentui/react-components';
import type { InputProps } from '@fluentui/react-components';
import { Eye20Regular, EyeOff20Regular } from '@fluentui/react-icons';

type PasswordInputProps = Omit<InputProps, 'contentAfter' | 'type'>;

export const PasswordInput = ({ value, autoComplete, ...props }: PasswordInputProps) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  useEffect(() => {
    setVisible(false);
  }, [autoComplete]);

  const visibilityLabel = visible ? 'Ocultar senha' : 'Mostrar senha';

  return (
    <Input
      {...props}
      value={value}
      autoComplete={autoComplete}
      type={visible ? 'text' : 'password'}
      contentAfter={(
        <Button
          type="button"
          className="password-visibility-button"
          appearance="subtle"
          size="small"
          icon={visible ? <EyeOff20Regular /> : <Eye20Regular />}
          aria-label={visibilityLabel}
          title={visibilityLabel}
          aria-pressed={visible}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((current) => !current)}
        />
      )}
    />
  );
};
