import '@fontsource-variable/figtree';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/dialogs.css';
import './styles/attention.css';
import './styles/accounts.css';
import './styles/prefs.css';
import './styles/a11y.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { start } from './lib/actions';
import { keepPageInPlace, trackInputMode } from './lib/a11y';
import { useStore } from './lib/store';
import './lib/realtime';
import { registerServiceWorker } from './lib/push';
import { installNative } from './lib/native';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

trackInputMode();
keepPageInPlace((listener) => {
  useStore.subscribe((state, previous) => {
    if (state.phase !== previous.phase) listener();
  });
});
void start();
registerServiceWorker();
installNative();
