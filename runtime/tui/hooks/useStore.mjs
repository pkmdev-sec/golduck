/* React hook that subscribes a component to the store. */
import { useState, useEffect } from 'react';
import { getStore } from '../store.mjs';

export function useStore() {
  const store = getStore();
  const [state, setState] = useState(store.state);
  useEffect(() => store.subscribe(setState), [store]);
  return [state, store];
}
