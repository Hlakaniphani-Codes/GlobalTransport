import { useEffect, useState } from 'react';
import { ArrowRight, Check, LoaderCircle, Siren } from 'lucide-react';
import { apiRequest } from '../api';

type IncidentStatus = 'open' | 'acknowledged' | 'resolved';
type IncidentType = 'emergency' | 'vehicle_problem' | 'passenger_issue' | 'driver_issue' | 'other';
type Incident = {
  id: string;
  trip_id: string | null;
  type: IncidentType;
  description: string;
  status: IncidentStatus;
  created_at: string;
  reporter_role: string;
  reporter_name: string;
  reporter_surname: string;
  resolution_note: string | null;
};
type IncidentResult = { incidents: Incident[]; pagination: { page: number; total: number; total_pages: number } };

const typeLabels: Record<IncidentType, string> = {
  emergency: 'Emergency',
  vehicle_problem: 'Vehicle problem',
  passenger_issue: 'Passenger issue',
  driver_issue: 'Driver issue',
  other: 'Other',
};

export function Incidents({
  reloadKey,
  onChanged,
  onOpenTrip,
}: {
  reloadKey: number;
  onChanged: () => void;
  onOpenTrip: (tripId: string) => void;
}) {
  const [status, setStatus] = useState<'active' | IncidentStatus>('active');
  const [type, setType] = useState<IncidentType | ''>('');
  const [result, setResult] = useState<IncidentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolutionTarget, setResolutionTarget] = useState<Incident | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ page: '1', page_size: '50' });
    if (status !== 'active') params.set('status', status);
    if (type) params.set('type', type);
    Promise.resolve()
      .then(() => {
        if (active) {
          setLoading(true);
          setError(null);
        }
        return apiRequest<IncidentResult>(`/admin/incidents?${params.toString()}`);
      })
      .then((data) => {
        if (active) setResult(data);
      })
      .catch((requestError: unknown) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Incidents could not be loaded.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloadKey, status, type]);

  async function updateIncident(incident: Incident, action: 'acknowledge' | 'resolve') {
    setSavingId(incident.id);
    setError(null);
    try {
      await apiRequest(`/admin/incidents/${incident.id}/${action}`, {
        method: 'POST',
        ...(action === 'resolve' ? { body: { note: resolutionNote.trim() } } : {}),
      });
      setResolutionTarget(null);
      setResolutionNote('');
      onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The incident update could not be saved.');
    } finally {
      setSavingId(null);
    }
  }

  const incidents = result?.incidents ?? [];

  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">SAFETY AND SUPPORT</span>
        <h1>Incidents</h1>
        <p className="muted-copy">Review reports, acknowledge active issues, and record how they were resolved.</p>
      </div>
      <section className="content-section">
        <div className="incident-filters">
          <label>
            Status
            <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
              <option value="active">Open and acknowledged</option>
              <option value="open">Open</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="resolved">Resolved</option>
            </select>
          </label>
          <label>
            Type
            <select value={type} onChange={(event) => setType(event.target.value as IncidentType | '')}>
              <option value="">All types</option>
              {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {result && <span className="muted-copy">{result.pagination.total} incident{result.pagination.total === 1 ? '' : 's'}</span>}
        </div>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {loading ? (
          <div className="loading-state"><LoaderCircle className="spin" size={22} /><span>Loading incidents</span></div>
        ) : incidents.length === 0 ? (
          <div className="empty-state"><span className="empty-mark"><Check size={19} /></span><p>No incidents match these filters.</p></div>
        ) : (
          <div className="incident-list">
            {incidents.map((incident) => (
              <article className={`incident-card${incident.type === 'emergency' && incident.status !== 'resolved' ? ' is-emergency' : ''}`} key={incident.id}>
                <div className="incident-card-heading">
                  <span className="incident-title">{incident.type === 'emergency' ? <Siren size={17} /> : null}{typeLabels[incident.type]}</span>
                  <span className={`status status-${incident.status}`}>{incident.status}</span>
                </div>
                <p>{incident.description}</p>
                <div className="incident-meta">
                  <span>{incident.reporter_name} {incident.reporter_surname} · {incident.reporter_role}</span>
                  <time dateTime={incident.created_at}>{new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(incident.created_at))}</time>
                </div>
                {incident.trip_id && (
                  <button className="text-action incident-trip-link" onClick={() => onOpenTrip(incident.trip_id!)} type="button">
                    View related trip <ArrowRight size={15} />
                  </button>
                )}
                {incident.resolution_note && <p className="incident-resolution"><strong>Resolution:</strong> {incident.resolution_note}</p>}
                <div className="incident-actions">
                  {incident.status === 'open' && (
                    <button className="button button-secondary button-small" disabled={savingId === incident.id} onClick={() => void updateIncident(incident, 'acknowledge')} type="button">
                      {savingId === incident.id ? <LoaderCircle className="spin" size={15} /> : null} Acknowledge
                    </button>
                  )}
                  {incident.status !== 'resolved' && (
                    <button className="button button-primary button-small" disabled={savingId === incident.id} onClick={() => { setResolutionTarget(incident); setResolutionNote(''); }} type="button">Resolve</button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {resolutionTarget && (
        <div className="dialog-backdrop" role="presentation">
          <section aria-labelledby="incident-resolution-title" aria-modal="true" className="dialog" role="dialog">
            <span className="eyebrow">CLOSE INCIDENT</span>
            <h2 id="incident-resolution-title">How was it resolved?</h2>
            <label className="field-label">
              Resolution note
              <textarea maxLength={1000} onChange={(event) => setResolutionNote(event.target.value)} required rows={4} value={resolutionNote} />
            </label>
            {error && <div className="alert alert-error" role="alert">{error}</div>}
            <div className="dialog-actions">
              <button className="button button-secondary" disabled={savingId !== null} onClick={() => setResolutionTarget(null)} type="button">Cancel</button>
              <button className="button button-primary" disabled={!resolutionNote.trim() || savingId !== null} onClick={() => void updateIncident(resolutionTarget, 'resolve')} type="button">
                {savingId === resolutionTarget.id ? <LoaderCircle className="spin" size={16} /> : null} Save resolution
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
