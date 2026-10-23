import { useEffect, useState, type FormEvent } from 'react';
import { CarFront, ChevronLeft, ChevronRight, LoaderCircle, Plus, X } from 'lucide-react';

import { apiRequest } from '../api';
import type { ApprovedDriver, FleetVehicle } from '../types';

type FleetProps = {
  vehicles: FleetVehicle[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  onPageChange: (page: number) => void;
  onSaved: () => void;
};

function expiryStatus(value: string | null): { label: string; className: string } {
  if (!value) return { label: 'Not recorded', className: 'status-pending' };
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysRemaining = Math.ceil((date.getTime() - today.getTime()) / 86_400_000);
  const formatted = new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium' }).format(date);
  if (daysRemaining < 0) return { label: `Expired ${formatted}`, className: 'status-rejected' };
  if (daysRemaining <= 30) return { label: `Expiring ${formatted}`, className: 'status-pending' };
  return { label: `Valid to ${formatted}`, className: 'status-approved' };
}

export function Fleet({ vehicles, pagination, onPageChange, onSaved }: FleetProps) {
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [driverSearch, setDriverSearch] = useState('');
  const [approvedDrivers, setApprovedDrivers] = useState<ApprovedDriver[]>([]);
  const [loadingDrivers, setLoadingDrivers] = useState(false);
  const [driverSearchError, setDriverSearchError] = useState<string | null>(null);
  const [driverId, setDriverId] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [colour, setColour] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [seatCount, setSeatCount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    const search = driverSearch.trim();
    if (!onboardingOpen || search.length < 2) return;

    let active = true;
    const timeout = window.setTimeout(() => {
      setLoadingDrivers(true);
      setDriverSearchError(null);
      apiRequest<{ drivers: ApprovedDriver[] }>(
        `/admin/drivers/approved?search=${encodeURIComponent(search)}`
      )
        .then(({ drivers }) => {
          if (active) setApprovedDrivers(drivers);
        })
        .catch((requestError: unknown) => {
          if (active) {
            setDriverSearchError(
              requestError instanceof Error ? requestError.message : 'Could not search drivers.'
            );
          }
        })
        .finally(() => {
          if (active) setLoadingDrivers(false);
        });
    }, 300);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [driverSearch, onboardingOpen]);

  function closeOnboarding() {
    if (saving) return;
    setOnboardingOpen(false);
    setDriverSearch('');
    setApprovedDrivers([]);
    setLoadingDrivers(false);
    setDriverSearchError(null);
    setDriverId('');
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!driverId) {
      setError('Search for and select an approved driver.');
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await apiRequest('/admin/vehicles', {
        method: 'POST',
        body: {
          driver_user_id: driverId,
          make: make.trim(),
          model: model.trim(),
          year: Number(year),
          colour: colour.trim(),
          registration_number: registrationNumber.trim().toUpperCase(),
          seat_count: Number(seatCount),
        },
      });
      setDriverId('');
      setMake('');
      setModel('');
      setYear('');
      setColour('');
      setRegistrationNumber('');
      setSeatCount('');
      setOnboardingOpen(false);
      setDriverSearch('');
      setApprovedDrivers([]);
      setSuccess('Vehicle added to the fleet and assigned to the selected driver.');
      onSaved();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Vehicle could not be added.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="page-heading fleet-heading">
        <div><span className="eyebrow">VEHICLES</span><h1>Fleet</h1></div>
        <button
          className="button button-primary"
          onClick={() => {
            setOnboardingOpen(true);
            setApprovedDrivers([]);
            setLoadingDrivers(false);
            setDriverSearchError(null);
            setError(null);
          }}
          type="button"
        >
          <Plus size={17} /> Onboard vehicle
        </button>
      </div>
      {error && !onboardingOpen && <div className="alert alert-error" role="alert">{error}</div>}
      {success && <div className="alert alert-success" role="status">{success}</div>}
      <section className="content-section fleet-list-section">
        <div className="section-header">
          <h2>Onboarded vehicles<span className="section-count">{pagination.total}</span></h2>
        </div>
        {vehicles.length === 0 ? (
          <div className="empty-state"><span className="empty-mark"><CarFront size={19} /></span><p>No vehicles have been onboarded.</p></div>
        ) : (
          <div className="table-scroll"><table>
            <thead><tr><th>Vehicle</th><th>Registration</th><th>Licence disc</th><th>Capacity</th><th>Assigned driver</th><th>Driver performance</th><th>Status</th></tr></thead>
            <tbody>{vehicles.map((vehicle) => (
              <tr key={vehicle.id}>
                <td><strong>{vehicle.year} {vehicle.make} {vehicle.model}</strong><small className="cell-subtitle">{vehicle.colour}</small></td>
                <td>{vehicle.registration_number}</td>
                <td>
                  {(() => {
                    const expiry = expiryStatus(vehicle.licence_disc_expiry);
                    return <span className={`status ${expiry.className}`}>{expiry.label}</span>;
                  })()}
                </td>
                <td>{vehicle.seat_count} seats</td>
                <td>{vehicle.driver_name} {vehicle.driver_surname}</td>
                <td>
                  {vehicle.average_rating == null ? 'No ratings' : `${Number(vehicle.average_rating).toFixed(1)} / 5`}
                  <small className="cell-subtitle">{vehicle.trips_completed} completed · {vehicle.withdrawals} withdrawals ({vehicle.late_withdrawals} late) · {vehicle.missed_trips} missed</small>
                </td>
                <td><span className={`status status-${vehicle.status}`}>{vehicle.status}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {pagination.total_pages > 1 && (
          <div className="application-pagination">
            <span>Page {pagination.page} of {pagination.total_pages}</span>
            <div>
              <button
                aria-label="Previous fleet page"
                className="icon-button"
                disabled={pagination.page <= 1}
                onClick={() => onPageChange(pagination.page - 1)}
                type="button"
              ><ChevronLeft size={17} /></button>
              <button
                aria-label="Next fleet page"
                className="icon-button"
                disabled={pagination.page >= pagination.total_pages}
                onClick={() => onPageChange(pagination.page + 1)}
                type="button"
              ><ChevronRight size={17} /></button>
            </div>
          </div>
        )}
      </section>

      {onboardingOpen && (
        <div className="dialog-backdrop" role="presentation">
          <section aria-labelledby="vehicle-dialog-title" aria-modal="true" className="dialog fleet-dialog" role="dialog">
            <button
              aria-label="Close vehicle onboarding"
              className="icon-button dialog-close"
              disabled={saving}
              onClick={closeOnboarding}
              type="button"
            ><X size={18} /></button>
            <span className="eyebrow">FLEET</span>
            <h2 id="vehicle-dialog-title">Onboard a vehicle</h2>
            <p className="dialog-copy">Search for an approved driver, then enter the vehicle details.</p>
            <form className="operation-form" onSubmit={(event) => void submit(event)}>
              <label className="field">
                <span>Find approved driver</span>
                <input
                  autoComplete="off"
                  onChange={(event) => {
                    setDriverSearch(event.target.value);
                    setApprovedDrivers([]);
                    setLoadingDrivers(false);
                    setDriverSearchError(null);
                    setDriverId('');
                  }}
                  placeholder="Enter at least 2 letters of their name"
                  value={driverSearch}
                />
              </label>
              {driverSearch.length > 0 && driverSearch.trim().length < 2 && (
                <p className="driver-search-hint">Enter at least 2 characters to search.</p>
              )}
              {driverSearch.trim().length >= 2 && loadingDrivers && <p className="driver-search-hint"><LoaderCircle className="spin" size={15} /> Searching approved drivers…</p>}
              {driverSearchError && <div className="alert alert-error" role="alert">{driverSearchError}</div>}
              {!loadingDrivers && !driverSearchError && driverSearch.trim().length >= 2 && (
                <div aria-label="Approved driver results" className="driver-search-results" role="listbox">
                  {approvedDrivers.length === 0 ? (
                    <p className="driver-search-hint">No active approved drivers matched that search.</p>
                  ) : approvedDrivers.map((driver) => (
                    <button
                      aria-selected={driverId === driver.user_id}
                      className="driver-search-result"
                      key={driver.user_id}
                      onClick={() => setDriverId(driver.user_id)}
                      role="option"
                      type="button"
                    >
                      {driver.name} {driver.surname}
                    </button>
                  ))}
                </div>
              )}
              {driverId && <p className="driver-search-hint">Approved driver selected.</p>}
              <div className="fleet-form-grid">
                <label className="field"><span>Make</span><input maxLength={80} onChange={(event) => setMake(event.target.value)} required value={make} /></label>
                <label className="field"><span>Model</span><input maxLength={80} onChange={(event) => setModel(event.target.value)} required value={model} /></label>
                <label className="field"><span>Year</span><input inputMode="numeric" max={new Date().getFullYear() + 1} min={1900} onChange={(event) => setYear(event.target.value)} required type="number" value={year} /></label>
                <label className="field"><span>Colour</span><input maxLength={40} onChange={(event) => setColour(event.target.value)} required value={colour} /></label>
                <label className="field">
                  <span>Registration number</span>
                  <input autoCapitalize="characters" maxLength={20} onChange={(event) => setRegistrationNumber(event.target.value)} required value={registrationNumber} />
                  <small className="field-hint">Every vehicle must have a unique registration number. If this vehicle is already listed in Fleet, don&apos;t add it again.</small>
                </label>
                <label className="field"><span>Seat count</span><input inputMode="numeric" max={80} min={1} onChange={(event) => setSeatCount(event.target.value)} required type="number" value={seatCount} /></label>
              </div>
              {error && <div className="alert alert-error" role="alert">{error}</div>}
              <div className="dialog-actions">
                <button className="button button-secondary" disabled={saving} onClick={closeOnboarding} type="button">Cancel</button>
                <button className="button button-primary" disabled={saving} type="submit">
                  {saving ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} Add vehicle
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}