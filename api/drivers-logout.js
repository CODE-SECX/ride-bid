require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { driverId } = req.body;
      await supabase
        .from('drivers')
        .update({ is_online: false })
        .eq('id', driverId);
      res.json({ success: true });
    } catch (err) {
      console.error('Error logout:', err);
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};