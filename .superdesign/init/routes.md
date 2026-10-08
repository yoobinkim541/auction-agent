# Routes

## Framework

Vite SPA, no file-based router. `web/src/main.tsx` mounts `App` into `#root`. Vercel rewrites all non-API paths to `/index.html`.

## Routes

- `/`: Main auction dashboard. Entry: `web/src/App.tsx`; Layout: self-contained app shell.
- `/#case=<caseNo>`: Deep-link state handled in `App.tsx`; opens `Detail` drawer after fetching listing detail.
- `/api/*`: Vercel rewrite to Spring API; not a frontend route.

## Router/source


### `web/src/main.tsx`

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

```
