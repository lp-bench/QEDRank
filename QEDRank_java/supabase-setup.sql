-- Supabase Database Setup for QEDengine Feedback System
-- Run this SQL in your Supabase SQL Editor to create the feedback table

CREATE TABLE IF NOT EXISTS feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  math_problem TEXT NOT NULL,
  results JSONB NOT NULL,
  feedback JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_math_problem ON feedback USING gin(to_tsvector('english', math_problem));

-- Enable Row Level Security (RLS)
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Create policy to allow anyone to insert feedback (for public collection)
CREATE POLICY "Allow public feedback insertion" ON feedback
FOR INSERT WITH CHECK (true);

-- Create policy to allow reading feedback (for analysis)
CREATE POLICY "Allow feedback reading" ON feedback
FOR SELECT USING (true);

-- Create function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to automatically update updated_at
DROP TRIGGER IF EXISTS update_feedback_updated_at ON feedback;
CREATE TRIGGER update_feedback_updated_at
    BEFORE UPDATE ON feedback
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Optional: Create a view for easier analysis
CREATE OR REPLACE VIEW feedback_analysis AS
SELECT 
  id,
  math_problem,
  created_at,
  feedback->>'gemini' AS gemini_rating,
  feedback->>'openai' AS openai_rating,
  feedback->>'anthropic' AS anthropic_rating,
  feedback->>'cohere' AS cohere_rating,
  feedback->>'mistral' AS mistral_rating,
  results
FROM feedback
ORDER BY created_at DESC;