import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiRequestError, apiRequest } from '../api';
import type { Passenger } from '../types';

type Pagination = { page: number; page_size: number; total: number; total_pages: number };
type PassengerPage = { passengers: Passenger[]; pagination: Pagination };

export function Passengers({ onSaved }: { onSaved: () => void }) {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Passenger | null>(null);
  const [homeSuburb, setHomeSuburb] = useState('');
  const [workplaceSuburb, setWorkplaceSuburb] = useState('');
  const [workplaceAddress, setWorkplaceAddress] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const value = searchInput.trim();
      if (value.length === 1) {
        setFormError('Enter at least 2 characters to search, or clear the search field.');
        return;
      }
      setFormError(null);
      if (value !== search) {
        setPage(1);
        setSearch(value);
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [search, searchInput]);

  const params = new URLSearchParams({ page: String(page), page_size: '25' });
  if (search) params.set('search', search);
  const passengersQuery = useQuery({
    queryKey: ['admin', 'passengers', page, search],
    queryFn: ({ signal }) => apiRequest<PassengerPage>(
      `/admin/passengers?${params.toString()}`,
      { signal }
    ),
    staleTime: 10_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const updateMutation = useMutation({
    mutationFn: (input: { passengerId: string; changes: Partial<Passenger> }) => apiRequest(
      `/admin/passengers/${input.passengerId}`,
      { method: 'PATCH', body: input.changes }
    ),
    onSuccess: async () => {
      setEditing(null);
      setFormError(null);
      setNotice('Passenger details updated.');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'passengers'] });
      onSaved();
    },
    onError: (error: unknown) => {
      setFormError(error instanceof ApiRequestError ? error.message : 'Passenger details could not be saved.');
    },
  });

  function openEdit(passenger: Passenger) {
    setEditing(passenger);
    setHomeSuburb(passenger.home_suburb ?? '');
    setWorkplaceSuburb(passenger.workplace_suburb ?? '');
    setWorkplaceAddress(passenger.workplace_address ?? '');
    setFormError(null);
  }

  function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const changes: Partial<Passenger> = {};
    if (homeSuburb.trim() !== (editing.home_suburb ?? '')) changes.home_suburb = homeSuburb.trim();
    if (workplaceSuburb.trim() !== (editing.workplace_suburb ?? '')) changes.workplace_suburb = workplaceSuburb.trim();
    if (workplaceAddress.trim() !== (editing.workplace_address ?? '')) changes.workplace_address = workplaceAddress.trim();
    if (Object.keys(changes).length === 0) {
      setFormError('Update at least one passenger detail.');
      return;
    }
    updateMutation.mutate({ passengerId: editing.id, changes });
  }

  const pageData = passengersQuery.data;
  const passengers = pageData?.passengers ?? [];

  return (
    <>
      <div className="page-heading"><span className="eyebrow">DIRECTORY</span><h1>Passengers</h1></div>
      <section className="content-section passenger-directory">
        <div className="application-toolbar">
          <div>
            <h2>Passenger records</h2>
            <p>{pageData ? `${pageData.pagination.total.toLocaleString()} passengers` : 'Search passenger records'}</p>
          </div>
          <form
            className="application-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              const value = searchInput.trim();
              if (value.length === 1) {
                setFormError('Enter at least 2 characters to search, or clear the search field.');
              }
            }}
          >
            <label className="visually-hidden" htmlFor="passenger-search">Search passengers</label>
            <input
              id="passenger-search"
              autoComplete="off"
              placeholder="Name, employee number, company or suburb"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <button className="button button-primary button-small" type="submit">Search</button>
          </form>
        </div>
        {notice && <div className="alert alert-success" role="status">{notice}</div>}
        {formError && !editing && <div className="alert alert-error" role="alert">{formError}</div>}
        {passengersQuery.error && <div className="alert alert-error" role="alert">
          {passengersQuery.error instanceof Error ? passengersQuery.error.message : 'Passengers could not be loaded.'}
        </div>}
        {passengersQuery.isLoading ? (
          <div className="loading-state">Loading passengers…</div>
        ) : passengers.length === 0 ? (
          <div className="empty-state"><strong>{search ? 'No matching passengers' : 'No passengers found'}</strong></div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Passenger</th><th>Employee number</th><th>Company / workplace</th><th>Home suburb</th><th>Workplace suburb</th><th /></tr>
              </thead>
              <tbody>
                {passengers.map((passenger) => {
                  const missingSuburb = !passenger.home_suburb?.trim() || !passenger.workplace_suburb?.trim();
                  return (
                    <tr key={passenger.id}>
                      <td>
                        <strong>{passenger.name} {passenger.surname}</strong>
                        <small className="cell-subtitle">{passenger.email} · {passenger.contact_number}</small>
                      </td>
                      <td>{passenger.employee_number || '—'}</td>
                      <td>{passenger.company_name ?? '—'}<small className="cell-subtitle">{passenger.workplace_name ?? '—'}</small></td>
                      <td>{passenger.home_suburb?.trim() || <span className="suburb-warning">Missing suburb</span>}</td>
                      <td>{passenger.workplace_suburb?.trim() || <span className="suburb-warning">Missing suburb</span>}</td>
                      <td>
                        <button className="button button-secondary button-small" onClick={() => openEdit(passenger)} type="button">
                          {missingSuburb ? 'Complete details' : 'Edit'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {pageData && pageData.pagination.total_pages > 1 && (
          <div className="application-pagination">
            <span>
              Showing {((pageData.pagination.page - 1) * pageData.pagination.page_size + 1).toLocaleString()}–
              {Math.min(pageData.pagination.page * pageData.pagination.page_size, pageData.pagination.total).toLocaleString()}
              {' '}of {pageData.pagination.total.toLocaleString()}
            </span>
            <div>
              <button className="icon-button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} type="button" aria-label="Previous page">‹</button>
              <span>Page {pageData.pagination.page} of {pageData.pagination.total_pages}</span>
              <button className="icon-button" disabled={page >= pageData.pagination.total_pages} onClick={() => setPage((current) => current + 1)} type="button" aria-label="Next page">›</button>
            </div>
          </div>
        )}
      </section>
      {editing && (
        <div className="dialog-backdrop" role="presentation">
          <section aria-labelledby="passenger-edit-title" aria-modal="true" className="dialog passenger-edit-dialog" role="dialog">
            <h2 id="passenger-edit-title">Edit passenger details</h2>
            <p>{editing.name} {editing.surname} · {editing.employee_number || 'No employee number'}</p>
            <form className="form-stack" onSubmit={submitEdit}>
              <label className="field"><span>Home suburb</span><input maxLength={120} value={homeSuburb} onChange={(event) => setHomeSuburb(event.target.value)} /></label>
              <label className="field"><span>Workplace suburb</span><input maxLength={120} value={workplaceSuburb} onChange={(event) => setWorkplaceSuburb(event.target.value)} /></label>
              <label className="field"><span>Workplace address</span><input maxLength={300} value={workplaceAddress} onChange={(event) => setWorkplaceAddress(event.target.value)} /></label>
              {formError && <div className="alert alert-error" role="alert">{formError}</div>}
              <div className="dialog-actions">
                <button className="button button-secondary" disabled={updateMutation.isPending} onClick={() => setEditing(null)} type="button">Cancel</button>
                <button className="button button-primary" disabled={updateMutation.isPending} type="submit">
                  {updateMutation.isPending ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
