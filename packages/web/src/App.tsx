import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './layout/AppLayout';
import DashboardPage from './pages/Dashboard';
import ServersPage from './pages/Servers';
import ServerFormPage from './pages/Servers/ServerFormPage';
import ServerDetailPage from './pages/Servers/ServerDetail';
import ProjectsPage from './pages/Projects';
import ProjectFormPage from './pages/Projects/ProjectFormPage';
import ProjectDetailPage from './pages/Projects/ProjectDetail';
import TargetFormPage from './pages/Projects/TargetFormPage';
import TargetWorkbenchPage from './pages/Projects/TargetWorkbench';
import JobsPage from './pages/Jobs';
import JobDetailPage from './pages/Jobs/JobDetail';
import SettingsPage from './pages/Settings';

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="servers" element={<ServersPage />} />
        <Route path="servers/new" element={<ServerFormPage />} />
        <Route path="servers/:id" element={<ServerDetailPage />} />
        <Route path="servers/:id/edit" element={<ServerFormPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/new" element={<ProjectFormPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="projects/:id/edit" element={<ProjectFormPage />} />
        <Route path="projects/:id/targets/new" element={<TargetFormPage />} />
        <Route path="projects/:id/targets/:targetId" element={<TargetWorkbenchPage />} />
        <Route path="projects/:id/targets/:targetId/edit" element={<TargetFormPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/:id" element={<JobDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}