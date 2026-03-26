require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const { status, passengerId, includeAll } = req.query;

      let query = supabase
        .from('ride_requests')
        .select('*')
        .order('created_at', { ascending: false });

      if (includeAll === 'true') {
        // Return all rides
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
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};