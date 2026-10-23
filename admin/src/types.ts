export type AdminUser = {
  id: string;
  name: string;
  surname: string;
  email: string;
  role: 'admin';
};

export type Company = {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
};

export type Workplace = {
  id: string;
  company_id: string;
  company_name: string;
  name: string;
  address: string;
  suburb: string;
  is_active: boolean;
  created_at: string;
};

export type DriverApplication = {
  id: string;
  email: string;
  name: string;
  surname: string;
  contact_number: string;
  address: string;
  status: 'pending';
  created_at: string;
};

export type ApprovedDriver = {
  user_id: string;
  name: string;
  surname: string;
};

export type VehicleApplication = {
  id: string;
  driver_user_id: string;
  make: string;
  model: string;
  year: number;
  colour: string;
  registration_number: string;
  seat_count: number;
  status: 'pending';
  driver_name: string;
  driver_surname: string;
  driver_email: string;
  created_at: string;
};

export type FleetVehicle = {
  id: string;
  driver_user_id: string;
  make: string;
  model: string;
  year: number;
  colour: string;
  registration_number: string;
  seat_count: number;
  status: 'pending' | 'approved' | 'rejected' | 'retired';
  driver_name: string;
  driver_surname: string;
  licence_disc_expiry: string | null;
  average_rating: number | string | null;
  trip_count: number;
  trips_completed: number;
  withdrawals: number;
  late_withdrawals: number;
  missed_trips: number;
  created_at: string;
};

export type RideRequest = {
  id: string;
  passenger_user_id: string;
  direction: 'to_work' | 'home';
  scheduled_at: string;
  status: 'pending' | 'assigned' | 'completed' | 'cancelled' | 'no_show' | 'missed' | 'expired';
  series_id: string | null;
  booking_source: 'passenger' | 'admin';
  booked_by: string | null;
  booked_at: string;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  cancelled_late: boolean;
  passenger_name: string;
  passenger_surname: string;
  email: string;
  contact_number: string;
  employee_number: string;
  home_address: string;
  home_suburb: string | null;
  workplace_suburb: string | null;
  workplace_address: string | null;
  workplace_name: string;
  company_name: string;
  booked_by_name: string | null;
  booked_by_surname: string | null;
  cancelled_by_name: string | null;
  cancelled_by_surname: string | null;
};

export type Trip = {
  id: string;
  series_id: string;
  direction: 'to_work' | 'home';
  scheduled_at: string;
  starts_at: string;
  ends_at: string;
  status: 'draft' | 'offered' | 'accepted' | 'in_progress' | 'completed' | 'cancelled' | 'unassigned' | 'missed';
  workplace_name: string;
  distance_km: number | null;
  driver_name: string | null;
  driver_surname: string | null;
  registration_number: string | null;
  passenger_count: number;
};

export type Passenger = {
  id: string;
  name: string;
  surname: string;
  email: string;
  contact_number: string;
  employee_number: string | null;
  address: string;
  home_suburb: string | null;
  workplace: string | null;
  workplace_name: string | null;
  workplace_address: string | null;
  workplace_suburb: string | null;
  company_name: string | null;
};