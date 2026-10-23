import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Route as RouterRoute, Routes } from 'react-router-dom';
import privacyPolicy from './legal/privacy-policy.md?raw';
import terms from './legal/terms.md?raw';
import logo from '../../mobile/assets/images/brand-icon.png';
import {
  ArrowRight,
  Bell,
  BusFront,
  Building2,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  MapPin,
  Siren,
  Plus,
  RefreshCw,
  Route,
  Search,
  Users,
  X,
} from 'lucide-react';

import {
  ApiRequestError,
  apiRequest,
  apiRequestAllPages,
  clearToken,
  getToken,
  pollingInterval,
  setToken,
} from './api';
import type {
  AdminUser,
  Company,
  DriverApplication,
  FleetVehicle,
  RideRequest,
  Trip,
  VehicleApplication,
  Workplace,
} from './types';
import './App.css';

const Fleet = lazy(() => import('./components/Fleet').then(({ Fleet }) => ({ default: memo(Fleet) })));
const Drivers = lazy(() => import('./components/Drivers').then(({ Drivers }) => ({ default: memo(Drivers) })));
const Incidents = lazy(() => import('./components/Incidents').then(({ Incidents }) => ({ default: memo(Incidents) })));
const NotificationLog = lazy(() => import('./components/NotificationLog').then(({ NotificationLog }) => ({ default: memo(NotificationLog) })));
const Passengers = lazy(() => import('./components/Passengers').then(({ Passengers }) => ({ default: memo(Passengers) })));
const TripPlanner = lazy(() => import('./components/TripPlanner').then(({ TripPlanner }) => ({ default: memo(TripPlanner) })));
const LegalPage = lazy(() => import('./components/LegalPage').then(({ LegalPage }) => ({ default: memo(LegalPage) })));

type Tab = 'overview' | 'reviews' | 'drivers' | 'fleet' | 'workplaces' | 'passengers' | 'trips' | 'incidents' | 'notifications';
type LoginResponse = { token: string; user: AdminUser };
type SessionResponse = { user: AdminUser };
type ApplicationPagination = {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};
type ReviewTarget = {
  kind: 'driver' | 'vehicle';
  id: string;
  name: string;
  decision: 'approved' | 'rejected';
};

type DashboardData = {
  companies: Company[];
  workplaces: Workplace[];
  pendingDriverCount: number;
  pendingVehicleCount: number;
  vehicles: FleetVehicle[];
  vehiclePagination: ApplicationPagination;
  requests: RideRequest[];
  trips: Trip[];
  openIncidentCount: number;
  openEmergencyCount: number;
  failedNotificationsLast24Hours: number;
  summary: {
    pending_ride_requests: number;
    unassigned_trips: number;
    offers_expiring_soon: number;
    today_trips_by_status: Record<string, number>;
    drivers_online: number;
    active_workplaces: number;
    active_companies: number;
    poll_after_seconds?: number;
  };
};

type NeedsAttentionData = {
  documents: {
    document_type: string;
    driver_user_id: string;
    vehicle_id: string | null;
    expires_at: string;
    driver_name: string;
    driver_surname: string;
    expired: boolean;
  }[];
  open_incidents: { id: string; trip_id: string | null; type: string; status: string }[];
  overdue_trips: { trip_id: string; event_type: string }[];
  completed_with_issues: { trip_id: string }[];
  recent_no_shows: { trip_id: string; passenger_name: string | null; passenger_surname: string | null }[];
  unassigned_trips: { trip_id: string; status: string; starts_at: string; flagged_at: string }[];
  overdue_never_started_trips: { trip_id: string; scheduled_at: string; ends_at: string; status: string }[];
  recent_withdrawals: {
    trip_id: string;
    driver_user_id: string;
    reason_kind: string;
    note: string | null;
    scope: string;
    late: boolean;
    created_at: string;
    scheduled_at: string;
  }[];
  trips_waiting_for_driver_confirmation: {
    trip_id: string;
    scheduled_at: string;
    driver_user_id: string;
    change_acknowledged_at: string | null;
  }[];
  recent_missed_trips: {
    trip_id: string;
    scheduled_at: string;
    closed_reason: string | null;
    closed_at: string | null;
    closed_by: string | null;
  }[];
  recent_expired_requests: {
    request_id: string;
    passenger_user_id: string;
    direction: 'to_work' | 'home';
    scheduled_at: string;
    closed_reason: string | null;
  }[];
  running_late_trips: {
    trip_id: string;
    eta_at: string;
    eta_updated_at: string;
    minutes_late: number;
    eta_age_minutes: number;
  }[];
  recent_declined_offers: {
    trip_id: string;
    direction: 'to_work' | 'home';
    scheduled_at: string;
    responded_at: string;
    driver_name: string;
    driver_surname: string;
  }[];
  failed_notifications_last_24_hours: number;
};

const emptyData: DashboardData = {
  companies: [],
  workplaces: [],
  pendingDriverCount: 0,
  pendingVehicleCount: 0,
  vehicles: [],
  vehiclePagination: { page: 1, page_size: 25, total: 0, total_pages: 1 },
  requests: [],
  trips: [],
  openIncidentCount: 0,
  openEmergencyCount: 0,
  failedNotificationsLast24Hours: 0,
  summary: {
    pending_ride_requests: 0,
    unassigned_trips: 0,
    offers_expiring_soon: 0,
    today_trips_by_status: {},
    drivers_online: 0,
    active_workplaces: 0,
    active_companies: 0,
  },
};

const tabs: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'reviews', label: 'Applications', icon: ClipboardCheck },
  { id: 'drivers', label: 'Drivers', icon: Users },
  { id: 'fleet', label: 'Fleet', icon: BusFront },
  { id: 'workplaces', label: 'Workplaces', icon: Building2 },
  { id: 'passengers', label: 'Passengers', icon: Users },
  { id: 'trips', label: 'Trips', icon: Route },
  { id: 'incidents', label: 'Incidents', icon: Siren },
  { id: 'notifications', label: 'Notifications', icon: Bell },
];

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatClockTime(value: string): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

function getInitials(user: AdminUser): string {
  return `${user.name.charAt(0)}${user.surname.charAt(0)}`.toUpperCase();
}

function AdminWorkspace() {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [restoring, setRestoring] = useState(() => Boolean(getToken()));
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const token = getToken();
    if (!token) return;

    apiRequest<SessionResponse>('/auth/me')
      .then(({ user: restoredUser }) => {
        if (!active) return;
        if (restoredUser.role === 'admin') {
          setUser(restoredUser);
          setRestoreError(null);
        } else {
          clearToken();
          setRestoreError('This session does not have administrator access. Please sign in again.');
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          clearToken();
          return;
        }
        setRestoreError(
          error instanceof Error
            ? error.message
            : 'We could not restore your session. Check your connection and try again.'
        );
      })
      .finally(() => {
        if (active) setRestoring(false);
      });

    return () => {
      active = false;
    };
  }, [restoreAttempt]);

  useEffect(() => {
    function expireSession() {
      setUser(null);
      setRestoring(false);
    }
    window.addEventListener('admin-session-expired', expireSession);
    return () => window.removeEventListener('admin-session-expired', expireSession);
  }, []);

  function handleLogin(response: LoginResponse) {
    setToken(response.token);
    setUser(response.user);
    setRestoreError(null);
  }

  function handleLogout() {
    clearToken();
    setUser(null);
    setRestoreError(null);
  }

  if (restoring) {
    return <div className="app-loading" aria-label="Loading"> <LoaderCircle className="spin" /> </div>;
  }

  return user ? (
    <Dashboard user={user} onLogout={handleLogout} />
  ) : (
    <LoginScreen
      onLogin={handleLogin}
      restoreError={restoreError}
      onRetryRestore={() => {
        setRestoring(true);
        setRestoreAttempt((attempt) => attempt + 1);
      }}
    />
  );
}

function DeleteAccountPage() {
  const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL?.trim();
  return (
    <main className="public-page">
      <article className="public-panel">
        <a className="wordmark" href="/" aria-label="Global Ride Transport">
          <span className="brand-mark"><img alt="" src={logo} /></span>
          <span>Global Ride Transport</span>
        </a>
        <h1>Delete your account</h1>
        <p>To request deletion, use Delete account in the app's Account screen.</p>
        {supportEmail && (
          <p>
            You can also email{' '}
            <a href={`mailto:${encodeURIComponent(supportEmail)}`}>{supportEmail}</a>
            {' '}from your registered email address.
          </p>
        )}
      </article>
    </main>
  );
}

function App() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Routes>
        <RouterRoute path="/delete-account" element={<DeleteAccountPage />} />
        <RouterRoute
          path="/privacy"
          element={<LegalPage title="Privacy policy" content={privacyPolicy} />}
        />
        <RouterRoute
          path="/terms"
          element={<LegalPage title="Terms of service" content={terms} />}
        />
        <RouterRoute path="*" element={<AdminWorkspace />} />
      </Routes>
    </Suspense>
  );
}

function LoginScreen({
  onLogin,
  restoreError,
  onRetryRestore,
}: {
  onLogin: (response: LoginResponse) => void;
  restoreError: string | null;
  onRetryRestore: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await apiRequest<LoginResponse>('/admin/auth/login', {
        method: 'POST',
        body: { email: email.trim().toLowerCase(), password },
      });
      onLogin(response);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "We couldn't sign you in. Check your email and password and try again."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <a className="wordmark" href="/" aria-label="Global Ride Transport">
          <span className="brand-mark"><img alt="" src={logo} /></span>
          <span>Global Ride Transport</span>
        </a>
        <div className="login-heading">
          <h1 id="login-title">Sign in</h1>
        </div>
        {restoreError && (
          <div className="alert alert-error" role="alert">
            <span>{restoreError}</span>
            {getToken() && (
              <button
                className="button button-secondary button-small"
                onClick={onRetryRestore}
                type="button"
              >
                Retry session
              </button>
            )}
          </div>
        )}
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span>Email address</span>
            <input
              autoComplete="username"
              autoCapitalize="none"
              inputMode="email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              autoComplete="current-password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
            />
          </label>
          <button className="button button-primary login-submit" type="submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="spin" size={18} /> : null}
            <span>Sign in</span>
            {!submitting ? <ArrowRight size={17} /> : null}
          </button>
        </form>
      </section>
    </main>
  );
}

function Dashboard({ user, onLogout }: { user: AdminUser; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [data, setData] = useState(emptyData);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [vehiclePage, setVehiclePage] = useState(1);
  const pollFailureCount = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);

  const refreshData = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    setReloadKey((value) => value + 1);
  }, []);

  const openTrip = useCallback((tripId: string) => {
    setSelectedTripId(tripId);
    setTab('trips');
  }, []);
  const closeTrip = useCallback(() => setSelectedTripId(null), []);

  useEffect(() => {
    let active = true;
    let pollAfterSeconds = 60;
    let failureStatus: number | undefined;
    let refreshTimer: number | undefined;
    Promise.all([
      apiRequestAllPages<Company>('/admin/companies', 'companies'),
      apiRequest<{ drivers: DriverApplication[]; pagination: ApplicationPagination }>(
        '/admin/drivers/applications?page=1&page_size=1'
      ),
      apiRequest<{ vehicles: VehicleApplication[]; pagination: ApplicationPagination }>(
        '/admin/vehicles/applications?page=1&page_size=1'
      ),
      apiRequest<{ vehicles: FleetVehicle[]; pagination: ApplicationPagination }>(
        `/admin/vehicles?page=${vehiclePage}&page_size=25`
      ),
      apiRequest<{ ride_requests: RideRequest[]; pagination: ApplicationPagination }>(
        '/admin/ride-requests?page=1&page_size=5&unassigned_only=true'
      ),
      apiRequest<{ trips: Trip[]; pagination: ApplicationPagination }>('/admin/trips?page=1&page_size=5'),
      apiRequest<DashboardData['summary']>('/admin/dashboard/summary'),
      apiRequest<{
        open_incident_count: number;
        open_emergency_count: number;
        failed_notifications_last_24_hours: number;
        poll_after_seconds?: number;
      }>('/admin/needs-attention'),
    ])
      .then(([companies, drivers, pendingVehicles, vehicles, requests, trips, summary, attention]) => {
        if (!active) return;
        pollFailureCount.current = 0;
        pollAfterSeconds = Math.min(
          summary.poll_after_seconds ?? 60,
          attention.poll_after_seconds ?? 60
        );
        setData({
          companies,
          workplaces: [],
          pendingDriverCount: drivers.pagination.total,
          pendingVehicleCount: pendingVehicles.pagination.total,
          vehicles: vehicles.vehicles,
          vehiclePagination: vehicles.pagination,
          requests: requests.ride_requests,
          trips: trips.trips,
          openIncidentCount: attention.open_incident_count,
          openEmergencyCount: attention.open_emergency_count,
          failedNotificationsLast24Hours: attention.failed_notifications_last_24_hours,
          summary,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.status === 401) return;
        if (error instanceof ApiRequestError) {
          failureStatus = error.status;
          if (error.status === 429 || error.status >= 500) pollFailureCount.current += 1;
        }
        if (active) {
          setLoadError(
            error instanceof Error ? error.message : 'We could not load operations. Please retry.'
          );
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          if (document.visibilityState === 'visible') {
            refreshTimer = window.setTimeout(() => {
              refreshTimerRef.current = null;
              setReloadKey((value) => value + 1);
            }, pollingInterval(pollAfterSeconds, 60, pollFailureCount.current, failureStatus));
            refreshTimerRef.current = refreshTimer;
          }
        }
      });

    return () => {
      active = false;
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
        if (refreshTimerRef.current === refreshTimer) refreshTimerRef.current = null;
      }
    };
  }, [reloadKey, vehiclePage]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setReloadKey((value) => value + 1);
      } else if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  async function confirmReview() {
    if (!reviewTarget) return;
    if (reviewTarget.decision === 'rejected' && !rejectionReason.trim()) {
      setReviewError('Enter a reason for rejection.');
      return;
    }

    setReviewing(true);
    setReviewError(null);
    const path = reviewTarget.kind === 'driver'
      ? `/admin/drivers/${reviewTarget.id}/review`
      : `/admin/vehicles/${reviewTarget.id}/review`;
    try {
      await apiRequest(path, {
        method: 'PATCH',
        body: {
          status: reviewTarget.decision,
          ...(reviewTarget.decision === 'rejected'
            ? { rejection_reason: rejectionReason.trim() }
            : {}),
        },
      });
      setNotice(`${reviewTarget.kind === 'driver' ? 'Driver' : 'Vehicle'} ${reviewTarget.decision}.`);
      setReviewTarget(null);
      setRejectionReason('');
      refreshData();
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Review could not be saved.');
    } finally {
      setReviewing(false);
    }
  }

  const currentTab = tabs.find((item) => item.id === tab) ?? tabs[0];
  const pendingReviews = data.pendingDriverCount + data.pendingVehicleCount;

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <a className="wordmark sidebar-brand" href="/" aria-label="Global Ride Transport">
          <span className="brand-mark"><img alt="" src={logo} /></span>
          <span className="brand-name">Global Ride<br /><strong>Transport</strong></span>
        </a>
        <div className="sidebar-label">OPERATIONS</div>
        <nav className="side-nav" aria-label="Main navigation">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              aria-current={tab === id ? 'page' : undefined}
              className={`nav-item${tab === id ? ' is-active' : ''}`}
              key={id}
              onClick={() => setTab(id)}
              type="button"
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {id === 'reviews' && pendingReviews > 0 && (
                <span className="nav-count">{pendingReviews}</span>
              )}
              {id === 'incidents' && data.openIncidentCount > 0 && (
                <span className="nav-count">{data.openIncidentCount}</span>
              )}
              {id === 'notifications' && data.failedNotificationsLast24Hours > 0 && (
                <span className="nav-count">{data.failedNotificationsLast24Hours}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="account-chip">
            <span className="account-avatar">{getInitials(user)}</span>
            <span className="account-copy"><strong>{user.name} {user.surname}</strong><small>{user.email}</small></span>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Global Ride</span><ChevronRight size={14} /><strong>{currentTab.label}</strong></div>
          <div className="topbar-actions">
            <span className="today-label"><CalendarDays size={15} /> {new Intl.DateTimeFormat('en-ZA', { dateStyle: 'full' }).format(new Date())}</span>
            <button className="logout-button" onClick={onLogout} type="button">
              <LogOut size={17} /> <span>Sign out</span>
            </button>
            <button
              aria-label="Refresh data"
              className="icon-button"
              disabled={loading}
              onClick={refreshData}
              title="Refresh data"
              type="button"
            ><RefreshCw size={17} className={loading ? 'spin' : ''} /></button>
          </div>
        </header>

        <div className="page-content">
          {data.openEmergencyCount > 0 && (
            <button className="emergency-banner" onClick={() => setTab('incidents')} type="button">
              <Siren size={19} />
              <span><strong>Emergency incident needs attention</strong><small>{data.openEmergencyCount} unresolved emergency{data.openEmergencyCount === 1 ? '' : 'ies'}</small></span>
              <ArrowRight size={17} />
            </button>
          )}
          {notice && (
            <div className="alert alert-success" role="status">
              <Check size={17} /> {notice}
              <button aria-label="Dismiss" className="alert-dismiss" onClick={() => setNotice(null)} type="button"><X size={16} /></button>
            </div>
          )}
          {loadError && (
            <div className="alert alert-error" role="alert">
              <span>{loadError}</span>
              <button className="button button-secondary button-small" onClick={refreshData} type="button">Retry</button>
            </div>
          )}
          {loading && data.companies.length === 0 ? (
            <LoadingState />
          ) : (
            <Suspense fallback={<LoadingState />}>
              {tab === 'overview' && <Overview data={data} reloadKey={reloadKey} onNavigate={setTab} onOpenTrip={openTrip} />}
              {tab === 'reviews' && (
                <Reviews
                  reloadKey={reloadKey}
                  pendingDriverCount={data.pendingDriverCount}
                  pendingVehicleCount={data.pendingVehicleCount}
                  onReview={(target) => {
                    setReviewTarget(target);
                    setRejectionReason('');
                    setReviewError(null);
                  }}
                />
              )}
              {tab === 'fleet' && (
                <Fleet
                  vehicles={data.vehicles}
                  pagination={data.vehiclePagination}
                  onPageChange={setVehiclePage}
                  onSaved={refreshData}
                />
              )}
              {tab === 'drivers' && <Drivers />}
              {tab === 'workplaces' && (
                <Workplaces data={data} onSaved={refreshData} />
              )}
              {tab === 'passengers' && <Passengers onSaved={refreshData} />}
              {tab === 'trips' && (
                <Trips
                  onChanged={refreshData}
                  openTripId={selectedTripId}
                  onTripOpened={closeTrip}
                />
              )}
              {tab === 'incidents' && <Incidents reloadKey={reloadKey} onOpenTrip={openTrip} onChanged={refreshData} />}
              {tab === 'notifications' && <NotificationLog />}
            </Suspense>
          )}
        </div>
      </main>

      {reviewTarget && (
        <div className="dialog-backdrop" role="presentation">
          <section aria-labelledby="review-dialog-title" aria-modal="true" className="dialog" role="dialog">
            <button
              aria-label="Close"
              className="dialog-close icon-button"
              disabled={reviewing}
              onClick={() => setReviewTarget(null)}
              type="button"
            ><X size={18} /></button>
            <span className={`dialog-mark ${reviewTarget.decision === 'approved' ? 'mark-green' : 'mark-coral'}`}>
              {reviewTarget.decision === 'approved' ? <Check size={20} /> : <ClipboardCheck size={20} />}
            </span>
            <span className="eyebrow">CONFIRM DECISION</span>
            <h2 id="review-dialog-title">{reviewTarget.decision === 'approved' ? 'Approve' : 'Reject'} {reviewTarget.kind} application?</h2>
            <p className="dialog-copy">{reviewTarget.name}</p>
            {reviewTarget.decision === 'rejected' && (
              <label className="field">
                <span>Reason for rejection</span>
                <textarea
                  maxLength={500}
                  onChange={(event) => setRejectionReason(event.target.value)}
                  rows={3}
                  value={rejectionReason}
                />
              </label>
            )}
            {reviewError && <div className="alert alert-error" role="alert">{reviewError}</div>}
            <div className="dialog-actions">
              <button className="button button-secondary" disabled={reviewing} onClick={() => setReviewTarget(null)} type="button">Cancel</button>
              <button
                className={`button ${reviewTarget.decision === 'approved' ? 'button-primary' : 'button-danger'}`}
                disabled={reviewing}
                onClick={() => void confirmReview()}
                type="button"
              >{reviewing ? <LoaderCircle className="spin" size={17} /> : null} Confirm</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Overview({ data, reloadKey, onNavigate, onOpenTrip }: {
  data: DashboardData;
  reloadKey: number;
  onNavigate: (tab: Tab) => void;
  onOpenTrip: (tripId: string) => void;
}) {
  return (
    <>
      <section className="overview-intro" aria-labelledby="overview-title">
        <div>
          <span className="eyebrow">GLOBAL RIDE / CONTROL ROOM</span>
          <h1 id="overview-title">Daily operations</h1>
          <p>{new Intl.DateTimeFormat('en-ZA', { dateStyle: 'full' }).format(new Date())}</p>
        </div>
        <span className="live-indicator"><span />Live dashboard</span>
      </section>
      <section className="metrics" aria-label="Operations summary">
        <Metric
          label="Applications to review"
          value={data.pendingDriverCount + data.pendingVehicleCount}
          detail={`${data.pendingDriverCount} drivers · ${data.pendingVehicleCount} vehicles`}
          icon={<ClipboardCheck size={18} />}
        />
        <Metric label="Ride requests" value={data.summary.pending_ride_requests} detail="Awaiting trip assignment" icon={<CalendarDays size={18} />} />
        <Metric label="Unassigned trips" value={data.summary.unassigned_trips} detail={`${data.summary.offers_expiring_soon} offers expire soon`} icon={<Route size={18} />} />
        <Metric label="Workplaces" value={data.summary.active_workplaces} detail={`${data.summary.active_companies} companies`} icon={<Building2 size={18} />} />
        <Metric label="Drivers online" value={data.summary.drivers_online} detail="Available for offers" icon={<Users size={18} />} />
      </section>
      <NeedsAttention reloadKey={reloadKey} onNavigate={onNavigate} onOpenTrip={onOpenTrip} />
      <div className="overview-grid">
        <section className="content-section">
          <SectionHeader title="Pending applications" action="View applications" onAction={() => onNavigate('reviews')} />
          {data.pendingDriverCount + data.pendingVehicleCount === 0 ? (
            <EmptyState title="No applications to review" />
          ) : (
            <div className="summary-list">
              {[
                { id: 'drivers', name: 'Driver applications', count: data.pendingDriverCount },
                { id: 'vehicles', name: 'Vehicle applications', count: data.pendingVehicleCount },
              ].filter(({ count }) => count > 0).map((application) => (
                <div className="summary-row" key={application.id}>
                  <span className="row-icon"><ClipboardCheck size={18} /></span>
                  <span className="summary-copy"><strong>{application.name}</strong><small>Waiting for admin review</small></span>
                  <span className="section-count">{application.count}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="content-section">
          <SectionHeader title="Recent trip activity" action="View trips" onAction={() => onNavigate('trips')} />
          {data.trips.length === 0 ? (
            <EmptyState title="No trips scheduled" />
          ) : (
            <div className="summary-list">
              {data.trips.slice(0, 4).map((trip) => (
                <div className="summary-row" key={trip.id}>
                  <span className="row-icon row-icon-yellow"><Route size={18} /></span>
                  <span className="summary-copy"><strong>{directionName(trip.direction)} · {trip.passenger_count} passengers</strong><small>{formatDate(trip.scheduled_at)}</small></span>
                  <span className={`status status-${trip.status}`}>{trip.status.replaceAll('_', ' ')}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <section className="content-section request-section">
        <SectionHeader title="Unassigned ride requests" action="View ride requests" onAction={() => onNavigate('trips')} />
        {data.requests.length === 0 ? (
          <EmptyState title="No unassigned requests" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Passenger</th><th>Workplace</th><th>Home suburb</th><th>Workplace suburb</th><th>Direction</th><th>Scheduled</th><th>Status</th></tr></thead>
              <tbody>{data.requests.slice(0, 5).map((request) => (
                <tr key={request.id}>
                  <td><strong>{request.passenger_name} {request.passenger_surname}</strong></td>
                  <td>{request.workplace_name}<small className="cell-subtitle">{request.company_name}</small></td>
                  <td>{request.home_suburb || <span className="suburb-warning">Missing suburb</span>}</td>
                  <td>{request.workplace_suburb || <span className="suburb-warning">Missing suburb</span>}</td>
                  <td>{directionName(request.direction)}</td>
                  <td>{formatDate(request.scheduled_at)}</td>
                  <td><span className="status status-pending">Pending</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function NeedsAttention({ reloadKey: dashboardReloadKey, onNavigate, onOpenTrip }: {
  reloadKey: number;
  onNavigate: (tab: Tab) => void;
  onOpenTrip: (tripId: string) => void;
}) {
  const [attention, setAttention] = useState<NeedsAttentionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    apiRequest<NeedsAttentionData>('/admin/needs-attention')
      .then((result) => {
        if (active) {
          setAttention(result);
          setError(null);
        }
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : 'Needs attention could not be loaded.');
        }
      });
    return () => {
      active = false;
    };
  }, [dashboardReloadKey, retryKey]);

  const total = attention
    ? attention.documents.length + attention.open_incidents.length + attention.overdue_trips.length
      + attention.completed_with_issues.length + attention.recent_no_shows.length
      + attention.unassigned_trips.length
      + attention.overdue_never_started_trips.length
      + attention.recent_withdrawals.length
      + attention.trips_waiting_for_driver_confirmation.length
      + attention.recent_missed_trips.length
      + attention.recent_expired_requests.length
      + attention.running_late_trips.length
      + attention.recent_declined_offers.length
      + attention.failed_notifications_last_24_hours
    : 0;
  return (
    <section className="content-section">
      <SectionHeader title="Needs attention" />
      {error ? (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
          <button className="button button-secondary button-small" onClick={() => setRetryKey((value) => value + 1)} type="button">Retry</button>
        </div>
      ) : !attention ? (
        <p className="muted-copy">Loading attention items…</p>
      ) : total === 0 ? (
        <EmptyState title="Nothing needs attention" />
      ) : (
        <div className="summary-list">
          {attention.failed_notifications_last_24_hours > 0 && (
            <button className="summary-row attention-row" onClick={() => onNavigate('notifications')} type="button">
              <span className="summary-copy"><strong>Failed notifications (last 24 hours)</strong><small>Review delivery status and recent errors</small></span>
              <span className="section-count">{attention.failed_notifications_last_24_hours}</span>
            </button>
          )}
          {attention.open_incidents.map((incident) => (
            <button className="summary-row attention-row" key={`incident-${incident.id}`} onClick={() => incident.trip_id ? onOpenTrip(incident.trip_id) : onNavigate('incidents')} type="button">
              <span className="summary-copy"><strong>{incident.type === 'emergency' ? 'Emergency incident' : 'Open incident'}</strong><small>{incident.type.replaceAll('_', ' ')} · {incident.status}</small></span>
              <span className="section-count">Review</span>
            </button>
          ))}
          {attention.documents.map((document) => (
            <button className="summary-row attention-row" key={`${document.document_type}-${document.vehicle_id ?? document.driver_user_id}`} onClick={() => onNavigate(document.document_type === 'vehicle_licence_disc' ? 'fleet' : 'drivers')} type="button">
              <span className="summary-copy"><strong>{document.expired ? 'Expired document' : 'Document expiring soon'}</strong><small>{document.document_type.replaceAll('_', ' ')} · {document.driver_name} {document.driver_surname}</small></span>
              <span className="section-count">{new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium' }).format(new Date(document.expires_at))}</span>
            </button>
          ))}
          {attention.overdue_trips.map((trip) => (
            <button className="summary-row attention-row" key={`${trip.trip_id}-${trip.event_type}`} onClick={() => onOpenTrip(trip.trip_id)} type="button">
              <span className="summary-copy"><strong>{trip.event_type === 'trip.not_started_overdue' ? 'Trip not started on time' : 'Trip running long'}</strong><small>{trip.trip_id}</small></span>
              <span className="section-count">Review</span>
            </button>
          ))}
          {attention.unassigned_trips.map((trip) => (
            <button className="summary-row attention-row" key={`unassigned-${trip.trip_id}`} onClick={() => onOpenTrip(trip.trip_id)} type="button">
              <span className="summary-copy"><strong>Trip has no accepted Driver</strong><small>Starts {formatDate(trip.starts_at)}</small></span>
              <span className="section-count">Review</span>
            </button>
          ))}
          {attention.overdue_never_started_trips.map((trip) => (
            <button className="summary-row attention-row" key={`overdue-trip-${trip.trip_id}`} onClick={() => onOpenTrip(trip.trip_id)} type="button">
              <span className="summary-copy"><strong>Accepted trip not started</strong><small>Planned to end {formatDate(trip.ends_at)} · {trip.status.replaceAll('_', ' ')}</small></span>
              <span className="section-count">Review</span>
            </button>
          ))}
          {attention.trips_waiting_for_driver_confirmation.map((trip) => (
            <button className="summary-row attention-row" key={`confirm-trip-${trip.trip_id}`} onClick={() => onOpenTrip(trip.trip_id)} type="button">
              <span className="summary-copy"><strong>Trip changes need driver confirmation</strong><small>Scheduled {formatDate(trip.scheduled_at)}</small></span>
              <span className="section-count">Review</span>
            </button>
          ))}
          {attention.recent_withdrawals.map((withdrawal, index) => (
            <button className="summary-row attention-row" key={`withdrawal-${withdrawal.trip_id}-${withdrawal.created_at}-${index}`} onClick={() => onOpenTrip(withdrawal.trip_id)} type="button">
              <span className="summary-copy"><strong>Driver withdrew{withdrawal.late ? ' late' : ''}</strong><small>{withdrawal.reason_kind.replaceAll('_', ' ')} · {withdrawal.scope === 'all_future' ? 'this and future trips' : 'this trip'} · {formatDate(withdrawal.scheduled_at)}</small></span>
              <span className="section-count">Review</span>
            </button>
          ))}
          {attention.recent_missed_trips.map((trip) => (
            <button className="summary-row attention-row" key={`missed-trip-${trip.trip_id}`} onClick={() => onOpenTrip(trip.trip_id)} type="button">
              <span className="summary-copy"><strong>Trip marked missed</strong><small>{formatDate(trip.scheduled_at)}{trip.closed_reason ? ` · ${trip.closed_reason.replaceAll('_', ' ')}` : ''}</small></span>
              <span className="section-count">Review</span>
            </button>
          ))}
          {attention.recent_expired_requests.map((request) => (
            <button className="summary-row attention-row" key={`expired-request-${request.request_id}`} onClick={() => onNavigate('trips')} type="button">
              <span className="summary-copy"><strong>Ride request expired</strong><small>{directionName(request.direction)} · {formatDate(request.scheduled_at)}</small></span>
              <span className="section-count">Requests</span>
            </button>
          ))}
          {attention.running_late_trips.map((trip) => (
            <button className="summary-row attention-row" key={`running-late-${trip.trip_id}`} onClick={() => onOpenTrip(trip.trip_id)} type="button">
              <span className="summary-copy"><strong>Running late</strong><small>Expected {formatClockTime(trip.eta_at)} · {trip.minutes_late} min later than planned · Updated {trip.eta_age_minutes} min ago</small></span>
              <span className="section-count">Review</span>
            </button>
          ))}
          {attention.recent_declined_offers.map((offer) => (
            <button className="summary-row attention-row" key={`declined-offer-${offer.trip_id}-${offer.responded_at}`} onClick={() => onOpenTrip(offer.trip_id)} type="button">
              <span className="summary-copy">
                <strong>Driver declined a trip</strong>
                <small>{offer.driver_name} {offer.driver_surname} · {directionName(offer.direction)} · {formatDate(offer.scheduled_at)}</small>
              </span>
              <span className="section-count">Review</span>
            </button>
          ))}
          {attention.completed_with_issues.map((trip) => (
            <button className="summary-row attention-row" key={`issue-${trip.trip_id}`} onClick={() => onOpenTrip(trip.trip_id)} type="button">
              <span className="summary-copy"><strong>Trip completed with issues</strong><small>{trip.trip_id}</small></span>
              <span className="section-count">Review</span>
            </button>
          ))}
          {attention.recent_no_shows.map((noShow, index) => (
            <button className="summary-row attention-row" key={`no-show-${noShow.trip_id}-${index}`} onClick={() => onOpenTrip(noShow.trip_id)} type="button">
              <span className="summary-copy"><strong>Recent no-show</strong><small>{[noShow.passenger_name, noShow.passenger_surname].filter(Boolean).join(' ') || 'Passenger'} · {noShow.trip_id}</small></span>
              <span className="section-count">7 days</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Reviews({
  pendingDriverCount,
  pendingVehicleCount,
  reloadKey,
  onReview,
}: {
  pendingDriverCount: number;
  pendingVehicleCount: number;
  reloadKey: number;
  onReview: (target: ReviewTarget) => void;
}) {
  const [kind, setKind] = useState<'driver' | 'vehicle'>('driver');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [applications, setApplications] = useState<(DriverApplication | VehicleApplication)[]>([]);
  const [pagination, setPagination] = useState<ApplicationPagination>({
    page: 1,
    page_size: 20,
    total: 0,
    total_pages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const value = searchInput.trim();
      if (value.length === 1) {
        setError('Enter at least 2 characters to search, or clear the search field.');
        return;
      }
      setError(null);
      if (value !== search) {
        setPage(1);
        setSearch(value);
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [search, searchInput]);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        page: String(page),
        page_size: '20',
      });
      if (search) params.set('search', search);
      const endpoint = kind === 'driver'
        ? `/admin/drivers/applications?${params.toString()}`
        : `/admin/vehicles/applications?${params.toString()}`;

      const request = kind === 'driver'
        ? apiRequest<{ drivers: DriverApplication[]; pagination: ApplicationPagination }>(endpoint)
            .then((result) => ({ applications: result.drivers, pagination: result.pagination }))
        : apiRequest<{ vehicles: VehicleApplication[]; pagination: ApplicationPagination }>(endpoint)
            .then((result) => ({ applications: result.vehicles, pagination: result.pagination }));

      request
        .then((result) => {
          if (!active) return;
          setApplications(result.applications);
          setPagination(result.pagination);
        })
        .catch((requestError: unknown) => {
          if (active) {
            setError(requestError instanceof Error ? requestError.message : 'Could not load applications.');
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
  }, [kind, page, reloadKey, search]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = searchInput.trim();
    if (value.length === 1) {
      setError('Enter at least 2 characters to search, or clear the search field.');
    }
  }

  const count = kind === 'driver' ? pendingDriverCount : pendingVehicleCount;
  const firstResult = pagination.total === 0 ? 0 : ((pagination.page - 1) * pagination.page_size) + 1;
  const lastResult = Math.min(pagination.page * pagination.page_size, pagination.total);

  return (
    <>
      <PageHeading eyebrow="APPLICATIONS" title="Review queue" />
      <div className="application-tabs" role="tablist" aria-label="Application type">
        <button
          aria-selected={kind === 'driver'}
          className={`application-tab${kind === 'driver' ? ' is-active' : ''}`}
          onClick={() => {
            setKind('driver');
            setPage(1);
          }}
          role="tab"
          type="button"
        >Drivers <span>{pendingDriverCount}</span></button>
        <button
          aria-selected={kind === 'vehicle'}
          className={`application-tab${kind === 'vehicle' ? ' is-active' : ''}`}
          onClick={() => {
            setKind('vehicle');
            setPage(1);
          }}
          role="tab"
          type="button"
        >Vehicles <span>{pendingVehicleCount}</span></button>
      </div>
      <section
        aria-label={`${kind} applications`}
        className="content-section application-queue"
        role="tabpanel"
      >
        <div className="application-toolbar">
          <div>
            <h2>{kind === 'driver' ? 'Driver applications' : 'Vehicle applications'}</h2>
            <p>
              {search
                ? `${pagination.total.toLocaleString()} matching · ${count.toLocaleString()} waiting for review`
                : `${count.toLocaleString()} waiting for review`}
            </p>
          </div>
          <form className="application-search" onSubmit={submitSearch} role="search">
            <label className="visually-hidden" htmlFor="application-search">Search applications</label>
            <Search size={17} />
            <input
              id="application-search"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={kind === 'driver' ? 'Name, email or phone' : 'Vehicle, registration or driver'}
              value={searchInput}
            />
            {searchInput && (
              <button
                aria-label="Clear search"
                className="application-search-clear"
                onClick={() => {
                  setSearchInput('');
                  setSearch('');
                  setPage(1);
                }}
                type="button"
              ><X size={15} /></button>
            )}
            <button className="button button-primary button-small" type="submit">Search</button>
          </form>
        </div>

        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {loading ? (
          <div className="loading-state"><LoaderCircle className="spin" size={20} /> Loading applications…</div>
        ) : applications.length === 0 ? (
          <EmptyState title={search ? 'No matching applications' : `No pending ${kind} applications`} />
        ) : (
          <div className="review-grid">
            {kind === 'driver'
              ? (applications as DriverApplication[]).map((driver) => (
                <article className="review-row" key={driver.id}>
                  <span className="row-icon"><UsersIcon /></span>
                  <div className="review-main">
                    <div className="review-title"><strong>{driver.name} {driver.surname}</strong><span className="status status-pending">Pending</span></div>
                    <div className="review-meta">{driver.email} · {driver.contact_number}</div>
                    <div className="review-meta">{driver.address}</div>
                    <div className="review-meta">Received {formatDate(driver.created_at)}</div>
                  </div>
                  <div className="review-actions">
                    <button className="button button-secondary" onClick={() => onReview({ kind: 'driver', id: driver.id, name: `${driver.name} ${driver.surname}`, decision: 'rejected' })} type="button">Reject</button>
                    <button className="button button-primary" onClick={() => onReview({ kind: 'driver', id: driver.id, name: `${driver.name} ${driver.surname}`, decision: 'approved' })} type="button">Approve</button>
                  </div>
                </article>
              ))
              : (applications as VehicleApplication[]).map((vehicle) => (
                <article className="review-row" key={vehicle.id}>
                  <span className="row-icon"><BusFront size={18} /></span>
                  <div className="review-main">
                    <div className="review-title">
                      <strong>{vehicle.year} {vehicle.make} {vehicle.model}</strong>
                      <span className="status status-pending">Pending inspection</span>
                    </div>
                    <div className="review-meta">{vehicle.colour} · {vehicle.registration_number} · {vehicle.seat_count} seats</div>
                    <div className="review-meta">Submitted by {vehicle.driver_name} {vehicle.driver_surname} · {vehicle.driver_email}</div>
                    <div className="review-meta">Received {formatDate(vehicle.created_at)}</div>
                  </div>
                  <div className="review-actions">
                    <button className="button button-secondary" onClick={() => onReview({
                      kind: 'vehicle',
                      id: vehicle.id,
                      name: `${vehicle.year} ${vehicle.make} ${vehicle.model} (${vehicle.registration_number})`,
                      decision: 'rejected',
                    })} type="button">Reject</button>
                    <button className="button button-primary" onClick={() => onReview({
                      kind: 'vehicle',
                      id: vehicle.id,
                      name: `${vehicle.year} ${vehicle.make} ${vehicle.model} (${vehicle.registration_number})`,
                      decision: 'approved',
                    })} type="button">Approve</button>
                  </div>
                </article>
              ))}
          </div>
        )}
        {!loading && pagination.total > 0 && (
          <div className="application-pagination">
            <span>Showing {firstResult.toLocaleString()}–{lastResult.toLocaleString()} of {pagination.total.toLocaleString()}</span>
            <div>
              <button
                aria-label="Previous page"
                className="icon-button"
                disabled={pagination.page <= 1}
                onClick={() => setPage(pagination.page - 1)}
                type="button"
              ><ChevronLeft size={17} /></button>
              <span>Page {pagination.page.toLocaleString()} of {pagination.total_pages.toLocaleString()}</span>
              <button
                aria-label="Next page"
                className="icon-button"
                disabled={pagination.page >= pagination.total_pages}
                onClick={() => setPage(pagination.page + 1)}
                type="button"
              ><ChevronRight size={17} /></button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function Workplaces({ data, onSaved }: { data: DashboardData; onSaved: () => void }) {
  const [workplaceSearch, setWorkplaceSearch] = useState('');
  const [workplacePage, setWorkplacePage] = useState(1);
  const [workplaceResults, setWorkplaceResults] = useState<{
    workplaces: Workplace[];
    pagination: ApplicationPagination;
  } | null>(null);
  const [workplaceLoading, setWorkplaceLoading] = useState(true);
  const [workplaceLoadError, setWorkplaceLoadError] = useState<string | null>(null);
  const [workplaceReloadKey, setWorkplaceReloadKey] = useState(0);
  const [companyName, setCompanyName] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [workplaceName, setWorkplaceName] = useState('');
  const [address, setAddress] = useState('');
  const [suburb, setSuburb] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [companyFormOpen, setCompanyFormOpen] = useState(false);
  const [workplaceFormOpen, setWorkplaceFormOpen] = useState(false);
  const workplacePageSize = 25;

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setWorkplaceLoading(true);
      setWorkplaceLoadError(null);
      const query = new URLSearchParams({
        page: String(workplacePage),
        page_size: String(workplacePageSize),
      });
      if (workplaceSearch.trim()) query.set('search', workplaceSearch.trim());
      apiRequest<{ workplaces: Workplace[]; pagination: ApplicationPagination }>(
        `/admin/workplaces?${query.toString()}`
      )
        .then((result) => {
          if (active) setWorkplaceResults(result);
        })
        .catch((requestError: unknown) => {
          if (active) {
            setWorkplaceLoadError(
              requestError instanceof Error ? requestError.message : 'Workplaces could not be loaded.'
            );
          }
        })
        .finally(() => {
          if (active) setWorkplaceLoading(false);
        });
    }, workplaceSearch ? 250 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [workplacePage, workplaceSearch, workplaceReloadKey]);

  const workplaceRows = workplaceResults?.workplaces ?? [];
  const workplacePagination = workplaceResults?.pagination;

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/admin/companies', { method: 'POST', body: { name: companyName.trim() } });
      setCompanyName('');
      setCompanyFormOpen(false);
      onSaved();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Company could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function createWorkplace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/admin/workplaces', {
        method: 'POST',
        body: {
          company_id: companyId,
          name: workplaceName.trim(),
          address: address.trim(),
          suburb: suburb.trim(),
        },
      });
      setCompanyId('');
      setWorkplaceName('');
      setAddress('');
      setSuburb('');
      setWorkplaceFormOpen(false);
      setWorkplacePage(1);
      setWorkplaceReloadKey((value) => value + 1);
      onSaved();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Workplace could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeading eyebrow="NETWORK" title="Companies & workplaces" />
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="workplace-actions" aria-label="Workplace actions">
        <button
          aria-controls="workplace-forms"
          aria-expanded={companyFormOpen}
          className={`button ${companyFormOpen ? 'button-secondary' : 'button-primary'}`}
          onClick={() => {
            setError(null);
            setCompanyFormOpen((open) => !open);
            setWorkplaceFormOpen(false);
          }}
          type="button"
        >{companyFormOpen ? <X size={17} /> : <Plus size={17} />}{companyFormOpen ? 'Close company form' : 'Add company'}</button>
        <button
          aria-controls="workplace-forms"
          aria-expanded={workplaceFormOpen}
          className={`button ${workplaceFormOpen ? 'button-secondary' : 'button-primary'}`}
          onClick={() => {
            setError(null);
            setWorkplaceFormOpen((open) => !open);
            setCompanyFormOpen(false);
          }}
          type="button"
        >{workplaceFormOpen ? <X size={17} /> : <Plus size={17} />}{workplaceFormOpen ? 'Close workplace form' : 'Add workplace'}</button>
      </div>
      <div className="workplace-layout">
        <section className="content-section">
          <div className="application-toolbar">
            <h2>Registered workplaces <span className="section-count">{(workplacePagination?.total ?? 0).toLocaleString()}</span></h2>
            <label className="application-search">
              <Search aria-hidden="true" size={17} />
              <span className="visually-hidden">Search workplaces</span>
              <input
                onChange={(event) => {
                  setWorkplaceSearch(event.target.value);
                  setWorkplacePage(1);
                }}
                placeholder="Search workplace, company, or suburb"
                type="search"
                value={workplaceSearch}
              />
            </label>
          </div>
          {workplaceLoadError && <div className="alert alert-error" role="alert">{workplaceLoadError}</div>}
          {workplaceLoading && !workplaceResults ? (
            <LoadingState />
          ) : workplacePagination?.total === 0 && !workplaceSearch.trim() ? <EmptyState title="No workplaces registered" /> : workplaceRows.length === 0 ? (
            <EmptyState title="No workplaces match your search" />
          ) : (
            <div className="workplace-list">
              {workplaceRows.map((workplace) => (
                <div className="workplace-row" key={workplace.id}>
                  <span className="row-icon row-icon-yellow"><MapPin size={18} /></span>
                  <div className="summary-copy"><strong>{workplace.name}</strong><small>{workplace.company_name} · {workplace.suburb}</small></div>
                  <span className={`status ${workplace.is_active ? 'status-active' : 'status-inactive'}`}>{workplace.is_active ? 'Active' : 'Inactive'}</span>
                </div>
              ))}
            </div>
          )}
          {workplacePagination && workplacePagination.total > 0 && (
            <div className="application-pagination">
              <span>Showing {((workplacePagination.page - 1) * workplacePagination.page_size + 1).toLocaleString()}–{Math.min(workplacePagination.page * workplacePagination.page_size, workplacePagination.total).toLocaleString()} of {workplacePagination.total.toLocaleString()}</span>
              {workplacePagination.total_pages > 1 && (
                <div>
                  <button
                    aria-label="Previous workplace page"
                    className="icon-button"
                    disabled={workplacePagination.page <= 1 || workplaceLoading}
                    onClick={() => setWorkplacePage((page) => page - 1)}
                    type="button"
                  ><ChevronLeft size={17} /></button>
                  <span>Page {workplacePagination.page.toLocaleString()} of {workplacePagination.total_pages.toLocaleString()}</span>
                  <button
                    aria-label="Next workplace page"
                    className="icon-button"
                    disabled={workplacePagination.page >= workplacePagination.total_pages || workplaceLoading}
                    onClick={() => setWorkplacePage((page) => page + 1)}
                    type="button"
                  ><ChevronRight size={17} /></button>
                </div>
              )}
            </div>
          )}
        </section>
        <div className="form-stack" hidden={!companyFormOpen && !workplaceFormOpen} id="workplace-forms">
          <section className="content-section form-section" hidden={!companyFormOpen}>
            <SectionHeader title="Add company" />
            <form className="operation-form" onSubmit={(event) => void createCompany(event)}>
              <label className="field"><span>Company name</span><input maxLength={120} onChange={(event) => setCompanyName(event.target.value)} required value={companyName} /></label>
              <button className="button button-primary" disabled={saving} type="submit"><Plus size={17} /> Add company</button>
            </form>
          </section>
          <section className="content-section form-section" hidden={!workplaceFormOpen}>
            <SectionHeader title="Add workplace" />
            <form className="operation-form" onSubmit={(event) => void createWorkplace(event)}>
              <label className="field"><span>Company</span>
                <select onChange={(event) => setCompanyId(event.target.value)} required value={companyId}>
                  <option value="">Select company</option>
                  {data.companies.filter((company) => company.is_active).map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Workplace name</span><input maxLength={120} onChange={(event) => setWorkplaceName(event.target.value)} required value={workplaceName} /></label>
              <label className="field"><span>Address</span><input maxLength={300} onChange={(event) => setAddress(event.target.value)} required value={address} /></label>
              <label className="field"><span>Suburb</span><input maxLength={120} onChange={(event) => setSuburb(event.target.value)} required value={suburb} /></label>
              <button className="button button-primary" disabled={saving || data.companies.filter((company) => company.is_active).length === 0} type="submit"><Plus size={17} /> Add workplace</button>
            </form>
          </section>
        </div>
      </div>
    </>
  );
}

function Trips({ onChanged, openTripId, onTripOpened }: {
  onChanged: () => void;
  openTripId: string | null;
  onTripOpened: () => void;
}) {
  return <TripPlanner onChanged={onChanged} openTripId={openTripId} onTripOpened={onTripOpened} />;
}

function PageHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="page-heading"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1></div>;
}

function SectionHeader({ title, count, action, onAction }: { title: string; count?: number; action?: string; onAction?: () => void }) {
  return (
    <div className="section-header">
      <h2>{title}{count !== undefined && <span className="section-count">{count}</span>}</h2>
      {action && onAction && <button className="text-action" onClick={onAction} type="button">{action}<ArrowRight size={15} /></button>}
    </div>
  );
}

function Metric({ label, value, detail, icon }: { label: string; value: number; detail: string; icon: React.ReactNode }) {
  return (
    <div className="metric">
      <div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div>
      <strong className="metric-value">{value}</strong>
      <span className="metric-detail">{detail}</span>
    </div>
  );
}

function EmptyState({ title }: { title: string }) {
  return <div className="empty-state"><span className="empty-mark"><ClipboardCheck size={19} /></span><p>{title}</p></div>;
}

function LoadingState() {
  return <div className="loading-state"><LoaderCircle className="spin" size={22} /><span>Loading operations</span></div>;
}

function UsersIcon() {
  return <span className="people-icon"><span /><span /></span>;
}

function directionName(direction: RideRequest['direction'] | Trip['direction']): string {
  return direction === 'to_work' ? 'To work' : 'Home';
}

export default App;
