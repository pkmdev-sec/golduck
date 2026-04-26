import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';
import { BorderedCard } from './BorderedCard.mjs';

const h = React.createElement;

/**
 * Recall card — one row per hit, kind badge + score + snippet.
 * Title collapses to "recalled · N hits" when there are hits, dim badge
 * at the right shows where the matches came from.
 */
export function RecallCell({ entry }) {
  const hits = entry.hits || [];
  if (!hits.length) return h(Box, null);
  const title = `${GLYPH.diamond} recalled`;
  const badge = hits.length === 1 ? '1 match' : `${hits.length} matches`;
  return h(Box, { marginTop: 1 },
    h(BorderedCard, { title, titleColor: COLORS.brand, badge, borderColor: COLORS.border },
      // Providers query shows every row (there are only ~10). Memory
      // recalls still show a top-3 teaser; the Memory overlay covers the rest.
      ...(entry.query && /provider/i.test(entry.query) ? hits : hits.slice(0, 3)).map((hit, i) =>
        h(Box, { key: i },
          h(Box, { width: 9 },
            h(Text, { inverse: true, bold: true }, ` ${String(hit.kind).padEnd(6)} `),
          ),
          h(Box, { width: 6 },
            h(Text, { color: 'cyan', dimColor: true }, ` ${(hit.score ?? 0).toFixed(2)}`),
          ),
          h(Box, { flexGrow: 1 },
            h(Text, { wrap: 'truncate-end' }, String(hit.text || '').slice(0, 160)),
          ),
        ),
      ),
    ),
  );
}
