# QEDengine - Proof Verification Tool

An AI-powered web application that converts mathematical problems to Lean4 code using multiple LLMs, with user feedback collection for model improvement.

## Features

- **Multi-Model AI Integration**: Gemini, GPT-4, Claude 3, Command R+, and Mistral Large
- **Lean4 Code Generation**: Converts mathematical problems to formal proof code
- **User Feedback System**: 1-5 star rating system for each model's output
- **Secure Backend**: Hidden API keys using Vercel serverless functions
- **Responsive Design**: Works on desktop and mobile devices
- **Preference Dataset Collection**: Human-in-the-Loop feedback for model training

## Architecture

```
/proof-checker
├── /api
│   ├── verify.js      # Backend bridge for LLMs (serverless)
│   └── feedback.js    # Feedback collection and storage
├── /src
│   ├── App.jsx        # Main React frontend
│   ├── main.jsx       # Application entry point
│   ├── index.css      # Global styles
│   └── App.css        # Component styles
├── .env.example       # Environment variables template
└── package.json       # Dependencies and scripts
```

## Local Development

### Prerequisites

- Node.js (version 18 or higher)
- npm or yarn

### Setup

1. **Clone and Install Dependencies**
   ```bash
   git clone <your-repo-url>
   cd proof-checker
   npm install
   ```

2. **Environment Configuration**
   ```bash
   cp .env.example .env.local
   ```
   
   Edit `.env.local` and add your API keys:
   - `GEMINI_API_KEY` - Google Gemini API key
   - `OPENAI_API_KEY` - OpenAI API key
   - `ANTHROPIC_API_KEY` - Anthropic Claude API key
   - `COHERE_API_KEY` - Cohere API key
   - `MISTRAL_API_KEY` - Mistral AI API key

3. **Optional: Feedback Storage Setup**
   - **Supabase**: Add `SUPABASE_URL` and `SUPABASE_ANON_KEY`
   - **EmailJS**: Add `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, and `EMAILJS_PUBLIC_KEY`

4. **Run Development Server**
   ```bash
   npm run dev
   ```
   
   Open [http://localhost:3000](http://localhost:3000) in your browser.

## Deployment to Vercel

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "initial commit"
git remote add origin <YOUR_GITHUB_URL>
git push -u origin main
```

### 2. Connect to Vercel
1. Go to [Vercel.com](https://vercel.com) and sign up with GitHub
2. Click "Add New Project" and select your proof-checker repository
3. **CRITICAL**: Before clicking "Deploy", configure Environment Variables:
   - Add all your API keys from `.env.local`
   - Add any feedback storage credentials (Supabase/EmailJS)

4. Click "Deploy"

Your site will be live at `https://your-project.vercel.app`

### 3. GitHub Pages Integration (Optional)

**Option A: Redirect**
Add a link to your GitHub Pages site: "Check out my Proof Verification Tool"

**Option B: Embed**
Use this HTML in your GitHub Pages `index.html`:
```html
<iframe src="https://your-project.vercel.app" width="100%" height="800px"></iframe>
```

## API Endpoints

### POST /api/verify
Converts mathematical problems to Lean4 code.

**Request:**
```json
{
  "mathProblem": "Prove that the square root of 2 is irrational"
}
```

**Response:**
```json
{
  "results": [
    {
      "leanCode": "theorem sqrt_two_irrational : irrational (sqrt 2) := ...",
      "model": "Gemini 1.5 Pro",
      "success": true
    }
  ],
  "timestamp": "2024-03-14T12:00:00.000Z"
}
```

### POST /api/feedback
Submits user feedback for model outputs.

**Request:**
```json
{
  "mathProblem": "Prove that the square root of 2 is irrational",
  "results": [...],
  "feedback": {
    "gemini": 5,
    "openai": 4,
    "anthropic": 3
  }
}
```

## Feedback System

### Storage Options

1. **Supabase (Recommended)**
   - Automatic database storage
   - Real-time data access
   - Easy querying and analysis

2. **EmailJS**
   - Email notifications
   - Simple setup
   - No database required

### Data Collection

The feedback system collects:
- Mathematical problem input
- Generated Lean4 code from each model
- User ratings (1-5 stars)
- Timestamp and metadata

This creates a preference dataset for training reward models (RLHF).

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:
- Create a GitHub issue
- Check the Vercel deployment logs
- Verify your API keys are correctly configured

## Technical Details

### CORS Handling
All API endpoints include proper CORS headers for cross-origin requests.

### Error Handling
- Graceful degradation if individual LLMs fail
- User-friendly error messages
- Comprehensive logging for debugging

### Security
- API keys stored as environment variables
- No client-side exposure of sensitive credentials
- Input validation and sanitization

### Performance
- Parallel LLM requests for optimal speed
- Efficient error handling with Promise.allSettled
- Minimal client-side processing

## Human-in-the-Loop (HITL) System

This application implements a HITL system by:
1. Presenting multiple AI-generated solutions
2. Collecting user preference data
3. Storing feedback for model improvement
4. Creating training datasets for RLHF

The collected preference data helps train better reward models, improving AI alignment and output quality.