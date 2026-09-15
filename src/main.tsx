import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './state/AppContext';
import { App } from './app/AppShell';
import './styles/tokens.css';
import './styles/app.css';
import './styles/pages.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
