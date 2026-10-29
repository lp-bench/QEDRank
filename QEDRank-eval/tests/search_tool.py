"""The web_search tool of search.py against the real Tavily API (one search, 1 credit):
plain results with URLs, no AI-written answer.  Needs TAVILY_API_KEY (in .env).
usage: .venv/bin/python tests/search_tool.py"""
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv  # noqa: E402
from proofbench_eval.search import web_search  # noqa: E402

load_dotenv(ROOT / ".env")
if not os.environ.get("TAVILY_API_KEY"):
    sys.exit("TAVILY_API_KEY is not set")
text = asyncio.run(web_search()(query="Vizing theorem edge colouring proof"))
print(text[:600])
checks = {
    "numbered results": text.startswith("1. ") and "\n\n2. " in text,
    "every result has a URL": text.count("\n   http") == text.count("\n\n") + 1,
    "no AI answer": "No answer found" not in text,
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
print(f"{sum(not ok for ok in checks.values())} failures")
sys.exit(0 if all(checks.values()) else 1)
