import { useEffect, useState } from 'react';

import { ApiRequestError, apiRequest } from '../api';

type NotificationLogRow = {
  id: string;
  channel: 'push' | 'sms';
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  last_error: string | null;
  created_at: string;
  type: string;
  title: string;
  body: string;
  recipient_name: string;
  recipient_surname: string;
  recipient_role: string;
};

type NotificationLogResult = {
  notifications: NotificationLogRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
};

const statuses = ['pending', 'sent', 'failed', 'skipped'] as const;

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function NotificationLog() {
  const [status, setStatus] = useState('');
  const [typeInput, setTypeInput] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<NotificationLogResult | null>(null);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<{ query: string; message: string } | null>(null);
  const params = new URLSearchParams({ page: String(page), page_size: '25' });
  if (status) params.set('status', status);
  if (type) params.set('type', type);
  const query = params.toString();
  const loading = loadedQuery !== query;
  const error = requestError?.query === query ? requestError.message : null;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setType(typeInput.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [typeInput]);

  useEffect(() => {
    let active = true;
    apiRequest<NotificationLogResult>(`/admin/notifications?${query}`)
      .then((response) => {
        if (active) setResult(response);
      })
      .catch((requestError: unknown) => {
        if (active) {
          setRequestError({
            query,
            message: requestError instanceof ApiRequestError
              ? requestError.message
              : 'Notification history could not be loaded.',
          });
        }
      })
      .finally(() => {
        if (active) setLoadedQuery(query);
      });
    return () => {
      active = false;
    };
  }, [query]);

  return (
    <>
      <div className="page-heading">
        <div><span className="eyebrow">DELIVERY STATUS</span><h1>Notifications</h1></div>
      </div>
      <section className="content-section">
        <div className="application-toolbar">
          <div>
            <h2>Recent delivery attempts</h2>
            <p>Delivery activity from the last 24 hours.</p>
          </div>
          <div className="notification-filters">
            <label>
              Status
              <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
                <option value="">All statuses</option>
                {statuses.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>
              Type
              <input
                aria-label="Filter notification type"
                maxLength={80}
                onChange={(event) => setTypeInput(event.target.value)}
                placeholder="All types"
                value={typeInput}
              />
            </label>
          </div>
        </div>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {loading ? (
          <p className="muted-copy">Loading delivery history…</p>
        ) : result && result.notifications.length === 0 ? (
          <div className="empty-state"><p>No notification attempts match these filters.</p></div>
        ) : result ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Recipient</th>
                    <th>Type</th>
                    <th>Channel</th>
                    <th>Status</th>
                    <th>Message</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {result.notifications.map((notification) => (
                    <tr key={notification.id}>
                      <td>{formatTime(notification.created_at)}</td>
                      <td>
                        {notification.recipient_name} {notification.recipient_surname}
                        <small className="cell-subtitle">{notification.recipient_role}</small>
                      </td>
                      <td>{notification.type.replaceAll('_', ' ')}</td>
                      <td>{notification.channel}</td>
                      <td><span className={`status status-${notification.status}`}>{notification.status}</span></td>
                      <td>
                        <strong>{notification.title}</strong>
                        <small className="cell-subtitle">{notification.body}</small>
                      </td>
                      <td>{notification.last_error ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="application-pagination">
              <span>{result.pagination.total} attempts · Page {result.pagination.page} of {result.pagination.total_pages}</span>
              <div>
                <button className="icon-button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} type="button">‹</button>
                <button className="icon-button" aria-label="Next page" disabled={page >= result.pagination.total_pages} onClick={() => setPage((current) => current + 1)} type="button">›</button>
              </div>
            </div>
          </>
        ) : null}
      </section>
    </>
  );
}
