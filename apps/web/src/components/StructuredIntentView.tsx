import type { StructuredIntent } from '@agentproof/shared';

interface Props {
  rawInput: string;
  structured: StructuredIntent;
}

export function StructuredIntentView({ rawInput, structured }: Props) {
  const hasMaxAmount = structured.maxAmount < 999999;
  const hasConstraints = structured.constraints.length > 0;

  return (
    <div className="panel">
      <h3 className="panel-title">Structured Intent</h3>
      <p className="intent-raw">"{rawInput}"</p>
      <dl className="intent-fields">
        <div className="intent-field">
          <dt>Purpose</dt>
          <dd>{structured.purpose}</dd>
        </div>
        {hasMaxAmount && (
          <div className="intent-field">
            <dt>Maximum amount</dt>
            <dd>{structured.maxAmount} {structured.currency}</dd>
          </div>
        )}
        <div className="intent-field">
          <dt>Currency</dt>
          <dd>{structured.currency}</dd>
        </div>
        <div className="intent-field">
          <dt>Brands</dt>
          <dd>{structured.brands.length > 0 ? structured.brands.join(', ') : 'Any'}</dd>
        </div>
        <div className="intent-field">
          <dt>Condition</dt>
          <dd>{structured.condition}</dd>
        </div>
        <div className="intent-field">
          <dt>Confirmation threshold</dt>
          <dd>
            {structured.requiresConfirmationAbove != null
              ? `Above ${structured.requiresConfirmationAbove} ${structured.currency}`
              : 'None'}
          </dd>
        </div>
        {hasConstraints && (
          <div className="intent-field intent-field--full">
            <dt>Constraints</dt>
            <dd>
              <ul className="constraint-list">
                {structured.constraints.map((c, i) => (
                  <li key={i}>
                    <span className="constraint-type">{c.type}</span>{' '}
                    <span className="constraint-op">{c.operator}</span>{' '}
                    <span className="constraint-value">
                      {Array.isArray(c.value) ? c.value.join(', ') : String(c.value)}
                    </span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
