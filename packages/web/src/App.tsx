import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { SetupPage } from "./routes/SetupPage";
import { LoginPage } from "./routes/LoginPage";
import { DashboardPage } from "./routes/DashboardPage";
import { ProjectPage } from "./routes/ProjectPage";
import { SessionPage } from "./routes/SessionPage";
import { MeetingPage } from "./routes/MeetingPage";
import { ProvidersPage } from "./routes/ProvidersPage";
import { IntegrationsPage } from "./routes/IntegrationsPage";
import { EmployeeDetailPage } from "./routes/EmployeeDetailPage";
import { AccountPage } from "./routes/AccountPage";
import { UsersPage } from "./routes/UsersPage";
import { ApprovalsPage } from "./routes/ApprovalsPage";
import { AppLayout } from "./components/AppLayout";

export function App() {
  const { user, loading, needsSetup } = useAuth();

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-fg-muted">Loading…</div>;
  }

  if (needsSetup) {
    return (
      <Routes>
        <Route path="*" element={<SetupPage />} />
      </Routes>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/users" element={user.role === "admin" ? <UsersPage /> : <Navigate to="/" replace />} />
        <Route path="/approvals" element={user.role === "admin" ? <ApprovalsPage /> : <Navigate to="/" replace />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="/projects/:projectId/agents/:agentId" element={<EmployeeDetailPage />} />
        <Route path="/projects/:projectId/sessions/:sessionId" element={<SessionPage />} />
        <Route path="/projects/:projectId/meetings/:meetingId" element={<MeetingPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}
