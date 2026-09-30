# QEDengine Setup Guide

## Prerequisites

You need Node.js (version 18 or higher) and npm installed on your system.

### Check if Node.js is installed:
```bash
node --version
npm --version
```

If not installed, download from: https://nodejs.org/

## Quick Setup

### 1. Navigate to Project Directory
```bash
cd proof-checker
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
```bash
cp .env.example .env.local
```

Edit `.env.local` and add your API keys:
```bash
# Open in your preferred editor
code .env.local
# or
notepad .env.local
# or
vim .env.local
```

Required API keys:
- `GEMINI_API_KEY` - Get from Google AI Studio
- `OPENAI_API_KEY` - Get from OpenAI Platform
- `ANTHROPIC_API_KEY` - Get from Anthropic Console
- `COHERE_API_KEY` - Get from Cohere Console
- `MISTRAL_API_KEY` - Get from Mistral AI Console

### 4. Optional: Setup Feedback Storage

**Option A: Supabase (Recommended)**
1. Create account at https://supabase.com
2. Create new project
3. Run the SQL from `supabase-setup.sql` in SQL Editor
4. Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env.local`

**Option B: EmailJS**
1. Create account at https://emailjs.com
2. Set up email service and template
3. Add `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, and `EMAILJS_PUBLIC_KEY` to `.env.local`

### 5. Start Development Server
```bash
npm run dev
```

### 6. Open in Browser
Visit: http://localhost:3000

## Testing the Setup

Run the verification script:
```bash
node test-setup.js
```

This will check if all required files are present.

## Troubleshooting

### Common Issues:

1. **Port 3000 already in use:**
   ```bash
   npm run dev -- --port 3001
   ```

2. **Missing dependencies:**
   ```bash
   npm install
   ```

3. **Environment variables not loading:**
   - Restart your terminal
   - Ensure `.env.local` is in the root directory
   - Check that variable names match exactly

4. **API errors:**
   - Verify API keys are correct
   - Check API usage limits
   - Ensure internet connection

## Production Build

```bash
npm run build
npm run preview
```

## Deployment to Vercel

1. **Push to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git remote add origin <YOUR_GITHUB_URL>
   git push -u origin main
   ```

2. **Deploy to Vercel:**
   - Go to https://vercel.com
   - Sign up with GitHub
   - Import your repository
   - Add environment variables in Vercel dashboard
   - Click Deploy

## File Structure Reference

```
proof-checker/
├── api/           # Serverless functions
│   ├── verify.js  # Main API for LLM calls
│   └── feedback.js # Feedback collection
├── src/           # React frontend
│   ├── App.jsx    # Main component
│   ├── main.jsx   # Entry point
│   ├── index.css  # Global styles
│   └── App.css    # Component styles
├── .env.local     # Your API keys (create this)
├── package.json   # Dependencies
└── README.md      # Full documentation
```

## Getting API Keys

### Gemini API Key
1. Go to https://makersuite.google.com
2. Create project
3. Get API key from API keys section

### OpenAI API Key
1. Go to https://platform.openai.com
2. Create account
3. Get API key from API keys section

### Anthropic API Key
1. Go to https://console.anthropic.com
2. Create account
3. Get API key from API keys section

### Cohere API Key
1. Go to https://dashboard.cohere.com
2. Create account
3. Get API key from API keys section

### Mistral API Key
1. Go to https://console.mistral.ai
2. Create account
3. Get API key from API keys section

## Support

For issues:
1. Check console logs in browser
2. Verify API keys are correct
3. Check network connectivity
4. Review Vercel deployment logs (if deployed)