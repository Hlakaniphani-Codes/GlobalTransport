# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: layout.spec.ts >> login at 320px
- Location: e2e\layout.spec.ts:226:9

# Error details

```
Error: login has no detectable controls

expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0
```

# Test source

```ts
  101 |     scheduled_at: testTripStart, starts_at: testTripStart, completed_at: null,
  102 |     workplace_name: 'Office', workplace_address: '2 Work Road', distance_km: 8,
  103 |     status: 'accepted', phase: 'scheduled', delay_minutes: 0,
  104 |     driver_first_name: 'Driver', driver_contact_number: null,
  105 |     vehicle_make: 'Toyota', vehicle_colour: 'Blue', vehicle_plate: 'ABC 123 GP',
  106 |     own_stops: [
  107 |       { id: 'pickup-1', sequence: 1, stop_type: 'pickup', address: '1 Main Road', suburb: 'Rosebank', planned_at: testTripStart, status: 'pending' },
  108 |       { id: 'dropoff-1', sequence: 2, stop_type: 'dropoff', address: '2 Work Road', suburb: 'Rosebank', planned_at: testTripEnd, status: 'pending' },
  109 |     ],
  110 |     passengers_picked_up: 0, passengers_dropped_off: 0, no_shows: 0, exceptions: 0,
  111 |     has_rated: true, has_issues: false,
  112 |   };
  113 | }
  114 | 
  115 | function mockApi(page: Page, role: ScreenCase['role'], state: ScreenCase['state']) {
  116 |   return page.route('**/api/v1/**', async (route: Route) => {
  117 |     const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, '');
  118 |     const user = {
  119 |       id: `${role ?? 'guest'}-user`,
  120 |       role: role ?? 'passenger',
  121 |       email: 'layout@example.test',
  122 |       name: 'Sample',
  123 |       surname: 'User',
  124 |       contact_number: '+27123456789',
  125 |       status: 'approved',
  126 |     };
  127 |     let data: unknown = {};
  128 |     if (path === '/auth/me') data = { user };
  129 |     else if (path === '/notifications') data = { notifications: [], unread_count: 0, next_cursor: null };
  130 |     else if (path === '/me/notification-preferences') data = { preferences: { push_enabled: true, sms_enabled: true } };
  131 |     else if (path === '/driver/home') {
  132 |       data = {
  133 |         greeting_name: 'Sample', driver_status: 'approved', is_available: true, can_go_online: true,
  134 |         expired_documents: [], upcoming_trip_count: 1, upcoming_count: 1,
  135 |         pending_offer_count: 0, pending_offers: 0, attention: [],
  136 |         next_trip: {
  137 |           id: 'trip-1', direction: 'to_work', scheduled_at: testTripStart, starts_at: testTripStart,
  138 |           ends_at: testTripEnd, workplace_name: 'Office', workplace_address: '2 Work Road',
  139 |           distance_km: 8, status: 'accepted', passenger_count: 1,
  140 |         },
  141 |       };
  142 |     } else if (path === '/driver/trips') {
  143 |       data = { trips: [driverTrip('accepted')], pagination: { page: 1, page_size: 25, total: 1, total_pages: 1 } };
  144 |     } else if (path === '/driver/trips/trip-1') data = { trip: driverTrip(state) };
  145 |     else if (path === '/driver/offers') data = { offers: [] };
  146 |     else if (path === '/rides/trips') data = { trips: [passengerTrip()] };
  147 |     else if (path === '/rides/trips/passenger-trip-1') data = { trip: passengerTrip() };
  148 |     else if (path === '/ride-requests') data = { ride_requests: [] };
  149 |     else if (path === '/vehicles' || path === '/driver/vehicles') data = { vehicles: [] };
  150 |     return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  151 |   });
  152 | }
  153 | 
  154 | async function seedSession(page: Page, role: ScreenCase['role']) {
  155 |   if (!role) return;
  156 |   await page.addInitScript(() => {
  157 |     sessionStorage.setItem('global_ride_auth_token', 'layout-test-token');
  158 |   });
  159 | }
  160 | 
  161 | async function assertLayout(page: Page, width: number, name: string) {
  162 |   const measurements = await page.evaluate(() => {
  163 |     const visible = (element: Element) => {
  164 |       const rect = element.getBoundingClientRect();
  165 |       const style = getComputedStyle(element);
  166 |       return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  167 |     };
  168 |     const interactive = [...document.querySelectorAll(
  169 |       'button, [role="button"], [role="tab"], [role="checkbox"], input, textarea, select'
  170 |     )].filter(visible).map((element) => {
  171 |       const rect = element.getBoundingClientRect();
  172 |       const style = getComputedStyle(element);
  173 |       const label = (element.textContent ?? element.getAttribute('aria-label') ?? '').trim();
  174 |       const textNodes: Node[] = [];
  175 |       const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  176 |       while (walker.nextNode()) {
  177 |         if (walker.currentNode.textContent?.trim()) textNodes.push(walker.currentNode);
  178 |       }
  179 |       const lineTops = textNodes.flatMap((node) => {
  180 |         const range = document.createRange();
  181 |         range.selectNodeContents(node);
  182 |         return [...range.getClientRects()].map((line) => Math.round(line.top));
  183 |       });
  184 |       return {
  185 |         label,
  186 |         x: rect.x,
  187 |         y: rect.y,
  188 |         width: rect.width,
  189 |         height: rect.height,
  190 |         lineHeight: Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2,
  191 |         lineTops: [...new Set(lineTops)],
  192 |       };
  193 |     });
  194 |     return {
  195 |       viewportWidth: window.innerWidth,
  196 |       documentWidth: document.documentElement.scrollWidth,
  197 |       interactive,
  198 |     };
  199 |   });
  200 |   expect(measurements.documentWidth, `${name} has horizontal scrolling at ${width}px`).toBeLessThanOrEqual(width);
> 201 |   expect(measurements.interactive.length, `${name} has no detectable controls`).toBeGreaterThan(0);
      |                                                                                 ^ Error: login has no detectable controls
  202 | 
  203 |   for (const control of measurements.interactive) {
  204 |     expect(control.height, `${name} control is shorter than 44px: ${control.label}`).toBeGreaterThanOrEqual(44);
  205 |     expect(control.width, `${name} control is narrower than 44px: ${control.label}`).toBeGreaterThanOrEqual(44);
  206 |     if (control.label.length > 0 && control.label.length < 64) {
  207 |       expect(control.lineTops.length, `${name} control wraps: ${control.label}`).toBeLessThanOrEqual(1);
  208 |     }
  209 |   }
  210 |   for (let index = 0; index < measurements.interactive.length; index += 1) {
  211 |     const current = measurements.interactive[index];
  212 |     for (const next of measurements.interactive.slice(index + 1)) {
  213 |       const horizontalOverlap = Math.min(current.x + current.width, next.x + next.width) - Math.max(current.x, next.x);
  214 |       const verticalOverlap = Math.min(current.y + current.height, next.y + next.height) - Math.max(current.y, next.y);
  215 |       expect(
  216 |         horizontalOverlap <= 1 || verticalOverlap <= 1,
  217 |         `${name} controls overlap: ${current.label} / ${next.label}`
  218 |       ).toBeTruthy();
  219 |     }
  220 |   }
  221 | }
  222 | 
  223 | test.describe.configure({ mode: 'serial' });
  224 | for (const screen of screens) {
  225 |   for (const width of widths) {
  226 |     test(`${screen.name} at ${width}px`, async ({ page }, testInfo) => {
  227 |       await page.setViewportSize({ width, height: 900 });
  228 |       await seedSession(page, screen.role);
  229 |       await mockApi(page, screen.role, screen.state);
  230 |       await page.goto(screen.path, { waitUntil: 'domcontentloaded' });
  231 |       await page.waitForLoadState('networkidle');
  232 |       await page.evaluate(() => document.fonts.ready);
  233 | 
  234 |       if (screen.signupStep === 'step-2') {
  235 |         await page.getByText('Contact', { exact: true }).scrollIntoViewIfNeeded();
  236 |       }
  237 |       if (screen.expandDriverHome) {
  238 |         await page.getByText('Next trip', { exact: true }).click();
  239 |         await page.getByText('Upcoming trips', { exact: true }).click();
  240 |         await page.waitForTimeout(100);
  241 |       }
  242 | 
  243 |       if (screen.name.includes('signup')) {
  244 |         const name = page.getByText('Name', { exact: true }).first();
  245 |         const surname = page.getByText('Surname', { exact: true }).first();
  246 |         const nameBox = await name.boundingBox();
  247 |         const surnameBox = await surname.boundingBox();
  248 |         expect(nameBox).not.toBeNull();
  249 |         expect(surnameBox).not.toBeNull();
  250 |         expect(surnameBox!.y).toBeGreaterThan(nameBox!.y);
  251 |       }
  252 | 
  253 |       await assertLayout(page, width, screen.name);
  254 |       const suffix = screen.signupStep === 'step-2' ? '-viewport' : '';
  255 |       await page.screenshot({
  256 |         path: testInfo.outputPath(`${screen.name}${suffix}-${width}.png`),
  257 |         fullPage: screen.signupStep !== 'step-2',
  258 |         animations: 'disabled',
  259 |       });
  260 |     });
  261 |   }
  262 | }
  263 | 
```