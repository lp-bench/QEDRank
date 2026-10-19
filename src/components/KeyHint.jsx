/**
 * "Add keys (masked input)": API keys are typed at a hidden PowerShell prompt by
 * scripts/set-llm-keys.ps1 and kept in the environment (Windows user or Vercel). The page
 * never receives, shows or stores a key; it only learns from /api/models which slots have one.
 */
export default function KeyHint() {
  return (
    <details className="key-hint">
      <summary className="btn btn-secondary btn-sm">Add keys (masked input)</summary>
      <pre>{`# PowerShell, from the project folder — input is hidden
.\\scripts\\set-llm-keys.ps1 -Target User            # local CLI / runner
.\\scripts\\set-llm-keys.ps1 -Target Vercel -Redeploy # deployed web app
.\\scripts\\set-llm-keys.ps1 -Only gpt54,deepseek,llama -Advanced  # custom endpoint per model`}</pre>
    </details>
  )
}
