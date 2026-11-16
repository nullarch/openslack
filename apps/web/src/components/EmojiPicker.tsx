import Picker from '@emoji-mart/react';
import { useMemo } from 'react';
import { asset } from '../lib/api';
import { customEmojiUrl, emojiData } from '../lib/emoji';
import { useStore } from '../lib/store';
import { resolvedTheme } from '../lib/theme';
import { S } from '../strings';

interface Picked {
  id: string;
  skin?: number;
  native?: string;
}

/**
 * The full emoji picker. It is its own chunk: this module pulls in the picker
 * library, which is only needed once someone opens it.
 */
export default function EmojiPicker({ onPick }: { onPick: (name: string) => void }) {
  const custom = useStore((state) => state.emoji);
  const categories = useMemo(() => {
    const emojis = Object.keys(custom)
      .map((name) => ({ name, url: customEmojiUrl(name, custom) }))
      .filter((item): item is { name: string; url: string } => item.url !== null)
      .map((item) => ({ id: item.name, name: item.name, keywords: [item.name], skins: [{ src: asset(item.url) }] }));
    return emojis.length > 0 ? [{ id: 'custom', name: S.admin.emoji, emojis }] : [];
  }, [custom]);

  return (
    <Picker
      data={emojiData()}
      custom={categories}
      theme={resolvedTheme()}
      autoFocus
      previewPosition="none"
      skinTonePosition="search"
      maxFrequentRows={2}
      onEmojiSelect={(emoji: Picked) => {
        // Skin 1 is the default tone; Slack names tones 2–6.
        onPick(emoji.skin && emoji.skin > 1 && emoji.native ? `${emoji.id}::skin-tone-${emoji.skin}` : emoji.id);
      }}
    />
  );
}
