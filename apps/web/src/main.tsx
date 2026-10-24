import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProjectLayout } from './components/ProjectLayout';
import { EmptyState } from './components/ui';
import { MainModuleDetailed, MainModuleOverall, ProjectOverview } from './pages/Dashboard';
import { Home } from './pages/Home';
import { Projects } from './pages/Projects';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Sources } from './pages/Sources';
import './styles.css';

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: true, staleTime: 10_000 } },
});

function NotFound() {
  return <EmptyState title="Page not found">This address does not exist.</EmptyState>;
}

// Navigation: Home → Project Hub → Project → Main Module → Overall / Detailed Dashboard (SRS V1.5 §5.1).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route element={<AppShell />}>
            <Route path="/projects" element={<Projects />} />
            <Route path="/dashboard" element={<Navigate to="/projects" replace />} />
            <Route path="/projects/:projectId" element={<ProjectLayout />}>
              <Route index element={<ProjectOverview />} />
              <Route path="dashboard" element={<Navigate to=".." replace />} />
              <Route path="main/:mainModuleId" element={<Navigate to="overall" replace />} />
              <Route path="main/:mainModuleId/overall" element={<MainModuleOverall />} />
              <Route path="main/:mainModuleId/add" element={<MainModuleOverall />} />
              <Route path="main/:mainModuleId/detailed" element={<MainModuleDetailed />} />
              <Route path="sources" element={<Sources />} />
              <Route path="reports" element={<Reports />} />
              <Route path="settings" element={<Settings />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
