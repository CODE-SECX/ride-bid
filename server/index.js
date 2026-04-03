require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'ridenegotiate.html'));
});

// Super Admin Portal Route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin.html'));
});

// Expose Supabase config to frontend
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
});

// ─────────────────────────────────────────────
// MAPBOX — all requests go through backend so the
// secret key never touches the client.
//
// Billing model:
//   • /suggest uses Mapbox Search Box API with session_token
//     → all keystrokes in one session = 1 Search request charge
//   • /retrieve fires once per selection (1 Retrieve charge)
//   • Country biased to IN (India); change if needed.
// ─────────────────────────────────────────────

const MAPBOX_TOKEN = process.env.MAPBOX_SECRET_TOKEN; // sk.eyJ1... stored in .env
const MAPBOX_SEARCH_BASE = 'https://api.mapbox.com/search/searchbox/v1';

/**
 * GET /api/mapbox/suggest?q=...&session_token=...&proximity=lng,lat
 *
 * Proxies Mapbox Search Box "suggest" endpoint.
 * Session token must be a UUID generated client-side at the start of
 * each typing session and reused until the user selects a result.
 * This ensures the entire session (N keystrokes) is billed as 1 call.
 */
app.get('/api/mapbox/suggest', async (req, res) => {
  try {
    const { q, session_token, proximity } = req.query;

    if (!q || q.length < 2) {
      return res.json({ suggestions: [] });
    }

    if (!MAPBOX_TOKEN) {
      return res.status(503).json({ error: 'Mapbox not configured. Add MAPBOX_SECRET_TOKEN to .env' });
    }

    const params = new URLSearchParams({
      q,
      access_token: MAPBOX_TOKEN,
      session_token: session_token || randomUUID(),
      country: 'ca',          // India — change to 'ca' for Canada, etc.
      language: 'en',
      limit: '7',
      types: 'place,district,locality,neighborhood,address,poi,street,block',
    });

    // Use user's GPS coords for proximity-biased results (Rapido/Uber style)
    if (proximity) {
      params.set('proximity', proximity);
    }

    const url = `${MAPBOX_SEARCH_BASE}/suggest?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      console.error('Mapbox suggest error:', response.status, text);
      return res.status(response.status).json({ error: 'Mapbox API error' });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Mapbox suggest proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/mapbox/retrieve/:mapbox_id?session_token=...
 *
 * Fires once when the user clicks a suggestion to get full coordinates.
 * This is the "Retrieve" call that finalises the billing session.
 */
app.get('/api/mapbox/retrieve/:mapbox_id', async (req, res) => {
  try {
    const { mapbox_id } = req.params;
    const { session_token } = req.query;

    if (!MAPBOX_TOKEN) {
      return res.status(503).json({ error: 'Mapbox not configured' });
    }

    const params = new URLSearchParams({
      access_token: MAPBOX_TOKEN,
      session_token: session_token || randomUUID(),
    });

    const url = `${MAPBOX_SEARCH_BASE}/retrieve/${encodeURIComponent(mapbox_id)}?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      console.error('Mapbox retrieve error:', response.status, text);
      return res.status(response.status).json({ error: 'Mapbox API error' });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Mapbox retrieve proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/mapbox/reverse?lng=...&lat=...
 *
 * Single reverse-geocode call used for "Use current location".
 * No session token needed for reverse geocoding.
 */
app.get('/api/mapbox/reverse', async (req, res) => {
  try {
    const { lng, lat } = req.query;

    if (!lng || !lat) {
      return res.status(400).json({ error: 'lng and lat are required' });
    }

    if (!MAPBOX_TOKEN) {
      return res.status(503).json({ error: 'Mapbox not configured' });
    }

    const params = new URLSearchParams({
      access_token: MAPBOX_TOKEN,
      language: 'en',
      limit: '1',
      types: 'address,poi,street',
    });

    const url = `${MAPBOX_SEARCH_BASE}/reverse?longitude=${lng}&latitude=${lat}&${params}`;
    const response = await fetch(url);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Reverse geocode failed' });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Mapbox reverse proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// LEGACY Mappls token endpoint kept for backwards compat
// (can be removed once fully migrated)
// ─────────────────────────────────────────────
app.get('/api/mappls-token', async (req, res) => {
  try {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.MAPPLS_CLIENT_ID,
      client_secret: process.env.MAPPLS_CLIENT_SECRET,
    });
    const response = await fetch('https://outpost.mappls.com/api/security/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) {
      return res.status(500).json({ error: 'Failed to get Mappls token' });
    }
    res.json({ access_token: data.access_token, expires_in: data.expires_in || 3600 });
  } catch (err) {
    console.error('Mappls token error:', err);
    res.status(500).json({ error: 'Token fetch failed' });
  }
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey || supabaseUrl.includes('your-project')) {
  console.log('⚠️  Please configure your .env file with valid Supabase credentials');
  console.log('   SUPABASE_URL and SUPABASE_ANON_KEY are required');
} else {
  console.log('✓ Supabase client configured');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const PORT = process.env.PORT || 3000;

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('WebSocket client connected');

  ws.on('close', () => {
    clients.delete(ws);
    console.log('WebSocket client disconnected');
  });
});

function broadcastRideUpdate(ride) {
  const message = JSON.stringify({ type: 'ride_update', data: ride });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

async function checkAndExpireRides() {
  try {
    await supabase.rpc('expire_pending_rides');
    const { data } = await supabase.from('ride_requests').select('*').in('status', ['pending', 'countered']).gt('expires_at', new Date().toISOString());
    if (data) data.forEach(ride => broadcastRideUpdate(ride));
  } catch (err) {
    console.error('Error expiring rides:', err);
  }
}

setInterval(checkAndExpireRides, 30000);

// ─────────────────────────────────────────────
// HELPER: Dual-write to ride_negotiations
// ─────────────────────────────────────────────
async function logNegotiationStep({ requestId, proposedBy, proposedById, fare, status }) {
  try {
    const { error } = await supabase
      .from('ride_negotiations')
      .insert([{
        request_id:     requestId,
        proposed_by:    proposedBy,
        proposed_by_id: proposedById || null,
        fare:           fare,
        status:         status
      }]);
    if (error) {
      console.warn('[ride_negotiations] Dual-write failed (non-fatal):', error.message);
    }
  } catch (err) {
    console.warn('[ride_negotiations] Dual-write exception (non-fatal):', err.message);
  }
}

// ─────────────────────────────────────────────
// PASSENGERS
// ─────────────────────────────────────────────

app.post('/api/passengers', async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    let { data: existing } = await supabase
      .from('passengers')
      .select('*')
      .eq('phone', phone)
      .single();

    if (existing) {
      return res.json({ passenger: existing });
    }

    const { data, error } = await supabase
      .from('passengers')
      .insert([{ name, phone }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ passenger: data });
  } catch (err) {
    console.error('Error creating passenger:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/passengers/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { data, error } = await supabase
      .from('passengers')
      .select('*')
      .eq('phone', phone)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Passenger not found' });
      }
      throw error;
    }
    res.json({ passenger: data });
  } catch (err) {
    console.error('Error getting passenger:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// DRIVERS
// ─────────────────────────────────────────────

app.post('/api/drivers/signup', async (req, res) => {
  try {
    const { name, username, password, contact_no, vehicle_info } = req.body;

    if (!name || !username || !password || !contact_no) {
      return res.status(400).json({ error: 'Name, username, password, and contact number are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const { data: existingUser } = await supabase
      .from('drivers')
      .select('id')
      .eq('username', username)
      .single();

    if (existingUser) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const { data: existingPhone } = await supabase
      .from('drivers')
      .select('id')
      .eq('contact_no', contact_no)
      .single();

    if (existingPhone) {
      return res.status(409).json({ error: 'Phone number already registered' });
    }

    const bcrypt = require('bcryptjs');
    const password_hash = await bcrypt.hash(password, 10);

    const { data, error } = await supabase
      .from('drivers')
      .insert([{ name, username, password_hash, contact_no, vehicle_info: vehicle_info || null, is_online: false }])
      .select()
      .single();

    if (error) throw error;

    const { password_hash: _, ...driverData } = data;
    res.status(201).json({ driver: driverData });
  } catch (err) {
    console.error('Error creating driver:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drivers', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const { data: driver, error } = await supabase
      .from('drivers')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !driver) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const bcrypt = require('bcryptjs');
    const validPassword = await bcrypt.compare(password, driver.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({
      driver: {
        id: driver.id,
        name: driver.name,
        contact_no: driver.contact_no,
        vehicle_info: driver.vehicle_info,
        username: driver.username
      }
    });
  } catch (err) {
    console.error('Error logging in driver:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drivers/logout', async (req, res) => {
  try {
    const { driverId } = req.body;
    await supabase.from('drivers').update({ is_online: false }).eq('id', driverId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error logging out driver:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// RIDES — list and create
// ─────────────────────────────────────────────

app.post('/api/rides', async (req, res) => {
  try {
    const { passengerId, passengerPhone, pickupLocation, dropoffLocation, pickupTime, offeredFare } = req.body;

    if (!passengerPhone || !pickupLocation || !dropoffLocation || !offeredFare) {
      return res.status(400).json({ error: 'Phone, pickup, dropoff and fare are required' });
    }

    const { data: passenger, error: passengerError } = await supabase
      .from('passengers')
      .select('id, name')
      .eq('phone', passengerPhone)
      .single();

    if (passengerError || !passenger) {
      return res.status(400).json({ error: 'Passenger not found. Please register first using your phone number.' });
    }

    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('ride_requests')
      .insert([{
        passenger_id:     passenger.id,
        passenger_name:   passenger.name,
        passenger_phone:  passengerPhone,
        pickup_location:  pickupLocation,
        dropoff_location: dropoffLocation,
        pickup_time:      pickupTime,
        offered_fare:     offeredFare,
        status:           'pending',
        expires_at:       expiresAt
      }])
      .select()
      .single();

    if (error) throw error;

    await logNegotiationStep({
      requestId:    data.id,
      proposedBy:   'passenger',
      proposedById: null,
      fare:         offeredFare,
      status:       'offered'
    });

    broadcastRideUpdate(data);
    res.status(201).json({ ride: data });
  } catch (err) {
    console.error('Error creating ride request:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rides', async (req, res) => {
  try {
    const { status, passengerId, passengerPhone } = req.query;

    let query = supabase.from('ride_requests').select('*').order('created_at', { ascending: false });

    if (passengerId) {
      query = query.eq('passenger_id', passengerId);
    } else if (passengerPhone) {
      query = query.eq('passenger_phone', passengerPhone);
    } else if (status === 'pending' || status === 'countered') {
      query = query.in('status', ['pending', 'countered']).gt('expires_at', new Date().toISOString());
    }

    const { data: rides, error } = await query;
    if (error) throw error;

    res.json({ rides: rides || [] });
  } catch (err) {
    console.error('Error fetching rides:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// HISTORY ROUTES — MUST be defined BEFORE /api/rides/:id
// ─────────────────────────────────────────────

app.get('/api/rides/history/passenger/:phone', async (req, res) => {
  try {
    const { phone } = req.params;

    const { data: passenger, error: passengerError } = await supabase
      .from('passengers')
      .select('id, name')
      .eq('phone', phone)
      .single();

    if (passengerError || !passenger) {
      return res.status(404).json({ error: 'Passenger not found' });
    }

    const { data: rides, error } = await supabase
      .from('ride_requests')
      .select('*')
      .eq('passenger_phone', phone)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ passenger, rides: rides || [] });
  } catch (err) {
    console.error('Error fetching passenger history:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rides/history/:phone', async (req, res) => {
  try {
    const { phone } = req.params;

    const { data: rides, error } = await supabase
      .from('ride_requests')
      .select('*')
      .eq('passenger_phone', phone)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ rides: rides || [] });
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// RIDE by ID
// ─────────────────────────────────────────────

app.get('/api/rides/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase.from('ride_requests').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Ride not found' });
      throw error;
    }
    res.json({ ride: data });
  } catch (err) {
    console.error('Error getting ride:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/rides/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, counterFare, counteredBy, acceptedBy } = req.body;

    const updateData = { status };
    if (counterFare) updateData.counter_fare = counterFare;
    if (counteredBy) updateData.countered_by = counteredBy;
    if (acceptedBy)  updateData.accepted_by  = acceptedBy;

    const { data, error } = await supabase
      .from('ride_requests')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    broadcastRideUpdate(data);
    res.json({ ride: data });
  } catch (err) {
    console.error('Error updating ride:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rides/:id/counter', async (req, res) => {
  try {
    const { id } = req.params;
    const { counterFare, driverId, isPassenger } = req.body;

    if (!counterFare) {
      return res.status(400).json({ error: 'Counter fare required' });
    }

    const { data: existingRide, error: fetchErr } = await supabase
      .from('ride_requests')
      .select('offered_fare, counter_fare, countered_by, passenger_countered')
      .eq('id', id)
      .single();

    if (fetchErr || !existingRide) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const updateData = {
      status:     'countered',
      counter_fare: counterFare,
      expires_at:   expiresAt
    };

    if (isPassenger) {
      updateData.countered_by        = null;
      updateData.passenger_countered = true;
    } else {
      updateData.countered_by        = driverId;
      updateData.passenger_countered = false;
    }

    const { data, error } = await supabase
      .from('ride_requests')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Ride not found or already processed' });
      }
      throw error;
    }

    const proposedById = isPassenger ? null : driverId;

    await logNegotiationStep({
      requestId:    id,
      proposedBy:   isPassenger ? 'passenger' : 'driver',
      proposedById: proposedById,
      fare:         counterFare,
      status:       'countered'
    });

    if (!isPassenger && driverId) {
      const { data: driver } = await supabase
        .from('drivers')
        .select('name, contact_no, vehicle_info')
        .eq('id', driverId)
        .single();
      data.driver = driver;
    }

    broadcastRideUpdate(data);
    res.json({ ride: data });
  } catch (err) {
    console.error('Error counter-offering ride:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rides/:id/accept', async (req, res) => {
  try {
    const { id } = req.params;
    const { driverId } = req.body;

    const { data, error } = await supabase
      .from('ride_requests')
      .update({ status: 'confirmed', accepted_by: driverId })
      .eq('id', id)
      .in('status', ['pending', 'countered'])
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Ride not found or already processed' });
      }
      throw error;
    }

    await logNegotiationStep({
      requestId:    id,
      proposedBy:   'driver',
      proposedById: driverId,
      fare:         data.counter_fare || data.offered_fare,
      status:       'accepted'
    });

    const { data: driver } = await supabase
      .from('drivers')
      .select('name, contact_no, vehicle_info')
      .eq('id', driverId)
      .single();

    data.driver = driver;
    broadcastRideUpdate(data);
    res.json({ ride: data });
  } catch (err) {
    console.error('Error accepting ride:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rides/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { driverId } = req.body;

    const { data: ride, error: fetchError } = await supabase
      .from('ride_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (ride.status === 'countered' && ride.countered_by === driverId) {
      const { data, error } = await supabase
        .from('ride_requests')
        .update({ status: 'pending', counter_fare: null, countered_by: null })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      broadcastRideUpdate(data);
      return res.json({ ride: data });
    }

    const { data, error } = await supabase
      .from('ride_requests')
      .update({ status: 'rejected' })
      .eq('id', id)
      .eq('status', 'pending')
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Ride not found or already processed' });
      }
      throw error;
    }

    broadcastRideUpdate(data);
    res.json({ ride: data });
  } catch (err) {
    console.error('Error rejecting ride:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rides/:id/accept-counter', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: ride, error: fetchError } = await supabase
      .from('ride_requests')
      .select('counter_fare, countered_by')
      .eq('id', id)
      .single();

    if (fetchError || !ride) {
      return res.status(404).json({ error: 'Ride not found or counter expired' });
    }

    const { data, error } = await supabase
      .from('ride_requests')
      .update({
        status:       'confirmed',
        offered_fare: ride.counter_fare,
        accepted_by:  ride.countered_by
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await logNegotiationStep({
      requestId:    id,
      proposedBy:   'passenger',
      proposedById: null,
      fare:         ride.counter_fare,
      status:       'accepted'
    });

    if (ride.countered_by) {
      const { data: driver } = await supabase
        .from('drivers')
        .select('name, contact_no, vehicle_info')
        .eq('id', ride.countered_by)
        .single();
      data.driver = driver;
    }

    broadcastRideUpdate(data);
    res.json({ ride: data });
  } catch (err) {
    console.error('Error accepting counter:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rides/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { driverId } = req.body;

    const { data, error } = await supabase.rpc('complete_ride', { p_ride_id: id });

    if (error) {
      if (error.message.includes('not found') || error.message.includes('already completed')) {
        return res.status(404).json({ error: error.message });
      }
      throw error;
    }

    broadcastRideUpdate(data[0]);
    res.json({ ride: data[0] });
  } catch (err) {
    console.error('Error completing ride:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rides/:id/decline-counter', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing } = await supabase
      .from('ride_requests')
      .select('counter_fare, offered_fare')
      .eq('id', id)
      .single();

    const { data, error } = await supabase
      .from('ride_requests')
      .update({ status: 'rejected', counter_fare: null, countered_by: null })
      .eq('id', id)
      .eq('status', 'countered')
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Ride not found or already processed' });
      }
      throw error;
    }

    await logNegotiationStep({
      requestId:    id,
      proposedBy:   'passenger',
      proposedById: null,
      fare:         existing?.counter_fare || existing?.offered_fare || 0,
      status:       'rejected'
    });

    broadcastRideUpdate(data);
    res.json({ ride: data });
  } catch (err) {
    console.error('Error declining counter:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rides/:id/negotiations', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('ride_negotiations')
      .select('*')
      .eq('request_id', id)
      .order('round', { ascending: true });

    if (error) throw error;
    res.json({ negotiations: data || [] });
  } catch (err) {
    console.error('Error fetching negotiations:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drivers/:id/history', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: driver, error: driverError } = await supabase
      .from('drivers')
      .select('id, name, username')
      .eq('id', id)
      .single();

    if (driverError || !driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    const { data: rides, error: ridesError } = await supabase
      .from('ride_requests')
      .select('*')
      .or(`accepted_by.eq.${id},countered_by.eq.${id}`)
      .order('created_at', { ascending: false });

    if (ridesError) throw ridesError;

    res.json({ driver, rides: rides || [] });
  } catch (err) {
    console.error('Error fetching driver history:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/expire-rides', async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('expire_pending_rides');
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Error expiring rides:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drivers/:id/profile', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: driver, error } = await supabase
      .from('drivers')
      .select('id, name, username, contact_no, vehicle_info')
      .eq('id', id)
      .single();
    if (error || !driver) return res.status(404).json({ error: 'Driver not found' });
    res.json({ driver });
  } catch (err) {
    console.error('Error fetching driver profile:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/drivers/:id/profile', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, contact_no, vehicle_info, password, username } = req.body;

    const updateData = {};
    if (name)         updateData.name         = name;
    if (contact_no)   updateData.contact_no   = contact_no;
    if (vehicle_info) updateData.vehicle_info = vehicle_info;
    if (username)     updateData.username     = username;
    if (password) {
      const bcrypt = require('bcryptjs');
      updateData.password_hash = await bcrypt.hash(password, 10);
    }

    const { data: driver, error } = await supabase
      .from('drivers')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const { data: updatedDriver, error: fetchError } = await supabase
      .from('drivers')
      .select('id, name, username, contact_no, vehicle_info')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;
    res.json({ driver: updatedDriver });
  } catch (err) {
    console.error('Error updating driver profile:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// SERVER BOOT
// ─────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready`);
  if (!MAPBOX_TOKEN) {
    console.log('⚠️  MAPBOX_SECRET_TOKEN not set — location autocomplete will be disabled');
    console.log('   Add MAPBOX_SECRET_TOKEN=sk.eyJ1... to your .env file');
  } else {
    console.log('✓ Mapbox configured');
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
