// Vercel Serverless Function - Feedback Storage
// This handles user feedback and can store it in Supabase or send via EmailJS

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { mathProblem, results, feedback } = req.body;

    if (!mathProblem || !results || !feedback) {
      res.status(400).json({ error: 'Invalid input: missing required fields' });
      return;
    }

    // Store feedback in Supabase (if configured)
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      await storeInSupabase(mathProblem, results, feedback);
    }

    // Send feedback via EmailJS (if configured)
    if (process.env.EMAILJS_SERVICE_ID && process.env.EMAILJS_TEMPLATE_ID && process.env.EMAILJS_PUBLIC_KEY) {
      await sendEmailFeedback(mathProblem, results, feedback);
    }

    res.status(200).json({ 
      message: 'Feedback submitted successfully',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Feedback Error:', error);
    res.status(500).json({ 
      error: 'Failed to submit feedback',
      message: error.message 
    });
  }
}

// Store feedback in Supabase
async function storeInSupabase(mathProblem, results, feedback) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase not configured');
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      math_problem: mathProblem,
      results: JSON.stringify(results),
      feedback: JSON.stringify(feedback),
      created_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    throw new Error(`Supabase error: ${response.status}`);
  }

  return await response.json();
}

// Send feedback via EmailJS
async function sendEmailFeedback(mathProblem, results, feedback) {
  const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
  const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
  const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
  const EMAILJS_USER_EMAIL = process.env.EMAILJS_USER_EMAIL || 'your-email@example.com';
  
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
    throw new Error('EmailJS not configured');
  }

  const templateParams = {
    to_email: EMAILJS_USER_EMAIL,
    math_problem: mathProblem,
    results: JSON.stringify(results, null, 2),
    feedback: JSON.stringify(feedback, null, 2),
    timestamp: new Date().toISOString()
  };

  const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: templateParams
    })
  });

  if (!response.ok) {
    throw new Error(`EmailJS error: ${response.status}`);
  }

  return await response.json();
}