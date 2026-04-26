/* ─────────────────────────────────────────────────────────────────────────
 * WelcomeCell — droidx splash on cold start
 * ─────────────────────────────────────────────────────────────────────────
 * Shown on first mount until the first user message is submitted. We reuse
 * the `Splash` renderer from Header.mjs so there's exactly one source of
 * truth for the DROID block-art + tagline + hint. The old "tips card" was
 * removed deliberately — droidx's welcome is just the splash.
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../theme.mjs';
import { Splash } from './Header.mjs';

const h = React.createElement;

export function WelcomeCell({ resumeTip }) {
  return h(Box, { flexDirection: 'column', marginTop: 0, marginBottom: 0 },
    h(Splash, null),
    resumeTip && h(Box, { justifyContent: 'center', marginTop: 1 },
      h(Text, { color: COLORS.textMuted }, resumeTip),
    ),
  );
}
