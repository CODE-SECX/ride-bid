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
// PASSENGERS
// ─────────────────────────────────────────────

/**
 * POST /api/passengers
 * Register or look up a passenger by phone number.
 * - If phone already exists: returns existing record (name is IGNORED — phone is the identity).
 * - If phone is new: creates a new record with the provided name.
 * FIX: previously, a new name could silently shadow an existing account.
 * Now we always return the authoritative record for that phone.
 */
app.post('/api/passengers', async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    // Check if passenger already exists for this phone
    let { data: existing } = await supabase
      .from('passengers')
      .select('*')
      .eq('phone', phone)
      .single();

    if (existing) {
      // Phone is the unique identity — return existing record regardless of supplied name
      return res.json({ passenger: existing });
    }

    // New phone — create the passenger
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
    await supabase
      .from('drivers')
      .update({ is_online: false })
      .eq('id', driverId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error logging out driver:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// RIDES
// ─────────────────────────────────────────────

/**
 * POST /api/rides
 * Create a new ride request.
 * FIX: We now look up the passenger by phone to enforce that the authoritative
 * name (from the passengers table) is always used, preventing a caller from
 * submitting a ride with an arbitrary name for an existing phone number.
 */
app.post('/api/rides', async (req, res) => {
  try {
    const {
      passengerId,
      passengerPhone,
      pickupLocation,
      dropoffLocation,
      pickupTime,
      offeredFare
    } = req.body;

    // passengerName is no longer trusted from the request body for existing passengers.
    // We resolve the canonical name from the passengers table using the phone number.
    if (!passengerPhone || !pickupLocation || !dropoffLocation || !offeredFare) {
      return res.status(400).json({ error: 'Phone, pickup, dropoff and fare are required' });
    }

    // Resolve canonical passenger record by phone
    const { data: passenger, error: passengerError } = await supabase
      .from('passengers')
      .select('id, name')
      .eq('phone', passengerPhone)
      .single();

    if (passengerError || !passenger) {
      return res.status(400).json({
        error: 'Passenger not found. Please register first using your phone number.'
      });
    }

    // Use the canonical name and id from the passengers table
    const resolvedPassengerId = passenger.id;
    const resolvedPassengerName = passenger.name;

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('ride_requests')
      .insert([{
        passenger_id: resolvedPassengerId,
        passenger_name: resolvedPassengerName,
        passenger_phone: passengerPhone,
        pickup_location: pickupLocation,
        dropoff_location: dropoffLocation,
        pickup_time: pickupTime,
        offered_fare: offeredFare,
        status: 'pending',
        expires_at: expiresAt
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

    let query = supabase
      .from('ride_requests')
      .select('*')
      .order('created_at', { ascending: false });

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
    const { data, error } = await supabase
      .from('ride_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Ride not found' });
      }
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
    if (acceptedBy) updateData.accepted_by = acceptedBy;

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
    const { counterFare, driverId } = req.body;

    if (!counterFare || !driverId) {
      return res.status(400).json({ error: 'Counter fare and driver ID required' });
    }

    const { data, error } = await supabase
      .from('ride_requests')
      .update({
        status: 'countered',
        counter_fare: counterFare,
        countered_by: driverId
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Ride not found or already processed' });
      }
      throw error;
    }

    const { data: driver } = await supabase
      .from('drivers')
      .select('name, contact_no, vehicle_info')
      .eq('id', driverId)
      .single();

    data.driver = driver;
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
      .update({
        status: 'confirmed',
        accepted_by: driverId
      })
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
        .update({
          status: 'pending',
          counter_fare: null,
          countered_by: null
        })
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
        status: 'confirmed',
        offered_fare: ride.counter_fare
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

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

    await supabase.from('ride_history').insert([{
      request_id: id,
      driver_id: driverId,
      passenger_name: data[0].passenger_name,
      pickup_location: data[0].pickup_location,
      dropoff_location: data[0].dropoff_location,
      final_fare: data[0].offered_fare
    }]);

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

    const { data, error } = await supabase
      .from('ride_requests')
      .update({
        status: 'rejected',
        counter_fare: null,
        countered_by: null
      })
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

    broadcastRideUpdate(data);
    res.json({ ride: data });
  } catch (err) {
    console.error('Error declining counter:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────────

/**
 * GET /api/rides/history/passenger/:phone
 * Full ride history for a passenger identified by phone number.
 * FIX: Was previously at /api/rides/history/:phone — kept that alias too for
 * backwards compatibility, but the preferred path is more explicit.
 * Includes ALL statuses (completed, rejected, expired, etc.) so the passenger
 * can see their complete record, not just active rides.
 */
app.get('/api/rides/history/passenger/:phone', async (req, res) => {
  try {
    const { phone } = req.params;

    // Verify the passenger exists
    const { data: passenger, error: passengerError } = await supabase
      .from('passengers')
      .select('id, name')
      .eq('phone', phone)
      .single();

    if (passengerError || !passenger) {
      return res.status(404).json({ error: 'Passenger not found' });
    }

    const { data, error } = await supabase
      .from('ride_requests')
      .select('*')
      .eq('passenger_phone', phone)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ passenger, rides: data || [] });
  } catch (err) {
    console.error('Error fetching passenger history:', err);
    res.status(500).json({ error: err.message });
  }
});

// Backwards-compatible alias
app.get('/api/rides/history/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { data, error } = await supabase
      .from('ride_requests')
      .select('*')
      .eq('passenger_phone', phone)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ rides: data || [] });
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/drivers/:id/history
 * Full ride history for a driver.
 * FIX: This endpoint was entirely missing. Drivers had no way to retrieve
 * their past rides. Now queries ride_history joined with ride_requests
 * for the full picture.
 */
app.get('/api/drivers/:id/history', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify driver exists
    const { data: driver, error: driverError } = await supabase
      .from('drivers')
      .select('id, name, username')
      .eq('id', id)
      .single();

    if (driverError || !driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    // Query ride_history for completed rides by this driver
    const { data: historyRows, error: histError } = await supabase
      .from('ride_history')
      .select('*')
      .eq('driver_id', id)
      .order('created_at', { ascending: false });

    if (histError) throw histError;

    // Also pull any confirmed/completed ride_requests accepted by this driver
    // (covers cases where ride_history insert may have failed or ride is still in-progress)
    const { data: activeRides, error: activeError } = await supabase
      .from('ride_requests')
      .select('*')
      .eq('accepted_by', id)
      .order('created_at', { ascending: false });

    if (activeError) throw activeError;

    res.json({
      driver,
      history: historyRows || [],
      rides: activeRides || []
    });
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
// SERVER BOOT
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
      
      // Build update object with only provided fields
      const updateData = {};
      if (name) updateData.name = name;
      if (contact_no) updateData.contact_no = contact_no;
      if (vehicle_info) updateData.vehicle_info = vehicle_info;
      if (password) {
        // Hash new password if provided
        const bcrypt = require('bcryptjs');
        const saltRounds = 10;
        updateData.password_hash = await bcrypt.hash(password, saltRounds);
      }
      if (username) updateData.username = username;
      
      const { data: driver, error } = await supabase
        .from('drivers')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();
      
      if (error) throw error;
      if (!driver) return res.status(404).json({ error: 'Driver not found' });
      
      // Return updated driver data (without password hash)
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

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready`);
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
