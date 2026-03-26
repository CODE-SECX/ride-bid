require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async function handler(req, res) {
  const { method, url } = req;
  const pathParts = url.split('/').filter(Boolean);
  
  // POST /api/rides - Create ride
  if (method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'rides' && pathParts.length === 2) {
    try {
      const { passengerId, passengerName, passengerPhone, pickupLocation, dropoffLocation, offeredFare } = req.body;
      
      if (!passengerName || !passengerPhone || !pickupLocation || !dropoffLocation || !offeredFare) {
        return res.status(400).json({ error: 'All fields are required' });
      }

      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('ride_requests')
        .insert([{
          passenger_id: passengerId,
          passenger_name: passengerName,
          passenger_phone: passengerPhone,
          pickup_location: pickupLocation,
          dropoff_location: dropoffLocation,
          offered_fare: offeredFare,
          status: 'pending',
          expires_at: expiresAt
        }])
        .select()
        .single();

      if (error) throw error;
      res.status(201).json({ ride: data });
    } catch (err) {
      console.error('Error creating ride:', err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // GET /api/rides - Get all rides
  if (method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'rides' && pathParts.length === 2) {
    try {
      const { status, passengerId, includeAll } = req.query;

      let query = supabase
        .from('ride_requests')
        .select('*')
        .order('created_at', { ascending: false });

      if (includeAll === 'true') {
        // all rides
      } else if (status === 'pending' || status === 'countered') {
        query = query.in('status', ['pending', 'countered']).gt('expires_at', new Date().toISOString());
      } else if (passengerId) {
        query = query.eq('passenger_id', passengerId);
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
    return;
  }

  // POST /api/rides/:id/counter
  if (method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'rides' && pathParts[3] === 'counter') {
    try {
      const id = pathParts[2];
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

      if (error) throw error;

      res.json({ ride: data });
    } catch (err) {
      console.error('Error counter:', err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // POST /api/rides/:id/accept
  if (method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'rides' && pathParts[3] === 'accept') {
    try {
      const id = pathParts[2];
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

      if (error) throw error;

      res.json({ ride: data });
    } catch (err) {
      console.error('Error accept:', err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // POST /api/rides/:id/reject
  if (method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'rides' && pathParts[3] === 'reject') {
    try {
      const id = pathParts[2];
      const { driverId } = req.body;

      const { data: ride } = await supabase
        .from('ride_requests')
        .select('*')
        .eq('id', id)
        .single();

      if (!ride) {
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
        res.json({ ride: data });
        return;
      }

      const { data, error } = await supabase
        .from('ride_requests')
        .update({ status: 'rejected' })
        .eq('id', id)
        .eq('status', 'pending')
        .select()
        .single();

      if (error) throw error;
      res.json({ ride: data });
    } catch (err) {
      console.error('Error reject:', err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // POST /api/rides/:id/complete
  if (method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'rides' && pathParts[3] === 'complete') {
    try {
      const id = pathParts[2];
      const { driverId } = req.body;

      const { data, error } = await supabase
        .from('ride_requests')
        .update({ status: 'completed' })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;

      res.json({ ride: data });
    } catch (err) {
      console.error('Error complete:', err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // POST /api/rides/:id/accept-counter
  if (method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'rides' && pathParts[3] === 'accept-counter') {
    try {
      const id = pathParts[2];

      const { data: ride } = await supabase
        .from('ride_requests')
        .select('counter_fare')
        .eq('id', id)
        .single();

      if (!ride) {
        return res.status(404).json({ error: 'Ride not found' });
      }

      const { data, error } = await supabase
        .from('ride_requests')
        .update({ status: 'confirmed', offered_fare: ride.counter_fare })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      res.json({ ride: data });
    } catch (err) {
      console.error('Error accept-counter:', err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // POST /api/rides/:id/decline-counter
  if (method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'rides' && pathParts[3] === 'decline-counter') {
    try {
      const id = pathParts[2];

      const { data, error } = await supabase
        .from('ride_requests')
        .update({ status: 'rejected', counter_fare: null, countered_by: null })
        .eq('id', id)
        .eq('status', 'countered')
        .select()
        .single();

      if (error) throw error;
      res.json({ ride: data });
    } catch (err) {
      console.error('Error decline-counter:', err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};