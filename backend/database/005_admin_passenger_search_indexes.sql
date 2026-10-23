CREATE INDEX IF NOT EXISTS users_passenger_name_search_idx
  ON users (lower(name || ' ' || surname) text_pattern_ops)
  WHERE role = 'passenger' AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS users_passenger_email_search_idx
  ON users (lower(email) text_pattern_ops)
  WHERE role = 'passenger' AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS passengers_employee_number_search_idx
  ON passengers (lower(employee_number) text_pattern_ops);

CREATE INDEX IF NOT EXISTS passengers_home_suburb_search_idx
  ON passengers (lower(home_suburb) text_pattern_ops);

CREATE INDEX IF NOT EXISTS passengers_workplace_suburb_search_idx
  ON passengers (lower(workplace_suburb) text_pattern_ops);
