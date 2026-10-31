import { useState } from 'react';

interface Props {
  onSubmit: (rawInput: string) => void;
  loading: boolean;
}

export function IntentInput({ onSubmit, loading }: Props) {
  const [value, setValue] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || loading) return;
    onSubmit(trimmed);
  }

  return (
    <form className="intent-form" onSubmit={handleSubmit}>
      <label htmlFor="intent-input" className="intent-label">
        What should your agent do?
      </label>
      <textarea
        id="intent-input"
        className="intent-textarea"
        placeholder="Buy me a pair of running shoes under $150. New only. Nike or Adidas."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        disabled={loading}
      />
      <button type="submit" className="btn btn-primary" disabled={loading || !value.trim()}>
        {loading ? 'Interpreting…' : 'Interpret intent'}
      </button>
    </form>
  );
}
