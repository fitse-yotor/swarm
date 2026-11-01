import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./auth";
import { ToastProvider } from "./components/ui";
import Shell from "./components/Shell";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Cases from "./pages/Cases";
import CaseDetail from "./pages/CaseDetail";
import CreateCase from "./pages/CreateCase";
import NewCase from "./pages/NewCase";
import Build from "./pages/Build";
import Documents from "./pages/Documents";
import GraphExplorer from "./pages/GraphExplorer";
import Review from "./pages/Review";
import Environments from "./pages/Environments";
import Simulations from "./pages/Simulations";
import Reports from "./pages/Reports";
import Interaction from "./pages/Interaction";
import { load } from "./prefs";
import "./styles.css";

document.documentElement.dataset.theme = load("theme", "dark");
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 } } });

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="center-fill">Signing in…</div>;
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="cases" element={<Cases />} />
        <Route path="cases/new" element={<NewCase />} />
        <Route path="cases/new/wizard" element={<CreateCase />} />
        <Route path="cases/:caseId" element={<CaseDetail />} />
        <Route path="cases/:caseId/build/:jobId" element={<Build />} />
        <Route path="cases/:caseId/documents" element={<Documents />} />
        <Route path="cases/:caseId/graph" element={<GraphExplorer />} />
        <Route path="cases/:caseId/review" element={<Review />} />
        <Route path="cases/:caseId/environments" element={<Environments />} />
        <Route path="cases/:caseId/environments/:envId" element={<Environments />} />
        <Route path="cases/:caseId/simulations" element={<Simulations />} />
        <Route path="cases/:caseId/simulations/:simId" element={<Simulations />} />
        <Route path="cases/:caseId/reports" element={<Reports />} />
        <Route path="cases/:caseId/reports/:repId" element={<Reports />} />
        <Route path="cases/:caseId/interaction" element={<Interaction />} />
        <Route path="cases/:caseId/interaction/:convId" element={<Interaction />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ToastProvider><AuthProvider><Gate /></AuthProvider></ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
