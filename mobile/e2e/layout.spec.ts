import { expect, test, type Page, type Route } from '@playwright/test';

const widths = [320, 360, 390, 430, 768];
const testTripStart = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
const testTripEnd = new Date(Date.now() + 3 * 60 * 60_000).toISOString();

type ScreenCase = {
  name: string;
  path: string;
  role?: 'driver' | 'passenger';
  state?: 'accepted' | 'enroute' | 'arrived' | 'dropoff';
  signupStep?: 'step-1' | 'step-2';
  expandDriverHome?: boolean;
  etaCard?: boolean;
  widths?: number[];
};

const screens: ScreenCase[] = [
  { name: 'login', path: '/login' },
  { name: 'driver-signup-step-1', path: '/signup-driver', signupStep: 'step-1' },
  { name: 'driver-signup-step-2', path: '/signup-driver', signupStep: 'step-2' },
  { name: 'passenger-signup', path: '/signup-passenger' },
  { name: 'driver-home', path: '/driver', role: 'driver', expandDriverHome: true },
  { name: 'driver-offers', path: '/driver-offers', role: 'driver', widths: [320] },
  { name: 'driver-trip-accepted', path: '/driver-trip/trip-1?state=accepted', role: 'driver', state: 'accepted' },
  { name: 'driver-trip-enroute', path: '/driver-trip/trip-1?state=enroute', role: 'driver', state: 'enroute' },
  { name: 'driver-trip-eta-card', path: '/driver-trip/trip-1?state=enroute', role: 'driver', state: 'enroute', etaCard: true, widths: [320] },
  { name: 'driver-trip-arrived', path: '/driver-trip/trip-1?state=arrived', role: 'driver', state: 'arrived' },
  { name: 'driver-trip-dropoff', path: '/driver-trip/trip-1?state=dropoff', role: 'driver', state: 'dropoff' },
  { name: 'passenger-home', path: '/passenger', role: 'passenger' },
  { name: 'request-ride', path: '/passenger-request', role: 'passenger' },
  { name: 'account', path: '/account', role: 'driver' },
];

function driverTrip(state: ScreenCase['state'] = 'accepted') {
  const dropoffActive = state === 'dropoff';
  const pickupStatus = state === 'enroute' ? 'en_route' : state === 'arrived' || dropoffActive ? 'completed' : 'pending';
  const dropoffStatus = dropoffActive ? 'arrived' : 'pending';
  const pickupGroupStatus = pickupStatus === 'en_route' ? 'en_route'
    : pickupStatus === 'completed' ? 'completed' : 'pending';
  const dropoffGroupStatus = dropoffStatus === 'arrived' ? 'arrived' : 'pending';
  const currentGroupId = dropoffActive ? 'dropoff-1' : 'pickup-1';
  const stops = [
    {
      id: 'pickup-1', ride_request_id: 'request-1', sequence: 1, stop_type: 'pickup',
      address: '1 Main Road', suburb: 'Rosebank', planned_at: testTripStart,
      status: pickupStatus, arrived_at: state === 'arrived' ? new Date(Date.now() - 6 * 60_000).toISOString() : null,
      completed_at: dropoffActive ? new Date().toISOString() : null,
      passenger_name: 'Sample', passenger_surname: 'Passenger',
      contact_number: state === 'enroute' || state === 'arrived' ? '+27123456789' : null,
      allowed_actions: { no_show: state === 'arrived' },
    },
    {
      id: 'dropoff-1', ride_request_id: 'request-1', sequence: 2, stop_type: 'dropoff',
      address: '2 Work Road', suburb: 'Rosebank', planned_at: testTripEnd,
      status: dropoffStatus, arrived_at: dropoffActive ? new Date(Date.now() - 6 * 60_000).toISOString() : null,
      completed_at: null, passenger_name: 'Sample', passenger_surname: 'Passenger',
      contact_number: null, allowed_actions: { no_show: false },
    },
  ];
  return {
    id: 'trip-1', series_id: 'series-1', direction: 'to_work',
    scheduled_at: testTripStart, starts_at: testTripStart, ends_at: testTripEnd,
    workplace_name: 'Office', workplace_address: '2 Work Road', distance_km: 8,
    notes: null, status: state === 'accepted' ? 'accepted' : 'in_progress',
    started_at: state === 'accepted' ? null : new Date().toISOString(),
    completed_at: null, has_issues: false, delay_minutes: 0, delay_reported_at: null,
    closed_reason: null, closed_by: null, closed_at: null, change_ack_required: false,
    change_acknowledged_at: null, vehicle_id: 'vehicle-1', vehicle_make: 'Toyota',
    vehicle_model: 'Corolla', registration_number: 'ABC 123 GP', seat_count: 4,
    passenger_count: 1, stops,
    stop_groups: [
      {
        id: 'pickup-1', sequence: 1, stop_type: 'pickup', address: '1 Main Road',
        suburb: 'Rosebank', planned_at: testTripStart, status: pickupGroupStatus,
        eta_at: null, eta_updated_at: null, eta_is_fresh: false,
        arrived_at: state === 'arrived' ? stops[0].arrived_at : null,
        completed_at: dropoffActive ? stops[0].completed_at : null,
        stops: [stops[0]], allowed_actions: {
          arrive: state === 'enroute', complete: state === 'arrived', skip: false,
        },
      },
      {
        id: 'dropoff-1', sequence: 2, stop_type: 'dropoff', address: '2 Work Road',
        suburb: 'Rosebank', planned_at: testTripEnd, status: dropoffGroupStatus,
        eta_at: null, eta_updated_at: null, eta_is_fresh: false,
        arrived_at: dropoffActive ? stops[1].arrived_at : null,
        completed_at: null, stops: [stops[1]], allowed_actions: {
          arrive: false, complete: dropoffActive, skip: dropoffActive,
        },
      },
    ],
    current_stop_group_id: currentGroupId,
    eta_quick_options: [5, 10, 15, 20, 30, 45, 60],
    allowed_next_actions: {
      start: state === 'accepted', start_reason: null, report_not_happened: false,
      acknowledge_change: false, arrive: state === 'enroute', complete: state === 'arrived' || dropoffActive,
      skip: dropoffActive, report_no_show: state === 'arrived',
      report_dropoff_exception: dropoffActive, delay: true,
    },
    events: [],
  };
}

function passengerTrip() {
  return {
    id: 'passenger-trip-1', ride_request_id: 'request-1', direction: 'to_work',
    scheduled_at: testTripStart, starts_at: testTripStart, completed_at: null,
    workplace_name: 'Office', workplace_address: '2 Work Road', distance_km: 8,
    status: 'accepted', phase: 'scheduled', delay_minutes: 0,
    driver_first_name: 'Driver', driver_contact_number: null,
    vehicle_make: 'Toyota', vehicle_colour: 'Blue', vehicle_plate: 'ABC 123 GP',
    own_stops: [
      { id: 'pickup-1', sequence: 1, stop_type: 'pickup', address: '1 Main Road', suburb: 'Rosebank', planned_at: testTripStart, status: 'pending' },
      { id: 'dropoff-1', sequence: 2, stop_type: 'dropoff', address: '2 Work Road', suburb: 'Rosebank', planned_at: testTripEnd, status: 'pending' },
    ],
    passengers_picked_up: 0, passengers_dropped_off: 0, no_shows: 0, exceptions: 0,
    has_rated: true, has_issues: false,
  };
}

function mockApi(page: Page, role: ScreenCase['role'], state: ScreenCase['state']) {
  return page.route('**/api/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, '');
    const user = {
      id: `${role ?? 'guest'}-user`,
      role: role ?? 'passenger',
      email: 'layout@example.test',
      name: 'Sample',
      surname: 'User',
      contact_number: '+27123456789',
      status: 'approved',
    };
    let data: unknown = {};
    if (path === '/auth/me') data = { user };
    else if (path === '/notifications') data = { notifications: [], unread_count: 0, next_cursor: null };
    else if (path === '/me/notification-preferences') data = { preferences: { push_enabled: true, sms_enabled: true } };
    else if (path === '/driver/home') {
      data = {
        greeting_name: 'Sample', driver_status: 'approved', is_available: true, can_go_online: true,
        expired_documents: [], upcoming_trip_count: 1, upcoming_count: 1,
        pending_offer_count: 0, pending_offers: 0, attention: [],
        next_trip: {
          id: 'trip-1', direction: 'to_work', scheduled_at: testTripStart, starts_at: testTripStart,
          ends_at: testTripEnd, workplace_name: 'Office', workplace_address: '2 Work Road',
          distance_km: 8, status: 'accepted', passenger_count: 1,
        },
      };
    } else if (path === '/driver/trips') {
      data = { trips: [driverTrip('accepted')], pagination: { page: 1, page_size: 25, total: 1, total_pages: 1 } };
    } else if (path === '/driver/trips/trip-1') data = { trip: driverTrip(state) };
    else if (path === '/driver/offers') {
      data = {
        offers: [{
          id: 'offer-1', series_id: 'series-1', expires_at: testTripStart, window_minutes: 30,
          trips: [{
            trip_id: 'trip-1', direction: 'home', scheduled_at: testTripStart,
            starts_at: testTripStart, workplace_name: 'Office', distance_km: 8,
            passenger_count: 2, suburbs: ['Rosebank', 'Midrand'],
          }],
        }],
      };
    }
    else if (path === '/rides/trips') data = { trips: [passengerTrip()] };
    else if (path === '/rides/trips/passenger-trip-1') data = { trip: passengerTrip() };
    else if (path === '/ride-requests') data = { ride_requests: [] };
    else if (path === '/vehicles' || path === '/driver/vehicles') data = { vehicles: [] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
}

async function seedSession(page: Page, role: ScreenCase['role']) {
  if (!role) return;
  await page.addInitScript(() => {
    sessionStorage.setItem('global_ride_auth_token', 'layout-test-token');
  });
}

async function assertLayout(page: Page, width: number, name: string) {
  const measurements = await page.evaluate(() => {
    const clippedRect = (element: Element) => {
      const rect = element.getBoundingClientRect();
      let left = Math.max(0, rect.left);
      let top = Math.max(0, rect.top);
      let right = Math.min(window.innerWidth, rect.right);
      let bottom = Math.min(window.innerHeight, rect.bottom);
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const clipX = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX);
        const clipY = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY);
        if (!clipX && !clipY) continue;
        const bounds = ancestor.getBoundingClientRect();
        if (clipX) {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
        if (clipY) {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
      }
      return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    };
    const visible = (element: Element) => {
      const rect = clippedRect(element);
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const interactive = [...document.querySelectorAll(
      'button, [role="button"], [role="tab"], [role="checkbox"], [role="switch"], input, textarea, select'
    )].filter((element) => {
      const isNestedToggleInput = element instanceof HTMLInputElement
        && ['checkbox', 'radio'].includes(element.type)
        && element.closest('[role="checkbox"], [role="switch"]');
      return !isNestedToggleInput && visible(element);
    }).map((element) => {
      const rawRect = element.getBoundingClientRect();
      const rect = clippedRect(element);
      const style = getComputedStyle(element);
      const label = (element.textContent?.trim() || element.getAttribute('aria-label') || '').trim();
      const textNodes: Node[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.trim()) textNodes.push(walker.currentNode);
      }
      const textNodesLayout = textNodes.map((node) => {
        const textElement = node.parentElement!;
        const parentStyle = getComputedStyle(textElement);
        const range = document.createRange();
        range.selectNodeContents(node);
        const textHeight = range.getBoundingClientRect().height;
        const singleLine = parentStyle.whiteSpace === 'nowrap'
          || parentStyle.textOverflow === 'ellipsis'
          || parentStyle.webkitLineClamp === '1';
        return {
          text: node.textContent?.trim() ?? '',
          height: textHeight,
          lineHeight: Number.parseFloat(parentStyle.lineHeight) || Number.parseFloat(parentStyle.fontSize) * 1.2,
          singleLine,
          clipped: ['hidden', 'clip'].includes(parentStyle.overflowX)
            && textElement.scrollWidth > textElement.clientWidth + 1
            && !singleLine
            || ['hidden', 'clip'].includes(parentStyle.overflowY)
            && textElement.scrollHeight > textElement.clientHeight + 1
            && parentStyle.webkitLineClamp !== '1',
        };
      });
      return {
        label,
        tagName: element.tagName,
        role: element.getAttribute('role'),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        rawWidth: rawRect.width,
        rawHeight: rawRect.height,
        requiresSingleLine: (element.tagName === 'BUTTON'
          || element.getAttribute('role') === 'button'
          || element.getAttribute('role') === 'tab')
          && textNodes.length === 1,
        lineHeight: Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2,
        textNodesLayout,
      };
    });
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyText: document.body.innerText.slice(0, 500),
      interactive,
    };
  });
  expect(measurements.documentWidth, `${name} has horizontal scrolling at ${width}px`).toBeLessThanOrEqual(width);
  expect(measurements.interactive.length, `${name} has no detectable controls; page text: ${measurements.bodyText}`).toBeGreaterThan(0);

  for (const control of measurements.interactive) {
    const description = `${control.tagName}[role=${control.role ?? 'none'}] "${control.label}" (${control.width}x${control.height}px; raw ${control.rawWidth}x${control.rawHeight}px)`;
    expect(control.rawHeight, `${name} control is shorter than 44px: ${description}`).toBeGreaterThanOrEqual(44);
    expect(control.rawWidth, `${name} control is narrower than 44px: ${description}`).toBeGreaterThanOrEqual(44);
    if (control.requiresSingleLine) {
      expect(control.textNodesLayout[0].singleLine, `${name} button label is not constrained to one line: ${description}`).toBeTruthy();
    }
    for (const textNode of control.textNodesLayout) {
      expect(textNode.clipped, `${name} control contains clipped text "${textNode.text}": ${description}`).toBeFalsy();
    }
    for (const textNode of control.textNodesLayout.filter((node) => node.singleLine)) {
      expect(
        textNode.height,
        `${name} control renders a multi-line label "${textNode.text}": ${description}`
      ).toBeLessThanOrEqual(textNode.lineHeight * 1.6);
    }
  }
  for (let index = 0; index < measurements.interactive.length; index += 1) {
    const current = measurements.interactive[index];
    for (const next of measurements.interactive.slice(index + 1)) {
      const horizontalOverlap = Math.min(current.x + current.width, next.x + next.width) - Math.max(current.x, next.x);
      const verticalOverlap = Math.min(current.y + current.height, next.y + next.height) - Math.max(current.y, next.y);
      expect(
        horizontalOverlap <= 1 || verticalOverlap <= 1,
        `${name} controls overlap: ${current.label} (${current.x},${current.y} ${current.width}x${current.height}) / ${next.label} (${next.x},${next.y} ${next.width}x${next.height})`
      ).toBeTruthy();
    }
  }
}

test.describe.configure({ mode: 'serial' });
for (const screen of screens) {
  for (const width of screen.widths ?? widths) {
    test(`${screen.name} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await seedSession(page, screen.role);
      await mockApi(page, screen.role, screen.state);
      await page.goto(screen.path, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts.ready);
      await page.locator('button, [role="button"], [role="tab"], [role="checkbox"], [role="switch"], input, textarea')
        .first()
        .waitFor({ state: 'visible' });

      if (screen.signupStep === 'step-2') {
        await page.getByText('Contact', { exact: true }).scrollIntoViewIfNeeded();
      }
      if (screen.expandDriverHome) {
        await page.getByText('Next trip', { exact: true }).click();
        await page.getByText('Upcoming trips', { exact: true }).click();
        await page.waitForTimeout(100);
      }
      if (screen.etaCard) {
        await expect(page.getByText('How long to Rosebank?')).toBeVisible();
      }

      if (screen.name.includes('signup')) {
        const name = page.getByText('Name', { exact: true }).first();
        const surname = page.getByText('Surname', { exact: true }).first();
        const nameBox = await name.boundingBox();
        const surnameBox = await surname.boundingBox();
        expect(nameBox).not.toBeNull();
        expect(surnameBox).not.toBeNull();
        expect(surnameBox!.y).toBeGreaterThan(nameBox!.y);
      }

      await assertLayout(page, width, screen.name);
      const suffix = screen.signupStep === 'step-2' ? '-viewport' : '';
      await page.screenshot({
        path: testInfo.outputPath(`${screen.name}${suffix}-${width}.png`),
        fullPage: screen.signupStep !== 'step-2',
        animations: 'disabled',
      });
    });
  }
}

test('expired authenticated session returns to sign in', async ({ page }) => {
  let driverHomeRequested = false;
  await page.addInitScript(() => {
    sessionStorage.setItem('global_ride_auth_token', 'expired-test-token');
  });
  await page.route('**/api/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, '');
    if (path === '/auth/me') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'driver-user',
            role: 'driver',
            email: 'driver@example.test',
            name: 'Driver',
            surname: 'User',
            contact_number: '+27123456789',
            status: 'approved',
          },
        }),
      });
    }
    if (path === '/driver/home') {
      driverHomeRequested = true;
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/driver', { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByText('Authentication required.')).toHaveCount(0);
  expect(driverHomeRequested).toBeTruthy();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('global_ride_auth_token'))).toBeNull();
});

test('cancelled ride rebooking prefills details without submitting a request', async ({ page }) => {
  const requestDate = new Date(Date.now() + 2 * 60 * 60_000);
  requestDate.setUTCDate(requestDate.getUTCDate() + 2);
  const localRequestDate = requestDate.toISOString().slice(0, 10);
  let createRequests = 0;

  await page.addInitScript(() => {
    sessionStorage.setItem('global_ride_auth_token', 'passenger-test-token');
  });
  await page.route('**/api/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, '');
    if (path === '/auth/me') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'passenger-user',
            role: 'passenger',
            email: 'passenger@example.test',
            name: 'Passenger',
            surname: 'User',
            contact_number: '+27123456789',
            status: 'approved',
          },
        }),
      });
    }
    if (path === '/ride-requests' && route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ride_requests: [{
            id: 'cancelled-request',
            direction: 'to_work',
            scheduled_at: `${localRequestDate}T07:15:00+02:00`,
            status: 'cancelled',
            series_id: null,
            closed_reason: null,
            outcome_reason: null,
            request_again: {
              direction: 'to_work',
              date: localRequestDate,
              time_of_day: '07:15',
              repeat_pattern: null,
            },
            cancelled_at: new Date().toISOString(),
            cancelled_late: false,
            cancel_reason: 'Passenger cancelled ride request.',
            cancelled_by: 'passenger-user',
            booking_source: 'passenger',
            workplace_name: 'Office',
            company_name: 'Company',
          }],
        }),
      });
    }
    if (path === '/ride-requests' && route.request().method() === 'POST') {
      createRequests += 1;
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/passenger-requests', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Book this ride again' }).click();
  await expect(page.getByText('Request a ride', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Date')).toHaveValue(localRequestDate);
  await expect(page.getByLabel('Time')).toHaveValue('07:15');
  await expect(page.getByRole('radio', { name: /To work/ })).toHaveCSS('background-color', 'rgb(23, 105, 170)');
  expect(createRequests).toBe(0);
});
