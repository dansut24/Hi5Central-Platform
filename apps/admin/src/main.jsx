import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './PlatformCurves.css'
import './ContextualSurfaces.css'
import { PlatformAdminApp } from './features/admin/PlatformAdminApp.jsx'

const root = document.getElementById('root')
document.documentElement.dataset.hi5Surface = 'admin'
document.body.dataset.hi5Surface = 'admin'
if (root) root.dataset.hi5Surface = 'admin'

createRoot(root).render(
  <StrictMode>
    <PlatformAdminApp />
  </StrictMode>,
)
