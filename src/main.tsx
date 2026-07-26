import 'katex/dist/katex.min.css';
import 'mathlive';
import './styles/app.css';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
