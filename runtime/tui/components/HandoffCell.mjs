import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';
import { BorderedCard } from './BorderedCard.mjs';

const h = React.createElement;

function Row({ label, value, color }) {
  if (!value) return null;
  return h(Box, null,
    h(Text, { dimColor: true }, label.padEnd(7)),
    h(Text, { color }, value),
  );
}

export function HandoffCell({ entry }) {
  const tools = entry.tools_used || {};
  const files = entry.files_touched || [];
  const tests = entry.tests_likely_ran || [];
  const isEmpty = Object.keys(tools).length === 0 && files.length === 0 && tests.length === 0 && !entry.usd_total;
  if (isEmpty && !entry.verify) return null;
  const spend = `$${(entry.usd_total ?? 0).toFixed(4)}`;
  const verify = entry.verify?.verdict;
  const verifyColor = verify === 'approve' ? COLORS.success
    : verify === 'revise' ? COLORS.warning
    : verify === 'regressed' ? COLORS.error
    : undefined;
  const badge = verify ? `${verify} · ${(entry.verify.confidence ?? 0).toFixed(2)}` : null;

  return h(Box, { marginTop: 1 },
    h(BorderedCard, {
      title: `${GLYPH.check} handoff`,
      titleColor: COLORS.primary,
      badge,
      badgeColor: verifyColor,
    },
      Object.keys(tools).length > 0 && h(Row, {
        label: 'tools',
        value: Object.entries(tools).map(([k, v]) => `${k}×${v}`).join('  '),
      }),
      files.length > 0 && h(Row, {
        label: 'files',
        value: files.slice(0, 8).join(', ') + (files.length > 8 ? ` +${files.length - 8} more` : ''),
      }),
      tests.length > 0 && h(Row, { label: 'tests', value: tests.slice(0, 3).join(' · ') }),
      h(Row, { label: 'spend', value: spend, color: COLORS.primary }),
    ),
  );
}
