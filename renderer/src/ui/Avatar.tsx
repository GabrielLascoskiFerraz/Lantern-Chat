interface AvatarProps {
  emoji: string;
  bg: string;
  size?: number;
}

export const Avatar = ({ emoji, bg, size = 36 }: AvatarProps) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      backgroundColor: bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0
    }}
  >
    <span
      style={{
        fontSize: Math.max(18, Math.floor(size * 0.58)),
        lineHeight: 1
      }}
    >
      {emoji}
    </span>
  </div>
);
