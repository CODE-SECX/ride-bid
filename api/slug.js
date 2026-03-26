require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async function handler(req, res) {
  const { method } = req;
  const pathParts = req.url.split('/').filter(Boolean);
  
  const resource = pathParts[1];
  const id = pathParts[2];
  const action = pathParts[3];

  try {
    // === PASSENGERS ===
    if (resource === 'passengers') {
      if (method === 'POST') {
        const { name, phone } = req.body;
        if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

        let { data: existing } = await supabase.from('passengers').select('*').eq('phone', phone).single();
        if (existing) return res.json({ passenger: existing });

        const { data, error } = await supabase.from('passengers').insert([{ name, phone }]).select().single();
        if (error) throw error;
        return res.status(201).json({ passenger: data });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // === DRIVERS ===
    if (resource === 'drivers') {
      // POST /api/drivers - login
      if (!action && method === 'POST') {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

        const { data: driver, error } = await supabase.from('drivers').select('*').eq('username', username).single();
        if (error || !driver) return res.status(401).json({ error: 'Invalid credentials' });

        const bcrypt = require('bcryptjs');
        const validPassword = await bcrypt.compare(password, driver.password_hash);
        if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

        return res.json({ driver: { id: driver.id, name: driver.name, contact_no: driver.contact_no, vehicle_info: driver.vehicle_info, username: driver.username } });
      }

      // POST /api/drivers/logout - logout
      if (action === 'logout' && method === 'POST') {
        const { driverId } = req.body;
        await supabase.from('drivers').update({ is_online: false }).eq('id', driverId);
        return res.json({ success: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // === RIDES ===
    if (resource === 'rides') {
      // GET /api/rides - list rides
      if (method === 'GET' && !id) {
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
        return res.json({ rides: rides || [] });
      }

      // POST /api/rides - create ride
      if (method === 'POST' && !id) {
        const { passengerId, passengerName, passengerPhone, pickupLocation, dropoffLocation, offeredFare } = req.body;
        if (!passengerName || !passengerPhone || !pickupLocation || !dropoffLocation || !offeredFare) {
          return res.status(400).json({ error: 'All fields are required' });
        }

        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        const { data, error } = await supabase.from('ride_requests').insert([{
          passenger_id: passengerId, passenger_name: passengerName, passenger_phone: passengerPhone,
          pickup_location: pickupLocation, dropoff_location: dropoffLocation, offered_fare, status: 'pending', expires_at: expiresAt
        }]).select().single();

        if (error) throw error;
        return res.status(201).json({ ride: data });
      }

      // POST /api/rides/:id/counter
      if (method === 'POST' && action === 'counter') {
        const { counterFare, driverId } = req.body;
        if (!counterFare || !driverId) return res.status(400).json({ error: 'Counter fare and driver ID required' });

        const { data, error } = await supabase.from('ride_requests').update({
          status: 'countered', counter_fare: counterFare, countered_by: driverId
        }).eq('id', id).select().single();

        if (error) throw error;
        return res.json({ ride: data });
      }

      // POST /api/rides/:id/accept
      if (method === 'POST' && action === 'accept') {
        const { driverId } = req.body;
        const { data, error } = await supabase.from('ride_requests').update({
          status: 'confirmed', accepted_by: driverId
        }).eq('id', id).in('status', ['pending', 'countered']).select().single();

        if (error) throw error;
        return res.json({ ride: data });
      }

      // POST /api/rides/:id/reject
      if (method === 'POST' && action === 'reject') {
        const { driverId } = req.body;
        const { data: ride } = await supabase.from('ride_requests').select('*').eq('id', id).single();
        if (!ride) return res.status(404).json({ error: 'Ride not found' });

        if (ride.status === 'countered' && ride.countered_by === driverId) {
          const { data, error } = await supabase.from('ride_requests').update({ status: 'pending', counter_fare: null, countered_by: null }).eq('id', id).select().single();
          return res.json({ ride: data });
        }

        const { data, error } = await supabase.from('ride_requests').update({ status: 'rejected' }).eq('id', id).eq('status', 'pending').select().single();
        if (error) throw error;
        return res.json({ ride: data });
      }

      // POST /api/rides/:id/complete
      if (method === 'POST' && action === 'complete') {
        const { data, error } = await supabase.from('ride_requests').update({ status: 'completed' }).eq('id', id).select().single();
        if (error) throw error;
        return res.json({ ride: data });
      }

      // POST /api/rides/:id/accept-counter
      if (method === 'POST' && action === 'accept-counter') {
        const { data: ride } = await supabase.from('ride_requests').select('counter_fare').eq('id', id).single();
        if (!ride) return res.status(404).json({ error: 'Ride not found' });

        const { data, error } = await supabase.from('ride_requests').update({ status: 'confirmed', offered_fare: ride.counter_fare }).eq('id', id).select().single();
        if (error) throw error;
        return res.json({ ride: data });
      }

      // POST /api/rides/:id/decline-counter
      if (method === 'POST' && action === 'decline-counter') {
        const { data, error } = await supabase.from('ride_requests').update({ status: 'rejected', counter_fare: null, countered_by: null }).eq('id', id).eq('status', 'countered').select().single();
        if (error) throw error;
        return res.json({ ride: data });
      }

      return res.status(405).json({ error: 'Action not allowed' });
    }

    res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('API Error:', err);
    res.status(500).json({ error: err.message });
  }
};