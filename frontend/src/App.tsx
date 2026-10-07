import { useEffect } from 'react'
import { createBrowserRouter, Outlet, useLocation } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import * as api from '@/api/client'
import { Nav } from '@/components/layout/Nav'
import { SmoothScroll } from '@/components/layout/SmoothScroll'
import { SolarClock } from '@/components/layout/SolarClock'
import { useUi } from '@/state/ui'

function Root() {
  const setApi = useUi((s) => s.setApi)
  const { pathname } = useLocation()
  useEffect(() => {
    void api.health().then(setApi)
  }, [setApi])
  return (
    <SmoothScroll>
      <div className="grain">
        {pathname !== '/app' && pathname !== '/demo' && <Nav />}
        <main id="main">
          <Outlet />
        </main>
        {pathname === '/' && <SolarClock />}
      </div>
    </SmoothScroll>
  )
}

function Booting() {
  return (
    <div className="grid min-h-svh place-items-center bg-ivory">
      <span className="kicker text-muted">Waking the feeder…</span>
    </div>
  )
}

const router = createBrowserRouter([
  {
    element: <Root />,
    HydrateFallback: Booting,
    children: [
      { path: '/', lazy: async () => ({ Component: (await import('./routes/Home')).default }) },
      { path: '/app', lazy: async () => ({ Component: (await import('./routes/LiveApp')).default }) },
      { path: '/demo', lazy: async () => ({ Component: (await import('./routes/Demo')).default }) },
      { path: '*', lazy: async () => ({ Component: (await import('./routes/NotFound')).default }) },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
