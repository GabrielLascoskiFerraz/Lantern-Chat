import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installWebLanternBridge } from './api/webLantern';
import './styles.css';

installWebLanternBridge();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
