/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './app.css';
import { App } from './App.js';

createRoot(document.getElementById('app')!).render(<App />);
