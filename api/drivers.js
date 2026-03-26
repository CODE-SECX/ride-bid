require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async function handler(req, res) {
  if (req.method === 'POST') {
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
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};