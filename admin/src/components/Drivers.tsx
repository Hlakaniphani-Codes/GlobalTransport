import { useEffect, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';

import { ApiRequestError, apiRequest } from '../api';

type Driver = {
  user_id: string;
  name: string;
  surname: string;
  email: string;
  contact_number: string;
  status: string;
  is_available: boolean;
  licence_expiry: string | null;
  prdp_expiry: string | null;
  average_rating: number | string | null;
  trip_count: number;
  trips_completed: number;
  withdrawals: number;
  late_withdrawals: number;
  missed_trips: number;
};

type DriverPage = {
  drivers: Driver[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
};

function expiryStatus(value: string | null): { label: string; status: string } {
  if (!value) return { label: 'Not recorded', status: 'status-pending' };
  const expiryDate = new Date(`${value.slice(0, 10)}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((expiryDate.getTime() - today.getTime()) / 86_400_000);
  const formatted = new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium' }).format(expiryDate);
  if (days < 0) return { label: `Expired ${formatted}`, status: 'status-rejected' };
  if (days <= 30) return { label: `Expiring ${formatted}`, status: 'status-pending' };
  return { label: `Valid to ${formatted}`, status: 'status-approved' };
}

export function Drivers() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<DriverPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingDriverId, setEditingDriverId] = useState<string | null>(null);
  const [licenceNumber, setLicenceNumber] = useState('');
  const [licenceExpiry, setLicenceExpiry] = useState('');
  const [prdpExpiry, setPrdpExpiry] = useState('');
  const [savingDocuments, setSavingDocuments] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ page: String(page), page_size: '25' });
      if (search) params.set('search', search);
      apiRequest<DriverPage>(`/admin/drivers/directory?${params.toString()}`)
        .then((response) => {
          if (active) setResult(response);
        })
        .catch((requestError: unknown) => {
          if (active) {
            setError(requestError instanceof Error ? requestError.message : 'Drivers could not be loaded.');
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [page, search]);

  function editDocuments(driver: Driver) {
    setEditingDriverId(driver.user_id);
    setLicenceNumber('');
    setLicenceExpiry(driver.licence_expiry?.slice(0, 10) ?? '');
    setPrdpExpiry(driver.prdp_expiry?.slice(0, 10) ?? '');
    setDocumentError(null);
    setNotice(null);
  }

  async function saveDocuments(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingDriverId) return;
    setSavingDocuments(true);
    setDocumentError(null);
    try {
      const response = await apiRequest<{
        driver: Pick<Driver, 'user_id' | 'licence_expiry' | 'prdp_expiry' | 'is_available'>
      }>(
        `/admin/drivers/${editingDriverId}/documents`,
        {
          method: 'PATCH',
          body: {
            licence_number: licenceNumber.trim(),
            licence_expiry: licenceExpiry,
            ...(prdpExpiry ? { prdp_expiry: prdpExpiry } : {}),
          },
        }
      );
      setResult((current) => current ? {
        ...current,
        drivers: current.drivers.map((driver) => driver.user_id === editingDriverId
          ? { ...driver, ...response.driver }
          : driver),
      } : current);
      setNotice('Driver document details updated.');
      setEditingDriverId(null);
    } catch (requestError) {
      setDocumentError(
        requestError instanceof ApiRequestError
          ? requestError.message
          : 'Driver document details could not be updated.'
      );
    } finally {
      setSavingDocuments(false);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div><span className="eyebrow">DRIVER OPERATIONS</span><h1>Drivers</h1></div>
      </div>
      <section className="content-section">
        <div className="application-toolbar">
          <div><h2>Driver directory <span className="section-count">{result?.pagination.total ?? 0}</span></h2></div>
          <label className="application-search">
            <Search size={16} />
            <input
              aria-label="Search drivers"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search name, email or phone"
              value={searchInput}
            />
          </label>
        </div>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {notice && <div className="alert alert-success" role="status">{notice}</div>}
        {loading ? (
          <p className="muted-copy">Loading drivers…</p>
        ) : result && result.drivers.length === 0 ? (
          <div className="empty-state"><p>No drivers match this search.</p></div>
        ) : result ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Driver</th><th>Contact</th><th>Status</th><th>Availability</th><th>Licence</th><th>PRDP</th><th>Rating</th><th>Trips completed</th><th>Withdrawals</th><th>Late withdrawals</th><th>Missed trips</th></tr>
                </thead>
                <tbody>
                  {result.drivers.flatMap((driver) => {
                    const licence = expiryStatus(driver.licence_expiry);
                    const prdp = expiryStatus(driver.prdp_expiry);
                    const rows = [(
                      <tr key={driver.user_id}>
                        <td><strong>{driver.name} {driver.surname}</strong><small className="cell-subtitle">{driver.email}</small></td>
                        <td>{driver.contact_number}</td>
                        <td><span className={`status status-${driver.status}`}>{driver.status.replaceAll('_', ' ')}</span></td>
                        <td>{driver.is_available ? 'Online' : 'Offline'}</td>
                        <td>
                          <span className={`status ${licence.status}`}>{licence.label}</span>
                          <button className="text-button" onClick={() => editDocuments(driver)} type="button">
                            Update documents
                          </button>
                        </td>
                        <td><span className={`status ${prdp.status}`}>{prdp.label}</span></td>
                        <td>{driver.average_rating == null ? 'No ratings' : `${Number(driver.average_rating).toFixed(1)} / 5`}</td>
                        <td>{driver.trips_completed}</td>
                        <td>{driver.withdrawals}</td>
                        <td>{driver.late_withdrawals}</td>
                        <td>{driver.missed_trips}</td>
                      </tr>
                    )];
                    if (editingDriverId !== driver.user_id) return rows;
                    return [...rows, (
                      <tr key={`${driver.user_id}-documents`}>
                        <td colSpan={11}>
                          <form className="driver-document-form" onSubmit={saveDocuments}>
                            <p>Enter details from the driver’s verified documents. Licence numbers are not shown in the directory.</p>
                            <label>
                              Licence number
                              <input
                                autoComplete="off"
                                maxLength={80}
                                onChange={(event) => setLicenceNumber(event.target.value)}
                                required
                                value={licenceNumber}
                              />
                            </label>
                            <label>
                              Licence expiry
                              <input
                                onChange={(event) => setLicenceExpiry(event.target.value)}
                                required
                                type="date"
                                value={licenceExpiry}
                              />
                            </label>
                            <label>
                              PRDP expiry (optional)
                              <input
                                onChange={(event) => setPrdpExpiry(event.target.value)}
                                type="date"
                                value={prdpExpiry}
                              />
                            </label>
                            {documentError && <span className="form-error" role="alert">{documentError}</span>}
                            <button className="button button-primary button-small" disabled={savingDocuments} type="submit">
                              {savingDocuments ? 'Saving…' : 'Save verified details'}
                            </button>
                            <button className="button button-secondary button-small" onClick={() => setEditingDriverId(null)} type="button">
                              Cancel
                            </button>
                          </form>
                        </td>
                      </tr>
                    )];
                  })}
                </tbody>
              </table>
            </div>
            <div className="application-pagination">
              <span>Page {result.pagination.page} of {result.pagination.total_pages}</span>
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
