import { createRoot } from 'react-dom/client';
import { setNonce } from 'get-nonce';
import App from './App';
import { signIn } from '@/lib/api';
import './index.css';
import './pipeline.css';
import './workspace.css';

// Radix dialogs inject scroll-lock CSS; bind it to this response's CSP nonce.
setNonce(document.querySelector<HTMLMetaElement>('meta[name="style-nonce"]')!.content);
// A launch link's secret leaves the address before the page reads it.
signIn();
createRoot(document.getElementById('root')!).render(<App />);
