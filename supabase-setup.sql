-- =============================================
-- Ride N Go - Supabase Database Setup
-- Run this in your Supabase SQL Editor
-- =============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================
-- PASSENGERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS passengers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for quick phone lookup
CREATE INDEX IF NOT EXISTS idx_passengers_phone ON passengers(phone);

-- =============================================
-- DRIVERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS drivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    contact_no VARCHAR(20) NOT NULL,
    vehicle_info TEXT,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_online BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for username lookup (login)
CREATE INDEX IF NOT EXISTS idx_drivers_username ON drivers(username);

-- =============================================
-- RIDE REQUESTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS ride_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    passenger_id UUID REFERENCES passengers(id) ON DELETE CASCADE,
    passenger_name VARCHAR(100) NOT NULL,
    passenger_phone VARCHAR(20) NOT NULL,
    pickup_location TEXT NOT NULL,
    dropoff_location TEXT NOT NULL,
    offered_fare DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'countered', 'accepted', 'confirmed', 'rejected', 'expired')),
    counter_fare DECIMAL(10,2),
    countered_by UUID REFERENCES drivers(id) ON DELETE SET NULL,
    accepted_by UUID REFERENCES drivers(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '10 minutes')
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_ride_requests_status ON ride_requests(status);
CREATE INDEX IF NOT EXISTS idx_ride_requests_passenger ON ride_requests(passenger_id);
CREATE INDEX IF NOT EXISTS idx_ride_requests_expires ON ride_requests(expires_at);

-- =============================================
-- RIDE HISTORY TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS ride_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID REFERENCES ride_requests(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
    passenger_name VARCHAR(100),
    pickup_location TEXT,
    dropoff_location TEXT,
    final_fare DECIMAL(10,2),
    completed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for driver history lookup
CREATE INDEX IF NOT EXISTS idx_ride_history_driver ON ride_history(driver_id);

-- =============================================
-- TRIGGER: Auto-update updated_at
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_ride_requests_updated_at
    BEFORE UPDATE ON ride_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- TRIGGER: Auto-expire old requests
-- =============================================
CREATE OR REPLACE FUNCTION expire_old_requests()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE ride_requests
    SET status = 'expired'
    WHERE status = 'pending'
    AND expires_at < NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Note: Auto-expiration is handled by the app checking expires_at field
-- (pg_cron extension not enabled by default in all Supabase tiers)

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE passengers ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_history ENABLE ROW LEVEL SECURITY;

-- Passengers: Anyone can create, read own record
CREATE POLICY "Passengers are viewable by everyone" ON passengers
    FOR SELECT USING (true);

CREATE POLICY "Passengers can be created" ON passengers
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Passengers can update own record" ON passengers
    FOR UPDATE USING (true);

-- Drivers: Anyone can create, read own record (for login lookup)
CREATE POLICY "Drivers are viewable by everyone" ON drivers
    FOR SELECT USING (true);

CREATE POLICY "Drivers can be created" ON drivers
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Drivers can update own record" ON drivers
    FOR UPDATE USING (true);

-- Ride Requests: Public read for pending, auth required for modifications
CREATE POLICY "Pending rides are viewable by everyone" ON ride_requests
    FOR SELECT USING (status = 'pending' OR status = 'countered');

CREATE POLICY "Ride requests can be created" ON ride_requests
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Ride requests can be updated" ON ride_requests
    FOR UPDATE USING (true);

-- Ride History: Public read
CREATE POLICY "Ride history is viewable by everyone" ON ride_history
    FOR SELECT USING (true);

CREATE POLICY "Ride history can be created" ON ride_history
    FOR INSERT WITH CHECK (true);

-- =============================================
-- DRIVER ACCOUNT
-- =============================================

INSERT INTO drivers (name, contact_no, vehicle_info, username, password_hash) VALUES
('Raj Sharma', '+91 98765 43210', 'Swift Dzire, White, KA01AB1234', 'driver', '$2b$10$LA/faK/WybEJfhbdDjVSOOI3d3PeiIkjHUWGHFHeIf0Pi6Md7uHES')
ON CONFLICT (username) DO NOTHING;

-- =============================================
-- HELPER FUNCTIONS
-- =============================================

-- Function to get active ride for passenger
CREATE OR REPLACE FUNCTION get_active_ride(p_passenger_id UUID)
RETURNS SETOF ride_requests AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ride_requests
    WHERE passenger_id = p_passenger_id
    AND status IN ('pending', 'countered', 'accepted', 'confirmed')
    ORDER BY created_at DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Function to get pending rides for drivers
CREATE OR REPLACE FUNCTION get_pending_rides()
RETURNS SETOF ride_requests AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM ride_requests
    WHERE status IN ('pending', 'countered')
    AND expires_at > NOW()
    ORDER BY created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- NOTES
-- =============================================
-- 1. The password_hash values above are bcrypt hashes of 'driver123'
-- 2. In production, generate new hashes with proper bcrypt
-- 3. The RLS policies allow public read/write for demo purposes
-- 4. For production, implement proper authentication via Supabase Auth
