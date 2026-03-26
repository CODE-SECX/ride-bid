require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async function handler(req, res) {
  console.log('[API] ========== NEW REQUEST ==========');
  console.log('[API] Method:', req.method, 'URL:', req.url);
  
  // Only handle /api/ routes
  if (!req.url.startsWith('/api/')) {
    console.log('[API] Not an API request');
    return res.status(404).json({ error: 'Not found' });
  }
  
  const { method } = req;
  const pathParts = req.url.split('/').filter(Boolean);
  console.log('[API] Path parts:', pathParts);
  
  const resource = pathParts[1];
  const id = pathParts[2];
  const action = pathParts[3];

  try {
    // === PASSENGERS ===
    if (resource === 'passengers' && method === 'POST') {
      console.log('[API] Creating/getting passenger');
      const { name, phone } = req.body;
      if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

      let { data: existing } = await supabase.from('passengers').select('*').eq('phone', phone).single();
      if (existing) return res.json({ passenger: existing });

      const { data, error } = await supabase.from('passengers').insert([{ name, phone }]).select().single();
      if (error) throw error;
      return res.status(201).json({ passenger: data });
    }

    // === DRIVERS - LOGIN ===
    if (resource === 'drivers' && !action && method === 'POST') {
      console.log('[API] >>> Driver login request');
      const { username, password } = req.body;
      console.log('[API] >>> Username:', username, 'Has password:', !!password);
      
      if (!username || !password) {
        console.log('[API] >>> Missing credentials');
        return res.status(400).json({ error: 'Username and password required' });
      }

      console.log('[API] >>> Looking up driver...');
      const { data: driver, error } = await supabase.from('drivers').select('*').eq('username', username).single();
      console.log('[API] >>> Driver found:', !!driver, 'Error:', error?.message);
      
      if (error || !driver) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      console.log('[API] >>> Verifying password...');
      const bcrypt = require('bcryptjs');
      const validPassword = await bcrypt.compare(password, driver.password_hash);
      console.log('[API] >>> Password valid:', validPassword);
      
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      console.log('[API] >>> Login SUCCESS');
      return res.json({ 
        driver: { 
          id: driver.id, 
          name: driver.name, 
          contact_no: driver.contact_no, 
          vehicle_info: driver.vehicle_info, 
          username: driver.username 
        } 
      });
    }

    // === DRIVERS - LOGOUT ===
    if (resource === 'drivers' && action === 'logout' && method === 'POST') {
      const { driverId } = req.body;
      await supabase.from('drivers').update({ is_online: false }).eq('id', driverId);
      return res.json({ success: true });
    }

    // === RIDES - LIST ===
    if (resource === 'rides' && !id && method === 'GET') {
      console.log('[API] Getting rides list');
      const { passengerId, passengerPhone } = req.query;
      let query = supabase.from('ride_requests').select('*').order('created_at', { ascending: false });

      if (passengerId) {
        query = query.eq('passenger_id', passengerId);
      } else if (passengerPhone) {
        query = query.eq('passenger_phone', passengerPhone);
      } else {
        query = query.in('status', ['pending', 'countered', 'confirmed', 'completed']);
      }

      const { data: rides, error } = await query;
      if (error) throw error;
      return res.json({ rides: rides || [] });
    }

    // === RIDES - CREATE ===
    if (resource === 'rides' && !id && method === 'POST') {
      console.log('[API] Creating new ride');
      const { passengerId, passengerName, passengerPhone, pickupLocation, dropoffLocation, offeredFare } = req.body;
      if (!passengerName || !passengerPhone || !pickupLocation || !dropoffLocation || !offeredFare) {
        return res.status(400).json({ error: 'All fields are required' });
      }

      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const { data, error } = await supabase.from('ride_requests').insert([{
        passenger_id: passengerId, 
        passenger_name: passengerName, 
        passenger_phone: passengerPhone,
        pickup_location: pickupLocation, 
        dropoff_location: dropoffLocation, 
        offered_fare, 
        status: 'pending', 
        expires_at: expiresAt
      }]).select().single();

      if (error) throw error;
      return res.status(201).json({ ride: data });
    }

    // === RIDES - COUNTER ===
    if (resource === 'rides' && action === 'counter' && method === 'POST') {
      const { counterFare, driverId } = req.body;
      if (!counterFare || !driverId) return res.status(400).json({ error: 'Counter fare and driver ID required' });

      const { data, error } = await supabase.from('ride_requests').update({
        status: 'countered', 
        counter_fare: counterFare, 
        countered_by: driverId
      }).eq('id', id).select().single();

      if (error) throw error;
      return res.json({ ride: data });
    }

    // === RIDES - ACCEPT ===
    if (resource === 'rides' && action === 'accept' && method === 'POST') {
      const { driverId } = req.body;
      const { data, error } = await supabase.from('ride_requests').update({
        status: 'confirmed', 
        accepted_by: driverId
      }).eq('id', id).in('status', ['pending', 'countered']).select().single();

      if (error) throw error;
      return res.json({ ride: data });
    }

    // === RIDES - REJECT ===
    if (resource === 'rides' && action === 'reject' && method === 'POST') {
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

    // === RIDES - COMPLETE ===
    if (resource === 'rides' && action === 'complete' && method === 'POST') {
      const { data, error } = await supabase.from('ride_requests').update({ status: 'completed' }).eq('id', id).select().single();
      if (error) throw error;
      return res.json({ ride: data });
    }

    // === RIDES - ACCEPT COUNTER ===
    if (resource === 'rides' && action === 'accept-counter' && method === 'POST') {
      const { data: ride } = await supabase.from('ride_requests').select('counter_fare').eq('id', id).single();
      if (!ride) return res.status(404).json({ error: 'Ride not found' });

      const { data, error } = await supabase.from('ride_requests').update({ status: 'confirmed', offered_fare: ride.counter_fare }).eq('id', id).select().single();
      if (error) throw error;
      return res.json({ ride: data });
    }

    // === RIDES - DECLINE COUNTER ===
    if (resource === 'rides' && action === 'decline-counter' && method === 'POST') {
      const { data, error } = await supabase.from('ride_requests').update({ status: 'rejected', counter_fare: null, countered_by: null }).eq('id', id).eq('status', 'countered').select().single();
      if (error) throw error;
      return res.json({ ride: data });
    }

    console.log('[API] No route matched, returning 404');
    res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('[API] ERROR:', err);
    res.status(500).json({ error: err.message });
  }
};