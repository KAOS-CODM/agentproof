import { useEffect, useState } from 'react';

interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
}

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/health')
      .then((res) => res.json())
      .then((data: HealthResponse) => setHealth(data))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <div className="mx-auto max-w-4xl px-4 py-16">
        <header className="mb-12 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-white">
            AgentProof
          </h1>
          <p className="mt-3 text-lg text-gray-400">
            Audit and control layer for agentic commerce
          </p>
        </header>

        <section className="rounded-lg border border-gray-700 bg-gray-800 p-6">
          <h2 className="mb-4 text-xl font-semibold text-white">
            API Status
          </h2>
          {error && (
            <div className="rounded bg-red-900/50 p-3 text-red-200">
              Error: {error}
            </div>
          )}
          {health && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-3 w-3 rounded-full ${
                    health.status === 'ok' ? 'bg-green-500' : 'bg-red-500'
                  }`}
                />
                <span className="text-green-400">{health.status}</span>
              </div>
              <p className="text-sm text-gray-400">
                Service: {health.service}
              </p>
              <p className="text-sm text-gray-400">
                Timestamp: {health.timestamp}
              </p>
            </div>
          )}
          {!health && !error && (
            <p className="text-gray-400">Checking API health...</p>
          )}
        </section>

        <section className="mt-8 rounded-lg border border-gray-700 bg-gray-800 p-6">
          <h2 className="mb-4 text-xl font-semibold text-white">
            Phase 1: Core Domain
          </h2>
          <p className="text-gray-400">
            Intent → Policy Engine → ALLOW/DENY → Evidence
          </p>
          <p className="mt-2 text-sm text-gray-500">
            PayPal, OpenRouter, and Channel3 integrations are not yet connected.
          </p>
        </section>
      </div>
    </div>
  );
}

export default App;
