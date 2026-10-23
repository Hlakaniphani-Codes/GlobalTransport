ALTER TABLE trip_offers
  DROP CONSTRAINT IF EXISTS trip_offers_trip_id_driver_user_id_key,
  DROP CONSTRAINT IF EXISTS trip_offers_trip_id_offer_order_key;
