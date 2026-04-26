import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';
import { Collapsible } from './Collapsible.mjs';

const h = React.createElement;

/**
 * droidx-style assistant cell.
 * droidx shows assistant turns as plain flowing text in textPrimary, no
 * header chip, with a subtle orange "●" marker at the very start. Usage
 * footer is dim muted grey so it reads like a timestamp.
 */
export function AssistantCell({ entry }) {
  const text = entry.text || '';
  const usage = entry.usage;
  const lineCount = text ? text.split('\n').length : 0;
  const long = lineCount > 40;

  return h(Box, { flexDirection: 'column', marginTop: 1 },
    h(Box, null,
      h(Text, { color: COLORS.primary, bold: true }, `${GLYPH.dot} `),
      long
        ? null
        : h(Text, { color: COLORS.textPrimary, wrap: 'wrap' }, text.split('\n')[0] || ''),
    ),
    long
      ? h(Box, { marginLeft: 2, flexDirection: 'column' },
          h(Collapsible, {
            text,
            maxLines: 40,
            expanded: entry.expanded ?? false,
          }),
        )
      : h(Box, { marginLeft: 2, flexDirection: 'column' },
          ...text.split('\n').slice(1).map((l, i) =>
            h(Text, { key: i, color: COLORS.textPrimary, wrap: 'wrap' }, l),
          ),
        ),
    usage && h(Box, { marginTop: 1, marginLeft: 2 },
      h(Text, { color: COLORS.textMuted },
        `in=${usage.input ?? '?'}  out=${usage.output ?? '?'}` +
        (usage.cache_read ? `  cache_hit=${usage.cache_read}` : '') +
        (usage.cache_write ? `  cache_wr=${usage.cache_write}` : '') +
        (usage.usd != null ? `  $=${usage.usd.toFixed(4)}` : '') +
        (usage.ctx_pct != null ? `  ctx=${usage.ctx_pct}%` : ''),
      ),
    ),
  );
}
