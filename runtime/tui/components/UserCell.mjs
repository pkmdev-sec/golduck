import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../theme.mjs';

const h = React.createElement;

/**
 * droidx-style user cell. droidx renders user turns as "> text" flush-left
 * in the user accent color (#EBB28C), not boxed. Multi-line prompts keep
 * the prefix on the first line only, with continuation lines aligned to
 * the same column.
 */
export function UserCell({ text }) {
  const lines = String(text || '').split('\n');
  return h(Box, { flexDirection: 'column', marginTop: 1 },
    ...lines.map((line, i) => h(Box, { key: i },
      i === 0
        ? h(Text, { color: COLORS.primary, bold: true }, '> ')
        : h(Text, null, '  '),
      h(Text, { color: COLORS.textUser }, line),
    )),
  );
}
