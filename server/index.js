require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

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
// This is a "best-effort" write. If it fails, we log the error but do NOT
// block the main response — ride_requests remains the source of truth during
// the dual-write phase. The new table is additive and non-blocking.
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

/**
 * POST /api/passengers
 * Register or look up a passenger by phone number.
 * - If phone already exists: returns existing record (name is IGNORED — phone is the identity).
 * - If phone is new: creates a new record with the provided name.
 */
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
// RIDES
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
    } else {
      query = query.in('status', ['pending', 'countered', 'confirmed', 'completed']);
    }

    const { data: rides, error } = await query;
    if (error) throw error;

    res.json({ rides: rides || [] });
  } catch (err) {
    console.error('Error fetching rides:', err);
    res.status(500).json({ error: err.message });
  }
});

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

// ─────────────────────────────────────────────
// COUNTER — dual-write to ride_negotiations
// ─────────────────────────────────────────────
app.post('/api/rides/:id/counter', async (req, res) => {
  try {
    const { id } = req.params;
    const { counterFare, driverId, isPassenger } = req.body;

    if (!counterFare) {
      return res.status(400).json({ error: 'Counter fare required' });
    }

    // ── 1. Fetch current ride state (needed for dual-write metadata) ──
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

    // ── 2. Update ride_requests (primary source of truth) ──
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

    // ── 3. DUAL-WRITE: Insert counter step into ride_negotiations ──
    // Determine proposed_by_id: if passenger is countering back, they don't
    // have a server-side ID in the request body, so we fall back to null.
    const proposedById = isPassenger ? null : driverId;

    await logNegotiationStep({
      requestId:    id,
      proposedBy:   isPassenger ? 'passenger' : 'driver',
      proposedById: proposedById,
      fare:         counterFare,
      status:       'countered'
    });

    // ── 4. Attach driver info for frontend (unchanged) ──
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

// ─────────────────────────────────────────────
// ACCEPT — driver accepts passenger's offer
// ─────────────────────────────────────────────
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

    // ── DUAL-WRITE: log acceptance ──
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

// ─────────────────────────────────────────────
// REJECT — driver passes (server-side, used by passenger decline-counter only now)
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// ACCEPT-COUNTER — passenger accepts driver's counter
// ─────────────────────────────────────────────
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
      .update({ status: 'confirmed', offered_fare: ride.counter_fare })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // ── DUAL-WRITE: log passenger acceptance ──
    await logNegotiationStep({
      requestId:    id,
      proposedBy:   'passenger',
      proposedById: null, // passenger ID not passed in body; null is acceptable
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

// ─────────────────────────────────────────────
// COMPLETE
// ─────────────────────────────────────────────
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

    await supabase.from('ride_history').insert([{
      request_id:       id,
      driver_id:        driverId,
      passenger_name:   data[0].passenger_name,
      pickup_location:  data[0].pickup_location,
      dropoff_location: data[0].dropoff_location,
      final_fare:       data[0].offered_fare
    }]);

    broadcastRideUpdate(data[0]);
    res.json({ ride: data[0] });
  } catch (err) {
    console.error('Error completing ride:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// DECLINE-COUNTER — passenger declines driver's counter (global close)
// ─────────────────────────────────────────────
app.post('/api/rides/:id/decline-counter', async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch current fare before we null it out, for the negotiation log
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

    // ── DUAL-WRITE: log passenger rejection ──
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

// ─────────────────────────────────────────────
// NEGOTIATIONS — full history for admin portal
// ─────────────────────────────────────────────
/**
 * GET /api/rides/:id/negotiations
 * Returns every counter/accept/reject step for a given ride,
 * ordered chronologically by round number.
 * Used exclusively by the admin portal's fare timeline widget.
 */
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

// ─────────────────────────────────────────────
// HISTORY
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
    
    // Enrich with ride_history for final_fare
    const rideIds = (rides || []).map(r => r.id);
    let histMap = {};
    if (rideIds.length > 0) {
      const { data: histories } = await supabase
        .from('ride_history')
        .select('request_id, driver_id, final_fare, completed_at')
        .in('request_id', rideIds);
      (histories || []).forEach(h => { histMap[String(h.request_id)] = h; });
    }
    
    const enriched = (rides || []).map(r => {
      const hist = histMap[String(r.id)];
      if (hist) {
        return { ...r, final_fare: hist.final_fare, completed_at: hist.completed_at,
          status: r.status === 'confirmed' ? 'completed' : r.status,
          accepted_by: r.accepted_by || hist.driver_id };
      }
      return r;
    });
    
    res.json({ passenger, rides: enriched });
  } catch (err) {
    console.error('Error fetching passenger history:', err);
    res.status(500).json({ error: err.message });
  }
});

// AFTER — JOINs ride_history to get final_fare + corrects completed status
app.get('/api/rides/history/:phone', async (req, res) => {
  try {
    const { phone } = req.params;

    // Fetch all ride_requests for this phone (all statuses)
    const { data: rides, error: ridesError } = await supabase
      .from('ride_requests')
      .select('*')
      .eq('passenger_phone', phone)
      .order('created_at', { ascending: false });

    if (ridesError) throw ridesError;
    if (!rides || rides.length === 0) {
      return res.json({ rides: [] });
    }

    // Fetch matching ride_history rows in one query
    const rideIds = rides.map(r => r.id);
    const { data: histories, error: histError } = await supabase
      .from('ride_history')
      .select('request_id, driver_id, final_fare, completed_at')
      .in('request_id', rideIds);

    if (histError) {
      // Non-fatal: return rides without enrichment
      console.warn('[history] ride_history fetch failed:', histError.message);
      return res.json({ rides });
    }

    // Build lookup: request_id → history row
    const histMap = {};
    (histories || []).forEach(h => { histMap[String(h.request_id)] = h; });

    // Enrich ride_requests rows with data from ride_history
    const enriched = rides.map(r => {
      const hist = histMap[String(r.id)];
      if (hist) {
        return {
          ...r,
          // final_fare from ride_history is authoritative
          final_fare:   hist.final_fare,
          completed_at: hist.completed_at,
          // If RPC didn't flip status, we correct it here
          status:       r.status === 'confirmed' ? 'completed' : r.status,
          // Backfill accepted_by if the RPC set it on ride_history but not ride_requests
          accepted_by:  r.accepted_by || hist.driver_id,
        };
      }
      return r;
    });

    res.json({ rides: enriched });
  } catch (err) {
    console.error('Error fetching history:', err);
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

    const { data: historyRows, error: histError } = await supabase
      .from('ride_history')
      .select('*')
      .eq('driver_id', id)
      .order('created_at', { ascending: false });

    if (histError) throw histError;

    const { data: activeRides, error: activeError } = await supabase
      .from('ride_requests')
      .select('*')
      .eq('accepted_by', id)
      .order('created_at', { ascending: false });

    if (activeError) throw activeError;

    res.json({ driver, history: historyRows || [], rides: activeRides || [] });
  } catch (err) {
    console.error('Error fetching driver history:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// DRIVER PROFILE
// ─────────────────────────────────────────────

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
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
