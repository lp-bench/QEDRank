// Vercel Serverless Function - Backend Bridge for LLMs
// This runs on the server, keeping your API keys hidden from the user

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
    const { mathProblem } = req.body;

    if (!mathProblem || typeof mathProblem !== 'string') {
      res.status(400).json({ error: 'Invalid input: mathProblem is required' });
      return;
    }

    // Call multiple LLMs in parallel
    const results = await Promise.allSettled([
      callGemini(mathProblem),
      callOpenAI(mathProblem),
      callAnthropic(mathProblem),
      callCohere(mathProblem),
      callMistral(mathProblem)
    ]);

    // Process results
    const processedResults = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return {
          leanCode: result.value.leanCode || 'Error generating code',
          model: result.value.model,
          success: true
        };
      } else {
        return {
          leanCode: `Error: ${result.reason.message || 'Failed to generate code'}`,
          model: ['Gemini', 'OpenAI', 'Anthropic', 'Cohere', 'Mistral'][index],
          success: false
        };
      }
    });

    res.status(200).json({ 
      results: processedResults,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

// Gemini API Call
async function callGemini(mathProblem) {
  const API_KEY = process.env.GEMINI_API_KEY;
  
  if (!API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const prompt = `Convert this mathematical problem to Lean4 code. Return ONLY the Lean4 code, no explanations or additional text:

${mathProblem}

Lean4 code:`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: prompt
        }]
      }],
      generationConfig: {
        temperature: 0.3,
        topK: 32,
        topP: 1,
        maxOutputTokens: 2048,
        stopSequences: []
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  const leanCode = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No code generated';

  return {
    leanCode: leanCode.trim(),
    model: 'Gemini 1.5 Pro'
  };
}

// OpenAI API Call
async function callOpenAI(mathProblem) {
  const API_KEY = process.env.OPENAI_API_KEY;
  
  if (!API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const prompt = `Convert this mathematical problem to Lean4 code. Return ONLY the Lean4 code, no explanations or additional text:

${mathProblem}

Lean4 code:`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 2048
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const leanCode = data.choices?.[0]?.message?.content || 'No code generated';

  return {
    leanCode: leanCode.trim(),
    model: 'GPT-4'
  };
}

// Anthropic API Call
async function callAnthropic(mathProblem) {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  
  if (!API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const prompt = `\n\nHuman: Convert this mathematical problem to Lean4 code. Return ONLY the Lean4 code, no explanations or additional text:

${mathProblem}

Lean4 code:

\n\nAssistant:`;

  const response = await fetch('https://api.anthropic.com/v1/complete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-sonnet-20240229',
      prompt: prompt,
      max_tokens_to_sample: 2048,
      temperature: 0.3,
      stop_sequences: ["\n\nHuman:"]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  const leanCode = data.completion || 'No code generated';

  return {
    leanCode: leanCode.trim(),
    model: 'Claude 3 Sonnet'
  };
}

// Cohere API Call
async function callCohere(mathProblem) {
  const API_KEY = process.env.COHERE_API_KEY;
  
  if (!API_KEY) {
    throw new Error('COHERE_API_KEY not configured');
  }

  const prompt = `Convert this mathematical problem to Lean4 code. Return ONLY the Lean4 code, no explanations or additional text:

${mathProblem}

Lean4 code:`;

  const response = await fetch('https://api.cohere.ai/v1/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: 'command-r-plus',
      prompt: prompt,
      max_tokens: 2048,
      temperature: 0.3,
      k: 0,
      p: 0.75,
      frequency_penalty: 0,
      presence_penalty: 0,
      stop_sequences: [],
      return_likelihoods: 'NONE'
    })
  });

  if (!response.ok) {
    throw new Error(`Cohere API error: ${response.status}`);
  }

  const data = await response.json();
  const leanCode = data.generations?.[0]?.text || 'No code generated';

  return {
    leanCode: leanCode.trim(),
    model: 'Command R+'
  };
}

// Mistral API Call
async function callMistral(mathProblem) {
  const API_KEY = process.env.MISTRAL_API_KEY;
  
  if (!API_KEY) {
    throw new Error('MISTRAL_API_KEY not configured');
  }

  const prompt = `Convert this mathematical problem to Lean4 code. Return ONLY the Lean4 code, no explanations or additional text:

${mathProblem}

Lean4 code:`;

  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: 'mistral-large-latest',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 2048
    })
  });

  if (!response.ok) {
    throw new Error(`Mistral API error: ${response.status}`);
  }

  const data = await response.json();
  const leanCode = data.choices?.[0]?.message?.content || 'No code generated';

  return {
    leanCode: leanCode.trim(),
    model: 'Mistral Large'
  };
}