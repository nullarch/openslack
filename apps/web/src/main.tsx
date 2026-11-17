import '@fontsource-variable/figtree';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/dialogs.css';
import './styles/attention.css';
import './styles/accounts.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { start } from './lib/actions';
import './lib/realtime';
import { registerServiceWorker } from './lib/push';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void start();
registerServiceWorker();
