require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async function handler(req, res) {
  if (req.method === 'POST') {
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
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};