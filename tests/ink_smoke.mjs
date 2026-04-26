import React from 'react';
import { render, Box, Text } from 'ink';

const App = () => React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'magenta', padding: 1 },
  React.createElement(Text, { bold: true, color: 'magenta' }, 'golduck'),
  React.createElement(Text, { dimColor: true }, 'ink smoke test — ✓'),
);

const app = render(React.createElement(App));
setTimeout(() => { app.unmount(); process.exit(0); }, 800);
